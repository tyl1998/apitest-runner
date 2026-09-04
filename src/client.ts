import type { JobSpec, RegisterResult, HeartbeatResult, LogsResult, CompleteStatus, ReportCase, ArtifactUploadTarget } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { RUNNER_VERSION } from "./version.js";

/**
 * 平台侧 Runner 协议客户端（8.2 接口 1–6）。
 *
 * 全部主动外连、全部 POST（除产物直传的 PUT——那是发给对象存储的，不是发给平台的）、
 * 认证一律 `Bearer apirunner_…`——平台永不反向连接 Runner 是这个组件能待在 NAT 后面的
 * 全部前提（边界 6）。
 *
 * 响应统一是 `{code, message, data}` 信封（server-contract）；claim 的 204 没有 body，
 * 读作「这轮没有活」而不是错误。
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 调用方拿它区分「重试有意义」（网络抖动 / 5xx）与「重试无意义」（4xx 语义拒绝）。 */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export type ClientOptions = {
  baseUrl: string;
  token: string;
  /** 普通接口（register/heartbeat/logs/complete）的请求超时。 */
  requestTimeoutMs?: number;
  /** claim 是长轮询：超时必须盖住服务端的 pollTimeoutSeconds（25s）再加余量。 */
  claimTimeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** 服务端长轮询窗口 25s + 网络余量。register 之前拿不到平台下发的 pollTimeoutSeconds，
    所以这里给一个「盖得住」的定值而不是精确值。 */
const DEFAULT_CLAIM_TIMEOUT_MS = 90_000;

/** 合并外部取消（优雅停机要能打断长轮询）与请求超时，两个来源都归一到同一个 controller。 */
function abortAfter(ms: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${ms}ms`)), ms);
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export class PlatformClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly claimTimeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  }

  /**
   * register（8.2 接口 1）。请求体按协议表用 snake_case（服务端两种拼法都收），
   * 响应是 camelCase——`heartbeatIntervalSeconds` 与 `pollTimeoutSeconds` 由平台下发，
   * Runner 不自定间隔：租约时长（90s）是平台侧回收器的判据，客户端自选间隔
   * 等于让它自己决定多久算掉线。
   *
   * `docker_transport` 是容器档通道的自报（cli = `docker run` 命令，api = Engine API
   * over unix socket）：部署时由 `APITRACK_RUNNER_DOCKER_TRANSPORT` 选定，注册时带上
   * 才能让 Runner 池面板说清「这台机器用哪条通道连 daemon」。
   */
  async register(input: {
    name: string;
    labels: string[];
    capacity: number;
    sandboxModes: string[];
    dockerTransport?: string;
  }): Promise<RegisterResult> {
    const data = await this.post(
      "/runner/register",
      {
        name: input.name,
        labels: input.labels,
        capacity: input.capacity,
        sandbox_modes: input.sandboxModes,
        ...(input.dockerTransport ? { docker_transport: input.dockerTransport } : {}),
        version: RUNNER_VERSION,
        protocol_version: PROTOCOL_VERSION,
      },
      { timeoutMs: this.requestTimeoutMs },
    );
    const result = data as RegisterResult;
    if (!result?.runnerId) throw new ApiError(500, 5001, "register response missing runnerId");
    return result;
  }

  /** claim（8.2 接口 2）：长轮询，204 → null。403 = draining（退场信号）。 */
  async claim(runnerId: string, capacityAvailable: number, signal?: AbortSignal): Promise<JobSpec | null> {
    const data = await this.post(
      "/runner/claim",
      { runner_id: runnerId, capacity_available: capacityAvailable },
      { timeoutMs: this.claimTimeoutMs, signal },
    );
    return (data as JobSpec | null) ?? null;
  }

  /** heartbeat（8.2 接口 3）：续租 + 阶段/日志水位 + 取消指令下发。 */
  async heartbeat(
    jobId: string,
    runnerId: string,
    stage: string | undefined,
    logBytes: number,
  ): Promise<HeartbeatResult> {
    const data = await this.post(
      `/runner/jobs/${jobId}/heartbeat`,
      { runner_id: runnerId, stage, log_bytes: logBytes },
      { timeoutMs: this.requestTimeoutMs },
    );
    return data as HeartbeatResult;
  }

  /** logs（8.2 接口 4）：按 byte_offset 幂等追加，响应给当前总长。 */
  async logs(jobId: string, runnerId: string, byteOffset: number, chunk: string): Promise<LogsResult> {
    const data = await this.post(
      `/runner/jobs/${jobId}/logs`,
      { runner_id: runnerId, byte_offset: byteOffset, chunk },
      { timeoutMs: this.requestTimeoutMs },
    );
    return data as LogsResult;
  }

  /**
   * complete（8.2 接口 6）：终态上报。服务端幂等（约定 5），重发安全。
   * `cases` 是报告解析结果（P4.5-6，边界 13 的 B/C 路径）——体积有 Runner 侧预算
   * （report/parse.ts），这里不再做二次防御：预算的位置必须唯一，否则两边各截
   * 一刀拼出来的不是同一份数据。
   */
  async complete(
    jobId: string,
    runnerId: string,
    payload: {
      status: CompleteStatus;
      exit_code?: number;
      commit_sha?: string;
      error?: string;
      cases?: ReportCase[];
    },
  ): Promise<void> {
    await this.post(
      `/runner/jobs/${jobId}/complete`,
      {
        runner_id: runnerId,
        status: payload.status,
        exit_code: payload.exit_code,
        commit_sha: payload.commit_sha ?? "",
        error: payload.error,
        cases: payload.cases,
      },
      { timeoutMs: this.requestTimeoutMs },
    );
  }

  /**
   * artifacts 申请（8.2 接口 5，P4.5-7）：拿一个直传目标（s3: pre-signed PUT URL；
   * fs: 带一次性 token 的平台上传地址）。字节流走 `uploadArtifact`，不进这个客户端——
   * 那是发给对象存储的 PUT，没有 `apirunner_` 头、没有信封。
   */
  async requestArtifactUpload(
    jobId: string,
    runnerId: string,
    payload: { kind: string; name: string; size_bytes: number; content_type: string; checksum: string },
  ): Promise<ArtifactUploadTarget> {
    const data = await this.post(
      `/runner/jobs/${jobId}/artifacts`,
      { runner_id: runnerId, ...payload },
      { timeoutMs: this.requestTimeoutMs },
    );
    const target = data as ArtifactUploadTarget;
    if (!target?.upload_url || !target.artifact_id) {
      throw new ApiError(500, 5001, "artifact upload target response missing upload_url");
    }
    return target;
  }

  /**
   * 产物直传：PUT 到 `requestArtifactUpload` 给的 URL（对象存储或平台的 fs 端点）。
   * 与 `post` 分开：无信封、无认证头（凭据在 URL / 一次性 token 里）、非 JSON 响应。
   *
   * 重试策略由调用方（executor/uploader.ts）决定——这里只发一次。
   */
  async uploadArtifact(
    target: ArtifactUploadTarget,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(target.upload_url, {
        method: target.method ?? "PUT",
        headers: {
          ...target.headers,
          "content-length": String(body.byteLength),
        },
        /* TS 的 lib.dom BodyInit 不认 Node 的 Uint8Array 泛型形状；运行时 fetch 接受它。
           断言只跨这一个字段，不把整个 init 放宽。 */
        body: body as unknown as BodyInit,
        signal,
      });
    } catch (error) {
      throw new ApiError(0, -1, error instanceof Error ? error.message : String(error));
    }
    /* fs 端点回信封 JSON；s3 回空 body + 200。非 2xx 一律读作失败。 */
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ApiError(response.status, -1, `artifact upload failed: HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
  }

  /**
   * 上传完成确认（`POST /runner/artifacts/:id/uploaded`）：s3 驱动下 `uploaded_at`
   * 的落位点——pre-signed PUT 的结果只有存储知道，平台要核过才认。fs 驱动幂等回
   * ok，所以这里不需要知道驱动是哪档。失败按 best-effort 纪律由调用方记日志。
   */
  async confirmArtifactUploaded(artifactId: string, runnerId: string): Promise<void> {
    await this.post(
      `/runner/artifacts/${artifactId}/uploaded`,
      { runner_id: runnerId },
      { timeoutMs: this.requestTimeoutMs },
    );
  }

  private async post(
    path: string,
    body: unknown,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const { signal, cleanup } = abortAfter(opts.timeoutMs, opts.signal);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      /* 网络层失败没有 HTTP 状态码，用 status=0 占位，调用方按 transient 处理。 */
      throw new ApiError(0, -1, error instanceof Error ? error.message : String(error));
    } finally {
      cleanup();
    }
    if (response.status === 204) return null;
    const text = await response.text();
    let parsed: { code?: number; message?: string; data?: unknown } | undefined;
    try {
      parsed = text ? (JSON.parse(text) as typeof parsed) : undefined;
    } catch {
      throw new ApiError(response.status, -1, `non-JSON response: ${text.slice(0, 200)}`);
    }
    if (!response.ok || !parsed || parsed.code !== 0) {
      throw new ApiError(
        response.status,
        Number(parsed?.code ?? -1),
        String(parsed?.message ?? `HTTP ${response.status}`),
      );
    }
    return parsed.data;
  }
}
