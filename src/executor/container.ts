import type { RunnerConfig } from "../config.js";
import { ApiContainerRuntime } from "./container/api.js";
import { CliContainerRuntime } from "./container/cli.js";
import type { ContainerRuntime } from "./container/runtime.js";

/**
 * 容器档的装配点（8.5，P4.5-10 / P4.5-10b）。
 *
 * 结构：
 * - `container/runtime.ts` —— 通道无关的 `ContainerSpec` / `ContainerRuntime` 契约 + 共用件；
 * - `container/cli.ts` —— `docker run`（默认通道）；
 * - `container/api.ts` —— Engine API over unix socket；
 * - `container/network.ts` —— job 专属网络 + DOCKER-USER deny 规则（iptables 两条通道共用）。
 *
 * 这个文件只做转发与选择，不含逻辑：`executor.ts` 依赖的是接口，不是通道。
 */

export {
  WORKSPACE_CONTAINER_PATH, runningInsideContainer, validateLimits,
  type ContainerLimits, type ContainerRunResult, type ContainerRuntime, type ContainerSpec,
  type ContainerTransport, type DockerProbe,
} from "./container/runtime.js";
export { ContainerNetwork } from "./container/network.js";
export { buildDockerRunArgs } from "./container/cli.js";
export { buildCreateBody } from "./container/api.js";

/**
 * 按配置选通道。`APITRACK_RUNNER_DOCKER=off` 的判断留在 `registry.ts`（那是「要不要
 * 自报 container」的决定，不是「怎么连 daemon」的决定），这里只在被调用时给出实例。
 */
export function createContainerRuntime(config: RunnerConfig): ContainerRuntime {
  if (config.dockerTransport === "api") return new ApiContainerRuntime(config.dockerSocket);
  return new CliContainerRuntime(config.dockerCommand);
}
