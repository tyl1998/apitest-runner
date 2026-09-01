import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type PlatformClient } from "./client.js";
import type { RunnerConfig } from "./config.js";
import type { CompleteStatus, JobSpec, PipelineStage, ReportCase } from "./protocol.js";
import { SecretMasker, httpsCredentialMaskValues, sshKeyMaskValues } from "./masker.js";
import { JobState, writeExitCode } from "./state.js";
import { LogStreamer } from "./streamer.js";
import { collectReportCases, collectAllureResultDirs } from "./report/parse.js";
import { uploadArtifacts } from "./uploader.js";
import { uploadAllureReportBundle } from "./reportBundle.js";
import { prepareCache } from "./executor/cache.js";
import { PhaseError, type SpawnFn } from "./executor/errors.js";
import { cloneRepository } from "./executor/git.js";
import { spawnDetached, type ProcHandle, type ProcResult } from "./executor/process.js";
import { prepareJobDir, removeJobDir } from "./executor/workspace.js";

/**
 * 单个 job 的编排（Spec 2.10.2(d) 的执行流程）：clone → cache → script → complete，
 * 外加心跳（续租 + 取消下发）、日志流、终态落盘与补报。
 *
 * 终态的判定优先级就是这边的控制流：lostLease（服务端已定局，报什么都进不了守卫）
 * > cancel（只经心跳下发，约定 6）> 阶段失败 / 超时 > 脚本退出码。
 *
 * `timeout_seconds` 覆盖**整个 job**（clone 吃掉的时间算在内）：挂死的 fetch 与挂死的
 * pytest 对槽位的占用没有区别。
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 透传给用户脚本的最小环境。白名单而不是整份继承：Runner 自己的环境里有
 * `APITRACK_RUNNER_TOKEN`（注册凭据），继承下去等于把平台凭据塞进任意用户脚本。
 * PATH/HOME/代理与 CA 是「这台机器怎么上网」的事实，用户脚本离不开，放行。
 */
const PASS_THROUGH_ENV = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
];

function buildScriptEnv(spec: JobSpec): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, spec.env ?? {});
  for (const secret of spec.secrets ?? []) {
    if (secret.key) env[secret.key] = secret.value;
  }
  /* §8.3 的勾选执行链路：JobSpec 的 case_filter 以 env 形态到达用户脚本。逗号分隔是
     本批定下的形态，P4.5-9 的 SDK 侧（APITRACK_CASE_KEYS 的消费者）与它对齐。 */
  const keys = spec.case_filter?.case_keys ?? [];
  if (keys.length) env.APITRACK_CASE_KEYS = keys.join(",");
  return env;
}

function startHeartbeat(deps: {
  client: PlatformClient;
  jobId: string;
  runnerId: string;
  intervalMs: number;
  getStage: () => PipelineStage;
  getLogBytes: () => number;
  onCancel: () => void;
  onLost: () => void;
}) {
  let stopped = false;
  let resolvePoke: (() => void) | undefined;
  const loop = (async () => {
    for (;;) {
      if (stopped) return;
      try {
        const result = await deps.client.heartbeat(deps.jobId, deps.runnerId, deps.getStage(), deps.getLogBytes());
        if (result.cancel) deps.onCancel();
      } catch (error) {
        /* 409/403/404：run 已终态 / 易主 / 不存在——继续跳只会永远撞墙。瞬时错误跳过
           一拍（租约 90s，间隔 30s，抖两拍才进入危险区）。 */
        if (error instanceof ApiError && !error.transient) {
          deps.onLost();
          return;
        }
      }
      if (stopped) return;
      const poked = new Promise<void>((resolve) => {
        resolvePoke = resolve;
      });
      await Promise.race([sleep(deps.intervalMs), poked]);
    }
  })();
  return {
    /** 阶段推进后立即发一拍，进度条不必等满一个心跳间隔。 */
    poke() {
      resolvePoke?.();
    },
    async stop() {
      stopped = true;
      resolvePoke?.();
      await loop;
    },
  };
}

