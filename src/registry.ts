import { ApiError, type PlatformClient } from "./client.js";
import type { RunnerConfig } from "./config.js";
import type { RegisterResult } from "./protocol.js";

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

export async function registerRunner(client: PlatformClient, config: RunnerConfig): Promise<RegisterResult> {
  let delay = 1_000;
  for (;;) {
    try {
      /* sandbox_modes 只报 process：容器档（P4.5-10）落地时在这里加 docker 探测。
         报了不支持的档位，claim 的 WHERE 会把容器任务发给这台跑不了的机器。 */
      const result = await client.register({
        name: config.name,
        labels: config.labels,
        capacity: config.capacity,
        sandboxModes: ["process"],
      });
      console.log(
        `[runner] registered as ${result.runnerId} (heartbeat ${result.heartbeatIntervalSeconds}s, poll ${result.pollTimeoutSeconds}s, labels ${config.labels.join(",")})`,
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
