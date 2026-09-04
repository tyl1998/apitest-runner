import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { JobSpec } from "../../protocol.js";
import { PhaseError } from "../errors.js";
import type { KillReason, ProcResult } from "../process.js";

/**
 * 容器档的**通道无关**层（8.5，P4.5-10 / P4.5-10b）。
 *
 * 容器档有两条通道：`cli`（`docker run`，默认）与 `api`（Engine API over unix
 * socket）。两者的差别只在「怎么跟 daemon 说话」，不在「跑什么」——所以这里定义
 * 一个结构化的 `ContainerSpec` 作为中间表示，由各通道自己翻译成 argv 或 HostConfig。
 *
 * **中间表示刻意不是 argv 数组**：让 api 通道去反解 `--volume h:c:ro` 这种字符串，
 * 等于把 CLI 的语法当成内部协议，改一个挂载点要同时改两处解析。
 *
 * 与进程档（executor/process.ts）的关系不变：两档都产出 `ProcResult`，
 * executor 的终态映射只写一份。
 */

export const WORKSPACE_CONTAINER_PATH = "/workspace";

export type ContainerTransport = "cli" | "api";

export type DockerProbe = {
  available: boolean;
  version: string;
  reason: string;
  /** 探测走的是哪条通道——注册日志要说清，否则运维分不出「CLI 没装」与「socket 没权限」。 */
  transport: ContainerTransport;
};

/** 校验过的限额原文。三个值都保持 docker 的字面语法：`StorageOpt.size` 本来就吃 "10g"。 */
export type ContainerLimits = { cpu: string; memory: string; disk: string };

export type ContainerBind = {
  host: string;
  container: string;
  /** 只读挂载（脚本文件用）。 */
  readOnly?: boolean;
};

/** 一次容器运行的完整描述（结构化，与通道无关）。 */
export type ContainerSpec = {
  name: string;
  network: string;
  image: string;
  /** 镜像里跑脚本的 shell（config.imageShell）——覆盖镜像自带 entrypoint。 */
  entrypoint: string;
  /** entrypoint 的参数（挂进去的脚本路径）。 */
  command: string[];
  workdir: string;
  binds: ContainerBind[];
  env: Record<string, string>;
  limits: ContainerLimits;
  /** stop 时 daemon 等 PID1 自己退的秒数，之后 daemon 自己 SIGKILL。 */
  stopTimeoutSeconds: number;
  /**
   * per-container DNS 追加（`--add-host` / `HostConfig.ExtraHosts`）。唯一消费者是
   * `host.apitrack.internal: host-gateway`——容器档 SDK 回连平台用的名字（jobSpec 的
   * containerLoopback 改写目标）。`host-gateway` 是 docker 20.10+ 的官方 token，由
   * daemon 替换成「容器到宿主的网关」：桌面产品是宿主转发地址、Linux 是网桥网关——
   * 平台不猜网络拓扑，两种环境同一个值。
   */
  extraHosts: string[];
};

/**
 * 容器运行结果。比 `ProcResult` 多一格 `oomKilled`，这是两条通道**能力不同**的地方：
 *
 * - `api`：`GET /containers/{id}/json` 明确给 `.State.OOMKilled`，返回 true/false；
 * - `cli`：`docker run --rm` 的容器在进程退出时已被 daemon 回收，没有 inspect 的
 *   窗口（去掉 `--rm` 换取这一格，代价是 Runner 崩溃时留下停止的容器），返回
 *   `null` = 未知。
 *
 * `null` 不能当 false 用：内存超限被杀与被 SIGKILL 杀在退出码上都是 137，把未知
 * 当「不是 OOM」会让用户看到一条误导性的错误信息。
 */
export type ContainerRunResult = ProcResult & { oomKilled: boolean | null };

export type ContainerRunOpts = {
  spec: ContainerSpec;
  onOutput: (text: string) => void;
  timeoutMs: number;
  /**
   * 容器就位后把它的杀梯子交回调用方（executor 的取消 / 丢租约路径）。没有这一格，
   * 心跳送到的取消在容器档上是空操作——executor 的 `currentHandle` 只认进程档的
   * spawnFn，容器跑多久取消就挂多久，直到脚本自然退出才落 canceled。
   */
  onReady?: (kill: (reason: KillReason) => void) => void;
};

/** 短命令结果（网络创建 / iptables / 清理）。stdout 只在需要时收（inspect Id）。 */
export type SpawnShortResult = { status: number | null; stdout: string; stderr: string; error?: Error };

/** 网络操作的统一结果：api 通道没有退出码，用 ok + detail 表达而不是伪造一个 status。 */
export type NetworkOutcome = { ok: boolean; detail: string };

