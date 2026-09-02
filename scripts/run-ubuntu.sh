#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${EASYDOC_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/run-ubuntu.log"
PID_FILE="$LOG_DIR/ubuntu.pid"
ACTION="start"

log() {
  echo "[$(date '+%Y%m%d-%H:%M:%S')][UBUNTU] $*"
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

kill_by_port() {
  local port="$1"
  local pids=""
  pids="$(resolve_port_pids "$port")"
  if [[ -z "${pids:-}" ]]; then
    return 0
  fi

  log "포트 ${port} 점유 프로세스 정리: ${pids//$'\n'/ }"
  while IFS= read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    kill_tree "$pid"
  done <<< "$pids"
}

kill_known_processes() {
  # 재시작 래퍼 자체는 제외하고 수명이 긴 앱 프로세스만 정리한다.
  pkill -f "scripts/dev-ubuntu.sh" >/dev/null 2>&1 || true
  pkill -f "scripts/dev-dgx-spark.sh" >/dev/null 2>&1 || true
  pkill -f "scripts/backend-loop-dgx.sh" >/dev/null 2>&1 || true
  pkill -f "node_modules/.bin/concurrently" >/dev/null 2>&1 || true
  pkill -f "node_modules/.bin/vite" >/dev/null 2>&1 || true
  pkill -f "server/node_modules/.bin/nodemon" >/dev/null 2>&1 || true
  pkill -f "scripts/ollama-serve-safe.mjs" >/dev/null 2>&1 || true
}

stop_all_tasks() {
  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid"
    fi
    rm -f "$PID_FILE"
  fi

  # 이전 포그라운드 실행과 다른 실행 모드가 남아 있어도 단일 세션으로 수렴시킨다.
  local attempt
  for attempt in 1 2 3 4; do
    kill_known_processes
    kill_by_port 5173
    kill_by_port 3001
    if [[ -z "$(resolve_port_pids 5173)" && -z "$(resolve_port_pids 3001)" ]]; then
      return 0
    fi
    sleep 0.5
  done

  log "5173 또는 3001 포트를 정리하지 못했습니다."
  return 1
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
    *)
      echo "[$(date '+%Y%m%d-%H:%M:%S')][ERROR] 알 수 없는 옵션: $1"
      echo "[$(date '+%Y%m%d-%H:%M:%S')][ERROR] 도움말: bash scripts/run-ubuntu.sh --help"
      exit 2
      ;;
  esac
  shift
done

if [[ "$ACTION" == "help" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/run-ubuntu.sh [--status|--stop]

Description:
  EasyDocStation Ubuntu 개발 서버를 백그라운드로 실행합니다.
  터미널이나 SSH 연결이 종료된 후에도 계속 실행됩니다.

Options:
  --status  실행 상태 확인
  --stop    실행 중인 프로세스 중지
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
  log "중지 완료"
  exit 0
fi

if [[ ! -f "$ROOT_DIR/server/.env" ]]; then
  log "server/.env 파일이 없습니다."
  log "먼저 설치를 실행하세요: npm run setup:ubuntu"
  exit 1
fi

stop_all_tasks

log "백그라운드 실행 시작"
log "로그: $LOG_FILE"
setsid env ROOT_DIR="$ROOT_DIR" LOG_FILE="$LOG_FILE" bash -c \
  'cd "$ROOT_DIR" && exec bash scripts/dev-ubuntu.sh >> "$LOG_FILE" 2>&1 < /dev/null' \
  >/dev/null 2>&1 &
runner_pid=$!
disown "$runner_pid" >/dev/null 2>&1 || true
echo "$runner_pid" > "$PID_FILE"

ready=0
for _ in {1..45}; do
  if ! kill -0 "$runner_pid" 2>/dev/null; then
    break
  fi
  if is_tcp_ready 127.0.0.1 5173 && is_tcp_ready 127.0.0.1 3001; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -eq 1 ]]; then
  log "실행 성공 (개발 FE: 5173, API: 3001, PID: $runner_pid)"
  log "상태 확인: bash scripts/run-ubuntu.sh --status"
  log "종료 명령: bash scripts/run-ubuntu.sh --stop"
  exit 0
fi

log "실행 실패. 로그를 확인하세요: $LOG_FILE"
stop_all_tasks || true
exit 1
