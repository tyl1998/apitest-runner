import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * report_paths 的展开器（P4.5-6）。
 *
 * 服务端只挡了绝对路径与 `..`（routes/ciTasks.ts 的 validatePathList），从没承诺过
 * 「不是 glob」——`reports/*.xml` 这种写法必须能工作：报告文件名通常带时间戳，
 * 只支持精确文件名等于让用户每次跑完手改任务配置。
 *
 * 只支持 `*`（段内任意字符）、`?`（段内单个字符）、`**`（整段，跨目录，也匹配零段）。
 * 字符类、大括号展开故意不做：每多支持一种语法，「这条路径为什么没匹配上」就多一种
 * 答案，而报告路径的复杂度不值得为它开这个口。
 *
 * 字面路径（无通配符）不走这里——由调用方 existsSync 直判（跟随软链：用户把
 * allure-results 软链到别处是合法布局）。glob 逐段 readdir，**不**跟随目录软链，
 * 环形软链在这里天然无路可走。
 */

/** glob 打错的防手误护栏：一条 pattern 最多产出这么多匹配，横扫全仓库时宁可少解析
 *  并留一条日志，也不把解析预算花在几万个无关文件上。 */
const MAX_MATCHES = 256;

/** 目录深度上限：真实仓库不会超过它；防御的是恶意/畸形仓库把递归堆栈吃穿。 */
const MAX_DEPTH = 64;

const GLOB_METACHARS = /[*?]/;

export function hasGlobMetachar(pattern: string): boolean {
  return GLOB_METACHARS.test(pattern);
}

/**
 * 展开一条 glob（相对 root 的路径），返回匹配到的绝对路径——文件与目录都返回，
 * 由调用方按报告格式决定怎么消费（junit 只认文件，allure 的目录要进去扫
 * `*-result.json`）。`capped` 表示触到 MAX_MATCHES 被截断。
 */
export function expandGlob(root: string, pattern: string): { matches: string[]; capped: boolean } {
  const matches: string[] = [];
  /* `a//b`、尾部 `/` 都归一掉；分隔符同时收 `/` 与 `\`（与 validatePathList 的
     split 同款——Windows 用户写反斜杠不该被当成文件名的一部分）。 */
  const segments = pattern.split(/[/\\]+/).filter(Boolean);
  walk(root, segments, 0, matches);
  return { matches, capped: matches.length >= MAX_MATCHES };
}

function walk(dir: string, segments: string[], depth: number, out: string[]): void {
  if (out.length >= MAX_MATCHES) return;
  if (!segments.length) {
    out.push(dir);
    return;
  }
  if (depth >= MAX_DEPTH) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    /* 目录消失或不可读：这条 pattern 走到这里的分支没有更多匹配，静默收手。 */
    return;
  }

  const [seg, ...rest] = segments;
  if (seg === "**") {
    /* 双星匹配零段（a/双星/b 命中 a/b）或吃掉一段继续双星。写成字面量会提前结束本注释。 */
    walk(dir, rest, depth, out);
    for (const entry of entries) {
      if (out.length >= MAX_MATCHES) return;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(join(dir, entry.name), segments, depth + 1, out);
      }
    }
    return;
  }

  const re = segmentRegExp(seg);
  const last = rest.length === 0;
  for (const entry of entries) {
    if (out.length >= MAX_MATCHES) return;
    if (!re.test(entry.name)) continue;
    const full = join(dir, entry.name);
    if (last) {
      /* 末段匹配到的条目原样交出（软链目录也算命中——类型判定交给调用方的 statSync）。 */
      out.push(full);
    } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walk(full, rest, depth + 1, out);
    }
    /* 末段之前的通配命中了文件：没有下一段可走，跳过（不报错——`*.py` 命中一堆文件
       是正常情况，只有中间段需要目录才能继续）。 */
  }
}

/** 逐段编译：`*`→`[^/]*`、`?`→`[^/]`，其余字符全部转义（段的边界由 walk 保证）。 */
function segmentRegExp(segment: string): RegExp {
  let re = "";
  for (const ch of segment) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += /[.*+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${re}$`);
}
