import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PlatformClient } from "./client.js";
import { expandGlob, hasGlobMetachar } from "./report/glob.js";

/**
 * 产物上传（P4.5-7，8.2 接口 5 的消费侧）。
 *
 * 流程：artifact_paths 展开（支持 `*` / `?` / `**` glob，与 report/parse.ts 同一套
 * 展开器）→ 逐文件申请直传目标 → **直传对象存储**（字节不经过平台 API 进程，边界 14
 * 的硬约束在 Runner 侧的对应物就是「别把文件塞进任何 JSON 请求体」）。
 *
 * 上传时机在 **complete 之后**：产物是 best-effort 的收尾件，终态永远优先——一个
 * 200MB 报告传一半失败，不该让 run 卡在等终态。平台侧申请接口在终态后仍收
 * （routes/runners.ts 的注释），两边对「complete 先、产物后」达成一致。
 *
 * 整体 best-effort：单个文件失败记 job 日志继续下一个，绝不改变 job 终态（报告解析
 * 同款纪律）；全部失败也只降级（执行详情页产物列表短一截），run 的成败由退出码说了算。
 */

/** 单个产物的最大字节数：与服务端申请接口的 1GB 上限同一个数，先在本地挡掉。 */
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

/** 展开后的文件总数上限（防一条「双星斜杠星」的整仓 glob 把所有文件都递上来）。 */
const MAX_FILES = 64;

/** 展开后的总字节数上限：一次任务把 100GB 递上来是配置错误，不是数据。 */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

export type UploadedArtifact = {
  name: string;
  size_bytes: number;
  checksum: string;
};

export async function uploadArtifacts(deps: {
  client: PlatformClient;
  jobId: string;
  runnerId: string;
  workspace: string;
  artifactPaths: string[];
  log: (line: string) => void;
}): Promise<UploadedArtifact[]> {
  const files = await expandArtifactFiles(deps.workspace, deps.artifactPaths, deps.log);
  if (!files.length) return [];

  const uploaded: UploadedArtifact[] = [];
  let totalBytes = 0;
  for (const file of files) {
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch (error) {
      deps.log(`artifact: ${file} stat failed (${error instanceof Error ? error.message : String(error)}); skipped`);
      continue;
    }
    if (size > MAX_ARTIFACT_BYTES) {
      deps.log(`artifact: ${file} is ${size} bytes, over the 1GB per-file cap; skipped`);
      continue;
    }
    if (totalBytes + size > MAX_TOTAL_BYTES) {
      deps.log("artifact: total size budget exhausted; remaining files skipped");
      break;
    }

    try {
      /* checksum 在读文件时顺带算，不读第二遍。 */
      const checksum = await hashFile(file);
      const target = await deps.client.requestArtifactUpload(deps.jobId, deps.runnerId, {
        kind: "file",
        name: basename(file),
        size_bytes: size,
        content_type: guessContentType(file),
        checksum,
      });
      const body = await readFileBuffered(file);
      await withRetry(() => deps.client.uploadArtifact(target, body));
      /* 确认走 best-effort：fs 驱动幂等回 ok；s3 驱动不确认会让 uploaded_at 恒空、
         产物列表与报告装载一起饿死。失败只记日志，不当上传失败处理（对象已在）。 */
      try {
        await deps.client.confirmArtifactUploaded(target.artifact_id, deps.runnerId);
      } catch (error) {
        deps.log(`artifact: confirm failed for ${basename(file)} (${error instanceof Error ? error.message : String(error)}); the object may need manual reconciliation`);
      }
      totalBytes += size;
      uploaded.push({ name: basename(file), size_bytes: size, checksum });
      deps.log(`artifact: uploaded ${basename(file)} (${size} bytes)`);
    } catch (error) {
      deps.log(`artifact: ${basename(file)} upload failed (${error instanceof Error ? error.message : String(error)}); skipped`);
    }
  }
  return uploaded;
}

/* ── 展开 ─────────────────────────────────────────────────────────────────── */

async function expandArtifactFiles(
  workspace: string,
  paths: string[],
  log: (line: string) => void,
): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const entry of paths) {
    const relative = sanitize(entry);
    if (!relative) {
      log(`artifact: ignore malformed path ${JSON.stringify(entry)}`);
      continue;
    }
    const matches = hasGlobMetachar(relative)
      ? expandGlob(workspace, relative)
      : { matches: [join(workspace, relative)], capped: false };
    for (const match of matches.matches) {
      if (seen.has(match)) continue;
      seen.add(match);
      if (files.length >= MAX_FILES) {
        log(`artifact: file list capped at ${MAX_FILES}; remaining matches skipped`);
        return [];
      }
      files.push(match);
    }
  }

  /* glob 已是文件/目录级；目录（allure-results/ 这类字面写法）展开到文件。 */
  const resolved: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || resolved.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        if (resolved.length >= MAX_FILES) return;
        resolved.push(full);
      }
    }
  };
  for (const file of files) {
    let stats;
    try {
      stats = statSync(file);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(file, 0);
    else if (stats.isFile()) resolved.push(file);
  }
  return resolved;
}

/** 与 executor/cache.ts 同款：绝对路径与 `..` 一律不认（JobSpec 来自网络）。 */
function sanitize(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.split(/[\\/]+/).includes("..")) return null;
  return trimmed;
}

/* ── 工具 ──────────────────────────────────────────────────────────────────── */

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const reader = createReadStream(file);
    reader.on("data", (chunk) => hash.update(chunk));
    reader.on("end", () => resolve());
    reader.on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * 整文件读进内存再传：1GB 上限内最简单的形状（Node 的 fetch 不接受 Node stream，
 * 转换要再引一个 polyfill——为一个收尾件不值）。到了「单文件过 GB」的量级，该做的是
 * 调小任务的 artifact_paths，不是在这里上流式。
 */
async function readFileBuffered(file: string): Promise<Uint8Array> {
  return new Uint8Array(readFileSync(file));
}

async function withRetry(attempt: () => Promise<void>, tries = 3): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await attempt();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (i + 1)));
    }
  }
  throw lastError;
}

/** 只有几种常见格式值得猜，其余一律 octet-stream（浏览器下载时不乱猜渲染方式）。 */
function guessContentType(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}
