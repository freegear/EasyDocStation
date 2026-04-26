#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${EASYDOC_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/run-dgx-spark.log"
PID_FILE="$LOG_DIR/dgx-spark.pid"

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
  kill_by_port() {
    local port="$1"
    local pids=""
    if command -v lsof >/dev/null 2>&1; then
      pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    elif command -v fuser >/dev/null 2>&1; then
      pids="$(fuser -n tcp "$port" 2>/dev/null || true)"
    fi
    if [[ -n "${pids:-}" ]]; then
      echo "$pids" | tr ' ' '\n' | xargs -r kill -TERM >/dev/null 2>&1 || true
      sleep 1
      echo "$pids" | tr ' ' '\n' | xargs -r kill -KILL >/dev/null 2>&1 || true
    fi
  }

  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" >/dev/null 2>&1 || true
      sleep 1
      kill -KILL "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$PID_FILE"
  fi
  # 보조 정리
  pkill -f "$ROOT_DIR/node_modules/.bin/vite" >/dev/null 2>&1 || true
  pkill -f "$ROOT_DIR/server/node_modules/.bin/nodemon" >/dev/null 2>&1 || true
  pkill -f "$ROOT_DIR/node_modules/concurrently" >/dev/null 2>&1 || true
  pkill -f "$ROOT_DIR/server/index.js" >/dev/null 2>&1 || true
  kill_by_port 5173
  kill_by_port 3001
  kill_by_port 11434
  echo "[DGX-SPARK] 중지 완료"
  exit 0
fi

if [[ ! -f "$ROOT_DIR/server/.env" ]]; then
  echo "[ERROR] server/.env 파일이 없습니다."
  echo "먼저 설치를 실행하세요: bash scripts/install-dgx-spark.sh"
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "[DGX-SPARK] 이미 실행 중입니다. (PID: $old_pid)"
    echo "[DGX-SPARK] 로그: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
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
