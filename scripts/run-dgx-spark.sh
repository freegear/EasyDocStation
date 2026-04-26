#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${EASYDOC_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/run-dgx-spark.log"
PID_FILE="$LOG_DIR/dgx-spark.pid"

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
    echo "[DGX-SPARK] 포트 ${port} 점유 프로세스 정리: ${pids//$'\n'/ }"
    while IFS= read -r pid; do
      [[ -z "${pid:-}" ]] && continue
      kill_tree "$pid"
    done <<< "$pids"
  fi
}

kill_known_processes() {
  # 경로/실행 방식이 달라도 매칭되도록 폭넓게 정리
  pkill -f "scripts/dev-dgx-spark.sh" >/dev/null 2>&1 || true
  pkill -f "scripts/backend-loop-dgx.sh" >/dev/null 2>&1 || true
  pkill -f "npm run dev:dgx-spark" >/dev/null 2>&1 || true
  pkill -f "npm run start --prefix server" >/dev/null 2>&1 || true
  pkill -f "while true; do npm run start --prefix server" >/dev/null 2>&1 || true
  pkill -f "node .*server/index\\.js" >/dev/null 2>&1 || true
  pkill -f "sh -c node index.js" >/dev/null 2>&1 || true
  pkill -f "node index.js" >/dev/null 2>&1 || true
  pkill -f "nodemon[[:space:]].*index\\.js" >/dev/null 2>&1 || true
  pkill -f "concurrently.*Ollama,FE,BE" >/dev/null 2>&1 || true
  pkill -f "$ROOT_DIR/node_modules/.bin/concurrently" >/dev/null 2>&1 || true
  pkill -f "node_modules/.bin/vite" >/dev/null 2>&1 || true
  pkill -f "node_modules/concurrently" >/dev/null 2>&1 || true
}

has_dgx_processes() {
  pgrep -af "$ROOT_DIR/node_modules/.bin/concurrently" >/dev/null 2>&1 && return 0
  pgrep -af "scripts/backend-loop-dgx.sh" >/dev/null 2>&1 && return 0
  pgrep -af "while true; do npm run start --prefix server" >/dev/null 2>&1 && return 0
  pgrep -af "npm run start --prefix server" >/dev/null 2>&1 && return 0
  pgrep -af "node index.js" >/dev/null 2>&1 && return 0
  return 1
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
EOF
  exit 0
fi

if [[ "${1:-}" == "--status" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[DGX-SPARK] 실행 중 (PID: $pid)"
      echo "[DGX-SPARK] 로그: $LOG_FILE"
      exit 0
    fi
  fi
  echo "[DGX-SPARK] 실행 중이 아닙니다."
  exit 1
fi

if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid"
    fi
    rm -f "$PID_FILE"
  fi
  rm -f "$LOG_DIR/dgx-be-loop.pid"

  # 여러 겹으로 떠 있는 과거 프로세스(중첩 concurrently/while-loop)를 라운드로 정리
  for _ in 1 2 3 4 5; do
    kill_known_processes
    kill_by_port 5173
    kill_by_port 3001
    kill_by_port 11434
    sleep 0.5
    has_dgx_processes || break
  done

  if ! wait_port_free 3001 30 0.5; then
    echo "[DGX-SPARK] 경고: 포트 3001 점유가 남아 있습니다."
    print_port_holders 3001
  fi
  if has_dgx_processes; then
    echo "[DGX-SPARK] 경고: 일부 DGX 실행 프로세스가 남아 있습니다."
    pgrep -af "$ROOT_DIR/node_modules/.bin/concurrently" || true
    pgrep -af "scripts/backend-loop-dgx.sh" || true
    pgrep -af "npm run start --prefix server" || true
    pgrep -af "node index.js" || true
  fi
  echo "[DGX-SPARK] 중지 완료"
  exit 0
fi

if [[ ! -f "$ROOT_DIR/server/.env" ]]; then
  echo "[ERROR] server/.env 파일이 없습니다."
  echo "먼저 설치를 실행하세요: bash scripts/install-dgx-spark.sh"
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
    echo "[DGX-SPARK] 포트 ${port} 점유 프로세스 없음"
    return 0
  fi
  echo "[DGX-SPARK] 포트 ${port} 점유 프로세스 상세:"
  while IFS= read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    ps -p "$pid" -o pid=,user=,comm=,args= 2>/dev/null | sed 's/^/[DGX-SPARK]   /' || true
  done <<< "$pids"
}

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "[DGX-SPARK] 이미 실행 중입니다. (PID: $old_pid)"
    echo "[DGX-SPARK] 로그: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# 과거 세션에서 띄운 dev 프로세스가 남아 있으면 먼저 정리
kill_known_processes
rm -f "$LOG_DIR/dgx-be-loop.pid"

kill_by_port 5173
kill_by_port 3001

if ! wait_port_free 3001 20 0.5; then
  echo "[DGX-SPARK] 포트 3001 정리가 완료되지 않았습니다. 시작을 중단합니다."
  print_port_holders 3001
  echo "[DGX-SPARK] 수동 정리 후 재시도: bash scripts/run-dgx-spark.sh --stop"
  exit 1
fi

# 3001이 계속 점유되어 있으면 시작 자체를 중단해 무한 루프를 방지한다.
if command -v lsof >/dev/null 2>&1; then
  if lsof -ti tcp:3001 >/dev/null 2>&1; then
    echo "[DGX-SPARK] 포트 3001이 여전히 점유되어 있어 시작을 중단합니다."
    print_port_holders 3001
    echo "[DGX-SPARK] 먼저 정리 후 재시도: bash scripts/run-dgx-spark.sh --stop"
    exit 1
  fi
elif command -v fuser >/dev/null 2>&1; then
  if fuser -n tcp 3001 >/dev/null 2>&1; then
    echo "[DGX-SPARK] 포트 3001이 여전히 점유되어 있어 시작을 중단합니다."
    print_port_holders 3001
    echo "[DGX-SPARK] 먼저 정리 후 재시도: bash scripts/run-dgx-spark.sh --stop"
    exit 1
  fi
fi

echo "[DGX-SPARK] 백그라운드 실행 시작"
echo "[DGX-SPARK] 로그: $LOG_FILE"

nohup env EASYDOC_DAEMON_MODE=1 bash "$ROOT_DIR/scripts/dev-dgx-spark.sh" >>"$LOG_FILE" 2>&1 < /dev/null &
new_pid=$!
disown "$new_pid" >/dev/null 2>&1 || true
echo "$new_pid" > "$PID_FILE"

sleep 1
if kill -0 "$new_pid" 2>/dev/null; then
  echo "[DGX-SPARK] 실행 성공 (PID: $new_pid)"
  echo "[DGX-SPARK] 종료 명령: bash scripts/run-dgx-spark.sh --stop"
  exit 0
fi

echo "[DGX-SPARK] 실행 실패. 로그를 확인하세요: $LOG_FILE"
rm -f "$PID_FILE"
exit 1
