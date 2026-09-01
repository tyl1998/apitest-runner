import { ApiError, type PlatformClient } from "./client.js";
import type { RunnerConfig } from "./config.js";
import type { JobSpec } from "./protocol.js";
import { runJob } from "./executor.js";
import { FatalError } from "./registry.js";

/**
 * 领取循环（8.2 接口 2 的消费侧）：有空槽就长轮询，领到就异步跑，跑完释放槽位。
 *
 * `capacity_available` 报的是**领这一刻**的空槽数：报多了服务端也只发一个 job
 * （认领是单行 UPDATE），但报 0 会让服务端立刻 204 而不占连接——满载时这是礼貌，
 * 不是能力声明。
 *
 * 403 是 draining（迁移 036）：这台机器被运维标记下线，不再领新活，在跑的跑完。
 * 204 之后歇 1 秒再轮：长轮询本身已经等了 25 秒，这一秒只是防止「服务端瞬时报错」
 * 变成热循环。
 */

export type ClaimLoopResult = {
  reason: "stopped" | "draining";
  /** 所有已启动 job 的完成 promise（含已经落地的与还在跑的）。 */
  jobs: Array<Promise<void>>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runClaimLoop(deps: {
  client: PlatformClient;
  config: RunnerConfig;
  runnerId: string;
  heartbeatIntervalSeconds: number;
  /** 优雅停机：abort 会打断在途的长轮询。 */
  stopSignal: AbortSignal;
}): Promise<ClaimLoopResult> {
  const jobs: Array<Promise<void>> = [];
  let running = 0;

  /* 单槽通知：flag 吸收「没人在等时的释放」，resolver 唤醒在等的循环——计数以
     `running` 为准，通知只负责「再看一眼」。 */
  let slotFlag = false;
  let slotResolver: (() => void) | undefined;
  const notifySlot = () => {
    if (slotResolver) {
      const resolve = slotResolver;
      slotResolver = undefined;
      resolve();
    } else {
      slotFlag = true;
    }
  };
  const waitForSlot = (): Promise<void> => {
    if (slotFlag) {
      slotFlag = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      slotResolver = resolve;
    });
  };

  while (!deps.stopSignal.aborted) {
    if (running >= deps.config.capacity) {
      await waitForSlot();
      continue;
    }
    let spec: JobSpec | null = null;
    try {
      spec = await deps.client.claim(deps.runnerId, deps.config.capacity - running, deps.stopSignal);
    } catch (error) {
      if (deps.stopSignal.aborted) break;
      if (error instanceof ApiError && error.status === 401) {
        throw new FatalError(`claim rejected: ${error.message} (token revoked?)`);
      }
      if (error instanceof ApiError && error.status === 403) {
        console.log("[runner] draining: this runner was asked to stop claiming; finishing in-flight jobs");
        return { reason: "draining", jobs };
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[runner] claim failed: ${message}; retrying`);
      await sleep(1_000);
      continue;
    }
    if (!spec) {
      await sleep(1_000);
      continue;
    }

    console.log(`[runner] claimed job ${spec.job_id} (run #${spec.run_number}, task ${spec.ci_task_id})`);
    running += 1;
    const task = runJob({
      client: deps.client,
      config: deps.config,
      spec,
      runnerId: deps.runnerId,
      heartbeatIntervalSeconds: deps.heartbeatIntervalSeconds,
    })
      .catch((error: unknown) => {
        console.error(`[runner] job ${spec.job_id} crashed the runner-side orchestration: ${error instanceof Error ? error.stack : error}`);
      })
      .finally(() => {
        running -= 1;
        notifySlot();
      });
    jobs.push(task);
  }
  return { reason: "stopped", jobs };
}
