import { ApiError, type PlatformClient } from "./client.js";
import type { RunnerConfig } from "./config.js";
import type { RegisterResult } from "./protocol.js";
import { createContainerRuntime, runningInsideContainer, type DockerProbe } from "./executor/container.js";

/**
 * register（8.2 接口 1）。幂等于 (token, name)——服务端靠它让重启的 Runner 拿回同一个
 * `runner_id`，所以这里只管「重试到成功」，不存在「重复注册」这回事。
 *
 * 400（协议版本被拒，验收门槛 16）与 401（Token 被吊销）是**配置问题**：重试到天亮
 * 也一样，直接致命退出，把服务端给的可读原因打给运维。
 */

export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `sandbox_modes` 自报（批次表 P4.5-10 的核心一行）：进程档恒可用；container 只在
 * docker 探测通过时加进来。报了跑不了的档位，claim 的 WHERE 会把容器任务发给这台
 * 机器、然后在 script 阶段失败——「触发时 2004 拒绝」的可满足性检查（边界 3 的
 * 同构物）就瞎了。
 *
 * 探测走的是**配置选定的那条通道**（cli 或 api）：探测 cli 通、实际跑 api 不通，
 * 等于自报了一个跑不了的档位。
 *
 * 探测的三个否决项，每个都要说清而不是静默降级：
 * - `APITRACK_RUNNER_DOCKER=off`：部署者显式关（这台机器只跑进程档任务）；
 * - CLI/socket/daemon 不可用：原因打进日志，运维看得见为什么没自报；
 * - docker-in-docker（8.5）：Runner 自己在容器里时，挂 docker.sock 的「隔离」是假的
 *   （兄弟容器共享宿主），不上报 container。`APITRACK_RUNNER_ALLOW_DIND=yes` 显式
 *   豁免——部署者声明「我知道这台的隔离语义」。
 *
 * **api 通道不放宽 DinD 这一条**：能通过 socket 说话不代表隔离成立，恰恰相反——
 * 容器里能摸到 socket 通常就是因为宿主把 socket 挂进来了，那时候起的容器是 Runner
 * 的兄弟而不是它的子级（`DEVELOPMENT_PLAN.md` 8.5）。通道是「怎么连 daemon」，
 * DinD 是「隔离是否成立」，两件事不能互相抵消。
 */
export async function resolveSandboxModes(config: RunnerConfig): Promise<{ modes: string[]; probe: DockerProbe | null }> {
  if (config.dockerCommand.toLowerCase() === "off") {
    console.log("[runner] container mode disabled by APITRACK_RUNNER_DOCKER=off");
    return { modes: ["process"], probe: null };
  }
  const probe = await createContainerRuntime(config).probe();
  if (!probe.available) {
    console.warn(`[runner] container mode unavailable via ${probe.transport} transport (${probe.reason}); registering with process only`);
    return { modes: ["process"], probe };
  }
  if (runningInsideContainer() && !process.env.APITRACK_RUNNER_ALLOW_DIND) {
    console.warn(
      "[runner] docker is reachable but this runner appears to run inside a container (docker-in-docker); " +
        "containers would be siblings of the runner, not isolated. Not reporting container mode. " +
        "Set APITRACK_RUNNER_ALLOW_DIND=yes to override if you know what this means.",
    );
    return { modes: ["process"], probe };
  }
  console.log(
    `[runner] container mode available via ${probe.transport} transport (docker server ${probe.version}); registering with process+container`,
  );
  return { modes: ["process", "container"], probe };
}

export async function registerRunner(client: PlatformClient, config: RunnerConfig): Promise<RegisterResult> {
  const { modes } = await resolveSandboxModes(config);
  let delay = 1_000;
  for (;;) {
    try {
      const result = await client.register({
        name: config.name,
        labels: config.labels,
        capacity: config.capacity,
        sandboxModes: modes,
        /* 通道自报只在容器档可用时才有意义（docker=off 或探测失败时那格配置不产生
           行为，面板上显示出来只会误导运维）。 */
        ...(modes.includes("container") ? { dockerTransport: config.dockerTransport } : {}),
      });
      console.log(
        `[runner] registered as ${result.runnerId} (heartbeat ${result.heartbeatIntervalSeconds}s, poll ${result.pollTimeoutSeconds}s, labels ${config.labels.join(",")}, sandbox ${modes.join("+")})`,
      );
      return result;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 400 || error.status === 401)) {
        throw new FatalError(`register rejected (${error.status}): ${error.message}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[runner] register failed: ${message}; retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      delay = Math.min(delay * 2, 60_000);
    }
  }
}
