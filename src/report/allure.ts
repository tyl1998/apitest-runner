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
  uuid?: unknown;
  status?: unknown;
  statusDetails?: unknown;
  start?: unknown;
  stop?: unknown;
  labels?: unknown;
};

/**
 * allure fullName → pytest nodeid 形态（归一规则的依据见上方 guessed_case_key 注释）。
 *
 * 只归一**带 `#`** 的 fullName——那是 allure-pytest 的产物形态；没有 `#` 的（name 兜底、
 * 其它语言适配器）原样返回，不猜。参数化后缀（`[...]`）不在这里处理：服务端匹配侧的
 * regexp_replace 已经负责剥掉它。
 */
function normalizeFullName(fullName: string): string {
  const hash = fullName.indexOf("#");
  if (hash < 0) return fullName;
  const head = fullName.slice(0, hash);
  const tail = fullName.slice(hash + 1);
  /* head 是「包路径的点号形态」：test_case.auth.test_auth → test_case/auth/test_auth.py。
     点号没有转义形态，逐个替换即可；空 head（函数顶层用例）不补 .py。 */
  const path = head ? `${head.replace(/\./g, "/")}.py` : "";
  return `${path}::${tail}`;
}

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

  /* guessed_case_key 用 fullName，并**归一到 pytest nodeid 形态**（2026-09-03）：
     allure-pytest 把 nodeid `test_case/a.py::test_x[vip]` 归一成 `test_case.a#test_x[vip]`
     （路径分隔符变点、`::` 变 `#`）。平台用例树的读时关联（迁移 047 + ingest.ts 的
     LATERAL）拿它与 SDK 的 case_key 比——SDK 的 key 就是 nodeid 去掉 `[...]`，两边形态
     不同就永远匹配不上（验收实测：树上一条报告都没有）。归一规则是 fullName 的逆变换：
     `#` → `::`、包段点号 → `/` 并补 `.py`；参数化后缀原样保留（服务端的
     regexp_replace 负责去掉）。非 pytest 适配器产生的 fullName（如 java 的
     `com.x.Foo.method`）会被错误地归一成一段不存在的路径——无妨：guessed 键本来就只做
     best-effort 展示，对不上就显示「没有报告」，不产生数据变更（边界 13）。
     `#` 不存在时（个别适配器只填 name）按原样透传，junit 形态不受影响。 */
  const fullName = typeof parsed.fullName === "string" && parsed.fullName.length ? parsed.fullName : name;
  const guessedKey = normalizeFullName(fullName);

  /* 结果文件的 uuid（迁移 044）：同名参数化用例的两次执行在 (suite, name) 上不可分，
     平台靠它把两条都留下。缺 uuid 的适配器报 undefined——服务端收空串，退回旧的去重
     口径，不会更糟。 */
  const uuid = typeof parsed.uuid === "string" ? parsed.uuid.trim().slice(0, 128) : "";

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
    guessed_case_key: guessedKey.slice(0, MAX_NAME_CHARS) || null,
    status: STATUS_MAP[String(parsed.status ?? "")] ?? "error",
    duration_ms: clampDuration(durationMs),
    message: clipText(message, MAX_MESSAGE_CHARS),
    started_at_ms: startedAtMs,
    finished_at_ms: finishedAtMs,
    host: host ? host.slice(0, MAX_NAME_CHARS) : null,
    thread: thread ? thread.slice(0, MAX_NAME_CHARS) : null,
    external_id: uuid || undefined,
  }];
}
