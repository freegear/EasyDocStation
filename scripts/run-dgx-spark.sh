#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load server env vars for child processes (HF_TOKEN etc.)
if [[ -f "$ROOT_DIR/server/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/server/.env"
  set +a
fi

LOG_DIR="${EASYDOC_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/run-dgx-spark.log"
PID_FILE="$LOG_DIR/dgx-spark.pid"
BE_LOOP_PID_FILE="$LOG_DIR/dgx-be-loop.pid"
BE_LOOP_LOCK_FILE="$LOG_DIR/dgx-be-loop.lock"
BE_LOOP_LOCK_DIR="$LOG_DIR/dgx-be-loop.lockdir"

log() {
  echo "[$(date '+%Y%m%d-%H:%M:%S')][DGX-SPARK] $*"
}

resolve_port_pids() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser -n tcp "$port" 2>/dev/null || true)"
  fi
  echo "$pids" | tr ' ' '\n' | awk 'NF' | sort -u
}

kill_tree() {
  local pid="$1"
  [[ -z "${pid:-}" ]] && return 0
  kill -0 "$pid" >/dev/null 2>&1 || return 0

  local children=""
  if command -v pgrep >/dev/null 2>&1; then
    children="$(pgrep -P "$pid" 2>/dev/null || true)"
  fi

  if [[ -n "${children:-}" ]]; then
    while IFS= read -r child; do
      [[ -z "${child:-}" ]] && continue
      kill_tree "$child"
    done <<< "$children"
  fi

  kill -TERM "$pid" >/dev/null 2>&1 || true
  sleep 0.2
  kill -KILL "$pid" >/dev/null 2>&1 || true
}

kill_by_port() {
  local port="$1"
  local pids=""
  pids="$(resolve_port_pids "$port")"
  if [[ -n "${pids:-}" ]]; then
    log "포트 ${port} 점유 프로세스 정리: ${pids//$'\n'/ }"
    while IFS= read -r pid; do
      [[ -z "${pid:-}" ]] && continue
      kill_tree "$pid"
    done <<< "$pids"
  fi
}

kill_known_processes() {
  # 관련 태스크(프론트/백엔드/루프/런처)를 전부 정리
  pkill -f "scripts/restart-dgx-spark.sh" >/dev/null 2>&1 || true
  pkill -f "scripts/rerun-dgx-spark.sh" >/dev/null 2>&1 || true
  pkill -f "scripts/dev-dgx-spark.sh" >/dev/null 2>&1 || true
  pkill -f "scripts/backend-loop-dgx.sh" >/dev/null 2>&1 || true
  pkill -f "npm run dev:dgx-spark" >/dev/null 2>&1 || true
  pkill -f "npm run start --prefix server" >/dev/null 2>&1 || true
  pkill -f "while true; do npm run start --prefix server" >/dev/null 2>&1 || true
  pkill -f "easydocstation-server@1.0.0 start" >/dev/null 2>&1 || true
  pkill -f "node .*server/index\\.js" >/dev/null 2>&1 || true
  pkill -f "sh -c node index.js" >/dev/null 2>&1 || true
  pkill -f "node index.js" >/dev/null 2>&1 || true
  pkill -f "nodemon[[:space:]].*index\\.js" >/dev/null 2>&1 || true
  pkill -f "concurrently.*Ollama,FE,BE" >/dev/null 2>&1 || true
  pkill -f "$ROOT_DIR/node_modules/.bin/concurrently" >/dev/null 2>&1 || true
  pkill -f "$ROOT_DIR/node_modules/.bin/vite" >/dev/null 2>&1 || true
  pkill -f "node_modules/.bin/vite" >/dev/null 2>&1 || true
  pkill -f "node_modules/concurrently" >/dev/null 2>&1 || true
  pkill -f "scripts/ollama-serve-safe.mjs" >/dev/null 2>&1 || true
}

has_dgx_processes() {
  pgrep -af "$ROOT_DIR/node_modules/.bin/concurrently" >/dev/null 2>&1 && return 0
  pgrep -af "scripts/backend-loop-dgx.sh" >/dev/null 2>&1 && return 0
  pgrep -af "while true; do npm run start --prefix server" >/dev/null 2>&1 && return 0
  pgrep -af "npm run start --prefix server" >/dev/null 2>&1 && return 0
  pgrep -af "node .*server/index\\.js" >/dev/null 2>&1 && return 0
  return 1
}

force_kill_residual_dgx_processes() {
  local pids=""
  pids+=$'\n'"$(pgrep -f "$ROOT_DIR/node_modules/.bin/concurrently" 2>/dev/null || true)"
  pids+=$'\n'"$(pgrep -f "scripts/backend-loop-dgx.sh" 2>/dev/null || true)"
  pids+=$'\n'"$(pgrep -f "while true; do npm run start --prefix server" 2>/dev/null || true)"
  pids+=$'\n'"$(pgrep -f "npm run start --prefix server" 2>/dev/null || true)"
  pids+=$'\n'"$(pgrep -f "node .*server/index\\.js" 2>/dev/null || true)"

  echo "$pids" | tr ' ' '\n' | awk 'NF' | sort -u | while IFS= read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    kill_tree "$pid"
  done
}

