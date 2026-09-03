import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ContainerTransport } from "./executor/container/runtime.js";

/**
 * Runner 配置，全部来自环境变量（自托管机器上没有「改一行代码重启」这个选项）。
 *
 * 前缀是 `APITRACK_RUNNER_*` 而不是照抄 SDK 的 `APITRACK_*`：JobSpec.env 会把
 * `APITRACK_URL` / `APITRACK_TOKEN` / `APITRACK_CI_RUN_ID` 注进**用户脚本的**环境，
 * Runner 自己的进程环境必须与那份命名空间隔开，否则一次误配就把上报 Token 当成了
 * 平台地址。
 */
export type RunnerConfig = {
  /** 平台根地址，如 https://apitrack.example.com（不带 /api/v1——`/runner/*` 挂在根上）。 */
  baseUrl: string;
  /** `apirunner_…` 注册 Token 明文（系统管理员签发，创建响应里只出现一次）。 */
  token: string;
  /** Runner 自报的名字；register 幂等于 (token, name)，改名字等于换一台机器。 */
  name: string;
  labels: string[];
  capacity: number;
  /** 工作区 / 缓存 / 崩溃恢复状态的根目录。Docker 部署时把它指到卷上。 */
  dataDir: string;
  /** 跑用户脚本的 shell（steps 是一整段 shell 文本，Spec 2.10.2(d)）。 */
  shell: string;
  /** 收到 SIGTERM 后等在途任务收尾的上限，超时则杀进程树并按 aborted 补报。 */
  shutdownGraceSeconds: number;
  /** complete 重试窗口：窗口内失败则保留状态目录，等下次启动补报（边界 8）。 */
  completeRetrySeconds: number;
  /** 容器档（P4.5-10）：docker CLI 命令（ podman 别名时指到这里）。`"off"` 显式关。 */
  dockerCommand: string;
  /** 容器档通道（P4.5-10b）：`cli` 走 `docker run`（默认），`api` 走 Engine API over unix socket。 */
  dockerTransport: ContainerTransport;
  /** `api` 通道的 socket 路径；`cli` 通道不读这一格。 */
  dockerSocket: string;
  /** 容器档：镜像里跑脚本的 shell（挂进去的 script.sh 用它执行）。 */
  imageShell: string;
  /** 容器档：是否给容器挂缓存卷（缓存目录直挂，不靠软链——容器里软链指向宿主路径不通）。 */
  containerCacheEnabled: boolean;
};

const DEFAULT_SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function loadConfig(): { config?: RunnerConfig; errors: string[] } {
  const errors: string[] = [];
  const baseUrl = (process.env.APITRACK_RUNNER_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) errors.push("APITRACK_RUNNER_URL is required (platform root, e.g. https://apitrack.example.com)");
  else if (!/^https?:\/\//.test(baseUrl)) errors.push("APITRACK_RUNNER_URL must start with http:// or https://");

  const token = (process.env.APITRACK_RUNNER_TOKEN ?? "").trim();
  if (!token) errors.push("APITRACK_RUNNER_TOKEN is required (apirunner_…, issued by a system admin)");
  else if (!token.startsWith("apirunner_")) errors.push("APITRACK_RUNNER_TOKEN must start with apirunner_");

  const labels = (process.env.APITRACK_RUNNER_LABELS ?? "default")
    .split(",")
    .map((each) => each.trim())
    .filter(Boolean);
  if (!labels.length) errors.push("APITRACK_RUNNER_LABELS resolved to an empty set");

  if (errors.length) return { errors };

  return {
    config: {
      baseUrl,
      token,
      name: (process.env.APITRACK_RUNNER_NAME ?? "").trim() || `runner@${hostname()}`,
      labels: [...new Set(labels)],
      /* 上限 64 对齐服务端的 clamp（routes/runners.ts）：两边各猜一个数只会互相打架。 */
      capacity: readInt("APITRACK_RUNNER_CAPACITY", 1, 1, 64),
      dataDir: (process.env.APITRACK_RUNNER_DATA_DIR ?? "").trim() || join(homedir(), ".apitrack-runner"),
      shell: (process.env.APITRACK_RUNNER_SHELL ?? "").trim() || DEFAULT_SHELL,
      shutdownGraceSeconds: readInt("APITRACK_RUNNER_SHUTDOWN_GRACE_SECONDS", 30, 1, 3600),
      completeRetrySeconds: readInt("APITRACK_RUNNER_COMPLETE_RETRY_SECONDS", 300, 10, 86_400),
      /* 容器档三件（P4.5-10）："off" 是显式关闭（不探测、不自报）；缺省 "docker" 但
         探测失败也只是不自报 container，进程档照常工作。imageShell 独立于 shell：
         镜像的文件系统与宿主无关（busybox 镜像没有 bash）。缓存卷默认开——挂卷与
         软链不冲突（容器档走挂卷路径，prepareCache 的软链只在进程档消费）。 */
      dockerCommand: (process.env.APITRACK_RUNNER_DOCKER ?? "").trim() || "docker",
      /* 通道选择（P4.5-10b）：默认 cli——它把 create→attach→start 的时序、流的解复用、
         限额单位换算都做好了，且日志里那行 `docker run …` 用户能直接复现。选 api 的
         唯一硬理由是 OOMKilled 的确定性判定（cli 在 --rm 下拿不到 inspect 窗口）。
         非法值静默回落 cli 而不是报错：这一格配错不该让整台 Runner 起不来。 */
      dockerTransport: (process.env.APITRACK_RUNNER_DOCKER_TRANSPORT ?? "").trim().toLowerCase() === "api"
        ? ("api" as ContainerTransport)
        : ("cli" as ContainerTransport),
      dockerSocket: (process.env.APITRACK_RUNNER_DOCKER_SOCKET ?? "").trim() || "/var/run/docker.sock",
      imageShell: (process.env.APITRACK_RUNNER_IMAGE_SHELL ?? "").trim() || "/bin/sh",
      containerCacheEnabled: readBool("APITRACK_RUNNER_CONTAINER_CACHE", true),
    },
    errors,
  };
}
