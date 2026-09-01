import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { PlatformClient } from "./client.js";
import { loadConfig } from "./config.js";
import { runClaimLoop, type ClaimLoopResult } from "./claimer.js";
import { killInflight, inflightCount } from "./executor/process.js";
import { recoverJobs } from "./recover.js";
import { FatalError, registerRunner } from "./registry.js";
import { RUNNER_VERSION } from "./version.js";

/**
 * 入口：装配配置与客户端 → 注册 → 恢复旧账 → 领取循环 →（信号到达）收尾退出。
 *
 * 优雅停机的两段式：SIGTERM 先打断长轮询（claim 不再领新活），在途 job 给满
 * shutdownGrace 秒自然收尾；到点还有进程组活着就整组杀掉——runJob 会把它们按
 * `aborted` 落盘并补报（kill -9 那种硬死则由租约回收器在平台侧判 aborted，
 * 下次启动时 recover 再兜一层）。
 */

function fatal(message: string): never {
  console.error(`[runner] fatal: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { config, errors } = loadConfig();
  if (!config) {
    for (const error of errors) console.error(`[runner] config: ${error}`);
    process.exit(1);
  }
  mkdirSync(config.dataDir, { recursive: true });

  /* git 是硬前置：每个 job 都要 clone（clone_method=none 是「无凭据」，不是「无仓库」）。 */
  const gitProbe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (gitProbe.error || gitProbe.status !== 0) {
    fatal("git is required on this machine (every job clones a repository)");
  }
  /* ssh 只有 ssh_key 的任务需要；缺了不致命（这台机器只跑 https/公开仓库时成立）。
     `ssh -V` 的退出码恒为 255、版本打在 stderr，判存在只看有没有这个可执行文件。 */
  const sshProbe = spawnSync("ssh", ["-V"], { encoding: "utf8" });
  if (sshProbe.error) {
    console.warn("[runner] ssh not found: jobs whose clone_method is ssh_key will fail on this machine");
  }

  console.log(
    `[runner] apitest-runner ${RUNNER_VERSION} → ${config.baseUrl} ` +
      `(name ${config.name}, labels ${config.labels.join(",")}, capacity ${config.capacity}, data ${config.dataDir})`,
  );

  const client = new PlatformClient({ baseUrl: config.baseUrl, token: config.token });

  let registered: Awaited<ReturnType<typeof registerRunner>>;
  try {
    registered = await registerRunner(client, config);
  } catch (error) {
    fatal(error instanceof FatalError ? error.message : error instanceof Error ? error.message : String(error));
  }

  /* 信号位先立起来再恢复旧账：恢复期间 Ctrl-C 不至于变成默认的硬杀。 */
  const stopController = new AbortController();
  const onSignal = () => {
    console.log("[runner] shutdown signal received; stopping claims");
    stopController.abort();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  await recoverJobs({ client, config, runnerId: registered.runnerId });

  let loop: ClaimLoopResult;
  try {
    loop = await runClaimLoop({
      client,
      config,
      runnerId: registered.runnerId,
      heartbeatIntervalSeconds: registered.heartbeatIntervalSeconds,
      stopSignal: stopController.signal,
    });
  } catch (error) {
    if (error instanceof FatalError) fatal(error.message);
    throw error;
  }

  if (loop.reason === "draining") {
    /* draining 语义（迁移 036）：不领新活，在跑的跑完。每个 spawn 都带超时，
       这个等待天然有界。 */
    console.log(`[runner] draining: waiting for ${loop.jobs.length} in-flight job(s) to finish`);
    await Promise.allSettled(loop.jobs);
    console.log("[runner] drained; exiting");
    process.exit(0);
  }

  console.log(`[runner] stopping: waiting up to ${config.shutdownGraceSeconds}s for ${loop.jobs.length} in-flight job(s)`);
  const settled = Promise.allSettled(loop.jobs);
  await Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, config.shutdownGraceSeconds * 1000))]);

  const alive = inflightCount();
  if (alive > 0) {
    console.warn(`[runner] grace expired with ${alive} process group(s) alive; killing them (those jobs will be reported aborted)`);
    killInflight("shutdown");
    await settled;
  }
  console.log("[runner] stopped");
  process.exit(0);
}

process.on("unhandledRejection", (reason) => {
  console.error("[runner] unhandled rejection:", reason);
});

main().catch((error) => {
  console.error("[runner] crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
