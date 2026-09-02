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
FE_PID_FILE="$LOG_DIR/easydoc-fe.pid"
BE_PID_FILE="$LOG_DIR/easydoc-be.pid"
OLLAMA_PID_FILE="$LOG_DIR/easydoc-ollama.pid"
BE_LOOP_PID_FILE="$LOG_DIR/dgx-be-loop.pid"
BE_LOOP_LOCK_FILE="$LOG_DIR/dgx-be-loop.lock"
BE_LOOP_LOCK_DIR="$LOG_DIR/dgx-be-loop.lockdir"
ACTION="start"
CONSTRUCT_SAFE_KANBAN_TEMPLATE="${VITE_CONSTRUCT_SAFE_KANBAN_TEMPLATE:-0}"
EASY_CODE_GENERATION_TEMPLATE="${VITE_EASY_CODE_GENERATION_TEMPLATE:-0}"
SHOW_WELCOME_BOARD="${VITE_SHOW_WELCOME_BOARD:-0}"
CASSANDRA_REQUIRED="${CASSANDRA_REQUIRED:-1}"
CASSANDRA_START_TIMEOUT="${CASSANDRA_START_TIMEOUT:-120}"

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
  local wait_count
  for wait_count in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  kill -KILL "$pid" >/dev/null 2>&1 || true
}

resolve_cassandra_target() {
  node -e '
    const fs = require("fs")
    let host = "127.0.0.1"
    let port = "9042"
    try {
      const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"))
      const cass = cfg.Cassandra || cfg.cassandra || {}
      const point = Array.isArray(cass.contactPoints) ? cass.contactPoints[0] : cass.contactPoints
      if (typeof point === "string" && point.trim()) {
        const raw = point.trim()
        const index = raw.lastIndexOf(":")
        if (index > 0 && /^\d+$/.test(raw.slice(index + 1))) {
          host = raw.slice(0, index)
          port = raw.slice(index + 1)
        } else {
          host = raw
        }
      }
    } catch (_) {}
    process.stdout.write(`${host} ${port}`)
  ' 2>/dev/null || echo "127.0.0.1 9042"
}

is_tcp_ready() {
  local host="$1"
  local port="$2"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 "$host" "$port" >/dev/null 2>&1
  else
    timeout 2 bash -c "cat < /dev/null > /dev/tcp/${host}/${port}" >/dev/null 2>&1
  fi
}

run_systemctl() {
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n systemctl "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && [[ -t 0 ]]; then
    log "Cassandra ${1:-제어}를 위해 sudo 인증을 요청합니다."
    sudo systemctl "$@"
    return
  fi
  log "Cassandra 제어에 관리자 권한이 필요합니다."
  log "먼저 실행: sudo systemctl $*"
  return 1
}

print_cassandra_diagnostics() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local active result
  active="$(systemctl is-active cassandra 2>/dev/null || true)"
  result="$(systemctl show cassandra -p Result --value 2>/dev/null || true)"
  log "Cassandra 상태: ${active:-unknown}${result:+ (result: $result)}"
  if [[ "$result" == "oom-kill" ]]; then
    log "Cassandra가 메모리 부족(OOM)으로 종료되었습니다."
    command -v free >/dev/null 2>&1 && free -h | sed "s/^/[$(date '+%Y%m%d-%H:%M:%S')][DGX-SPARK]   /" || true
  fi
}