/**
 * 一条容器通道要提供的全部能力。**不含 iptables**：deny 规则操作的是宿主 netfilter，
 * Engine API 里没有对应物，两条通道都得 `spawn iptables`（见 network.ts）。
 */
export type ContainerRuntime = {
  readonly transport: ContainerTransport;
  /** 探测 daemon 可达性；结果决定 register 自报的 `sandbox_modes`。 */
  probe(): Promise<DockerProbe>;
  /** 跑用户脚本，直到容器结束或被 kill。 */
  run(opts: ContainerRunOpts): Promise<ContainerRunResult>;
  createNetwork(name: string): Promise<NetworkOutcome>;
  /** 网络的完整 Id（用于推 `br-<id 前 12 位>` 桥名）；取不到返回空串。 */
  networkId(name: string): Promise<string>;
  removeNetwork(name: string): Promise<NetworkOutcome>;
};

/** docker-in-docker 检测（8.5）：Runner 自己跑在容器里时，挂 docker.sock 的「容器隔离」是假的。 */
export function runningInsideContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    return /docker|kubepods|containerd|lxc/.test(cgroup);
  } catch {
    /* 非 Linux（mac 开发机）两判据都落空，读作宿主。 */
    return false;
  }
}

/** 限额值格式（JobSpec 来自网络，正则过一遍再交给 daemon，畸形值报 failed 而不是透传）。 */
export function validateLimits(sandbox: JobSpec["sandbox"]): ContainerLimits {
  const cpu = String(sandbox.cpu_limit ?? "").trim();
  const memory = String(sandbox.memory_limit ?? "").trim();
  const disk = String(sandbox.disk_limit ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(cpu)) {
    throw new PhaseError("failed", `sandbox.cpu_limit ${JSON.stringify(cpu)} is not a valid --cpus value`);
  }
  if (!/^\d+[kmg]$/.test(memory)) {
    throw new PhaseError("failed", `sandbox.memory_limit ${JSON.stringify(memory)} is not a valid --memory value (expected e.g. 512m / 2g)`);
  }
  if (!/^\d+[kmg]$/.test(disk)) {
    throw new PhaseError("failed", `sandbox.disk_limit ${JSON.stringify(disk)} is not a valid --storage-opt size value`);
  }
  return { cpu, memory, disk };
}

/**
 * 限额原文 → Engine API 的数值字段（只有 api 通道需要；cli 通道原样透传）。
 * `validateLimits` 已经把格式钉死，这里不再防御性解析。
 */
export function cpuToNanoCpus(cpu: string): number {
  return Math.round(Number(cpu) * 1e9);
}

export function memoryToBytes(memory: string): number {
  const unit = memory.slice(-1).toLowerCase();
  const amount = Number(memory.slice(0, -1));
  const scale = unit === "k" ? 1024 : unit === "m" ? 1024 ** 2 : 1024 ** 3;
  return amount * scale;
}

/** TERM 之后的强杀宽限（与进程档同一个数量级，容器档乘 2——stop 要过 daemon 一趟）。 */
export const KILL_GRACE_MS = 5_000;

/**
 * daemon 拒绝 `--storage-opt size=` 的报错特征（CLI 与 Engine API 的措辞都在这里）。
 * 该旗标只在特定存储驱动上成立（overlay2 + xfs backing + pquota；Docker Desktop 与
 * 大多数自建 daemon 都不满足），不支持时 create 直接被拒——两条通道都要能降级重试
 * （去掉磁盘限额，CPU / 内存照常），见各自的 `run`。
 */
export const STORAGE_OPT_REJECT = /storage-opt|pquota/i;

/**
 * 跑一个短命令并收窄输出。**不进** executor 的 spawnFn（那套的 currentHandle 语义属于
 * 用户脚本），也不进日志流——结果由调用方记进 job 日志。
 *
 * 通道无关：cli 通道用它跑 `docker network …`，两条通道都用它跑 `iptables`。
 */
export function runShort(command: string, args: string[], timeoutMs = 30_000): Promise<SpawnShortResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 4_096) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk;
    });
    child.on("error", (error) => resolve({ status: null, stdout, stderr, error }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** 供 network.ts 用：固定命令的 runShort 适配。 */
export function commandSpawnShort(command: string): (args: string[]) => Promise<SpawnShortResult> {
  return (args) => runShort(command, args);
}

/** 短命令失败原因收成一行（两条通道的错误信息格式统一）。 */
export function shortFailureDetail(result: SpawnShortResult): string {
  const text = (result.stderr || result.error?.message || "").trim();
  return text.split(/\r?\n/).filter(Boolean).pop() ?? `exit ${result.status ?? "signal"}`;
}
