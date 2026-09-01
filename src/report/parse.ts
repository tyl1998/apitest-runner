import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { ReportCase } from "../protocol.js";
import type { SecretMasker } from "../masker.js";
import { expandGlob, hasGlobMetachar } from "./glob.js";
import { MAX_REPORT_CASES } from "./limits.js";
import { parseJunitXml } from "./junit.js";
import { parseAllureResult } from "./allure.js";

/**
 * 报告收集的编排（P4.5-6，边界 13 的 B/C 路径）：
 * report.paths 展开（字面路径或 glob）→ 逐文件解析（junit XML / allure 结果 JSON）
 * → message 脱敏 → 行数与载荷预算截断 → `complete` 的 `cases[]`。
 *
 * 三条纪律：
 * - **绝不改变 job 终态**：报告解析是 best-effort，坏文件、缺文件、解析器崩了都只
 *   记日志、产出已收到的部分——脚本的成败由退出码说了算，报告只是它的注脚。
 * - **绝不回写**：B/C 的测试名与 case_key 没有稳定映射（guessed_case_key 命名即
 *   声明），树上的 last_result 只有 SDK 路径（A）能碰，这里产出的每一条都只进
 *   `pipeline_run_cases`。
 * - **预算先于发送**：cases 的 JSON 体积有硬顶，超了截断并记日志。服务端拒一个
 *   413 会被重试逻辑读成「已送达」（executor.ts 的降级分支只能兜一次），比少几条
 *   case 难看得多。
 *
 * 同步执行（readFileSync + 单遍扫描）：文件大小与数量都有上限，最坏几秒的 CPU——
 * 租约 90 秒，心跳慢这几拍不进危险区；为它上流式解析是把 5% 的边角复杂度引进
 * 100% 的主路径。
 */

/** 单个报告文件的大小上限。junit 会把 traceback 全塞进 XML，几十 MB 真实存在；
 *  64MB 以上按「这份报告不该由这条链路搬」处理（要看全量走产物上传，P4.5-7）。 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** 报告文件总数上限（全部 pattern 加起来）。 */
const MAX_FILES_TOTAL = 1024;

/** cases 的 JSON 载荷预算。服务端 complete 路由的 bodyLimit 是 8MB（env 可调低），
 *  这里留 2MB 给信封、转义膨胀与消息脱敏后的重算误差。 */
const MAX_CASES_JSON_BYTES = 6 * 1024 * 1024;

/** allure 结果文件的命名约定：`<uuid>-result.json`（边界 13 的「只解析结果 JSON」）。 */
const ALLURE_RESULT_FILE = /-result\.json$/i;

export function collectReportCases(deps: {
  report: { format: "none" | "junit" | "allure"; paths: string[] };
  workspace: string;
  masker: SecretMasker;
  log: (line: string) => void;
}): ReportCase[] {
  try {
    return collect(deps);
  } catch (error) {
    /* 解析器自己的 bug 不该把一次成功的执行变红（纪律一）；日志里留原文供排查。 */
    deps.log(`report: collection crashed (${error instanceof Error ? error.message : String(error)}); continuing with zero cases`);
    return [];
  }
}

/**
 * allure-results 目录定位（P4.5-13，边界 19 的报告层）：返回解析实际触到的
 * **去重目录集合**。zip 打包按目录整体打（container / attachment 与 result 文件
 * 同目录是 allure 的正常布局，报告视图缺了它们 steps / 附件就没了）。
 *
 * 只在 format=allure 且匹配到文件时非空；junit / none / 没匹配到都返回空数组。
 */
export function collectAllureResultDirs(deps: {
  report: { format: "none" | "junit" | "allure"; paths: string[] };
  workspace: string;
  log: (line: string) => void;
}): string[] {
  const { report, workspace, log } = deps;
  if (report.format !== "allure") return [];
  if (!Array.isArray(report.paths) || !report.paths.length) return [];
  const matched = matchReportFiles(report, workspace, log);
  const dirs = new Set<string>();
  for (const file of matched.files) {
    dirs.add(dirname(file));
  }
  return [...dirs].sort();
}

