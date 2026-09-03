import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import {
  KILL_GRACE_MS, STORAGE_OPT_REJECT, cpuToNanoCpus, memoryToBytes,
  type ContainerRunOpts, type ContainerRunResult, type ContainerRuntime, type ContainerSpec,
  type DockerProbe, type NetworkOutcome,
} from "./runtime.js";
import { registerInflightKill, unregisterInflightKill, type KillReason } from "../process.js";

/**
 * 容器档的 **api 通道**：Engine API over unix socket。
 *
 * 相对 cli 通道买到两件事：
 * 1. `oomKilled` 有确定答案（`GET /containers/{id}/json` → `.State.OOMKilled`）。
 *    退出码 137 既可能是内存超限被 daemon 杀、也可能是别处的 SIGKILL，cli 通道
 *    在 `--rm` 下分不出来，只能给用户一条误导性的 "terminated by signal SIGKILL"。
 * 2. daemon 侧失败与容器退出码物理分离：镜像拉不到是 404 带 JSON message，不会
 *    伪装成「脚本 exit 125」。
 *
 * 代价是 attach 的多路复用要自己解（见 `demux`），以及 create → attach → start 的
 * 时序要自己排对（先 start 再 attach 会丢掉容器开头几行输出）。
 *
 * **零运行时依赖**（`package.json` 无 dependencies）：用 node 内置 `http.request`
 * 的 `socketPath` 直接跟 socket 上的 Engine API 说话，不引 dockerode。
 *
 * 首版只支持 unix socket。`DOCKER_HOST=tcp://` + TLS 客户端证书明确不做：那要再加
 * 一套证书加载与 `tls.connect`，而 Runner 的部署形状（跑在宿主机上、就近访问本机
 * daemon）里远程 daemon 不是一个真实需求。
 */

/** Engine API 版本前缀：显式钉住，避免 daemon 换版本时字段语义漂移。1.41 = Docker 20.10+。 */
const API_VERSION = "v1.41";

type ApiResponse = { status: number; body: string };

type CreateResult = { id: string } | { error: string; status: number };

function parseMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    /* 非 JSON（极少数 daemon 错误页）：原文截断即可。 */
  }
  return body.trim().slice(0, 300) || fallback;
}

export class ApiContainerRuntime implements ContainerRuntime {
  readonly transport = "api" as const;

  constructor(private readonly socketPath: string) {}

  /**
   * `HostConfig.StorageOpt` 只在特定存储驱动上成立（overlay2 + xfs backing + pquota；
   * Docker Desktop 与大多数自建 daemon 都不满足），不支持时 create 回 400。首次撞上后
   * 记住「这台 daemon 不吃 size」，之后的 job 不再带它——磁盘限额退化为无上限，
   * CPU / 内存限额不受影响。与 cli 通道同一条纪律（见 runtime.ts 的 STORAGE_OPT_REJECT）。
   */
  private storageOptUnsupported = false;

