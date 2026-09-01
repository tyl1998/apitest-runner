import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { assertUuid } from "./workspace.js";

/**
 * 依赖缓存（8.5 进程档）：`cache_paths` 在 Runner 数据目录下按 key 建目录，**软链**进
 * workspace——脚本往 workspace 里的这些路径写的一切，天然就落在缓存目录里，
 * 「未命中安装后回写缓存」不需要第二个回写步骤。
 *
 * key 是 `cache_key_files` 内容的 sha256（这些文件变了缓存自动失效，Spec 2.10.2(b)），
 * 再挂到 `ci_task_id` 名下：不同任务即使依赖清单恰好相同，也不共享缓存目录——
 * 「为什么我的缓存被那个任务弄脏了」是一个不值得开的设计空间。
 *
 * `key_files` 为空时**禁用**缓存而不是用常量 key：没有失效依据的缓存是永不失效的
 * 脏缓存，宁可慢也不错。
 *
 * 整体 best-effort：缓存坏掉（磁盘满、权限、路径畸形）只降级不杀 job——用户脚本的
 * 成败不该由缓存决定。唯一硬失败是 `ci_task_id` 不是 UUID（路径拼接的攻击面）。
 */
export async function prepareCache(deps: {
  dataDir: string;
  ciTaskId: string;
  repoDir: string;
  cache: { paths: string[]; key_files: string[] };
  log: (line: string) => void;
}): Promise<void> {
  const { dataDir, ciTaskId, repoDir, cache, log } = deps;
  if (!cache.key_files.length) {
    log("cache: task has no cache_key_files, caching disabled");
    return;
  }
  assertUuid(ciTaskId, "ci_task_id");

  try {
    const hash = createHash("sha256");
    hash.update(ciTaskId);
    for (const file of cache.key_files) {
      const relative = sanitizeRelativePath(file);
      if (!relative) {
        log(`cache: ignore malformed key_file ${JSON.stringify(file)}`);
        hash.update("\0malformed\0");
        continue;
      }
      hash.update("\0");
      hash.update(relative);
      hash.update("\0");
      /* 文件还没出现（首次运行、装完才有）读作空内容：key 稳定，不被「文件不存在」卡住。 */
      hash.update(existsSafe(join(repoDir, relative)) ? readFileSync(join(repoDir, relative)) : Buffer.alloc(0));
    }
    const key = hash.digest("hex").slice(0, 32);

    if (!cache.paths.length) {
      log(`cache: key ${key}, nothing to link (no cache_paths)`);
      return;
    }

    const cacheRoot = join(dataDir, "cache", ciTaskId, key);
    let hits = 0;
    let linked = 0;
    for (const path of cache.paths) {
      const relative = sanitizeRelativePath(path);
      if (!relative) {
        log(`cache: ignore malformed cache_path ${JSON.stringify(path)}`);
        continue;
      }
      const target = join(repoDir, relative);
      const cacheTarget = join(cacheRoot, relative.replace(/[\\/]+/g, "__"));

      const warm = existsSync(cacheTarget) && readdirSync(cacheTarget).length > 0;
      mkdirSync(cacheTarget, { recursive: true });

      if (existsSafe(target)) {
        let isSymlink = false;
        try {
          isSymlink = lstatSync(target).isSymbolicLink();
        } catch {
          /* 竞态消失就当不存在。 */
        }
        if (!isSymlink) {
          /* 仓库里提交了这个路径（罕见但合法）：保留仓库内容，跳过这一条并说清。 */
          log(`cache: skip ${relative} (exists in repository and is not a symlink)`);
          continue;
        }
        rmSync(target, { force: true, recursive: true });
      }
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(cacheTarget, target, "dir");
      linked += 1;
      if (warm) hits += 1;
    }
    log(`cache: key ${key}, linked ${linked} path(s), ${hits} warm`);
  } catch (error) {
    log(`cache: unavailable (${error instanceof Error ? error.message : error}); continuing without cache`);
  }
}

/** 服务端已挡绝对路径与 `..`（routes/ciTasks.ts），这里再挡一次：JobSpec 来自网络。 */
function sanitizeRelativePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed) || trimmed.split(/[\\/]+/).includes("..")) {
    return null;
  }
  return trimmed;
}

function existsSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