export async function completeWithRetries(
  client: PlatformClient,
  jobId: string,
  runnerId: string,
  payload: { status: CompleteStatus; exit_code?: number; commit_sha: string; error?: string; cases?: ReportCase[] },
  windowMs: number,
): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  let delay = 1_000;
  let current = payload;
  for (;;) {
    try {
      await client.complete(jobId, runnerId, current);
      return true;
    } catch (error) {
      /* 413（载荷超限）先于语义拒绝处理：最常见的成因是部署侧把服务端 bodyLimit 调低
         而 Runner 侧预算没跟上——此时丢掉 cases 重发，终态比 case 明细重要（一条没有
         明细的成功 run 好过一条永远等不到终态、最后被判 aborted 的 run）。只降级一次：
         没有 cases 的请求再撞 413 就是别的问题了。 */
      if (error instanceof ApiError && error.status === 413 && current.cases?.length) {
        current = { ...current, cases: undefined };
        continue;
      }
      /* 4xx 语义拒绝（409 守卫 / 403 易主 / 400 我们的载荷错）：重试无意义。前两者
         服务端已定局；后者重试到天亮也一样，留给租约回收器收尾。 */
      if (error instanceof ApiError && !error.transient) return true;
      if (Date.now() >= deadline) return false;
      await sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  }
}

export type RunJobDeps = {
  client: PlatformClient;
  config: RunnerConfig;
  spec: JobSpec;
  runnerId: string;
  heartbeatIntervalSeconds: number;
};

