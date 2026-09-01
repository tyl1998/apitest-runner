/**
 * 报告解析的防手误护栏（P4.5-6）。数值不是拍脑袋：每一个都对着服务端
 * `completePipelineRun`（apitest-server/src/lib/pipelineRun.ts）的收口——先在这里
 * 截，服务端再截一次就只是双保险而不是第二套答案。
 */

/** case 行数上限：与服务端 MAX_REPORT_CASES 同值。再多发也会被 slice 掉，先在这里
 *  停并留日志，用户在 job 日志里能看到「被截断了」而不是「少了几条不知道为什么」。 */
export const MAX_REPORT_CASES = 20_000;

/** suite / case / guessed_key 的截断长度：与服务端 slice(0, 512) 对齐。 */
export const MAX_NAME_CHARS = 512;

/**
 * message 的截断长度：服务端收 8000，这里给 2000。差值是载荷账——complete 的
 * cases[] 带整份报告解析结果，按「每条失败都顶格」算，8000 会让一份几千失败的报告
 * 轻易把请求体撑到 bodyLimit 之外（413 会被重试逻辑读成「已送达」，见 executor.ts
 * 的降级分支）；2000 字符也足够认出一次失败，完整 traceback 在报告文件本身里。
 */
export const MAX_MESSAGE_CHARS = 2_000;

/** duration_ms 上限：`pipeline_run_cases.duration_ms` 是 int4，一个越界值会让整批
 *  INSERT 失败——一条垃圾 time 属性不该带走全部 case。 */
export const MAX_DURATION_MS = 2_147_483_647;

/** started_at_ms / finished_at_ms 上限（P4.5-13）：落库列是 int8，同样先在本地挡。 */
export const MAX_TIMESTAMPS_MS = Number.MAX_SAFE_INTEGER;

/** 毫秒值归一：非数/负数/无穷读 0（junit 的 time 属性是外部输入，信不得）。 */
export function clampDuration(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(MAX_DURATION_MS, Math.round(ms));
}

/** epoch 毫秒归一（P4.5-13）：非数/负数/越界读 null——时间戳不是算术的输入而是
 *  定位的事实，缺了就降级进列表视图，不造一个 0 冒充 1970 年。 */
export function clampTimestamp(ms: unknown): number | null {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMESTAMPS_MS) return null;
  return Math.round(value);
}

/** 截断 + 空值归一：空字符串在这里统一成 null（服务端的列本来就是 NULL 语义）。 */
export function clipText(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  const clipped = value.length > max ? value.slice(0, max) : value;
  return clipped.length ? clipped : null;
}
