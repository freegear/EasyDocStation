#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${EASYDOC_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
LOOP_PID_FILE="$LOG_DIR/dgx-be-loop.pid"
MAX_CLEANUP_RETRIES="${MAX_CLEANUP_RETRIES:-8}"
cleanup_failures=0

if [[ -f "$LOOP_PID_FILE" ]]; then
  old_pid="$(cat "$LOOP_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "[BE] backend-loop가 이미 실행 중입니다. (PID: $old_pid)"
    exit 0
  fi
fi

echo "$$" > "$LOOP_PID_FILE"
cleanup() {
  rm -f "$LOOP_PID_FILE"
}
trap cleanup EXIT INT TERM

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

print_port_holders() {
  local port="$1"
  local pids
  pids="$(resolve_port_pids "$port")"
  if [[ -z "${pids:-}" ]]; then
    echo "[BE] 포트 ${port} 점유 프로세스 없음"
    return 0
  fi
  echo "[BE] 포트 ${port} 점유 프로세스 상세:"
  while IFS= read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    ps -p "$pid" -o pid=,user=,comm=,args= 2>/dev/null | sed 's/^/[BE]   /' || true
  done <<< "$pids"
}

cleanup_port() {
  local port="$1"
  local pids
  pids="$(resolve_port_pids "$port")"
  if [[ -z "${pids:-}" ]]; then
    return 0
  fi

  echo "[BE] 포트 ${port} 점유 프로세스 정리 시도: ${pids//$'\n'/ }"
  print_port_holders "$port"
  echo "$pids" | xargs -r kill -TERM >/dev/null 2>&1 || true
  sleep 1

  local alive
  alive="$(resolve_port_pids "$port")"
  if [[ -n "${alive:-}" ]]; then
    echo "$alive" | xargs -r kill -KILL >/dev/null 2>&1 || true
    # root 소유 프로세스 등으로 일반 kill 실패 시 sudo 무인 모드로 재시도
    if [[ -n "${alive:-}" ]] && command -v sudo >/dev/null 2>&1; then
      echo "$alive" | xargs -r sudo -n kill -TERM >/dev/null 2>&1 || true
      sleep 1
      echo "$alive" | xargs -r sudo -n kill -KILL >/dev/null 2>&1 || true
    fi
    sleep 1
  fi

  alive="$(resolve_port_pids "$port")"
  [[ -z "${alive:-}" ]]
}

while true; do
  if ! cleanup_port 3001; then
    cleanup_failures=$((cleanup_failures + 1))
    echo "[BE] 포트 3001 점유 프로세스를 정리하지 못했습니다. (${cleanup_failures}/${MAX_CLEANUP_RETRIES})"
    print_port_holders 3001
    if [[ "$cleanup_failures" -ge "$MAX_CLEANUP_RETRIES" ]]; then
      echo "[BE] 정리 실패가 반복되어 backend-loop를 중단합니다. run 스크립트에서 수동 정리 후 재실행하세요."
      exit 1
    fi
    echo "[BE] 5초 후 재시도..."
    sleep 5
    continue
  fi

  cleanup_failures=0
  npm run start --prefix server
  code=$?
  echo "[BE] process exited with code ${code}. restarting in 2s..."
  sleep 2
done
