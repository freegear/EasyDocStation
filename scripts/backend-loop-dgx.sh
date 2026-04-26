#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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

cleanup_port() {
  local port="$1"
  local pids
  pids="$(resolve_port_pids "$port")"
  if [[ -z "${pids:-}" ]]; then
    return 0
  fi

  echo "[BE] 포트 ${port} 점유 프로세스 정리 시도: ${pids//$'\n'/ }"
  echo "$pids" | xargs -r kill -TERM >/dev/null 2>&1 || true
  sleep 1

  local alive
  alive="$(resolve_port_pids "$port")"
  if [[ -n "${alive:-}" ]]; then
    echo "$alive" | xargs -r kill -KILL >/dev/null 2>&1 || true
    sleep 1
  fi

  alive="$(resolve_port_pids "$port")"
  [[ -z "${alive:-}" ]]
}

while true; do
  if ! cleanup_port 3001; then
    echo "[BE] 포트 3001 점유 프로세스를 정리하지 못했습니다. 5초 후 재시도..."
    sleep 5
    continue
  fi

  npm run start --prefix server
  code=$?
  echo "[BE] process exited with code ${code}. restarting in 2s..."
  sleep 2
done

