import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/**
 * 进程档执行原语（8.5）：`spawn` + `detached: true`，超时/取消/停机时 kill **整棵进程树**
 * （POSIX 用负 pid 打进程组，Windows 用 `taskkill /T`），而不是只杀直接子进程。
 *
 * 为什么必须全杀：用户脚本里 `sleep 9999 &` 起的后台进程、pytest 拉起的被测服务，
 * 都是孙进程——只杀直接子进程会漏，漏一个就永久占着 Runner 的槽位（验收门槛 8）。
 * POSIX 上进程组（detached 让子进程成为组长）是唯一可靠的全杀原语；Windows 没有
 * 「向进程组发信号」这回事（Node 的 `process.kill(-pid)` 也不支持负 pid），只有
 * `taskkill /PID <pid> /T` 沿父子链递归——两条系统两种原语，语义对齐在 `killGroup`。
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

/** taskkill 自身的上限：它只是杀进程，卡住说明系统出问题了，不能连带拖住 job 收尾。 */
const TASKKILL_TIMEOUT_MS = 10_000;


const inflight: Array<(reason: KillReason) => void> = [];

/** 优雅停机用：杀掉所有还在跑的用户进程（runJob 会把结果按 aborted 补报）。 */
export function killInflight(reason: KillReason): void {
  for (const kill of [...inflight]) kill(reason);
}

export function inflightCount(): number {
  return inflight.length;
}

/* 容器档（executor/container/*.ts）的用户进程不是 spawnDetached 起的，但「停机时全杀」
   要把它算进来：注册/注销一对由各通道的 run() 自己调用，名单语义不变。 */
export function registerInflightKill(kill: (reason: KillReason) => void): void {
  inflight.push(kill);
}

export function unregisterInflightKill(kill: (reason: KillReason) => void): void {
  const index = inflight.indexOf(kill);
  if (index >= 0) inflight.splice(index, 1);
}

/**
 * Windows 上的「全杀」：`taskkill /T` 沿快照出的父子链递归（`/F` 才是强杀）。不带 `/F`
 * 的那一发是宽限窗口里的礼貌尝试——控制台程序通常直接返回「只能强制终止」，但 GUI
 * 子进程（被测服务）能收到 WM_CLOSE 自己收尾，值得先给这一下。同步调用是刻意的：
 * `kill` 的契约是「返回时树已经收到信号」，异步投递会让随后的收尾（删网络、清目录）
 * 与还在跑的子孙进程抢文件。
 */
function killTreeWindows(pid: number, force: boolean): void {
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
      timeout: TASKKILL_TIMEOUT_MS,
    });
  } catch {
    /* taskkill 不可用（PATH 被裁剪、精简系统）：这一刀落空，`close` 事件照常兜底。 */
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    killTreeWindows(child.pid, signal === "SIGKILL");
    return;
  }
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
        /* Windows：detached 的进程不该弹出控制台窗口（脚本的管道已经被我们接管），
           POSIX 上这一格被忽略。 */
        windowsHide: true,
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
