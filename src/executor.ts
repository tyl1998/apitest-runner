import { chmodSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
import { spawnDetached, type KillReason, type ProcHandle, type ProcResult } from "./executor/process.js";
import { prepareJobDir, removeJobDir } from "./executor/workspace.js";
import {
  ContainerNetwork, WORKSPACE_CONTAINER_PATH, createContainerRuntime, validateLimits,
  type ContainerSpec,
} from "./executor/container.js";

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

/* ── 容器档挂载常量与辅助 ──────────────────────────────────────────────────── */

/** script.sh 挂在 job 目录（workspace 的兄弟），容器内路径固定 `/script.sh`：
    不放进 workspace——脚本本体不是脚本的产物，混在一起会污染「报告/产物按 workspace
    相对路径收集」的约定。宿主侧挂整个 job 目录会把 state.json / exit_code 也带进
    容器（文件系统隔离的目标正是这些），所以 script 单独一条只读挂载。 */
const SCRIPT_CONTAINER_PATH = "/script.sh";

function containerNameOf(jobId: string): string {
  return `apitrack-job-${jobId.slice(0, 8)}`;
}

/**
 * 缓存卷直挂（8.5 容器档的「缓存」行）：进程档软链指向的同一个缓存目录
 * （`<data>/cache/<ci_task_id>/<key>/<path 打平>`），容器档以挂卷达到同一效果——
 * 脚本往容器内路径写的一切天然落缓存。挂点与 workspace 里的相对路径一致，
 * `pytest` 之类工具对 CWD 相对路径的假设才不破。
 *
 * key 不在这里重算——从 prepareCache 挂完软链的**宿主** workspace 里读软链反解
 * 宿主目录与相对路径：两档的缓存身份由此钉死在同一段代码（prepareCache）上。 */
function containerCacheMounts(
  config: RunnerConfig,
  spec: JobSpec,
  workspace: string,
  log: (line: string) => void,
): Array<{ host: string; container: string }> {
  if (!config.containerCacheEnabled) return [];
  if (!spec.cache.key_files.length || !spec.cache.paths.length) return [];
  const mounts: Array<{ host: string; container: string }> = [];
  for (const raw of spec.cache.paths) {
    const relative = raw.trim();
    if (!relative || isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) continue;
    try {
      const linkTarget = readlinkSync(join(workspace, relative));
      /* 软链目标即宿主缓存目录（prepareCache 写的绝对路径）。挂点 = 容器内 workspace
         挂点 + 同一相对路径——脚本看不见这个差异，这就是挂卷版「写入即回写」。 */
      mounts.push({ host: linkTarget, container: join(WORKSPACE_CONTAINER_PATH, relative) });
    } catch {
      /* prepareCache 跳过了这一条（仓库里已有同路径内容等），不挂——容器内看到的
         就是仓库版本，与进程档语义一致。 */
    }
  }
  if (mounts.length) log(`container cache: ${mounts.length} volume mount(s)`);
  return mounts;
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

  /* 脱敏面 = clone 凭据（https 的 token / ssh key 的 PEM body 行）+ JobSpec 里的 secrets。
     凭据虽然不该出现在任何日志里，但万一 git 把它带进错误输出，这里兜底（边界 11 缓解③）。
     **`spec.secrets` 自平台侧 P4.5-14 起恒为空**：任务级 secret 被删掉了，敏感值写进
     `env` 就会原样进日志。这条 spread 保留是因为协议字段仍在（第三方 Runner 实现、
     未来若恢复任务级 secret 都不需要动这里）。 */
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
  /* 容器档脚本的杀梯子，由通道的 onReady 交接（见下）：脚本阶段容器不走 spawnFn，
     `currentHandle` 是 null——没有这一格，心跳送到的取消在容器档上是空操作，
     容器会一路跑到自然退出才落 canceled。 */
  let containerKill: ((reason: KillReason) => void) | null = null;
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
      log("cancel received via heartbeat; killing the running script");
      currentHandle?.kill("cancel");
      containerKill?.("cancel");
    },
    onLost: () => {
      if (lostLease) return;
      lostLease = true;
      log("run is no longer active for this runner (settled or re-claimed); killing the running script");
      currentHandle?.kill("shutdown");
      containerKill?.("shutdown");
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

  /* 容器档的收尾件（job 专属网络 + deny 规则），clone 后建、finally 里拆——与
     workspace 同生命周期；建晚了（script 才建）会多一个「job 已取消」的分支。 */
  let containerNet: ContainerNetwork | null = null;
  /* 通道（cli / api）由配置决定，job 内不变；网络增删与 run 走同一个实例。 */
  const containerRuntime = createContainerRuntime(config);

  let phaseError: PhaseError | null = null;
  /* 容器档多带一格 `oomKilled`（api 通道有确定答案，cli 通道恒 null=未知）；
     进程档不产出这一格，所以是可选属性而不是必填。 */
  let scriptResult: (ProcResult & { oomKilled?: boolean | null }) | null = null;
  let reportCases: ReportCase[] = [];
  /* P4.5-13：allure 时解析触到的目录，complete 后整体打 zip 传平台（报告视图的
     原始数据；解析失败/跳过时为空数组——bundle 上传与解析同一条 best-effort 纪律）。 */
  let allureDirs: string[] = [];

  log(
    `job started: run #${spec.run_number}, sandbox ${spec.sandbox.mode}, timeout ${spec.timeout_seconds}s` +
      (spec.case_filter?.case_keys?.length ? `, case filter ${spec.case_filter.case_keys.length} key(s)` : ""),
  );

  try {
    /* 防御分派：claim 的 WHERE 已按 sandbox_mode 过滤，不该出现的档位明确失败，而不是
       默默当进程档跑。 */
    if (spec.sandbox.mode !== "process" && spec.sandbox.mode !== "container") {
      throw new PhaseError("failed", `sandbox mode "${spec.sandbox.mode}" is not supported by this runner`);
    }
    const containerMode = spec.sandbox.mode === "container";
    const limits = containerMode ? validateLimits(spec.sandbox) : null;

    state.setStage("clone");
    heartbeat.poke();
    /* clone 永远在宿主上跑（Runner 的职责，沙箱要关的是用户脚本）：与进程档同一条
       spawnFn 路径——git 二进制、凭据临时件、预算检查全都不因沙箱档位而分叉。 */
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

    /* 容器档的网络在 clone 之后建：job 专属 bridge + deny 规则——脚本还没起，规则就位
       的时间窗里没东西可拦，这是正确的次序而不是巧合。 */
    if (containerMode && !cancelRequested && !lostLease) {
      containerNet = await ContainerNetwork.create({
        runtime: containerRuntime,
        jobId: spec.job_id,
        denyCidrs: spec.sandbox.network?.deny_cidrs ?? [],
        log,
      });
    }

    if (!cancelRequested && !lostLease) {
      state.setStage("cache");
      heartbeat.poke();
      /* 进程档：软链进 workspace（脚本写入即回写缓存）。容器档：目录准备逻辑同一份
         （key 计算、命中判定），挂卷发生在 script 起 docker 时——软链在容器内不成立，
         它指向宿主路径。 */
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

      if (containerMode) {
        if (!spec.sandbox.image.trim()) {
          throw new PhaseError("failed", "container sandbox requires an image; configure it on the CI task first");
        }
        const containerSpec: ContainerSpec = {
          name: containerNameOf(spec.job_id),
          network: containerNet!.name,
          image: spec.sandbox.image,
          entrypoint: config.imageShell,
          command: [SCRIPT_CONTAINER_PATH],
          workdir: WORKSPACE_CONTAINER_PATH,
          binds: [
            { host: workspace, container: WORKSPACE_CONTAINER_PATH },
            { host: scriptPath, container: SCRIPT_CONTAINER_PATH, readOnly: true },
            ...containerCacheMounts(config, spec, workspace, log),
          ],
          /* buildScriptEnv 产出 NodeJS.ProcessEnv（值可 undefined），两条通道的 env
             都不接受空值条目——这里收窄成纯 Record，undefined 的键本来就不会被写进去。 */
          env: buildScriptEnv(spec) as Record<string, string>,
          limits: limits!,
          stopTimeoutSeconds: 5,
        };
        log(`container transport ${containerRuntime.transport}, image ${spec.sandbox.image}`);
        scriptResult = await containerRuntime.run({
          spec: containerSpec,
          onOutput: (text) => streamer.feed(text),
          timeoutMs: remaining(),
          onReady: (kill) => {
            /* 交接发生在容器就位时，而取消可能先到（镜像拉取、storage-opt 重试窗口、
               cli 通道的 runOnce 重入）：到手即补杀，否则那次取消就停在「已请求、
               没人执行」，容器起跑后一路跑到底。 */
            containerKill = kill;
            if (cancelRequested) kill("cancel");
            else if (lostLease) kill("shutdown");
          },
        });
        containerKill = null;
      } else {
        scriptResult = await spawnFn({
          file: config.shell,
          args: [scriptPath],
          cwd: workspace,
          env: buildScriptEnv(spec),
          timeoutMs: remaining(),
        });
      }
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
    containerKill = null;
    /* 容器档收尾件：deny 规则摘除 + 网络删除。发生在终态判定**之前**——回收慢不占
       心跳（心跳还活着），但也不能拖到 complete 之后（那边有重试窗口，网络删不掉
       会一直挂着）。失败只记日志：空网络不碍事，残留规则可手工摘。 */
    if (containerNet) {
      const net = containerNet;
      containerNet = null;
      await net.cleanup({ runtime: containerRuntime, log }).catch(() => {});
    }
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
    /* 容器档的内存超限：退出码 137 与「被别的东西 SIGKILL 了」在退出码上不可区分，
       归因必须来自 daemon。api 通道读 `.State.OOMKilled` 得到确定答案；cli 通道
       （`--rm`，无 inspect 窗口）只能给 null，那时候只提示可能性，不断言——把未知
       说成 OOM 会让用户去调一个没问题的内存限额。 */
    if (scriptResult.oomKilled === true) {
      errorMessage = `script was killed by the kernel OOM killer: the container exceeded its memory limit (${spec.sandbox.memory_limit})`;
    } else if (scriptResult.oomKilled === null && scriptResult.exitCode === 137) {
      errorMessage += "; exit code 137 means SIGKILL, which is usually the memory limit " +
        `(${spec.sandbox.memory_limit}) — set APITRACK_RUNNER_DOCKER_TRANSPORT=api on this runner to get a definitive OOM verdict`;
    }
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
