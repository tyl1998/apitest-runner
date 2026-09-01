/**
 * 极小 XML 扫描器（junit 报告解析专用，P4.5-6）。
 *
 * 为什么手写而不是引 fast-xml-parser：本仓的「零运行时依赖」是刻意约束（README——
 * HTTP 用内置 fetch、进程控制用 node:child_process），报告解析不值得为它破例。
 *
 * 这不是通用 XML 解析器，是「够解析 junit 的那个子集」：
 * - 元素 / 属性（单双引号、实体解码）、文本、CDATA、注释、XML 声明、PI；
 * - **拒绝 DTD**（`<!DOCTYPE` / `<!ENTITY` 一律抛错）：报告文件来自用户仓库，XXE 与
 *   十亿 laughs 在这里挡掉。平台侧不解析 XML（边界 13）已经挡掉一次，这是第二道；
 * - 实体只认五个预定义 + 数字字符引用，未知实体原样保留（宽松读法，绝不崩溃）；
 * - 结束标签与开标签栈不匹配直接抛错：junit 是机器产物，标签错位意味着文件在写一半
 *   时被截断，继续解析只会产出「后半份报告」的假数据。
 *
 * 事件回调（onStartTag / onEndTag / onText）而不是 DOM：junit 报告可以到几十 MB，
 * 一棵全量 DOM 树的内存是内容本身的数倍，而我们要的只是「testcase + 它的失败子元素」。
 */

/** 结构性错误（标签错位 / DTD / 截断）：调用方按「这一个文件坏」处理，不影响 job 终态。 */
export class XmlFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlFormatError";
  }
}

export type XmlHandlers = {
  onStartTag(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  onEndTag(name: string): void;
  /** 文本节点（已解码；CDATA 的内容原样）。 */
  onText(text: string): void;
};

const NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9._:-]*$/;

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** 单遍扫描。抛 XmlFormatError 表示文件结构性损坏；回调里的异常原样穿透。 */
export function scanXml(text: string, handlers: XmlHandlers): void {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const open = text.indexOf("<", i);
    if (open < 0) {
      if (i < n) handlers.onText(decodeEntities(text.slice(i)));
      return;
    }
    if (open > i) handlers.onText(decodeEntities(text.slice(i, open)));

    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      if (end < 0) throw new XmlFormatError("unterminated comment");
      i = end + 3;
    } else if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9);
      if (end < 0) throw new XmlFormatError("unterminated CDATA section");
      /* CDATA 的内容不做实体解码——它本来就是「原文」语义。 */
      handlers.onText(text.slice(open + 9, end));
      i = end + 3;
    } else if (text.startsWith("<!", open)) {
      /* 到这里只剩 DOCTYPE / ENTITY 等 DTD 声明：见文件头注释，拒收。 */
      throw new XmlFormatError("DTD declarations are not accepted in report files");
    } else if (text.startsWith("<?", open)) {
      const end = text.indexOf("?>", open + 2);
      if (end < 0) throw new XmlFormatError("unterminated processing instruction");
      i = end + 2;
    } else if (text.startsWith("</", open)) {
      const end = text.indexOf(">", open + 2);
      if (end < 0) throw new XmlFormatError("unterminated end tag");
      const name = text.slice(open + 2, end).trim();
      if (!NAME_PATTERN.test(name)) throw new XmlFormatError(`malformed end tag "${name.slice(0, 40)}"`);
      handlers.onEndTag(name);
      i = end + 1;
    } else {
      const end = scanTagEnd(text, open);
      if (end < 0) throw new XmlFormatError("unterminated start tag");
      const raw = text.slice(open + 1, end);
      const selfClosing = raw.endsWith("/");
      const { name, attrs } = parseTagBody(selfClosing ? raw.slice(0, -1) : raw);
      handlers.onStartTag(name, attrs, selfClosing);
      i = end + 1;
    }
  }
}

/**
 * 找 start tag 的 `>`。不能直接 indexOf(">")：属性值里合法地出现 `>`（pytest 会把
 * 断言表达式放进 message，`a > b` 很常见），引号内的必须跳过。
 */
function scanTagEnd(text: string, from: number): number {
  let quote = "";
  for (let i = from + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/** 解析 `name attr="v" attr2='v2'`（已剥掉 `<`、`>` 与自闭合斜杠）。 */
function parseTagBody(body: string): { name: string; attrs: Record<string, string> } {
  const nameMatch = /^\S+/.exec(body);
  const name = nameMatch ? nameMatch[0] : "";
  if (!NAME_PATTERN.test(name)) throw new XmlFormatError(`malformed tag name "${name.slice(0, 40)}"`);
  const attrs: Record<string, string> = {};
  let i = name.length;
  while (i < body.length) {
    while (i < body.length && isWhitespace(body[i])) i++;
    if (i >= body.length) break;
    const start = i;
    while (i < body.length && !/[\s=/]/.test(body[i])) i++;
    const attrName = body.slice(start, i);
    if (!NAME_PATTERN.test(attrName)) throw new XmlFormatError(`malformed attribute name in <${name}>`);
    while (i < body.length && isWhitespace(body[i])) i++;
    if (body[i] !== "=") throw new XmlFormatError(`attribute "${attrName}" in <${name}> has no value`);
    i += 1;
    while (i < body.length && isWhitespace(body[i])) i++;
    const quote = body[i];
    if (quote !== '"' && quote !== "'") {
      throw new XmlFormatError(`attribute "${attrName}" in <${name}> must have a quoted value`);
    }
    const close = body.indexOf(quote, i + 1);
    if (close < 0) throw new XmlFormatError(`unterminated value for attribute "${attrName}" in <${name}>`);
    attrs[attrName] = decodeEntities(body.slice(i + 1, close));
    i = close + 1;
  }
  return { name, attrs };
}

/**
 * 实体解码：五个预定义 + 数字字符引用。未知实体（`&a;` 之类）原样保留——没有 DTD
 * 的文档里它本来就无解，抛错只会把「能解析的其余部分」连坐掉。
 *
 * 单遍 replace 的替换结果不会被重扫，`&amp;#60;` 不会二次解码成 `<`（这是 replace
 * 与「循环替换直到不变」的分界线，后者才是双重解码 bug 的老家）。
 */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      /* XML 的十六进制引用只认小写 x（`&#x1F600;`），大写 X 进不了上面这组捕获。 */
      const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      /* 代理区与非法码点交回原样：String.fromCodePoint 对它们要么抛错要么产出孤代理。 */
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
      return whole;
    }
    return NAMED_ENTITIES[entity] ?? whole;
  });
}
