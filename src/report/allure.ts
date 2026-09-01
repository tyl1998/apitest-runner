import type { ReportCase } from "../protocol.js";
import { clampDuration, clampTimestamp, clipText, MAX_MESSAGE_CHARS, MAX_NAME_CHARS } from "./limits.js";

/**
 * allure `*-result.json` → cases[]（边界 13 的 C 路径）。
 *
 * 只解析结构化 JSON——不跑 `allure generate`、不 vendor allure 官方 SPA（8.10 与
 * 边界 19 的准确边界）。**报告视图的原始文件**（container / 附件）由
 * `reportBundle.ts` 整目录打 zip 走产物线，与本解析器平行：解析产出 timeline 的
 * 结构化数据，zip 产出 steps / 附件的完整事实，两条线读同一个目录、互不依赖。
 *
 * 一个文件 = 一条用例结果（`<uuid>-result.json`）；containers / attachments 文件
 * 由调用方的文件名过滤挡在外面，到不了这里。
 *
 * 状态映射：allure 的 `broken`（用例本身炸了）→ `error`；`unknown`（被中断、没跑完）
 * → `error`——不是 skipped：跳过是显式决定，中断是意外，两者的整改动作不同。
 */

const STATUS_MAP: Record<string, ReportCase["status"]> = {
  passed: "passed",
  failed: "failed",
  broken: "error",
  skipped: "skipped",
  unknown: "error",
};

type AllureResult = {
  name?: unknown;
  fullName?: unknown;
  status?: unknown;
  statusDetails?: unknown;
  start?: unknown;
  stop?: unknown;
  labels?: unknown;
};

/**
 * 解析一个结果文件。JSON.parse 抛错由调用方按「这一个文件坏」记日志；结构对不上
 * （不是对象 / 没有 name）返回空数组而不是抛错——那不是损坏，是不认识，记日志的
 * 价值留给调用方的计数汇总。
 */
export function parseAllureResult(text: string): ReportCase[] {
  const parsed = JSON.parse(text) as AllureResult;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const name = typeof parsed.name === "string" ? parsed.name : "";
  if (!name) return [];

  /* suite 归属：labels 里的 suite 标签，缺省退 parentSuite。display 路径（parentSuite
     . suite . subSuite）不拼——拼接符是 allure 报告页的展示约定，存储里保留单层名。 */
  const labels = Array.isArray(parsed.labels) ? (parsed.labels as Array<{ name?: unknown; value?: unknown }>) : [];
  const labelValue = (key: string): string => {
    for (const label of labels) {
      if (String(label?.name ?? "") === key && typeof label.value === "string" && label.value.length) {
        return label.value;
      }
    }
    return "";
  };
  const suiteName = labelValue("suite") || labelValue("parentSuite") || "";

  /* guessed_case_key 用 fullName（pytest 适配器放的就是 nodeid）——它与 case_key 仍然
     没有稳定映射（参数化 id 的写法两边不同），所以同样只进 guessed 列、不回写树。
     个别适配器只填 name 不填 fullName，此时 guessed 用 name 本身。 */
  const fullName = typeof parsed.fullName === "string" && parsed.fullName.length ? parsed.fullName : name;

  const start = Number(parsed.start);
  const stop = Number(parsed.stop);
  const durationMs = Number.isFinite(start) && Number.isFinite(stop) ? stop - start : 0;
  /* P4.5-13：start/stop 不只用来算 duration——epoch 毫秒原样上报（时间轴的事实源），
     host/thread 从 labels 取（并行执行按 thread 分泳道）。缺了是 null 而不是 0：
     0 是 1970 年，造一个假时间戳比缺一个更糟。 */
  const startedAtMs = clampTimestamp(parsed.start);
  const finishedAtMs = clampTimestamp(parsed.stop);
  const host = labelValue("host");
  const thread = labelValue("thread");

  const details = parsed.statusDetails && typeof parsed.statusDetails === "object"
    ? (parsed.statusDetails as { message?: unknown; trace?: unknown })
    : {};
  const message = typeof details.message === "string" && details.message.length
    ? details.message
    : typeof details.trace === "string" && details.trace.length
      ? details.trace
      : null;

  return [{
    source: "allure",
    suite_name: suiteName.slice(0, MAX_NAME_CHARS),
    case_name: name.slice(0, MAX_NAME_CHARS),
    guessed_case_key: fullName.slice(0, MAX_NAME_CHARS) || null,
    status: STATUS_MAP[String(parsed.status ?? "")] ?? "error",
    duration_ms: clampDuration(durationMs),
    message: clipText(message, MAX_MESSAGE_CHARS),
    started_at_ms: startedAtMs,
    finished_at_ms: finishedAtMs,
    host: host ? host.slice(0, MAX_NAME_CHARS) : null,
    thread: thread ? thread.slice(0, MAX_NAME_CHARS) : null,
  }];
}
