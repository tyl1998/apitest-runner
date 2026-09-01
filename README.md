# apitest-runner

ApiTrack 平台的自研 CI Runner（P4.5）。部署在**能访问被测服务**的那台机器上，主动外连
平台领取任务：clone 仓库 → 跑用户脚本 → 按 offset 推日志 → 上报终态。平台永不反向
连接它，所以这台机器只需要**出站 443**——待在 NAT 后面也可以。

协议是冻结的 Runner 协议 v1.0（`DEVELOPMENT_PLAN.md` §8.2）：`POST /runner/register |
claim | jobs/:id/heartbeat | jobs/:id/logs | jobs/:id/complete`，认证
`Authorization: Bearer apirunner_…`。

## 部署

前置：Node ≥ 20、`git`（每个任务都要 clone，硬前置）、`ssh`（只有 `ssh_key` 拉取方式的
任务需要）。

```bash
# 1. 平台「系统管理 → Runner」签发注册 Token（明文只出现一次）
# 2. 在目标机器上：
pnpm install && pnpm build
cp .env.example .env        # 填 URL / Token / 分区标签
./start.sh                  # 后台启动；./start.sh fg 前台调试
./start.sh status           # 运行状态；stop / restart 同形
```

`start.sh` 从 `.env` 补缺环境变量（shell 里已导出的优先）、把日志追加到 `runner.log`
（pid 记在 `.runner.pid`）、启动失败时翻出最后 20 行日志；`stop` 发 SIGTERM 后按
「收尾宽限 + 90s」等待——Runner 自己会停止领取、等在途任务收尾、超宽限杀进程树并按
`aborted` 补报，然后才退出。平台在自签证书反代后面时，给 `APITRACK_RUNNER_CA_BUNDLE`
一个 PEM 路径，脚本会注入 `NODE_EXTRA_CA_CERTS`。

不用脚本：`APITRACK_RUNNER_URL=… APITRACK_RUNNER_TOKEN=… pnpm start`（或 `pnpm dev`）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `APITRACK_RUNNER_URL` | 必填 | 平台根地址（不带 `/api/v1`，`/runner/*` 挂在根上） |
| `APITRACK_RUNNER_TOKEN` | 必填 | `apirunner_…` 注册 Token |
| `APITRACK_RUNNER_NAME` | `runner@<hostname>` | register 幂等于 (token, name)，**改名字等于换一台机器**（在途任务的补报会 403） |
| `APITRACK_RUNNER_LABELS` | `default` | 逗号分隔；必须是 Token 允许的标签子集（服务端注册时校验） |
| `APITRACK_RUNNER_CAPACITY` | `1` | 同时跑几个 job（1–64） |
| `APITRACK_RUNNER_DATA_DIR` | `~/.apitrack-runner` | workspace / 缓存 / 崩溃恢复状态的根目录；Docker 部署指到卷上 |
| `APITRACK_RUNNER_SHELL` | `/bin/bash` 或 `/bin/sh` | 跑用户脚本的 shell |
| `APITRACK_RUNNER_SHUTDOWN_GRACE_SECONDS` | `30` | SIGTERM 后等在途任务自然收尾的上限，超时杀进程树并按 `aborted` 补报 |
| `APITRACK_RUNNER_COMPLETE_RETRY_SECONDS` | `300` | complete 重试窗口；窗口耗尽仍失败则保留状态目录，下次启动补报 |
| `APITRACK_RUNNER_CA_BUNDLE` | — | **start.sh 的变量**（进程本身不读）：PEM 路径，注入 `NODE_EXTRA_CA_CERTS` 以打通自签证书的平台 |

注意：Runner 自己的配置用 `APITRACK_RUNNER_*` 前缀。`APITRACK_URL` / `APITRACK_TOKEN` /
`APITRACK_CI_RUN_ID` 是平台注入**用户脚本**的 SDK 三件套，两个命名空间不共享。

## 数据目录布局

```
<data>/jobs/<job_id>/          一次性 job 目录，任务收尾即删
  state.json                   阶段 / commit / 日志水位 / 终态 / 报告 cases（崩溃恢复的账本）
  exit_code                    子进程自然退出才写（被杀不写）
  workspace/                   clone 目标 + 用户脚本的工作目录
  script.sh                    任务 steps 原样写成的脚本文件
  deploy_key / git-askpass.sh  临时凭据件，finally 删除（绝不写进 ~/.ssh/）
<data>/cache/<ci_task_id>/<key>/   依赖缓存，按 key_files 内容 hash 分目录
```

## 安全边界（读部署这份之前先读这一节）

**进程档是一个信任声明，不是「轻量模式」**（计划 8.0 边界 15）：选它等于声明「我信任这个
仓库里的脚本，就像信任一个传统 CI agent 上的脚本一样」。它**没有** CPU/内存/磁盘限额、
**没有**网络隔离（脚本可以访问这台机器能访问的一切，包括平台下发的凭据）、**没有**文件
系统隔离。容器档（P4.5-10）落地后才是任务级默认。