  /** 一次普通请求（有请求体则 JSON）。网络层错误收成 status 0，调用方统一按失败处理。 */
  private call(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<ApiResponse> {
    return new Promise((resolve) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
      let req: ClientRequest;
      try {
        req = httpRequest({
          socketPath: this.socketPath,
          path: `/${API_VERSION}${path}`,
          method,
          headers: {
            Host: "docker",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
          },
          timeout: timeoutMs,
        });
      } catch (error) {
        resolve({ status: 0, body: error instanceof Error ? error.message : String(error) });
        return;
      }
      req.on("response", (res: IncomingMessage) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (text.length < 64_000) text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("timeout", () => {
        req.destroy(new Error(`docker API ${method} ${path} timed out after ${timeoutMs}ms`));
      });
      req.on("error", (error) => resolve({ status: 0, body: error.message }));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** `GET /version` 的 `.Version` 本来就是 Server 版本，不必像 CLI 那样区分 Client/Server 段。 */
  async probe(): Promise<DockerProbe> {
    const result = await this.call("GET", "/version", undefined, 15_000);
    if (result.status === 0) {
      return {
        available: false, version: "", transport: this.transport,
        reason: `docker socket ${this.socketPath} not usable: ${result.body}`,
      };
    }
    if (result.status !== 200) {
      return {
        available: false, version: "", transport: this.transport,
        reason: `docker API /version returned ${result.status}: ${parseMessage(result.body, "unknown error")}`,
      };
    }
    let version = "";
    try {
      version = String((JSON.parse(result.body) as { Version?: unknown }).Version ?? "").trim();
    } catch {
      /* 落到下面的空版本分支。 */
    }
    if (!version) {
      return { available: false, version: "", transport: this.transport, reason: "docker API /version returned no server version" };
    }
    return { available: true, version, reason: "", transport: this.transport };
  }

  async createNetwork(name: string): Promise<NetworkOutcome> {
    /* CheckDuplicate: 同名网络直接报错而不是静默复用——job 专属网络重名意味着上一个
       job 的清理没跑完，那是要看见的事故，不是可以合并的巧合。 */
    const result = await this.call("POST", "/networks/create", { Name: name, Driver: "bridge", CheckDuplicate: true });
    if (result.status === 201) return { ok: true, detail: "" };
    return { ok: false, detail: `API ${result.status}: ${parseMessage(result.body, "network create failed")}` };
  }

  async networkId(name: string): Promise<string> {
    const result = await this.call("GET", `/networks/${encodeURIComponent(name)}`);
    if (result.status !== 200) return "";
    try {
      return String((JSON.parse(result.body) as { Id?: unknown }).Id ?? "").trim();
    } catch {
      return "";
    }
  }

  async removeNetwork(name: string): Promise<NetworkOutcome> {
    const result = await this.call("DELETE", `/networks/${encodeURIComponent(name)}`);
    if (result.status === 204) return { ok: true, detail: "" };
    return { ok: false, detail: `API ${result.status}: ${parseMessage(result.body, "network remove failed")}` };
  }

  /** 镜像不在本地时 daemon 的 create 返回 404（CLI 会自动 pull，API 不会——这一步要自己做）。 */
  private async pullImage(image: string, onOutput: (text: string) => void, timeoutMs: number): Promise<string> {
    onOutput(`[runner] image ${image} not present locally; pulling\n`);
    const result = await this.call("POST", `/images/create?fromImage=${encodeURIComponent(image)}`, undefined, timeoutMs);
    if (result.status === 200) return "";
    return `API ${result.status}: ${parseMessage(result.body, "image pull failed")}`;
  }

  private async createContainer(spec: ContainerSpec, storageOpt = true): Promise<CreateResult> {
    const result = await this.call(
      "POST",
      `/containers/create?name=${encodeURIComponent(spec.name)}`,
      buildCreateBody(spec, { storageOpt }),
    );
    if (result.status === 201) {
      try {
        const id = String((JSON.parse(result.body) as { Id?: unknown }).Id ?? "").trim();
        if (id) return { id };
      } catch {
        /* 落到下面的错误分支。 */
      }
      return { error: "container create returned no Id", status: result.status };
    }
    return { error: parseMessage(result.body, "container create failed"), status: result.status };
  }

  /**
   * attach 到容器的 stdout/stderr。非 TTY 的 attach 流是**多路复用**的：每帧 8 字节头
   * `[streamType, 0,0,0, size(BE32)]` 后跟 size 字节负载。帧会跨 TCP 包切断，所以要
   * 攒够头再攒够负载（见 `demux`）。
   *
   * 用 Upgrade 拿裸 socket：daemon 对 attach 回 101（hijack），少数版本回 200 后直接
   * 把流接上，两种都接。
   */
  private attach(id: string, onOutput: (text: string) => void): Promise<{ done: Promise<void>; close: () => void }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        socketPath: this.socketPath,
        path: `/${API_VERSION}/containers/${id}/attach?stream=1&stdout=1&stderr=1`,
        method: "POST",
        headers: { Host: "docker", Connection: "Upgrade", Upgrade: "tcp", "Content-Length": "0" },
      });

      const bind = (stream: Socket | IncomingMessage) => {
        const feed = demux(onOutput);
        const done = new Promise<void>((finish) => {
          stream.on("data", (chunk: Buffer) => feed(chunk));
          stream.on("end", () => finish());
          stream.on("close", () => finish());
          /* attach 流断了不是 job 失败（容器可能已经正常退出）：wait 才是权威。 */
          stream.on("error", () => finish());
        });
        resolve({ done, close: () => stream.destroy() });
      };

      req.on("upgrade", (_res, socket) => bind(socket));
      req.on("response", (res) => {
        if (res.statusCode === 200) bind(res);
        else reject(new Error(`container attach returned ${res.statusCode}`));
      });
      req.on("error", (error) => reject(error));
      req.end();
    });
  }

  /**
   * 跑用户脚本：create → attach → start → wait → inspect（取 OOMKilled）→ rm。
   *
   * 次序不能变：先 start 再 attach 会丢掉容器开头几行输出；inspect 必须在 rm 之前
   * （这也是为什么这条通道不用 `--rm` 的等价物 `AutoRemove`——那会把 inspect 窗口
   * 一起拿掉，等于放弃 api 通道唯一的能力增量）。
   *
   * 杀梯子与 cli 通道同构：`POST /stop?t=N`（SIGTERM → t 秒 → daemon 自己 SIGKILL）
   * ，escalator 兜底 `POST /kill`。
   */
  async run(opts: ContainerRunOpts): Promise<ContainerRunResult> {
    const { spec } = opts;
    let killedBy: KillReason | null = null;
    let containerId = "";
    let finished = false;

    const kill = (reason: KillReason): void => {
      if (finished || !containerId) return;
      killedBy = reason;
      const id = containerId;
      void this.call("POST", `/containers/${id}/stop?t=${spec.stopTimeoutSeconds}`, undefined, 60_000).then(() => {
        if (finished) return;
        void this.call("POST", `/containers/${id}/kill`, undefined, 60_000);
      });
      setTimeout(() => {
        if (finished) return;
        void this.call("POST", `/containers/${id}/kill`, undefined, 60_000);
      }, KILL_GRACE_MS * 2);
    };

    const failed = (message: string): ContainerRunResult => ({
      exitCode: null, signal: null, killedBy: null, oomKilled: null, spawnError: message,
    });

    let created = await this.createContainer(spec, !this.storageOptUnsupported);
    if ("error" in created && created.status === 404) {
      const pullError = await this.pullImage(spec.image, opts.onOutput, Math.max(60_000, opts.timeoutMs));
      if (pullError) return failed(`could not pull image ${spec.image}: ${pullError}`);
      created = await this.createContainer(spec, !this.storageOptUnsupported);
    }
    /* daemon 不吃 `StorageOpt.size`（存储驱动不支持，见类头注释）：去掉它重试一次，
       而不是把「起不来容器」报成 job 失败。进程内缓存，之后的 job 直接走无 size 路径。 */
    if ("error" in created && !this.storageOptUnsupported && STORAGE_OPT_REJECT.test(created.error)) {
      this.storageOptUnsupported = true;
      opts.onOutput(
        `[runner] this docker daemon rejected --storage-opt (${created.error}); ` +
        "retrying without the disk-size limit\n",
      );
      created = await this.createContainer(spec, false);
    }
    if ("error" in created) {
      return failed(`could not create container: API ${created.status}: ${created.error}`);
    }
    containerId = created.id;

    const timeoutTimer = setTimeout(() => kill("timeout"), Math.max(1, opts.timeoutMs));
    registerInflightKill(kill);
    /* 杀梯子交给 executor（取消 / 丢租约直达容器）。放在 containerId 赋值之后：
       kill 的守卫要求 containerId 非空，这之前交出去也只会被静默吞掉。 */
    opts.onReady?.(kill);

    let attached: { done: Promise<void>; close: () => void } | null = null;
    try {
      attached = await this.attach(containerId, opts.onOutput);

      const started = await this.call("POST", `/containers/${containerId}/start`);
      if (started.status !== 204 && started.status !== 304) {
        return failed(`could not start container: API ${started.status}: ${parseMessage(started.body, "start failed")}`);
      }

      /* wait 没有超时上限：job 的超时由上面的 timeoutTimer 经 stop/kill 生效，
         容器一旦被杀，wait 立刻返回。给它一个 HTTP 超时反而会在长 job 上误伤。 */
      const waited = await this.call("POST", `/containers/${containerId}/wait`, undefined, 0);
      if (waited.status !== 200) {
        return failed(`could not wait for container: API ${waited.status}: ${parseMessage(waited.body, "wait failed")}`);
      }
      let exitCode: number | null = null;
      try {
        const parsed = JSON.parse(waited.body) as { StatusCode?: unknown };
        if (typeof parsed.StatusCode === "number") exitCode = parsed.StatusCode;
      } catch {
        /* exitCode 保持 null：executor 会按「signal 终止」报，比编一个 0 好。 */
      }

      /* 容器已停，attach 流会自然收尾；等它把尾巴上的字节冲干净再读 inspect。 */
      await Promise.race([attached.done, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);

      const oomKilled = await this.readOomKilled(containerId);

      finished = true;
      return { exitCode, signal: null, killedBy, oomKilled, spawnError: null };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    } finally {
      finished = true;
      clearTimeout(timeoutTimer);
      unregisterInflightKill(kill);
      attached?.close();
      /* `?v=1` 连匿名卷一起删。失败只影响这台宿主留一个停止的容器，job 结论不受影响。 */
      if (containerId) await this.call("DELETE", `/containers/${containerId}?v=1&force=1`).catch(() => undefined);
    }
  }

  /** `.State.OOMKilled`：读不到时返回 null（未知），不当 false——见 runtime.ts 的说明。 */
  private async readOomKilled(id: string): Promise<boolean | null> {
    const result = await this.call("GET", `/containers/${id}/json`);
    if (result.status !== 200) return null;
    try {
      const state = (JSON.parse(result.body) as { State?: { OOMKilled?: unknown } }).State;
      return typeof state?.OOMKilled === "boolean" ? state.OOMKilled : null;
    } catch {
      return null;
    }
  }
}

