#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${EASYDOC_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
LOOP_PID_FILE="$LOG_DIR/dgx-be-loop.pid"
LOOP_LOCK_FILE="$LOG_DIR/dgx-be-loop.lock"
LOOP_LOCK_DIR="$LOG_DIR/dgx-be-loop.lockdir"
MAX_CLEANUP_RETRIES="${MAX_CLEANUP_RETRIES:-8}"
cleanup_failures=0
LOCK_MODE=""

log_be() {
  echo "[$(date '+%Y%m%d-%H:%M:%S')][BE] $*"
}

if [[ -f "$LOOP_PID_FILE" ]]; then
  old_pid="$(cat "$LOOP_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    log_be "backend-loop가 이미 실행 중입니다. (PID: $old_pid)"
    exit 0
  fi
fi

# PID 파일만으로는 경쟁 상태를 막지 못하므로 lock으로 단일 인스턴스를 강제한다.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOOP_LOCK_FILE"
  if ! flock -n 9; then
    log_be "backend-loop lock이 이미 점유되어 있습니다. 다른 인스턴스가 실행 중입니다."
    exit 0
  fi
  LOCK_MODE="flock"
else
  if ! mkdir "$LOOP_LOCK_DIR" 2>/dev/null; then
    log_be "backend-loop lockdir이 이미 존재합니다. 다른 인스턴스가 실행 중입니다."
    exit 0
  fi
  LOCK_MODE="mkdir"
fi

echo "$$" > "$LOOP_PID_FILE"
cleanup() {
  rm -f "$LOOP_PID_FILE"
  if [[ "$LOCK_MODE" == "mkdir" ]]; then
    rmdir "$LOOP_LOCK_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

CASSANDRA_REQUIRED="${CASSANDRA_REQUIRED:-1}"

resolve_cassandra_target() {
  local target
  target="$(node -e '
    const fs = require("fs")
    const path = require("path")
    const cfgPath = path.join(process.cwd(), "config.json")
    let host = "127.0.0.1"
    let port = "9042"
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
      const cass = cfg.Cassandra || cfg.cassandra || {}
      const cp = Array.isArray(cass.contactPoints) ? cass.contactPoints[0] : cass.contactPoints
      if (typeof cp === "string" && cp.trim()) {
        const raw = cp.trim()
        if (raw.includes(":")) {
          const idx = raw.lastIndexOf(":")
          host = raw.slice(0, idx) || host
          port = raw.slice(idx + 1) || port
        } else {
          host = raw
        }
      }
    } catch (_) {}
    process.stdout.write(`${host} ${port}`)
  ' 2>/dev/null || true)"
  if [[ -z "${target:-}" ]]; then
    echo "127.0.0.1 9042"
    return 0
  fi
  echo "$target"
}

ensure_cassandra_ready_or_exit() {
  [[ "$CASSANDRA_REQUIRED" == "1" ]] || return 0
  local host port
  read -r host port <<< "$(resolve_cassandra_target)"
  host="${host:-127.0.0.1}"
  port="${port:-9042}"

  local ok=1
  if command -v nc >/dev/null 2>&1; then
    if nc -z -w 2 "$host" "$port" >/dev/null 2>&1; then
      ok=0
    fi
  elif command -v bash >/dev/null 2>&1; then
    if timeout 2 bash -lc "cat < /dev/null > /dev/tcp/${host}/${port}" >/dev/null 2>&1; then
      ok=0
    fi
  fi

  if [[ "$ok" -ne 0 ]]; then
    log_be "❌ Cassandra 필수 모드(CASSANDRA_REQUIRED=1): ${host}:${port} 연결 실패"
    log_be "❌ PostgreSQL fallback으로 진행하지 않고 즉시 중단합니다."
    log_be "조치: Cassandra 기동 후 다시 실행하세요."
    exit 1
  fi
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

print_port_holders() {
  local port="$1"
  local pids
  pids="$(resolve_port_pids "$port")"
  if [[ -z "${pids:-}" ]]; then
    log_be "포트 ${port} 점유 프로세스 없음"
    return 0
  fi
  log_be "포트 ${port} 점유 프로세스 상세:"
  while IFS= read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    ps -p "$pid" -o pid=,user=,comm=,args= 2>/dev/null | sed "s/^/[$(date '+%Y%m%d-%H:%M:%S')][BE]   /" || true
  done <<< "$pids"
}

cleanup_port() {
  local port="$1"
  local pids
  pids="$(resolve_port_pids "$port")"
  if [[ -z "${pids:-}" ]]; then
    return 0
  fi

  log_be "포트 ${port} 점유 프로세스 정리 시도: ${pids//$'\n'/ }"
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

# 포트 정리는 루프 진입 전 1회만 수행한다.
# 반복 루프마다 정리하면 중복 실행 인스턴스가 서로의 정상 서버를 죽이는 현상이 생긴다.
ensure_cassandra_ready_or_exit
if ! cleanup_port 3001; then
  cleanup_failures=$((cleanup_failures + 1))
  log_be "포트 3001 점유 프로세스를 정리하지 못했습니다. (${cleanup_failures}/${MAX_CLEANUP_RETRIES})"
  print_port_holders 3001
  if [[ "$cleanup_failures" -ge "$MAX_CLEANUP_RETRIES" ]]; then
    log_be "정리 실패가 반복되어 backend-loop를 중단합니다. run 스크립트에서 수동 정리 후 재실행하세요."
    exit 1
  fi
  log_be "5초 후 재시도..."
  sleep 5
fi
cleanup_failures=0

while true; do
  ensure_cassandra_ready_or_exit

  npm run start --prefix server 2>&1 | while IFS= read -r line; do
    echo "[$(date '+%Y%m%d-%H:%M:%S')][BE] $line"
  done
  code=${PIPESTATUS[0]}
  log_be "process exited with code ${code}. restarting in 2s..."
  sleep 2
done