function collect(deps: {
  report: { format: "none" | "junit" | "allure"; paths: string[] };
  workspace: string;
  masker: SecretMasker;
  log: (line: string) => void;
}): ReportCase[] {
  const { report, workspace, masker, log } = deps;
  if (report.format === "none") return [];
  if (!Array.isArray(report.paths) || !report.paths.length) {
    log("report: format is configured but report_paths is empty; nothing to parse");
    return [];
  }

  const matched = matchReportFiles(report, workspace, log);
  if (!matched.files.length) {
    log(`report: no files matched ${report.paths.map((each) => JSON.stringify(each)).join(", ")}; producing zero cases`);
    return [];
  }

  const cases: ReportCase[] = [];
  let parsedFiles = 0;
  let droppedByCases = 0;
  let droppedByBudget = false;
  let budgetBytes = 0;

  const take = (incoming: ReportCase[]): void => {
    for (let i = 0; i < incoming.length; i++) {
      const each = incoming[i];
      if (cases.length >= MAX_REPORT_CASES) {
        droppedByCases += incoming.length - i;
        return;
      }
      /* 先脱敏再量预算：发出去的就是脱敏后的这份，量错了就是白算。message 之外的
         字段是标识符（UNIQUE 键的一部分），脱敏会破坏幂等去重，不动。 */
      if (each.message) each.message = masker.maskLine(each.message);
      const size = Buffer.byteLength(JSON.stringify(each), "utf8");
      if (budgetBytes + size > MAX_CASES_JSON_BYTES) {
        droppedByBudget = true;
        return;
      }
      budgetBytes += size;
      cases.push(each);
    }
  };

  const parse = report.format === "junit" ? parseJunitXml : parseAllureResult;
  for (const file of matched.files) {
    const loaded = readReportFile(file);
    if (!loaded.ok) {
      log(`report: ${display(workspace, file)} skipped (${loaded.error})`);
      continue;
    }
    try {
      take(parse(loaded.content));
      parsedFiles += 1;
    } catch (error) {
      log(`report: ${display(workspace, file)} failed to parse (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const counts = { passed: 0, failed: 0, error: 0, skipped: 0 };
  for (const each of cases) counts[each.status] += 1;
  const notes: string[] = [];
  if (droppedByCases > 0) notes.push(`dropped ${droppedByCases} case(s) at the ${MAX_REPORT_CASES}-case cap`);
  if (droppedByBudget) notes.push(`stopped early at the ${Math.round(MAX_CASES_JSON_BYTES / 1024 / 1024)}MB payload budget`);
  if (matched.capped) notes.push("file list capped");
  log(
    `report: parsed ${parsedFiles} ${report.format} file(s) → ${cases.length} case(s) ` +
      `(passed ${counts.passed}, failed ${counts.failed}, error ${counts.error}, skipped ${counts.skipped})` +
      (notes.length ? `; ${notes.join("; ")}` : ""),
  );
  return cases;
}

/** 展开 report.paths：字面路径 existsSync（跟随软链），glob 逐段扫描。
 *  format 收全三值：调用方已挡 "none"，这里不靠收窄（属性收窄传不进函数形参），
 *  只按 `=== "allure"` 分派，"none" 走 junit 那侧的文件收集也无害——到不了。 */
function matchReportFiles(
  report: { format: "none" | "junit" | "allure"; paths: string[] },
  workspace: string,
  log: (line: string) => void,
): { files: string[]; capped: boolean } {
  const files: string[] = [];
  const seen = new Set<string>();
  let capped = false;

  for (const entry of report.paths) {
    const relativePath = sanitizeRelativePath(entry);
    if (!relativePath) {
      log(`report: ignore malformed path ${JSON.stringify(entry)}`);
      continue;
    }
    /* 服务端已挡绝对路径与 `..`（routes/ciTasks.ts），这里再挡一次：JobSpec 来自
       网络（executor/cache.ts 同款纪律）。 */
    const matches = hasGlobMetachar(relativePath)
      ? expandGlob(workspace, relativePath)
      : existsSync(join(workspace, relativePath))
        ? { matches: [join(workspace, relativePath)], capped: false }
        : { matches: [] as string[], capped: false };
    if (matches.capped) {
      capped = true;
      log(`report: pattern ${JSON.stringify(relativePath)} hit the per-pattern match cap; results truncated`);
    }
    for (const match of matches.matches) {
      if (seen.has(match)) continue;
      seen.add(match);
      if (files.length >= MAX_FILES_TOTAL) {
        capped = true;
        break;
      }
      files.push(match);
    }
  }

  /* allure 的目录匹配在文件名层面再过一道 `-result.json`；junit 只要文件。排序为了
     日志与 cases 顺序可复现（readdir 顺序是文件系统实现细节）。 */
  const resolved: string[] = [];
  for (const match of files.sort()) {
    const kind = pathKind(match);
    if (kind === "directory") {
      if (report.format === "allure") {
        let entries;
        try {
          entries = readdirSync(match, { withFileTypes: true });
        } catch (error) {
          /* 一个目录读不动只废这一条匹配，不连坐整份收集。 */
          log(`report: ${display(workspace, match)} could not be listed (${error instanceof Error ? error.message : String(error)})`);
          continue;
        }
        for (const entry of entries) {
          /* containers / attachments 与 result 文件同目录，是 allure 的正常布局：
             静默跳过，不为每个文件记一行。 */
          if (entry.isFile() && ALLURE_RESULT_FILE.test(entry.name)) resolved.push(join(match, entry.name));
        }
      } else {
        log(`report: ${display(workspace, match)} skipped (junit expects files, got a directory)`);
      }
      continue;
    }
    if (kind !== "file") {
      log(`report: ${display(workspace, match)} skipped (not a regular file)`);
      continue;
    }
    if (report.format === "allure" && !ALLURE_RESULT_FILE.test(basename(match))) {
      log(`report: ${display(workspace, match)} skipped (allure parsing only accepts *-result.json files)`);
      continue;
    }
    resolved.push(match);
  }
  resolved.sort();
  return { files: resolved, capped };
}

type ReadResult = { ok: true; content: string } | { ok: false; error: string };

function readReportFile(file: string): ReadResult {
  let size: number;
  try {
    size = statSync(file).size;
  } catch (error) {
    return { ok: false, error: `stat failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (size > MAX_FILE_BYTES) {
    return { ok: false, error: `file is ${size} bytes, over the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB cap` };
  }
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    return { ok: false, error: `read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, content: decodeText(buffer) };
}

/**
 * BOM 感知的解码。junit XML 声明的 encoding 名义上一堆（UTF-8 / UTF-16 / ISO-8859-1），
 * 实践里 pytest / jest 产的都是 UTF-8；这里只多认 BOM 标记的 UTF-16——Windows 上的
 * 个别工具链会产它，不认的话 `<` 解码成 `<\0`，报错信息会指鹿为马。其余编码按 UTF-8
 * 硬解，坏字符归坏字符，结构还在。
 */
function decodeText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return stripBom(buffer.toString("utf16le"));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    /* Node 没有 utf16be 解码器：交换字节对后按 utf16le 读。 */
    const swapped = Buffer.allocUnsafe(buffer.length);
    for (let i = 0; i + 1 < buffer.length; i += 2) {
      swapped[i] = buffer[i + 1];
      swapped[i + 1] = buffer[i];
    }
    return stripBom(swapped.toString("utf16le"));
  }
  return stripBom(buffer.toString("utf8"));
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pathKind(file: string): "file" | "directory" | "other" {
  try {
    const stats = statSync(file);
    return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
  } catch {
    return "other";
  }
}

/** 日志里用 workspace 相对路径：绝对路径是这台机器的隐私，相对路径才读得懂。 */
function display(workspace: string, file: string): string {
  const rel = relative(workspace, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}

/** 与 executor/cache.ts 同款：绝对路径与 `..` 一律不认。 */
function sanitizeRelativePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed) || trimmed.split(/[\\/]+/).includes("..")) return null;
  return trimmed;
}
