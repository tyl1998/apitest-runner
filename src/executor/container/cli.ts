import { spawn, spawnSync } from "node:child_process";
import {
  KILL_GRACE_MS, STORAGE_OPT_REJECT, runShort, shortFailureDetail,
  type ContainerRunOpts, type ContainerRunResult, type ContainerRuntime, type ContainerSpec,
  type DockerProbe, type NetworkOutcome,
} from "./runtime.js";
import { registerInflightKill, unregisterInflightKill, type KillReason } from "../process.js";

/**
 * 容器档的 **cli 通道**（默认）：`docker run --rm` + 资源限额 + 独立网络 + 缓存卷直挂。
 *
 * 为什么它是默认：Runner 一次 job 只起一个容器、跑几分钟，fork 一个 CLI 进程的开销
 * 是零；而 CLI 帮我们排好了 create → attach → start 的时序、分好了 stdout/stderr
 * 两路流、把限额单位换算与存储驱动差异翻译成人能看懂的报错。日志里那一行完整的
 * `docker run …` 是自托管软件的运维资产：用户复制粘贴就能复现。
 *
 * 它换不到的一格是 `oomKilled`：`--rm` 的容器退出即被回收，没有 inspect 窗口
 * （见 runtime.ts 的 `ContainerRunResult`）。要那一格就用 api 通道。
 */

export class CliContainerRuntime implements ContainerRuntime {
  readonly transport = "cli" as const;

  constructor(private readonly command: string) {}

  /**
   * `--storage-opt size=` 只在特定存储驱动上成立（overlay2 需要 xfs backing + pquota；
   * Docker Desktop / 大多数自建 daemon 都不满足），不支持时 daemon 直接拒绝、CLI 退 125。
   * 首次撞上后记住「这台 daemon 不吃 size」，之后的 job 不再带上它——磁盘限额退化为
   * 无上限，CPU / 内存限额不受影响。按**进程内缓存**而不是启动探测：探测要真起一个
   * 容器才有结论，为它付一次拉镜像不值得。
   */
  private storageOptUnsupported = false;

