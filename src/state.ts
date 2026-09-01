import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompleteStatus, PipelineStage, ReportCase } from "./protocol.js";

/**
 * job 目录里的持久状态（`<data>/jobs/<job_id>/state.json` + `exit_code` 文件）。
 *
 * 退出码落盘是 Spec 2.10.2(d) 的 durable 做法的一半：Runner 被 kill -9 后重启，
 * 靠这两个文件补报 `complete`（边界 8）。另一半是 `recover.ts` 在启动时读它们。
 *
 * 写入是 tmp + rename 的原子写：崩溃在半截只会留下「上一份完整状态 + 一个孤儿 tmp」，
 * 不会留下解析不了的 JSON 让恢复路径整个卡死。
 */

export type JobStateFile = {
  job_id: string;
  runner_id: string;
  ci_task_id: string;
  stage: PipelineStage;
  commit_sha: string;
  /** 已被服务端确认的日志字节水位（断线重连的续传起点，边界 7）。 */
  sent_log_offset: number;
  final_status: CompleteStatus | null;
  exit_code: number | null;
  error: string | null;
  /** 报告解析结果（P4.5-6）：complete 没送达时随恢复路径一起补报。体积已按
      complete 的载荷预算截断（report/parse.ts），终态落定即随 job 目录删除。 */
  cases: ReportCase[] | null;
  updated_at: string;
};

/** 恢复路径读回 cases 的轻校验上限：写入侧有 MAX_REPORT_CASES，读回侧不放大。 */
const MAX_PERSISTED_CASES = 20_000;

/** state.json 是自己写的，但读回的每一格都当外部输入对待（cache.ts 同款纪律）。 */
function sanitizeCases(input: unknown): ReportCase[] | null {
  if (!Array.isArray(input)) return null;
  const cases = input.filter((each): each is ReportCase => {
    if (!each || typeof each !== "object") return false;
    const candidate = each as Partial<ReportCase>;
    return (candidate.source === "junit" || candidate.source === "allure")
      && typeof candidate.case_name === "string" && candidate.case_name.length > 0
      && (candidate.status === "passed" || candidate.status === "failed"
        || candidate.status === "skipped" || candidate.status === "error")
      && typeof candidate.duration_ms === "number";
  });
  return cases.length ? cases.slice(0, MAX_PERSISTED_CASES) : null;
}

export function jobDirOf(dataDir: string, jobId: string): string {
  return join(dataDir, "jobs", jobId);
}

export function exitCodeFileOf(jobDir: string): string {
  return join(jobDir, "exit_code");
}

/** 写退出码文件：只在子进程**自然退出**时写，被杀（取消/超时/停机）不写——读不到才判 aborted。 */
export function writeExitCode(jobDir: string, exitCode: number): void {
  writeFileSync(exitCodeFileOf(jobDir), String(exitCode), "utf8");
}

export function readExitCode(jobDir: string): number | null {
  const file = exitCodeFileOf(jobDir);
  if (!existsSync(file)) return null;
  const parsed = Number(readFileSync(file, "utf8").trim());
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export class JobState {
  private data: JobStateFile;

  private constructor(readonly jobDir: string, data: JobStateFile) {
    this.data = data;
  }

  /** 全新 job：claim 之后立即建目录与状态文件，此后 kill -9 也有东西可恢复。 */
  static create(jobDir: string, seed: { job_id: string; runner_id: string; ci_task_id: string }): JobState {
    return new JobState(jobDir, {
      ...seed,
      stage: "pending",
      commit_sha: "",
      sent_log_offset: 0,
      final_status: null,
      exit_code: null,
      error: null,
      cases: null,
      updated_at: new Date().toISOString(),
    });
  }

  /** 恢复路径读存量状态；不存在或损坏返回 null（调用方按孤儿目录处理）。 */
  static load(jobDir: string): JobState | null {
    const file = join(jobDir, "state.json");
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<JobStateFile>;
      if (!parsed?.job_id || !parsed?.runner_id) return null;
      return new JobState(jobDir, {
        job_id: String(parsed.job_id),
        runner_id: String(parsed.runner_id),
        ci_task_id: String(parsed.ci_task_id ?? ""),
        stage: (parsed.stage ?? "pending") as PipelineStage,
        commit_sha: String(parsed.commit_sha ?? ""),
        sent_log_offset: Math.max(0, Math.trunc(Number(parsed.sent_log_offset ?? 0)) || 0),
        final_status: (parsed.final_status ?? null) as CompleteStatus | null,
        exit_code: parsed.exit_code === null || parsed.exit_code === undefined ? null : Math.trunc(Number(parsed.exit_code)),
        error: parsed.error === undefined || parsed.error === null ? null : String(parsed.error),
        cases: sanitizeCases(parsed.cases),
        updated_at: String(parsed.updated_at ?? new Date().toISOString()),
      });
    } catch {
      return null;
    }
  }

  get jobId(): string {
    return this.data.job_id;
  }

  get runnerId(): string {
    return this.data.runner_id;
  }

  get stage(): PipelineStage {
    return this.data.stage;
  }

  setStage(stage: PipelineStage): void {
    if (this.data.stage === stage) return;
    this.data.stage = stage;
    this.save();
  }

  get commitSha(): string {
    return this.data.commit_sha;
  }

  setCommitSha(sha: string): void {
    this.data.commit_sha = sha;
    this.save();
  }

  get sentLogOffset(): number {
    return this.data.sent_log_offset;
  }

  /** 日志水位推进（streamer 每次收到 ack 时调用）。 */
  advanceLogOffset(offset: number): void {
    if (offset <= this.data.sent_log_offset) return;
    this.data.sent_log_offset = offset;
    this.save();
  }

  /** 终态落盘：必须在调 `complete` **之前**写——「写完状态、还没报上去」是恢复路径要盖住的窗口。
      cases 随终态一起落盘（空数组归一成 null：多数 job 没有报告，state.json 不该为此多一个键）。 */
  settle(status: CompleteStatus, exitCode: number | null, error: string | null, cases?: ReportCase[]): void {
    this.data.final_status = status;
    this.data.exit_code = exitCode;
    this.data.error = error;
    this.data.cases = cases && cases.length ? cases : null;
    this.save();
  }

  get final(): { status: CompleteStatus; exitCode: number | null; error: string | null } | null {
    return this.data.final_status
      ? { status: this.data.final_status, exitCode: this.data.exit_code, error: this.data.error }
      : null;
  }

  get cases(): ReportCase[] | null {
    return this.data.cases;
  }

  save(): void {
    this.data.updated_at = new Date().toISOString();
    const file = join(this.jobDir, "state.json");
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), "utf8");
    renameSync(tmp, file);
  }
}