ensure_cassandra_ready() {
  [[ "$CASSANDRA_REQUIRED" == "1" ]] || return 0
  local host port operation elapsed
  read -r host port <<< "$(resolve_cassandra_target)"
  host="${host:-127.0.0.1}"
  port="${port:-9042}"

  if is_tcp_ready "$host" "$port"; then
    if [[ "$ACTION" != "restart" ]]; then
      log "Cassandra 준비 완료: ${host}:${port}"
      return 0
    fi
  fi

  print_cassandra_diagnostics
  if [[ "$host" != "127.0.0.1" && "$host" != "localhost" && "$host" != "::1" ]]; then
    log "원격 Cassandra ${host}:${port}는 이 스크립트에서 시작할 수 없습니다."
    return 1
  fi
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl cat cassandra >/dev/null 2>&1; then
    log "cassandra.service를 찾을 수 없습니다. Cassandra 설치/컨테이너 상태를 확인하세요."
    return 1
  fi

  operation="start"
  [[ "$ACTION" == "restart" ]] && operation="restart"
  log "Cassandra ${operation} 실행"
  if ! run_systemctl "$operation" cassandra; then
    log "Cassandra ${operation} 실패"
    print_cassandra_diagnostics
    return 1
  fi

  for ((elapsed=0; elapsed<CASSANDRA_START_TIMEOUT; elapsed+=2)); do
    if is_tcp_ready "$host" "$port"; then
      log "Cassandra 준비 완료: ${host}:${port} (${elapsed}초)"
      return 0
    fi
    sleep 2
  done
  log "Cassandra 준비 시간 초과: ${host}:${port} (${CASSANDRA_START_TIMEOUT}초)"
  print_cassandra_diagnostics
  log "상세 확인: sudo journalctl -u cassandra -n 100 --no-pager"
  return 1
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
  # 관련 태스크(프론트/백엔드/루프)를 전부 정리한다.
  # restart/rerun 래퍼를 여기서 pkill 하면 현재 재시작 명령도 자기 자신을
  # 종료해 시작 단계에 도달하지 못하므로, 수명이 짧은 래퍼는 대상에서 제외한다.
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

stop_all_tasks() {
  local task_pid_file pid
  # PID로 추적되는 런처/FE/BE/Ollama wrapper/backend-loop와 그 자식부터 정상 종료한다.
  for task_pid_file in "$PID_FILE" "$FE_PID_FILE" "$BE_PID_FILE" "$OLLAMA_PID_FILE" "$BE_LOOP_PID_FILE"; do
    [[ -f "$task_pid_file" ]] || continue
    pid="$(cat "$task_pid_file" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid"
    fi
    rm -f "$task_pid_file"
  done

  rm -f "$BE_LOOP_PID_FILE" "$BE_LOOP_LOCK_FILE"
  rm -f "$FE_PID_FILE" "$BE_PID_FILE" "$OLLAMA_PID_FILE"
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

verify_app_tasks_stopped() {
  local failed=0
  local port
  for port in 3001 5173 5001; do
    if ! wait_port_free "$port" 20 0.25; then
      failed=1
      log "포트 ${port} 정리가 완료되지 않았습니다."
      print_port_holders "$port"
    fi
  done
  if has_dgx_processes; then
    failed=1
    log "EasyDocStation 관련 프로세스가 남아 있습니다."
  fi
  [[ "$failed" -eq 0 ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      ACTION="help"
      ;;
    --status)
      ACTION="status"
      ;;
    --stop)
      ACTION="stop"
      ;;
    --restart)
      ACTION="restart"
      ;;
    --Construct_safe_kanban_template|--construct-safe-kanban-template|Construct_safe_kanban_template)
      CONSTRUCT_SAFE_KANBAN_TEMPLATE="1"
      ;;
    --EasyCodeGeneration|--easy-code-generation|EasyCodeGeneration)
      EASY_CODE_GENERATION_TEMPLATE="1"
      ;;
    --showWelcomeBoard|--show-welcome-board|showWelcomeBoard)
      SHOW_WELCOME_BOARD="1"
      ;;
    *)
      echo "[$(date '+%Y%m%d-%H:%M:%S')][ERROR] 알 수 없는 옵션: $1"
      echo "[$(date '+%Y%m%d-%H:%M:%S')][ERROR] 도움말: bash scripts/run-dgx-spark.sh --help"
      exit 2
      ;;
  esac
  shift
done

