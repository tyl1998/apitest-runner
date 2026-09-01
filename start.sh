#!/usr/bin/env bash
# apitest-runner 启动/停止脚本（部署在自托管机器上用）。
# 用法:
#   ./start.sh            # 后台启动（环境变量可来自 shell 或同目录 .env）
#   ./start.sh fg         # 前台启动，日志直接打到终端（调试用）
#   ./start.sh stop       # 优雅停止：SIGTERM，Runner 自己等在途任务收尾后退出
#   ./start.sh restart    # 停止后再启动
#   ./start.sh status     # 查看运行状态
#
# 环境变量见 README；必填的是 APITRACK_RUNNER_URL 与 APITRACK_RUNNER_TOKEN。
# .env 一行一个 KEY=VALUE，只补缺、不覆盖 shell 里已导出的变量。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/.runner.pid"
LOG_FILE="$ROOT/runner.log"

CMD="${1:-start}"
case "$CMD" in
  start|fg|stop|restart|status) ;;
  *)
    echo "未知命令: $CMD (支持 start | fg | stop | restart | status)" >&2
    exit 1
    ;;
esac

# 企业 CA（平台部署在自签证书反代后面时，Node 的 fetch 会报 SELF_SIGNED_CERT_IN_CHAIN）：
# 给一个 PEM 路径即可，不需要就不设。只在本脚本注入，不进 .env 的说明文档。
if [ -n "${APITRACK_RUNNER_CA_BUNDLE:-}" ] && [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$APITRACK_RUNNER_CA_BUNDLE" ]; then
  export NODE_EXTRA_CA_CERTS="$APITRACK_RUNNER_CA_BUNDLE"
fi

# .env 只补缺：手工 export 的优先级高于文件，方便临时覆盖单个值。
load_env() {
  [ -f "$ROOT/.env" ] || return 0
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      ''|\#*) continue ;;
    esac
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    value="${value%$'\r'}"
    case "$key" in
      ''|*[!A-Za-z0-9_]*) continue ;;
    esac
    if [ -z "${!key:+set}" ]; then
      export "$key=$value"
    fi
  done < "$ROOT/.env"
}

require_env() {
  if [ -z "${APITRACK_RUNNER_URL:-}" ]; then
    echo "缺少 APITRACK_RUNNER_URL（环境变量或 $ROOT/.env）" >&2
    exit 1
  fi
  if [ -z "${APITRACK_RUNNER_TOKEN:-}" ]; then
    echo "缺少 APITRACK_RUNNER_TOKEN（环境变量或 $ROOT/.env）" >&2
    exit 1
  fi
}

# 优先跑构建产物（dist），没有再退回 tsx 现场跑（开发机形状）。
RUNNER_CMD=()
pick_runner_cmd() {
  if [ -f "$ROOT/dist/index.js" ] && command -v node >/dev/null 2>&1; then
    RUNNER_CMD=(node "$ROOT/dist/index.js")
  elif [ -x "$ROOT/node_modules/.bin/tsx" ]; then
    RUNNER_CMD=("$ROOT/node_modules/.bin/tsx" "$ROOT/src/index.ts")
  else
    echo "运行时缺失：先在 $ROOT 执行 pnpm install（跑产物另需 pnpm build）" >&2
    exit 1
  fi
}

runner_pid() {
  cat "$PID_FILE" 2>/dev/null || true
}

is_up() {
  local pid
  pid="$(runner_pid)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

do_start() {
  load_env
  require_env
  if is_up; then
    echo "Runner 已在运行 (pid $(runner_pid))，跳过"
    return 0
  fi
  pick_runner_cmd
  echo "启动 Runner（${RUNNER_CMD[*]}），日志追加到 $LOG_FILE"
  (
    cd "$ROOT"
    nohup "${RUNNER_CMD[@]}" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )
  # 配置错误会在启动一秒内退出（URL/Token 校验、git 缺失），把原因翻出来而不是留一个空 pidfile。
  sleep 1
  if ! is_up; then
    echo "启动失败，最近的日志：" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  echo "已启动 (pid $(runner_pid))"
}

do_stop() {
  if ! is_up; then
    echo "Runner 未在运行"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid grace wait_seconds waited
  pid="$(runner_pid)"
  # 停机等待 = Runner 自己的收尾宽限 + 余量：SIGTERM 后它先停止领取、等在途 job 收尾、
  # 超宽限杀进程树并按 aborted 补报，然后才退出。等不到就强杀（补报由下次启动兜底）。
  grace="${APITRACK_RUNNER_SHUTDOWN_GRACE_SECONDS:-30}"
  case "$grace" in
    ''|*[!0-9]*) grace=30 ;;
  esac
  wait_seconds=$((grace + 90))
  echo "停止 Runner (pid $pid)：SIGTERM，最多等 ${wait_seconds}s（在途任务收尾）"
  kill -TERM "$pid" 2>/dev/null || true
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$wait_seconds" ]; then
      echo "等待超时，SIGKILL（残留状态由下次启动的补报与平台租约回收兜底）" >&2
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done
  rm -f "$PID_FILE"
  echo "已停止"
}

do_status() {
  if is_up; then
    echo "运行中 (pid $(runner_pid))"
  else
    echo "未运行"
    exit 1
  fi
}

case "$CMD" in
  start) do_start ;;
  fg)
    load_env
    require_env
    pick_runner_cmd
    exec "${RUNNER_CMD[@]}"
    ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) do_status ;;
esac
