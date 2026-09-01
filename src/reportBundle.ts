import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { PlatformClient } from "./client.js";
import { ZipWriter } from "./report/zip.js";

/**
 * allure-results 报告包上传（P4.5-13，边界 19 的报告层）。
 *
 * `collectAllureResultDirs` 触到的每个目录**整体**进 zip（result / container /
 * attachment 文件同目录是 allure 的正常布局——只挑 `-result.json` 会把 steps 与附件
 * 全部丢掉，报告视图就退化成 cases 列表）。名字用 workspace 相对路径，平台侧按
 * 「去前缀后的文件名」解析，包内布局对读取方是平的。
 *
 * 与 uploader.ts 的 artifact_paths 同一条 best-effort 纪律：失败记日志、不碰终态。
 * 与它分开是因为**触发条件不同**——artifact_paths 是用户显式配的，这个是
 * report_format='allure' 时的平台行为，不该让用户为平台自己的渲染需求配一遍路径。
 */

/** 单个报告包的字节数上限：对齐 uploader 的单文件 1GB 硬顶。 */
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;

/** 报告包内的文件总数上限：与 MAX_FILES 同量级，防一条 glob 匹配出整仓。 */
const MAX_BUNDLE_FILES = 4096;

export async function uploadAllureReportBundle(deps: {
  client: PlatformClient;
  jobId: string;
  runnerId: string;
  workspace: string;
  resultDirs: string[];
  log: (line: string) => void;
}): Promise<void> {
  const { client, jobId, runnerId, workspace, resultDirs, log } = deps;
  if (!resultDirs.length) return;

  const zip = new ZipWriter();
  const seen = new Set<string>();
  let total = 0;
  let files = 0;
  let capped = false;

  for (const dir of resultDirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      log(`report-bundle: ${relative(workspace, dir) || dir} could not be listed (${error instanceof Error ? error.message : String(error)}); skipped`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (files >= MAX_BUNDLE_FILES || total >= MAX_BUNDLE_BYTES) {
        capped = true;
        break;
      }
      const full = join(dir, entry.name);
      /* 多目录匹配同一文件（两个 pattern 交叠）时用包内路径去重。 */
      const zipName = relative(workspace, full).split("\\").join("/");
      if (seen.has(zipName)) continue;
      let size: number;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (total + size > MAX_BUNDLE_BYTES) {
        capped = true;
        break;
      }
      try {
        const content = readFileSync(full);
        zip.addFile(zipName, content);
        seen.add(zipName);
        total += size;
        files += 1;
      } catch (error) {
        log(`report-bundle: ${zipName} could not be read (${error instanceof Error ? error.message : String(error)}); skipped`);
      }
    }
    if (capped) break;
  }

  if (!files) {
    log("report-bundle: nothing to package; skipped");
    return;
  }
  if (capped) {
    log(`report-bundle: capped at ${files} file(s) / ${total} bytes; report view covers a prefix`);
  }

  const bundle = zip.build();
  const checksum = createHash("sha256").update(bundle).digest("hex");
  try {
    const target = await client.requestArtifactUpload(jobId, runnerId, {
      kind: "report",
      name: "allure-results.zip",
      size_bytes: bundle.byteLength,
      content_type: "application/zip",
      checksum,
    });
    await withRetry(() => client.uploadArtifact(target, new Uint8Array(bundle)));
    log(`report-bundle: uploaded allure-results.zip (${files} files, ${bundle.byteLength} bytes)`);
  } catch (error) {
    log(`report-bundle: upload failed (${error instanceof Error ? error.message : String(error)}); skipped`);
  }
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
