import type { CompleteStatus } from "../protocol.js";
import type { ProcResult } from "./process.js";

/** 阶段失败：git clone 挂了不是「脚本失败」，终态与错误信息由这里给出。 */
export class PhaseError extends Error {
  constructor(readonly status: CompleteStatus, message: string) {
    super(message);
    this.name = "PhaseError";
  }
}

/** executor 提供的统一 spawn 入口：串接 streamer、登记当前进程（取消/停机要能杀到它）。 */
export type SpawnOpts = {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 收集 stdout+stderr（git 子命令的输出量小，收下来给错误信息用）。 */
  capture?: boolean;
  /** 本进程允许的最长存活时间（毫秒）；缺省表示交给调用方自己杀。 */
  timeoutMs?: number;
};

export type SpawnOutcome = ProcResult & { captured: string };

export type SpawnFn = (opts: SpawnOpts) => Promise<SpawnOutcome>;

/** 错误信息里只带输出的最后一个非空行：整段输出已经在 job 日志里，error 是摘要不是副本。 */
export function lastMeaningfulLine(captured: string): string {
  const lines = captured.split(/\r?\n/).map((each) => each.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** 给日志看的 URL：剥掉可能内嵌的 userinfo（clone_url 正常不含凭据，这里是防御）。 */
export function sanitizeUrlForLog(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
