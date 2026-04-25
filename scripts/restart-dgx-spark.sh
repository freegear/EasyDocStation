#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[restart] EasyDocStation(DGX Spark) 관련 프로세스 정리 중..."

kill_by_pattern() {
  local pattern="$1"
  local pids
  pids="$(pgrep -f "$pattern" || true)"
  if [[ -z "${pids:-}" ]]; then
    return 0
  fi

  echo "$pids" | xargs -r kill -TERM >/dev/null 2>&1 || true
  sleep 1

  local alive
  alive="$(echo "$pids" | xargs -r -I{} sh -c 'kill -0 "{}" 2>/dev/null && echo "{}"' || true)"
  if [[ -n "${alive:-}" ]]; then
    echo "$alive" | xargs -r kill -KILL >/dev/null 2>&1 || true
  fi
}

kill_by_port() {
  local port="$1"
  local pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser -n tcp "$port" 2>/dev/null || true)"
  fi

  if [[ -z "${pids:-}" ]]; then
    return 0
  fi

  echo "$pids" | tr ' ' '\n' | xargs -r kill -TERM >/dev/null 2>&1 || true
  sleep 1
  echo "$pids" | tr ' ' '\n' | xargs -r kill -KILL >/dev/null 2>&1 || true
}

kill_by_pattern "$ROOT_DIR/node_modules/.bin/vite"
kill_by_pattern "$ROOT_DIR/server/node_modules/.bin/nodemon"
kill_by_pattern "$ROOT_DIR/node_modules/concurrently"
kill_by_pattern "$ROOT_DIR/scripts/dev-ubuntu.sh"
kill_by_pattern "$ROOT_DIR/scripts/dev-dgx-spark.sh"
kill_by_pattern "$ROOT_DIR/scripts/ollama-serve-safe.mjs"

kill_by_port 5173
kill_by_port 3001

echo "[restart] DGX Spark 모드로 재기동합니다..."
exec bash "$ROOT_DIR/scripts/dev-dgx-spark.sh"

