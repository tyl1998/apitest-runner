import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PlatformClient } from "./client.js";
import type { RunnerConfig } from "./config.js";
import { completeWithRetries } from "./executor.js";
import { JobState, readExitCode } from "./state.js";
import { removeJobDir } from "./executor/workspace.js";

/**
 * 崩溃恢复（边界 8，Spec 2.10.2(d) 的另一半）：启动时扫 `jobs/` 目录，把「跑完了但
 * 没来得及 complete」的 job 补报上去。
 *
 * 三种残留，三种读法：
 * - `final_status` 已落盘 —— complete 发出去之前进程死了，按落盘的终态补报；
 * - 只有 `exit_code` 文件 —— 进程死在「子进程退出」与「写终态」之间，按退出码推导；
 * - 两者都没有 —— 子进程还在跑时 Runner 就没了，报 `aborted`：读不到才判 aborted。
 *
 * 这一步在 claim 之前跑：先把旧账报清，再领新活——不然崩溃重启后前 30 分钟的容量
 * 全给了新 job，旧 run 却在等下一次崩溃才有机会补报。
 *
 * 只碰 `runner_id` 等于本次注册身份的目录：另一台 Runner（或换了名字的本机）的
 * 在途状态不是我们的账，动了就是替别人报终态。
 */
export async function recoverJobs(deps: {
  client: PlatformClient;
  config: RunnerConfig;
  runnerId: string;
}): Promise<void> {
  const jobsDir = join(deps.config.dataDir, "jobs");
  if (!existsSync(jobsDir)) return;

  const entries = readdirSync(jobsDir, { withFileTypes: true });
  let foreign = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobDir = join(jobsDir, entry.name);

    const state = JobState.load(jobDir);
    if (!state) {
      /* 建了目录、state 没写成就崩了：没有任何可补报的事实，按垃圾清掉。 */
      removeJobDir(jobDir);
      continue;
    }
    if (state.runnerId !== deps.runnerId) {
      foreign += 1;
      continue;
    }

    const exitCode = readExitCode(jobDir);
    const final = state.final ??
      (exitCode !== null
        ? { status: exitCode === 0 ? ("success" as const) : ("failed" as const), exitCode, error: null }
        : { status: "aborted" as const, exitCode: null, error: "runner exited before the job finished" });

    /* register 刚成功过（平台可达），30 秒的重试窗口足够；再失败就留给下次启动。
       cases 是终态落盘时一并写进 state.json 的（P4.5-6）：恢复路径补报的不只是
       「跑成什么样」，还有「跑了哪些 case」——缺了后者，一条补报回来的成功 run
       在执行详情页上 case 计数是 0。 */
    const delivered = await completeWithRetries(
      deps.client,
      state.jobId,
      state.runnerId,
      {
        status: final.status,
        exit_code: final.exitCode ?? undefined,
        commit_sha: state.commitSha,
        error: final.error ?? undefined,
        cases: state.cases ?? undefined,
      },
      30_000,
    );
    if (delivered) {
      removeJobDir(jobDir);
      console.log(`[runner] recovered job ${state.jobId} as ${final.status}`);
    } else {
      console.error(`[runner] job ${state.jobId} still undeliverable; keeping state for the next startup`);
    }
  }
  if (foreign > 0) {
    console.warn(
      `[runner] ${foreign} job dir(s) belong to another runner identity (RUNNER_NAME or token changed?); left untouched — clean ${jobsDir} manually if that identity is gone for good`,
    );
  }
}
