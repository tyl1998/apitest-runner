import { spawn, type ChildProcess } from "node:child_process";

/**
 * 进程档执行原语（8.5）：`spawn` + `detached: true`，超时/取消/停机时 kill **整个进程组**
 * （负 pid），而不是只杀直接子进程。
 *
 * 为什么必须 detached：用户脚本里 `sleep 9999 &` 起的后台进程、pytest 拉起的被测服务，
 * 都是孙进程——只杀直接子进程会漏，漏一个就永久占着 Runner 的槽位（验收门槛 8）。
 * 进程组（detached 让子进程成为组长）是 POSIX 上唯一可靠的「全杀」原语。
 *
 * 容器档（P4.5-10）不在这里：`docker run --rm` 天然全杀，加进来只会让这份文件
 * 在未来同时背两套语义。
 */

export type KillReason = "cancel" | "timeout" | "shutdown";

export type ProcResult = {
  exitCode: number | null;
  signal: string | null;
  /** 被我们主动杀掉的进程没有「自然退出码」，杀死原因由调用方映射终态。 */
  killedBy: KillReason | null;
  /** spawn 本身失败（如 shell 不存在），没有进程可谈。 */
  spawnError: string | null;
};

export type ProcHandle = {
  readonly promise: Promise<ProcResult>;
  kill(reason: KillReason): void;
};

/** TERM 之后的强杀宽限：给进程组 5 秒清理（写报告、关连接），然后 SIGKILL。 */
const KILL_GRACE_MS = 5_000;

const inflight: Array<(reason: KillReason) => void> = [];

/** 优雅停机用：杀掉所有还在跑的用户进程（runJob 会把结果按 aborted 补报）。 */
export function killInflight(reason: KillReason): void {
  for (const kill of [...inflight]) kill(reason);
}

export function inflightCount(): number {
  return inflight.length;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* ESRCH：组已经没了。再补一刀直接子进程，防 detached 组语义在个别平台失灵。 */
    try {
      child.kill(signal);
    } catch {
      /* 也死了，收尸即可。 */
    }
  }
}

export function spawnDetached(opts: {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 本进程允许的最长存活时间（毫秒）；缺省表示交给调用方自己杀。 */
  timeoutMs?: number;
  /** 合并后的 stdout/stderr 增量（已按 UTF-8 解码，跨 chunk 的多字节字符是完整的）。 */
  onOutput?: (text: string) => void;
}): ProcHandle {
  let killedBy: KillReason | null = null;
  let settled = false;
  let child: ChildProcess | undefined;
  let escalator: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  const kill = (reason: KillReason): void => {
    if (settled || !child || child.exitCode !== null) return;
    killedBy = reason;
    killGroup(child, "SIGTERM");
    /* 宽限后强杀整个组：SIGTERM 被无视时（或孙进程还攥着管道）这里是兜底。 */
    escalator = setTimeout(() => child && killGroup(child, "SIGKILL"), KILL_GRACE_MS);
  };

  const promise = new Promise<ProcResult>((resolve) => {
    const finish = (result: ProcResult) => {
      if (settled) return;
      settled = true;
      if (escalator) clearTimeout(escalator);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const index = inflight.indexOf(kill);
      if (index >= 0) inflight.splice(index, 1);
      resolve(result);
    };

    try {
      child = spawn(opts.file, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ exitCode: null, signal: null, killedBy: null, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }

    inflight.push(kill);
    if (opts.timeoutMs) timeoutTimer = setTimeout(() => kill("timeout"), opts.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => opts.onOutput?.(chunk));
    child.stderr?.on("data", (chunk: string) => opts.onOutput?.(chunk));

    child.on("error", (error) => {
      finish({ exitCode: null, signal: null, killedBy, spawnError: error.message });
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal: signal ?? null, killedBy, spawnError: null });
    });
  });

  return { promise, kill };
}
