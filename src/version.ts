/**
 * Runner 自身版本（register 时上报，`runners.version` 列）。
 *
 * 与 package.json 的 version 手工同步：rootDir=src 挡住了 import package.json
 * （TS6059），为一个数字引 resolveJsonModule + 放宽 rootDir 不值。
 */
export const RUNNER_VERSION = "0.1.0";