凭据处理（边界 11 的三条缓解，全部硬性）：

- 仓库凭据只随 claim 响应体到达这台机器的**内存**，不落任何日志（错误输出里有兜底脱敏）；
- `ssh_key` 写成 job 目录里的 0600 临时文件，`GIT_SSH_COMMAND` 指向它，任务结束删除；
- `https_token` 经 `GIT_ASKPASS` 注入——不嵌 URL（`ps` 会泄露）、不进 `.git/config`
  （会随 workspace 落盘到任务结束）。凭据含 `:` 读作 `user:password`（GitLab 的
  `oauth2:<token>`），否则整个当用户名（GitHub PAT 写法）。

secret 脱敏的能力边界（边界 12，必须照实说）：只做**原文逐行替换**——`echo $MY_TOKEN`
在平台日志里是掩码；`echo $MY_TOKEN | base64` **挡不住**。短于 4 个字符的值不参与替换
（误伤大于风险）。任务 `secrets` 以环境变量注入用户脚本。

## 运行语义

- **超时**：`timeout_seconds` 覆盖整个 job（clone 吃掉的时间算在内），到点杀**整个进程
  组**（detached + 负 pid），脚本里 `&` 起的后台进程也一起死；终态 `timed_out`。
- **取消**：只经心跳响应下发（`{cancel: true}`），收到即杀进程组，终态 `canceled`
  （平台侧状态 `cancelling` → `canceled`）。最长延迟一个心跳间隔。
- **崩溃恢复**（退出码落盘，边界 8）：子进程退出码写进 job 目录；Runner 被 `kill -9`
  后重启，启动时扫描残留目录补报——`final_status` 已落盘按落盘值；只有 `exit_code`
  文件按退出码推导成功/失败；都没有则报 `aborted`（读不到才判 aborted）。
- **日志续传**：按字节 offset 幂等上报（服务端 `UNIQUE (run, byte_offset)` 去重）；
  断线重发同一段，服务端要么没收到要么幂等收，不丢不重。
- **缓存**：`cache_paths` 软链进 workspace，脚本写进这些路径的内容天然落缓存；
  key 是 `cache_key_files` 内容的 hash（挂 `ci_task_id` 名下）。**key_files 为空则禁用
  缓存**——没有失效依据的缓存是永不失效的脏缓存。
- **勾选执行**：JobSpec 带 `case_filter` 时注入 `APITRACK_CASE_KEYS`（逗号分隔）到
  用户脚本环境；脚本是无视它全量跑还是只跑选中，由脚本自己决定，平台用 `not_run`
  差集兜底（P4.5-9 贯通树侧）。
- **报告解析**（P4.5-6，边界 13 的 B/C 路径）：任务配了 `reportFormat`（junit /
  allure）时，脚本自然退出后按 `reportPaths` 收集报告文件（字面相对路径或 glob，
  `*` / `?` / `**`），解析成 case 级结果随 `complete` 上报进 `pipeline_run_cases`。
  - junit：`suite_name` = 最近一层 `<testsuite name>`；`guessed_case_key` =
    `classname::name`（best-effort 猜测，平台**绝不**拿它回写用例树——树上
    `last_result` 只有 SDK 上报路径能碰）；状态由 `<failure>/<error>/<skipped>`
    子元素定，都没有即 passed。
  - allure：只解析结果目录 / glob 匹配到的 `*-result.json`，不跑
    `allure generate`、不托管静态站点；`broken` / `unknown` 归 `error`。
  - 只有脚本**自然退出**才解析——被取消 / 超时 / 停机杀掉的会话写不出完整报告。
  - 解析绝不改变 job 终态：坏文件、缺文件都只记一行 job 日志，产出零条 case。
  - message 先过 secret 脱敏再上报（与日志同一条纪律）；case 名等标识符不脱敏
    （它们是幂等去重键的一部分）。
  - 护栏：单文件 64MB、共 1024 个文件、20000 条 case、cases 载荷 6MB（服务端
    complete 的 bodyLimit 是 8MB）；任一触顶截断并写进 job 日志。

## 本版未做（后续批次）

| 能力 | 批次 |
|---|---|
| 产物上传（pre-signed URL 直传对象存储） | P4.5-7 |
| 容器档（docker run + 资源限额 + 出站白名单） | P4.5-10 |

## 开发

```bash
pnpm check    # tsc --noEmit
pnpm build    # dist/
pnpm dev      # tsx watch
```

零运行时依赖：HTTP 用 Node 自带 fetch，进程控制用 `node:child_process`，加密用
`node:crypto`。协议类型在 `src/protocol.ts`，与 `apitest-server/src/lib/jobSpec.ts`
的 `JobSpec` 由人眼对齐。