wait_port_free() {
  local port="$1"
  local retries="${2:-20}"
  local delay="${3:-0.5}"
  local i
  for ((i=1; i<=retries; i++)); do
    if [[ -z "$(resolve_port_pids "$port")" ]]; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

stop_all_tasks() {
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid"
    fi
    rm -f "$PID_FILE"
  fi

  rm -f "$BE_LOOP_PID_FILE" "$BE_LOOP_LOCK_FILE"
  rmdir "$BE_LOOP_LOCK_DIR" >/dev/null 2>&1 || true

  # 여러 겹 중복 실행까지 수렴할 때까지 반복 정리
  for _ in 1 2 3 4 5 6 7 8; do
    kill_known_processes
    force_kill_residual_dgx_processes
    kill_by_port 5173
    kill_by_port 3001
    kill_by_port 5001
    sleep 0.5
    has_dgx_processes || true
    if wait_port_free 3001 2 0.2 && wait_port_free 5173 2 0.2; then
      break
    fi
  done
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/run-dgx-spark.sh

Description:
  EasyDocStation을 DGX-SPARK 모드로 백그라운드 실행합니다.
  터미널 로그아웃 후에도 계속 실행됩니다.

Options:
  --status   실행 상태 확인
  --stop     실행 중인 프로세스 중지
  --restart  전체 태스크 정리 후 재실행
EOF
  exit 0
fi

if [[ "${1:-}" == "--status" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      log "실행 중 (PID: $pid)"
      log "로그: $LOG_FILE"
      exit 0
    fi
  fi
  log "실행 중이 아닙니다."
  exit 1
fi

if [[ "${1:-}" == "--stop" ]]; then
  stop_all_tasks

  if ! wait_port_free 3001 30 0.5; then
    log "경고: 포트 3001 점유가 남아 있습니다."
    print_port_holders 3001
  fi
  if has_dgx_processes; then
    log "경고: 일부 DGX 실행 프로세스가 남아 있습니다."
    pgrep -af "$ROOT_DIR/node_modules/.bin/concurrently" || true
    pgrep -af "scripts/backend-loop-dgx.sh" || true
    pgrep -af "npm run start --prefix server" || true
    pgrep -af "node .*server/index\\.js" || true
  fi
  log "중지 완료"
  exit 0
fi

if [[ "${1:-}" == "--restart" ]]; then
  stop_all_tasks
fi

if [[ ! -f "$ROOT_DIR/server/.env" ]]; then
  echo "[$(date '+%Y%m%d-%H:%M:%S')][ERROR] server/.env 파일이 없습니다."
  echo "[$(date '+%Y%m%d-%H:%M:%S')][ERROR] 먼저 설치를 실행하세요: bash scripts/install-dgx-spark.sh"
  exit 1
fi

print_port_holders() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser -n tcp "$port" 2>/dev/null || true)"
  fi
  pids="$(echo "$pids" | tr ' ' '\n' | awk 'NF' | sort -u)"
  if [[ -z "${pids:-}" ]]; then
    log "포트 ${port} 점유 프로세스 없음"
    return 0
  fi
  log "포트 ${port} 점유 프로세스 상세:"
  while IFS= read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    ps -p "$pid" -o pid=,user=,comm=,args= 2>/dev/null | sed "s/^/[$(date '+%Y%m%d-%H:%M:%S')][DGX-SPARK]   /" || true
  done <<< "$pids"
}

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    log "이미 실행 중입니다. (PID: $old_pid)"
    log "로그: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# start는 항상 전체 태스크를 먼저 정리해서 깨끗한 단일 세션으로 시작한다.
stop_all_tasks

if ! wait_port_free 3001 20 0.5; then
  log "포트 3001 정리가 완료되지 않았습니다. 시작을 중단합니다."
  print_port_holders 3001
  log "수동 정리 후 재시도: bash scripts/run-dgx-spark.sh --stop"
  exit 1
fi

# 3001이 계속 점유되어 있으면 시작 자체를 중단해 무한 루프를 방지한다.
if command -v lsof >/dev/null 2>&1; then
  if lsof -ti tcp:3001 >/dev/null 2>&1; then
    log "포트 3001이 여전히 점유되어 있어 시작을 중단합니다."
    print_port_holders 3001
    log "먼저 정리 후 재시도: bash scripts/run-dgx-spark.sh --stop"
    exit 1
  fi
elif command -v fuser >/dev/null 2>&1; then
  if fuser -n tcp 3001 >/dev/null 2>&1; then
    log "포트 3001이 여전히 점유되어 있어 시작을 중단합니다."
    print_port_holders 3001
    log "먼저 정리 후 재시도: bash scripts/run-dgx-spark.sh --stop"
    exit 1
  fi
fi

log "백그라운드 실행 시작"
log "로그: $LOG_FILE"

nohup env EASYDOC_DAEMON_MODE=1 bash "$ROOT_DIR/scripts/dev-dgx-spark.sh" >>"$LOG_FILE" 2>&1 < /dev/null &
new_pid=$!
disown "$new_pid" >/dev/null 2>&1 || true
echo "$new_pid" > "$PID_FILE"

sleep 1
if kill -0 "$new_pid" 2>/dev/null; then
  log "실행 성공 (PID: $new_pid)"
  log "종료 명령: bash scripts/run-dgx-spark.sh --stop"
  exit 0
fi

log "실행 실패. 로그를 확인하세요: $LOG_FILE"
rm -f "$PID_FILE"
exit 1
