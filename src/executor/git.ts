import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobSpec } from "../protocol.js";
import { PhaseError, lastMeaningfulLine, sanitizeUrlForLog, type SpawnFn, type SpawnOutcome } from "./errors.js";

/**
 * git 拉取（Spec 2.10.2(d)：准备独立 workspace → clone）。三种 `clone_method`：
 *
 * - `none`：公开仓库，直接 fetch，不带任何凭据机制（平台侧的表达是「任务不引用任何
 *   Git 凭据」，见服务端迁移 041——「不需要凭据」应该是默认状态而不是特例）。
 * - `https_token`：凭据经 **GIT_ASKPASS** 注入。不嵌进 URL（token 会随 `ps` 的 argv 泄露）、
 *   不进 `git remote add`（token 会落进 workspace 的 `.git/config`，存活到任务结束）——
 *   askpass 脚本 0700、放在 job 目录里、finally 删除，与 ssh key 同一条纪律（边界 11）。
 *   凭据含 `:` 时读作 `user:password`（GitLab 的 `oauth2:<token>`），否则整个当用户名
 *   （GitHub PAT 的写法）。
 * - `ssh_key`：deploy key 写成 0600 临时文件（绝不写进 `~/.ssh/`），`GIT_SSH_COMMAND`
 *   指向它，finally 删除。Host key 用 `accept-new` + 一次性 known_hosts：既不盲信
 *   （no），也不要求运维手工预置指纹。
 *
 * 不 `git clone` 而是 init + fetch + checkout：`clone --branch` 不接受 commit sha，
 * 而 fetch 路径对分支 / 标签 / （服务端允许时的）sha 是同一条。
 */
export async function cloneRepository(deps: {
  spawn: SpawnFn;
  jobDir: string;
  workspace: string;
  spec: JobSpec;
  log: (line: string) => void;
  /** job 剩余预算（毫秒）：clone 也吃任务的 timeout_seconds，挂死的 fetch 必须能被杀。 */
  remainingMs: () => number;
  /** 取消/丢租约已发生时，不再起下一条 git 命令（fetch 是长命令，init 与它之间有空窗）。 */
  shouldAbort: () => boolean;
}): Promise<string> {
  const { spawn, jobDir, workspace, spec, log } = deps;
  const { clone_url, clone_method, credential } = spec.repo;

  if (!clone_url.trim()) {
    throw new PhaseError("failed", "repository has no clone_url configured; set the task's git URL first");
  }

  /* 所有 git 子命令共有的环境：绝不弹终端提示——凭据不对就快点失败，别挂到超时。 */
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  const cleanupFiles: string[] = [];

  try {
    if (clone_method === "https_token") {
      if (!credential) throw new PhaseError("failed", "clone_method is https_token but the job spec carried no credential");
      const separator = credential.indexOf(":");
      const user = separator >= 0 ? credential.slice(0, separator) : credential;
      const password = separator >= 0 ? credential.slice(separator + 1) : "";
      const askpass = join(jobDir, "git-askpass.sh");
      writeFileSync(
        askpass,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  *sername*) printf \'%s\\n\' "$APITRACK_GIT_USER" ;;',
          '  *) printf \'%s\\n\' "$APITRACK_GIT_PASS" ;;',
          "esac",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(askpass, 0o700);
      cleanupFiles.push(askpass);
      env.GIT_ASKPASS = askpass;
      env.APITRACK_GIT_USER = user;
      env.APITRACK_GIT_PASS = password;
    }

    if (clone_method === "ssh_key") {
      if (!credential) throw new PhaseError("failed", "clone_method is ssh_key but the job spec carried no credential");
      const keyFile = join(jobDir, "deploy_key");
      const knownHosts = join(jobDir, "known_hosts");
      writeFileSync(keyFile, credential.endsWith("\n") ? credential : `${credential}\n`, { mode: 0o600 });
      /* writeFileSync 的 mode 会被 umask 收紧，显式 chmod 才能保证就是 0600。 */
      chmodSync(keyFile, 0o600);
      cleanupFiles.push(keyFile, knownHosts);
      env.GIT_SSH_COMMAND = [
        "ssh",
        `-i ${JSON.stringify(keyFile)}`,
        "-o IdentitiesOnly=yes",
        "-o StrictHostKeyChecking=accept-new",
        `-o UserKnownHostsFile=${JSON.stringify(knownHosts)}`,
      ].join(" ");
    }

    const ref = spec.git_ref.trim();
    log(`cloning ${sanitizeUrlForLog(clone_url)}${ref ? ` (ref ${ref})` : ""} via ${clone_method}`);

    const step = (args: string[], label: string) => {
      if (deps.shouldAbort()) throw new PhaseError("canceled", "clone skipped: the job was already canceled");
      return gitStep(spawn, env, workspace, args, label, Math.max(1, deps.remainingMs()));
    };

    await step(["init", "-q"], "init");
    const fetchArgs = ["fetch", "--depth", "1", clone_url];
    if (ref) fetchArgs.push(ref);
    await step(fetchArgs, "fetch");
    await step(["checkout", "--detach", "FETCH_HEAD"], "checkout");

    const sha = (await step(["rev-parse", "HEAD"], "rev-parse")).captured.trim();
    if (!sha) throw new PhaseError("failed", "git rev-parse returned an empty commit sha");
    log(`checked out ${sha}`);
    return sha;
  } finally {
    for (const file of cleanupFiles) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* 删不掉也随 job 目录一起消失；这里尽力而为。 */
      }
    }
  }
}

async function gitStep(
  spawn: SpawnFn,
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
  label: string,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  const result = await spawn({ file: "git", args, cwd, env, capture: true, timeoutMs });
  if (result.spawnError) {
    throw new PhaseError("failed", `git could not be executed: ${result.spawnError}`);
  }
  if (result.exitCode === 0) return result;
  throw phaseErrorFrom(result, `git ${label} failed (exit ${result.exitCode ?? "signal " + result.signal})`, lastMeaningfulLine(result.captured));
}

function phaseErrorFrom(result: { killedBy: "cancel" | "timeout" | "shutdown" | null }, fallback: string, detail: string): PhaseError {
  if (result.killedBy === "cancel") return new PhaseError("canceled", "clone was interrupted by cancel");
  if (result.killedBy === "timeout") return new PhaseError("timed_out", "clone exceeded the job timeout");
  if (result.killedBy === "shutdown") return new PhaseError("aborted", "runner shut down during clone");
  return new PhaseError("failed", detail ? `${fallback}: ${detail}` : fallback);
}