/**
 * `ContainerSpec` → Engine API 的 create 请求体。与 cli 通道的 argv 一一对应。
 * `storageOpt: false` 省掉 `HostConfig.StorageOpt`（daemon 不支持时，见类头注释）。
 */
export function buildCreateBody(spec: ContainerSpec, opts?: { storageOpt?: boolean }): Record<string, unknown> {
  const binds = spec.binds.map((bind) => `${bind.host}:${bind.container}${bind.readOnly ? ":ro" : ""}`);
  const env = Object.entries(spec.env)
    .filter(([key]) => key && !key.includes("="))
    .map(([key, value]) => `${key}=${value}`);
  return {
    Image: spec.image,
    Entrypoint: [spec.entrypoint],
    Cmd: spec.command,
    Env: env,
    WorkingDir: spec.workdir,
    StopTimeout: spec.stopTimeoutSeconds,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: false,
    OpenStdin: false,
    Tty: false,
    HostConfig: {
      Binds: binds,
      NetworkMode: spec.network,
      NanoCpus: cpuToNanoCpus(spec.limits.cpu),
      Memory: memoryToBytes(spec.limits.memory),
      ...(opts?.storageOpt === false ? {} : { StorageOpt: { size: spec.limits.disk } }),
      /* AutoRemove 刻意不开：inspect 要在 rm 之前读 OOMKilled，自动回收会关掉那个窗口。
         回收由 run() 的 finally 显式做。 */
      AutoRemove: false,
    },
  };
}