export async function runJob(deps: RunJobDeps): Promise<void> {
  const { client, config, spec, runnerId } = deps;
  const { jobDir, workspace } = prepareJobDir(config.dataDir, spec.job_id);
  const state = JobState.create(jobDir, { job_id: spec.job_id, runner_id: runnerId, ci_task_id: spec.ci_task_id });
  state.save();

  /* 脱敏面 = 任务 secrets + 仓库凭据（https 的 token / ssh key 的 PEM body 行）：
     凭据虽然不该出现在任何日志里，但万一 git 把它带进错误输出，这里兜底（边界 11 缓解③）。 */
  const masker = new SecretMasker([
    ...(spec.secrets ?? []).map((each) => each.value),
    ...(spec.repo.clone_method === "https_token" ? httpsCredentialMaskValues(spec.repo.credential) : []),
    ...(spec.repo.clone_method === "ssh_key" ? sshKeyMaskValues(spec.repo.credential) : []),
  ]);
  const streamer = new LogStreamer(client, spec.job_id, runnerId, masker, {
    initialOffset: 0,
    onAck: (offset) => state.advanceLogOffset(offset),
  });
  const log = (line: string) => streamer.feed(`[runner] ${line}\n`);

  let currentHandle: ProcHandle | null = null;
  let cancelRequested = false;
  let lostLease = false;

  const heartbeat = startHeartbeat({
    client,
    jobId: spec.job_id,
    runnerId,
    intervalMs: deps.heartbeatIntervalSeconds * 1000,
    getStage: () => state.stage,
    getLogBytes: () => streamer.ackedOffset,
    onCancel: () => {
      if (cancelRequested) return;
      cancelRequested = true;
      log("cancel received via heartbeat; killing the process group");
      currentHandle?.kill("cancel");
    },
    onLost: () => {
      if (lostLease) return;
      lostLease = true;
      log("run is no longer active for this runner (settled or re-claimed); killing the process group");
      currentHandle?.kill("shutdown");
    },
  });

  const spawnFn: SpawnFn = async (opts) => {
    let captured = "";
    const captureCap = 65_536;
    const onOutput = opts.capture
      ? (text: string) => {
          if (captured.length < captureCap) captured += text.slice(0, captureCap - captured.length);
          streamer.feed(text);
        }
      : (text: string) => streamer.feed(text);
    const handle = spawnDetached({
      file: opts.file,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      onOutput,
    });
    currentHandle = handle;
    try {
      const result = await handle.promise;
      return { ...result, captured };
    } finally {
      if (currentHandle === handle) currentHandle = null;
    }
  };

  const timeoutMs = Math.max(1, (Number(spec.timeout_seconds) || 1800)) * 1000;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

  let phaseError: PhaseError | null = null;
  let scriptResult: ProcResult | null = null;
  let reportCases: ReportCase[] = [];
  /* P4.5-13：allure 时解析触到的目录，complete 后整体打 zip 传平台（报告视图的
     原始数据；解析失败/跳过时为空数组——bundle 上传与解析同一条 best-effort 纪律）。 */
  let allureDirs: string[] = [];

  log(
    `job started: run #${spec.run_number}, sandbox ${spec.sandbox.mode}, timeout ${spec.timeout_seconds}s` +
      (spec.case_filter?.case_keys?.length ? `, case filter ${spec.case_filter.case_keys.length} key(s)` : ""),
  );

  try {
    /* 防御分派：claim 的 WHERE 已按 sandbox_mode 过滤，容器任务到不了这里；协议演进
       送来新档位时明确失败，而不是默默当进程档跑。 */
    if (spec.sandbox.mode !== "process") {
      throw new PhaseError("failed", `sandbox mode "${spec.sandbox.mode}" is not supported by this runner (process only; container lands with P4.5-10)`);
    }

    state.setStage("clone");
    heartbeat.poke();
    const commitSha = await cloneRepository({
      spawn: spawnFn,
      jobDir,
      workspace,
      spec,
      log,
      remainingMs: remaining,
      shouldAbort: () => cancelRequested || lostLease,
    });
    state.setCommitSha(commitSha);

    if (!cancelRequested && !lostLease) {
      state.setStage("cache");
      heartbeat.poke();
      await prepareCache({
        dataDir: config.dataDir,
        ciTaskId: spec.ci_task_id,
        repoDir: workspace,
        cache: spec.cache,
        log,
      });
    }

    if (!cancelRequested && !lostLease) {
      state.setStage("script");
      heartbeat.poke();
      const scriptPath = join(jobDir, "script.sh");
      writeFileSync(scriptPath, spec.steps.endsWith("\n") ? spec.steps : `${spec.steps}\n`, { mode: 0o750 });
      chmodSync(scriptPath, 0o750);
      if (remaining() <= 0) throw new PhaseError("timed_out", "job timeout exhausted before the script started");
      scriptResult = await spawnFn({
        file: config.shell,
        args: [scriptPath],
        cwd: workspace,
        env: buildScriptEnv(spec),
        timeoutMs: remaining(),
      });
    }

    /* 报告解析（junit/allure → complete 的 cases[]，P4.5-6）。只有脚本**自然退出**才
       解析：被杀（取消/超时/停机）的会话写不出完整报告——pytest 在会话收尾才落
       junit.xml，半截 XML 解析出来的只会是噪音。脚本失败（退出码非 0）照样解析：
       失败恰恰是报告最有价值的时候。解析本身 best-effort，绝不改变终态。 */
    state.setStage("report");
    heartbeat.poke();
    if (
      spec.report.format !== "none" && !cancelRequested && !lostLease &&
      scriptResult && !scriptResult.spawnError && scriptResult.killedBy === null
    ) {
      reportCases = collectReportCases({ report: spec.report, workspace, masker, log });
      if (spec.report.format === "allure") {
        allureDirs = collectAllureResultDirs({ report: spec.report, workspace, log });
      }
    } else if (spec.report.format !== "none") {
      log("report parsing skipped: the script did not finish with a natural exit (phase failure, cancel, timeout, or shutdown)");
    }
  } catch (error) {
    phaseError = error instanceof PhaseError ? error : new PhaseError("failed", error instanceof Error ? error.message : String(error));
  } finally {
    currentHandle = null;
  }

  let finalStatus: CompleteStatus;
  let exitCode: number | null = null;
  let errorMessage: string | null = null;

  if (lostLease) {
    finalStatus = "aborted";
    errorMessage = "runner lost the lease (run settled server-side)";
  } else if (cancelRequested) {
    finalStatus = "canceled";
  } else if (phaseError) {
    finalStatus = phaseError.status;
    errorMessage = phaseError.message;
  } else if (scriptResult?.spawnError) {
    finalStatus = "failed";
    errorMessage = `could not start the script: ${scriptResult.spawnError}`;
  } else if (scriptResult?.killedBy === "timeout") {
    finalStatus = "timed_out";
  } else if (scriptResult?.killedBy === "shutdown") {
    finalStatus = "aborted";
    errorMessage = "runner shut down before the job finished";
  } else if (scriptResult?.killedBy === "cancel") {
    finalStatus = "canceled";
  } else if (scriptResult && scriptResult.exitCode === 0) {
    finalStatus = "success";
  } else if (scriptResult) {
    finalStatus = "failed";
    errorMessage = scriptResult.exitCode !== null
      ? `script exited with code ${scriptResult.exitCode}`
      : `script terminated by signal ${scriptResult.signal ?? "unknown"}`;
    exitCode = scriptResult.exitCode;
  } else {
    finalStatus = "failed";
    errorMessage = "script never ran";
  }
  if (scriptResult && scriptResult.exitCode !== null && (finalStatus === "success" || finalStatus === "failed")) {
    exitCode = scriptResult.exitCode;
  }

  log(`job finished: ${finalStatus}${errorMessage ? ` (${errorMessage})` : ""}`);

  /* 退出码文件只在自然退出时写（被杀的进程没有退出码），终态先落盘再上报——
     「写完状态、还没报上去」正是恢复路径要盖住的窗口（边界 8）。 */
  if (exitCode !== null && (finalStatus === "success" || finalStatus === "failed")) {
    writeExitCode(jobDir, exitCode);
  }
  /* cases 与终态一起落盘（settle 之前已按 complete 的载荷预算截断过）：complete 重试
     窗口耗尽后重启补报的那条路拿到的就是这份——否则一次「跑成功但没报上去」的 run
     永远缺 case 计数。message 在解析侧已脱敏，这里落盘的不再是明文。 */
  state.settle(finalStatus, exitCode, errorMessage, reportCases);

  await streamer.close();

  const delivered = await completeWithRetries(
    client,
    spec.job_id,
    runnerId,
    {
      status: finalStatus,
      exit_code: exitCode ?? undefined,
      commit_sha: state.commitSha,
      /* error 会进执行详情页，先过一遍脱敏（阶段错误的摘要里可能带 git 输出行）。 */
      error: errorMessage ? masker.maskLine(errorMessage) : undefined,
      cases: reportCases.length ? reportCases : undefined,
    },
    config.completeRetrySeconds * 1000,
  );

  /* 心跳保到 complete 落地为止：重试窗口里租约不能断，断了回收器会把一条其实跑完的
     run 判成 aborted。 */
  await heartbeat.stop();

  /* 产物上传（P4.5-7）在 complete **之后**：终态永远优先，产物是 best-effort 的收尾件
     （平台侧申请接口终态后仍收，两边对这个顺序有共识）。只有 run 正常收尾才传——
     取消/超时/丢租约时 workspace 里的半截产物没有证据价值，传了反而误导。
     allure 报告包（P4.5-13）同窗口同纪律：目录来自解析成功的匹配，解析没跑就没有。 */
  if (delivered && !cancelRequested && !lostLease && finalStatus !== "timed_out") {
    if (spec.artifact_paths?.length) {
      try {
        await uploadArtifacts({
          client, jobId: spec.job_id, runnerId, workspace,
          artifactPaths: spec.artifact_paths, log,
        });
      } catch {
        /* uploader 内部已逐文件降级并记日志；这里兜的是它自己的 bug。 */
      }
    }
    if (allureDirs.length) {
      try {
        await uploadAllureReportBundle({
          client, jobId: spec.job_id, runnerId, workspace,
          resultDirs: allureDirs, log,
        });
      } catch {
        /* reportBundle 内部已降级并记日志；这里兜的是它自己的 bug。 */
      }
    }
  }

  if (delivered) {
    removeJobDir(jobDir);
  } else {
    /* 没报上去：保留 state.json 与 exit_code 等下次启动补报，workspace 立刻删——
       它可能以 GB 计，而补报只需要那两个小文件。 */
    console.error(`[runner] job ${spec.job_id} could not be reported; keeping state for recovery at next startup`);
    try {
      rmSync(join(jobDir, "workspace"), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* 删不掉下次启动还会再删。 */
    }
  }
}
