#!/usr/bin/env bash
# apitest-runner 停止脚本（与 ./start.sh stop 同一套语义的独立入口）。
# 用法:
#   ./stop.sh            # 优雅停止：SIGTERM，Runner 自己等在途任务收尾后退出
#   ./stop.sh --force    # 快停：SIGTERM 后最多等 10s 就 SIGKILL（在途任务按 aborted 由下次启动补报）
#
# 停机等待 = Runner 自己的收尾宽限 + 余量（与 start.sh stop 一致）：
# SIGTERM 后它先停止领取、等在途 job 收尾、超宽限杀进程树并按 aborted 补报，然后才退出。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/.runner.pid"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=1 ;;
    *)
      echo "未知参数: $arg (支持 -f | --force)" >&2
      exit 1
      ;;
  esac
done

runner_pid() {
  cat "$PID_FILE" 2>/dev/null || true
}

# pidfile 里的 pid 可能已被系统复用，动手前确认它还是本 Runner（命令行里带 $ROOT 路径）。
looks_like_runner() {
  local cmd
  cmd="$(ps -p "$1" -o command= 2>/dev/null)" || return 1
  case "$cmd" in
    *"$ROOT"*) return 0 ;;
    *) return 1 ;;
  esac
}

# 从最深的孩子往上杀: 超时强杀 Runner 时没人替它收尾，把它派生的 job 子进程一并 TERM 掉。
kill_tree() {
  local pid="$1"
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
}

do_stop() {
  local pid grace wait_seconds waited
  pid="$(runner_pid)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null || ! looks_like_runner "$pid"; then
    if [ -n "$pid" ]; then
      echo "pidfile 记录的 pid $pid 已不是 Runner，视为残留记录"
    else
      echo "无 pidfile 记录"
    fi
    rm -f "$PID_FILE"
    return 0
  fi

  grace="${APITRACK_RUNNER_SHUTDOWN_GRACE_SECONDS:-30}"
  case "$grace" in
    ''|*[!0-9]*) grace=30 ;;
  esac
  if [ "$FORCE" -eq 1 ]; then
    wait_seconds=10
  else
    wait_seconds=$((grace + 90))
  fi
  echo "停止 Runner (pid $pid)：SIGTERM，最多等 ${wait_seconds}s（在途任务收尾）"
  kill -TERM "$pid" 2>/dev/null || true
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$wait_seconds" ]; then
      echo "等待超时，SIGKILL（残留状态由下次启动的补报与平台租约回收兜底）" >&2
      # 先杀孩子再杀父：父一死孩子就被 init 收养，pgrep -P 就找不到了
      kill_tree "$pid"
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done
  rm -f "$PID_FILE"
  echo "已停止"
}

# 兜底: pidfile 之外可能还有活口(如 pidfile 被删过、手动用绝对路径起的)。
# 只用带 apitest-runner 路径前缀的模式——"watch src/index.ts" 这类会误杀 apitest-server 的 API 进程。
LEFTOVER=0
cleanup() {
  local pattern="$1" label="$2" pids
  pids="$(pgrep -f "$pattern" 2>/dev/null)" || true
  if [ -z "$pids" ]; then
    return 0
  fi
  LEFTOVER=1
  echo "清理残留 $label (pid $(printf '%s ' $pids))"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
}

do_stop

cleanup "apitest-runner/dist/index.js" "dist 产物进程"
cleanup "apitest-runner/src/index.ts" "tsx 进程"

# 给兜底清理的进程 2 秒退场时间，还活着就补一刀 KILL
if [ "$LEFTOVER" -eq 1 ]; then
  sleep 2
  pkill -KILL -f "apitest-runner/dist/index.js" 2>/dev/null || true
  pkill -KILL -f "apitest-runner/src/index.ts" 2>/dev/null || true
fi

echo "完成（平台四个服务与 Postgres/Redis 不受影响）"
