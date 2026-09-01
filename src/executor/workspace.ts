import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * 一次性 workspace（8.5 进程档）：`<data>/jobs/<job_id>/workspace`，任务结束即清理。
 *
 * job_id 是路径的一部分，必须是服务端发来的 UUID——不是防注入的仪式，是真的攻击面：
 * JobSpec 来自网络，一份带 `../../` 的 job_id 能把 workspace 写到数据目录之外。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertJobId(jobId: string): void {
  if (!UUID_PATTERN.test(jobId)) {
    throw new Error(`job_id ${JSON.stringify(jobId)} is not a uuid; refusing to touch the filesystem`);
  }
}

/** ci_task_id 同样拼进缓存路径（executor/cache.ts），过同一道校验。 */
export function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${field} ${JSON.stringify(value)} is not a uuid`);
  }
}

export function prepareJobDir(dataDir: string, jobId: string): { jobDir: string; workspace: string } {
  assertJobId(jobId);
  const jobDir = join(dataDir, "jobs", jobId);
  const workspace = join(jobDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { jobDir, workspace };
}

/**
 * 清理 job 目录。`maxRetries`：Windows 上文件被占用会 EBUSY，POSIX 上基本无感，
 * 但保留这个参数——自托管机器不全是 Linux。
 *
 * 清理失败只记不抛：workspace 残留是磁盘问题，不该把一次成功的 complete 变成异常。
 */
export function removeJobDir(jobDir: string): void {
  try {
    rmSync(jobDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    console.error(`[runner] failed to remove job dir ${jobDir}: ${error instanceof Error ? error.message : error}`);
  }
}
