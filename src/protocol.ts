/**
 * Runner 协议 v1.0 的类型面（计划 8.2，冻结协议）。
 *
 * 键名 snake_case：这是第三方实现者照抄的那份文档，`apitest-server/src/lib/jobSpec.ts`
 * 的 `JobSpec` 是它的服务端出处——两边由人眼对齐（跨仓没有共享包，REPOSITORY_ARCHITECTURE
 * 3.3 的契约文件还没落地，落地前这里是 Runner 侧唯一一份）。
 *
 * register 的**响应**是 camelCase（服务端 P4.5-1 的已记录偏差），其余四个接口的响应按
 * 协议表输出 snake_case。
 */

export const PROTOCOL_VERSION = "1.0";

/** claim 的响应体，也是全协议唯一出现凭据明文的地方（边界 11）。 */
export type JobSpec = {
  job_id: string;
  project_id: string;
  ci_task_id: string;
  run_number: number;
  repo: {
    clone_url: string;
    clone_method: "none" | "https_token" | "ssh_key";
    /** ★ 只在 claim 响应体里出现；不落盘、不进日志、不回传任何接口。 */
    credential: string | null;
  };
  git_ref: string;
  sandbox: {
    mode: "process" | "container";
    image: string;
    cpu_limit: string;
    memory_limit: string;
    disk_limit: string;
    /** container 档才生效（8.5）；进程档是信任声明，做不到网络隔离。 */
    network: { deny_cidrs: string[] };
  };
  steps: string;
  env: Record<string, string>;
  secrets: { key: string; value: string }[];
  cache: { paths: string[]; key_files: string[] };
  report: { format: "none" | "junit" | "allure"; paths: string[] };
  artifact_paths: string[];
  case_filter: { case_keys: string[] } | null;
  timeout_seconds: number;
  protocol_version: string;
};

/** register 响应（camelCase，服务端 P4.5-1 偏差）。 */
export type RegisterResult = {
  runnerId: string;
  heartbeatIntervalSeconds: number;
  pollTimeoutSeconds: number;
  protocolVersion: string;
};

/** heartbeat 响应：`cancel` 是取消指令的唯一下发通道（约定 6）。 */
export type HeartbeatResult = {
  lease_expires_at: string | null;
  cancel: boolean;
};

/** logs 响应：`next_offset` 永远是服务端当前总长（断线重连的续传起点）。 */
export type LogsResult = { next_offset: number };

/** artifacts 申请响应（8.2 接口 5，P4.5-7）：直传目标，字节不进平台 API 进程。 */
export type ArtifactUploadTarget = {
  artifact_id: string;
  upload_url: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  expires_at: string;
};

/** `complete` 的合法终态（与 `pipeline_runs.status` 的 CHECK 对齐，去掉三个在途态）。 */
export type CompleteStatus = "success" | "failed" | "canceled" | "aborted" | "timed_out";

/**
 * `complete` 的 `cases[]`（8.2 接口 6，边界 13 的 B/C 路径）：junit / allure 报告在
 * Runner 侧解析出的 case 级结果。`source` 只有 junit / allure——SDK 路径（A）的 case
 * 级结果在 `repo_test_cases` + `ingest_records` 里，平台不存第二份（迁移 038 的注释）。
 *
 * `guessed_case_key` 命名即声明：测试名与 case_key 没有稳定映射，平台不拿它回写用例
 * 树——写脏的树没有办法回滚。服务端的收口（截断 / 枚举 / 行数上限）在
 * `completePipelineRun`，形状以那边为准，报告解析侧先按同一组数截好。
 */
export type ReportCase = {
  source: "junit" | "allure";
  suite_name: string;
  case_name: string;
  guessed_case_key: string | null;
  status: "passed" | "failed" | "skipped" | "error";
  duration_ms: number;
  message: string | null;
  /* P4.5-13（边界 19 的 timeline 层）：allure 才有的定位数据，junit 路径永远缺省。
     可选而不是必填——旧 Runner 升级窗口里服务端要能同时收两种形状。 */
  started_at_ms?: number | null;
  finished_at_ms?: number | null;
  host?: string | null;
  thread?: string | null;
};

/** 固定四段阶段 + pending/done（迁移 038 的 CHECK）。 */
export type PipelineStage = "pending" | "clone" | "cache" | "script" | "report" | "done";