  /**
   * `docker version --format {{.Server.Version}}` 只认 Server 段——CLI 存在但 daemon
   * 没起时 Client 段有版本、Server 段取不到，注册 `container` 会领到跑不了的任务。
   */
  async probe(): Promise<DockerProbe> {
    const probe = spawnSync(this.command, ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (probe.error) {
      return { available: false, version: "", reason: `docker CLI not usable: ${probe.error.message}`, transport: this.transport };
    }
    if (probe.status !== 0) {
      const detail = `${probe.stderr ?? ""}`.trim().split(/\r?\n/).filter(Boolean).pop() ?? `exit ${probe.status}`;
      return { available: false, version: "", reason: `docker daemon not reachable: ${detail}`, transport: this.transport };
    }
    const version = `${probe.stdout ?? ""}`.trim();
    if (!version) {
      return { available: false, version: "", reason: "docker version returned an empty server version", transport: this.transport };
    }
    return { available: true, version, reason: "", transport: this.transport };
  }

  async createNetwork(name: string): Promise<NetworkOutcome> {
    const created = await runShort(this.command, ["network", "create", name]);
    if (created.status === 0) return { ok: true, detail: "" };
    return { ok: false, detail: shortFailureDetail(created) };
  }

  async networkId(name: string): Promise<string> {
    const inspect = await runShort(this.command, ["network", "inspect", name, "--format", "{{.Id}}"]);
    return inspect.status === 0 ? inspect.stdout.trim() : "";
  }

  async removeNetwork(name: string): Promise<NetworkOutcome> {
    const removed = await runShort(this.command, ["network", "rm", name]);
    if (removed.status === 0) return { ok: true, detail: "" };
    return { ok: false, detail: shortFailureDetail(removed) };
  }

  /**
   * 跑用户脚本。`docker run` 的退出码就是容器主进程退出码（0–255 映射），被我们主动
   * 杀的（docker stop/kill）读 killedBy。
   *
   * 杀梯子：`docker stop -t 5`（SIGTERM → 5s → daemon 自己 SIGKILL，容器内 PID1 与
   * `&` 起的后台进程一锅端）；escalator 兜底 `docker kill`（SIGKILL 直杀），防 stop
   * 卡在 daemon 上。docker CLI 自身收到 SIGTERM 会把信号转给容器（--sig-proxy 默认开），
   * 但那依赖 CLI 进程树还活着——所以 kill 永远直呼容器名，不依赖信号转发。
   *
   * escalator 是**重复的**（每 10s 一发 `docker kill`，run 结束才停）：取消可能落在
   * 镜像拉取窗口里，那时容器还没创建，第一轮 stop/kill 都会扑空（`No such container`）
   * ——单发 escalator 同样扑空的话，这次取消就永远没人执行，容器起跑后一路跑到底。
   * 对已死容器多发 kill 只是无害报错。
   *
   * 退出码 125 是「docker run 自己失败」而不是脚本失败；其中 daemon 拒绝
   * `--storage-opt size=`（见 storageOptUnsupported）是最常见的版本兼容问题，
   * 去掉该旗标重试一次，而不是把一次起不来的容器报成「脚本退出 125」。
   */
  async run(opts: ContainerRunOpts): Promise<ContainerRunResult> {
    if (this.storageOptUnsupported) return (await this.runOnce(opts, false)).result;
    const first = await this.runOnce(opts, true);
    if (first.result.exitCode === 125 && STORAGE_OPT_REJECT.test(first.stderrTail)) {
      this.storageOptUnsupported = true;
      opts.onOutput(
        `[runner] this docker daemon rejected --storage-opt (${first.stderrTail}); ` +
        "retrying without the disk-size limit\n",
      );
      return (await this.runOnce(opts, false)).result;
    }
    return first.result;
  }

  /** 单次 `docker run`，带回 stderr 尾巴供重试判定（125 的原因在 stderr，不在退出码）。 */
  private async runOnce(opts: ContainerRunOpts, storageOpt: boolean): Promise<{ result: ContainerRunResult; stderrTail: string }> {
    const args = buildDockerRunArgs(opts.spec, { storageOpt });
    const containerName = opts.spec.name;
    let killedBy: KillReason | null = null;
    let settled = false;
    let escalator: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let stderrTail = "";

    const kill = (reason: KillReason): void => {
      if (settled) return;
      killedBy = reason;
      void runShort(this.command, ["stop", "-t", String(opts.spec.stopTimeoutSeconds), containerName], 60_000).then(() => {
        if (settled) return;
        void runShort(this.command, ["kill", containerName], 60_000);
      });
      /* 重复而不是单发：容器可能还没创建（镜像拉取窗口），见 run 的注释。
         已在杀就不再重复起 interval——kill 可能被取消与超时先后各调一次，
         只留一个可被 finish 清掉的句柄。 */
      if (escalator) return;
      escalator = setInterval(() => {
        void runShort(this.command, ["kill", containerName], 60_000);
      }, KILL_GRACE_MS * 2);
    };

    return await new Promise<{ result: ContainerRunResult; stderrTail: string }>((resolve) => {
      const finish = (result: ContainerRunResult) => {
        if (settled) return;
        settled = true;
        if (escalator) clearInterval(escalator);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        unregisterInflightKill(kill);
        resolve({ result, stderrTail });
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.command, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        finish({
          exitCode: null, signal: null, killedBy: null, oomKilled: null,
          spawnError: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      registerInflightKill(kill);
      /* 杀梯子交给 executor：取消 / 丢租约由此直达容器（timeoutTimer 走的是同一个 kill）。 */
      opts.onReady?.(kill);
      timeoutTimer = setTimeout(() => kill("timeout"), Math.max(1, opts.timeoutMs));

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => opts.onOutput(chunk));
      child.stderr?.on("data", (chunk: string) => {
        opts.onOutput(chunk);
        /* 只留最后一屏：重试判定要的是 daemon 的拒绝理由（最后一行），不是整段输出。 */
        stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
      });
      child.on("error", (error) => {
        finish({ exitCode: null, signal: null, killedBy, oomKilled: null, spawnError: error.message });
      });
      child.on("close", (code, signal) => {
        /* oomKilled 恒为 null：--rm 的容器已被回收，没有 inspect 窗口（runtime.ts）。 */
        finish({ exitCode: code, signal: signal ?? null, killedBy, oomKilled: null, spawnError: null });
      });
    });
  }
}

/** daemon 拒绝 `--storage-opt size=` 的判定特征见 runtime.ts 的 `STORAGE_OPT_REJECT`。 */

/**
 * 组装 `docker run` 参数（纯函数）。挂载与 env 的次序是确定的——同一次 job 重放时
 * argv 完全一致，便于对日志排查。**只有 cli 通道消费它**：api 通道从同一个
 * `ContainerSpec` 直接生成 HostConfig，不反解这串字符串。
 *
 * `storageOpt: false` 省掉 `--storage-opt size=`（该 daemon 不支持时，见
 * `CliContainerRuntime.run`）；其余限额照常。
 */
export function buildDockerRunArgs(spec: ContainerSpec, opts?: { storageOpt?: boolean }): string[] {
  const args = [
    "run", "--rm",
    "--name", spec.name,
    "--network", spec.network,
    "--cpus", spec.limits.cpu,
    "--memory", spec.limits.memory,
  ];
  if (opts?.storageOpt !== false) args.push("--storage-opt", `size=${spec.limits.disk}`);
  args.push(
    "--stop-timeout", String(spec.stopTimeoutSeconds),
    "--workdir", spec.workdir,
  );
  for (const bind of spec.binds) {
    /* 只读挂载（脚本文件）：脚本由平台下发（steps 原文），用户脚本改它没有意义，
       只读还挡掉「脚本把自己 chmod 成 setuid」这类花招。 */
    args.push("--volume", `${bind.host}:${bind.container}${bind.readOnly ? ":ro" : ""}`);
  }
  for (const extraHost of spec.extraHosts) {
    args.push("--add-host", extraHost);
  }
  for (const [key, value] of Object.entries(spec.env)) {
    if (!key || key.includes("=")) continue;
    args.push("--env", `${key}=${value}`);
  }
  args.push("--entrypoint", spec.entrypoint, spec.image, ...spec.command);
  return args;
}