/**
 * 非 TTY attach 流的解复用器。返回一个吃 Buffer 的函数，内部攒不完整的帧。
 *
 * 帧格式：`[streamType(1), 0,0,0, size(BE32)]` + size 字节负载。stdout(1) 与
 * stderr(2) 都直接喂给 onOutput——Runner 的日志流本来就是合并的（进程档也是把
 * 两路都 feed 进同一个 streamer）。
 *
 * UTF-8 边界：帧负载可能切在多字节字符中间，所以用 `StringDecoder` 的等价做法——
 * 攒到帧完整再解码。帧内负载本身也可能切断一个字符（daemon 按字节切），因此跨帧
 * 保留一个待解码尾巴。
 */
export function demux(onOutput: (text: string) => void): (chunk: Buffer) => void {
  /* 显式标注成默认的 `Buffer`（ArrayBufferLike）：`subarray` 的返回类型比
     `Buffer.alloc` 宽，不标注会让这两个累加器被推断成不兼容的窄类型。 */
  let buffer: Buffer = Buffer.alloc(0);
  let pending: Buffer = Buffer.alloc(0);

  const flush = (payload: Buffer): void => {
    const combined = pending.length ? Buffer.concat([pending, payload]) : payload;
    /* 末尾若是不完整的多字节序列，留到下一帧再解——否则会吐出替换字符。 */
    const keep = incompleteTailLength(combined);
    const decodable = keep ? combined.subarray(0, combined.length - keep) : combined;
    pending = keep ? combined.subarray(combined.length - keep) : Buffer.alloc(0);
    if (decodable.length) onOutput(decodable.toString("utf8"));
  };

  return (chunk: Buffer): void => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 8) return;
      const size = buffer.readUInt32BE(4);
      if (buffer.length < 8 + size) return;
      const payload = buffer.subarray(8, 8 + size);
      buffer = buffer.subarray(8 + size);
      if (size) flush(payload);
    }
  };
}

/** 末尾不完整 UTF-8 序列的字节数（0 表示可以整段解码）。 */
function incompleteTailLength(buffer: Buffer): number {
  const max = Math.min(3, buffer.length);
  for (let back = 1; back <= max; back += 1) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue; // 续字节，继续往前找头字节
    const needed =
      (byte & 0b1000_0000) === 0 ? 1 :
      (byte & 0b1110_0000) === 0b1100_0000 ? 2 :
      (byte & 0b1111_0000) === 0b1110_0000 ? 3 :
      (byte & 0b1111_1000) === 0b1111_0000 ? 4 : 1;
    return needed > back ? back : 0;
  }
  return 0;
}
