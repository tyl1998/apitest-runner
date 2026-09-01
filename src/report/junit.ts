import type { ReportCase } from "../protocol.js";
import { scanXml, XmlFormatError, type XmlHandlers } from "./xml.js";
import { clampDuration, clipText, MAX_MESSAGE_CHARS, MAX_NAME_CHARS } from "./limits.js";

/**
 * junit XML → cases[]（边界 13 的 B 路径）。
 *
 * 映射规则全是 best-effort——`guessed_case_key` 这个列名就是在说这件事：
 * - suite_name = 最近一层 `<testsuite>` 的 name 属性（pytest 放的是文件路径）；
 * - case_name = `<testcase name>`，缺失则整条丢弃（服务端同样要求非空）；
 * - guessed_case_key = `classname::name`——junit 的 classname（点分）与 pytest nodeid
 *   （斜杠路径）之间没有稳定映射，类名、参数化 id、conftest 层级都会让它对不上，
 *   所以平台绝不拿它回写用例树（边界 13 的 B/C 绝不回写）；
 * - 状态：有 `<failure>` 子元素 → failed，`<error>` → error，`<skipped>` → skipped，
 *   都没有 → passed（三个都在时 failure 赢：断言失败比错误更具体）；
 * - duration_ms = `<testcase time>`（秒，浮点）四舍五入成毫秒；
 * - message = failure/error/skipped 的 message 属性，缺省用元素文本（pytest 把
 *   traceback 放在那里）。
 *
 * 嵌套 `<testsuite>`（少数工具会产）也支持：suite 栈记最近一层。
 */

type FailureKind = "failure" | "error" | "skipped";

type CaseDraft = {
  suiteName: string;
  className: string;
  caseName: string;
  timeSeconds: number | null;
  kinds: Set<FailureKind>;
  /** 第一个失败子元素的 message 属性（属性是摘要，文本是 trace，摘要优先）。 */
  message: string | null;
  textParts: string[];
  textChars: number;
};

/**
 * 解析一份 junit XML 文本。结构性损坏抛 XmlFormatError / Error，由调用方按
 * 「这一个文件坏」记日志——绝不在这里吞掉，静默产出半份报告比明确报错难看得多。
 */
export function parseJunitXml(text: string): ReportCase[] {
  const cases: ReportCase[] = [];
  const elementStack: string[] = [];
  const suiteStack: string[] = [];
  let draft: CaseDraft | null = null;
  /* 正在收文本的失败子元素所属的 draft；离开该元素即置空（system-out 等兄弟元素的
     文本不该混进 failure 的 trace）。 */
  let captureInto: CaseDraft | null = null;

  function finalize(): void {
    if (!draft) return;
    const current = draft;
    draft = null;
    captureInto = null;
    if (!current.caseName) return;
    const status: ReportCase["status"] = current.kinds.has("failure")
      ? "failed"
      : current.kinds.has("error")
        ? "error"
        : current.kinds.has("skipped")
          ? "skipped"
          : "passed";
    const body = current.textParts.join("").trim();
    const guessed = current.className ? `${current.className}::${current.caseName}` : current.caseName;
    cases.push({
      source: "junit",
      suite_name: current.suiteName.slice(0, MAX_NAME_CHARS),
      case_name: current.caseName.slice(0, MAX_NAME_CHARS),
      guessed_case_key: guessed.slice(0, MAX_NAME_CHARS) || null,
      status,
      duration_ms: clampDuration((current.timeSeconds ?? 0) * 1000),
      message: clipText(current.message ?? (body.length ? body : null), MAX_MESSAGE_CHARS),
    });
  }

  const handlers: XmlHandlers = {
    onStartTag(name, attrs, selfClosing) {
      if (!selfClosing) elementStack.push(name);
      if (name === "testsuite") {
        /* 自闭合的 testsuite 没有 testcase 可言，不进栈。 */
        if (!selfClosing) suiteStack.push(String(attrs.name ?? ""));
        return;
      }
      if (name === "testcase") {
        draft = {
          suiteName: suiteStack[suiteStack.length - 1] ?? "",
          className: String(attrs.classname ?? ""),
          caseName: String(attrs.name ?? ""),
          timeSeconds: parseSeconds(attrs.time),
          kinds: new Set(),
          message: null,
          textParts: [],
          textChars: 0,
        };
        if (selfClosing) finalize();
        return;
      }
      if (draft && (name === "failure" || name === "error" || name === "skipped")) {
        draft.kinds.add(name);
        if (draft.message === null && typeof attrs.message === "string" && attrs.message.length) {
          draft.message = attrs.message;
        }
        /* 只有非自闭合才收文本：自闭合元素没有 end tag 来复位 captureInto，置了的话
           后续兄弟元素（system-out 等）的文本会混进 failure 的 trace。 */
        if (!selfClosing) captureInto = draft;
      }
      /* 其余元素（properties / system-out / testsuites 根）不参与映射。 */
    },
    onText(chunk) {
      if (captureInto && captureInto.textChars < MAX_MESSAGE_CHARS) {
        captureInto.textParts.push(chunk);
        captureInto.textChars += chunk.length;
      }
    },
    onEndTag(name) {
      const top = elementStack.pop();
      if (top !== name) {
        throw new XmlFormatError(`mismatched close tag </${name}> (still open: <${top ?? "nothing"}>)`);
      }
      if (name === "testsuite") {
        suiteStack.pop();
        return;
      }
      if (name === "testcase") {
        finalize();
        return;
      }
      if (name === "failure" || name === "error" || name === "skipped") {
        captureInto = null;
      }
    },
  };

  scanXml(text, handlers);
  /* 文档在 testcase 中途截断（栈未清空）时最后一个 draft 已随 end tag 落袋或随
     start tag 挂着——挂着的那个丢弃：半条 case 比没有更糟。 */
  return cases;
}

/** time 属性（秒）：非数与负数读 null（duration 归 0），不猜。 */
function parseSeconds(value: string | undefined): number | null {
  if (typeof value !== "string" || !value.length) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