if [[ "$ACTION" == "help" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/run-dgx-spark.sh [options]

Description:
  EasyDocStation을 DGX-SPARK 모드로 백그라운드 실행합니다.
  터미널 로그아웃 후에도 계속 실행됩니다.

Options:
  --status                          실행 상태 확인
  --stop                            실행 중인 프로세스 중지
  --restart                         전체 앱 태스크 정리 및 Cassandra 재시작 후 재실행
  --Construct_safe_kanban_template  Teams 위 Service 섹션에 Construct_Safe_kanban.html 표시
  --EasyCodeGeneration              Teams 위 Service 섹션에 EasyCodeGeneration.html 표시
  --showWelcomeBoard                Service 섹션 최상단에 Welcome 보드(WelcomeBoard_blueThema.html) 표시
EOF
  exit 0
fi

if [[ "$ACTION" == "status" ]]; then
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

if [[ "$ACTION" == "stop" ]]; then
  stop_all_tasks
  verify_app_tasks_stopped || {
    log "일부 태스크를 정리하지 못했습니다."
    exit 1
  }
  log "중지 완료"
  exit 0
fi

if [[ "$ACTION" == "restart" ]]; then
  stop_all_tasks
fi

if [[ ! -f "$ROOT_DIR/server/.env" ]]; then
  echo "[$(date '+%Y%m%d-%H:%M:%S')][ERROR] server/.env 파일이 없습니다."
  echo "[$(date '+%Y%m%d-%H:%M:%S')][ERROR] 먼저 설치를 실행하세요: bash scripts/install-dgx-spark.sh"
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    log "기존 실행을 중지한 뒤 재실행합니다. (PID: $old_pid)"
    stop_all_tasks
  else
    rm -f "$PID_FILE"
  fi
fi

# start는 항상 전체 태스크를 먼저 정리해서 깨끗한 단일 세션으로 시작한다.
stop_all_tasks
if ! verify_app_tasks_stopped; then
  log "기존 태스크 정리가 완료되지 않아 시작을 중단합니다."
  log "수동 정리 후 재시도: bash scripts/run-dgx-spark.sh --stop"
  exit 1
fi

# Cassandra 필수 모드에서는 앱을 띄우기 전에 서비스 상태를 복구하고 CQL 포트를 확인한다.
# --restart는 Cassandra도 명시적으로 재시작해 OOM/failed 상태와 남은 연결을 정리한다.
if ! ensure_cassandra_ready; then
  log "Cassandra가 준비되지 않아 EasyDocStation 시작을 중단합니다."
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
if [[ "$CONSTRUCT_SAFE_KANBAN_TEMPLATE" == "1" ]]; then
  log "Construct_Safe_kanban Service 섹션 활성화"
fi
if [[ "$EASY_CODE_GENERATION_TEMPLATE" == "1" ]]; then
  log "EasyCodeGeneration Service 섹션 활성화"
fi
if [[ "$SHOW_WELCOME_BOARD" == "1" ]]; then
  log "Welcome 보드 Service 섹션 활성화"
fi

log "프론트엔드 프로덕션 빌드 생성 중"
if ! env VITE_CONSTRUCT_SAFE_KANBAN_TEMPLATE="$CONSTRUCT_SAFE_KANBAN_TEMPLATE" \
  VITE_EASY_CODE_GENERATION_TEMPLATE="$EASY_CODE_GENERATION_TEMPLATE" \
  VITE_SHOW_WELCOME_BOARD="$SHOW_WELCOME_BOARD" \
  npm run build >> "$LOG_FILE" 2>&1; then
  log "프론트엔드 빌드 실패. 로그를 확인하세요: $LOG_FILE"
  exit 1
fi
if [[ ! -f "$ROOT_DIR/dist/index.html" ]]; then
  log "프론트엔드 빌드 산출물이 없습니다: $ROOT_DIR/dist/index.html"
  exit 1
fi

setsid env ROOT_DIR="$ROOT_DIR" LOG_FILE="$LOG_FILE" bash -c \
  'cd "$ROOT_DIR" && npm run ollama:serve >> "$LOG_FILE" 2>&1 < /dev/null' \
  >/dev/null 2>&1 &
ollama_pid=$!
disown "$ollama_pid" >/dev/null 2>&1 || true
echo "$ollama_pid" > "$OLLAMA_PID_FILE"

setsid env ROOT_DIR="$ROOT_DIR" LOG_FILE="$LOG_FILE" NODE_ENV="production" SERVE_FRONTEND_DIST="1" SERVE_FRONTEND_PORT="5173" bash -c \
  'cd "$ROOT_DIR" && bash scripts/backend-loop-dgx.sh >> "$LOG_FILE" 2>&1 < /dev/null' \
  >/dev/null 2>&1 &
be_pid=$!
disown "$be_pid" >/dev/null 2>&1 || true
echo "$be_pid" > "$BE_PID_FILE"
echo "$be_pid" > "$PID_FILE"

ready=0
for _ in {1..30}; do
  if ! kill -0 "$be_pid" 2>/dev/null; then
    break
  fi
  if is_tcp_ready 127.0.0.1 3001 && is_tcp_ready 127.0.0.1 5173; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -eq 1 ]]; then
  log "실행 성공 (프로덕션 FE: 5173, API: 3001, PID: $be_pid)"
  log "종료 명령: bash scripts/run-dgx-spark.sh --stop"
  exit 0
fi

log "실행 실패. 로그를 확인하세요: $LOG_FILE"
stop_all_tasks
rm -f "$PID_FILE"
exit 1
