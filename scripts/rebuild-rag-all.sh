#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${EASYDOC_LOG_DIR:-$ROOT_DIR/logs}"
LOG_FILE="$LOG_DIR/rebuild-rag-all.log"
PID_FILE="$LOG_DIR/rebuild-rag-all.pid"
mkdir -p "$LOG_DIR"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/rebuild-rag-all.sh
  bash scripts/rebuild-rag-all.sh --foreground
  bash scripts/rebuild-rag-all.sh --status
  bash scripts/rebuild-rag-all.sh --stop
  bash scripts/rebuild-rag-all.sh --log

Description:
  RAG LanceDB/FileTrainingData를 초기화한 뒤, 모든 팀/채널의 게시글,
  댓글, 첨부 문서(PDF/Word/TXT), 이미지 첨부를 전체 재학습합니다.

  기본 실행은 nohup 백그라운드 모드라 로그아웃 후에도 계속 진행됩니다.

Environment:
  FULL_REBUILD_BATCH_SIZE=10
    rag_train.py에 넘기는 게시글/댓글 배치 크기입니다.

  EASYDOC_RAG_KEEP_NO_DATA_ANSWERS=1
    "찾을 수 없습니다"류의 이전 AI 실패 답변도 학습합니다.
    기본값은 제외입니다. RAG 오염 방지를 위해 기본 제외를 권장합니다.

  EASYDOC_REBUILD_KEEP_APP=1
    EasyDocStation을 중지하지 않고 재학습합니다.
    기본값은 중지 -> 초기화/학습 -> 재시작입니다.

  EASYDOC_REBUILD_TELEGRAM_CHAT_IDS=123456789,-1001234567890
    알림을 받을 Telegram chat_id 목록입니다.
    비워두면 EasyDocStation 사용자 중 use_sns_channel=telegram 이고
    숫자형 telegram_id가 등록된 활성 사용자에게 보냅니다.

  EASYDOC_REBUILD_TELEGRAM_FORCE=1
    config.json에서 Telegram이 disabled여도 TELEGRAM_BOT_TOKEN으로 전송합니다.

  EASYDOC_REBUILD_NO_TIMEOUT=1
    rag_train.py 배치 학습 시간 제한을 두지 않습니다. 기본값은 1입니다.
    제한 시간을 두려면 EASYDOC_REBUILD_NO_TIMEOUT=0 과
    EASYDOC_REBUILD_TRAINER_TIMEOUT_SEC=7200 처럼 지정합니다.
EOF
}

log() {
  echo "[$(date '+%Y%m%d-%H:%M:%S')][RAG-REBUILD] $*"
}

notify_telegram() {
  local message="$1"
  node "$ROOT_DIR/server/scripts/telegram-notify.js" "$message" >/dev/null 2>&1 || true
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null
}

kill_tree() {
  local pid="$1"
  [[ -n "${pid:-}" ]] || return 0
  kill -0 "$pid" >/dev/null 2>&1 || return 0

  local children=""
  if command -v pgrep >/dev/null 2>&1; then
    children="$(pgrep -P "$pid" 2>/dev/null || true)"
  fi
  if [[ -n "${children:-}" ]]; then
    while IFS= read -r child; do
      [[ -n "${child:-}" ]] && kill_tree "$child"
    done <<< "$children"
  fi

  kill -TERM "$pid" >/dev/null 2>&1 || true
  sleep 0.5
  kill -KILL "$pid" >/dev/null 2>&1 || true
}

run_foreground() {
  local app_stopped=0
  local app_restarted=0

  log "전체 RAG 재학습 시작"
  log "로그 파일: $LOG_FILE"
  notify_telegram "EasyDocStation RAG 전체 재학습을 시작했습니다.

로그: $LOG_FILE"

  if [[ -f "$ROOT_DIR/server/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT_DIR/server/.env"
    set +a
  fi

  if [[ -x "$ROOT_DIR/.venv/bin/python3" ]]; then
    export VIRTUAL_ENV="$ROOT_DIR/.venv"
    export PATH="$ROOT_DIR/.venv/bin:$PATH"
    export PYTHON_BIN="${PYTHON_BIN:-$ROOT_DIR/.venv/bin/python3}"
  else
    log "경고: $ROOT_DIR/.venv/bin/python3 를 찾지 못했습니다. RAG Python 의존성 오류가 날 수 있습니다."
  fi

  export CASSANDRA_REQUIRED="${CASSANDRA_REQUIRED:-1}"
  export EASYDOC_RAG_DEVICE="${EASYDOC_RAG_DEVICE:-auto}"
  export EASYDOC_REBUILD_NO_TIMEOUT="${EASYDOC_REBUILD_NO_TIMEOUT:-1}"

  cleanup() {
    local code=$?
    rm -f "$PID_FILE"
    if [[ "${app_stopped:-0}" -eq 1 && "${app_restarted:-0}" -eq 0 && "${EASYDOC_REBUILD_KEEP_APP:-0}" != "1" ]]; then
      log "정리 단계: EasyDocStation 재시작 시도"
      bash "$ROOT_DIR/scripts/run-dgx-spark.sh" || true
    fi
    if [[ "$code" -eq 0 ]]; then
      log "전체 RAG 재학습 정상 종료"
      notify_telegram "EasyDocStation RAG 전체 재학습이 완료되었습니다.

상태: 성공
로그: $LOG_FILE"
    else
      log "전체 RAG 재학습 실패 또는 중단 (exit=$code)"
      notify_telegram "EasyDocStation RAG 전체 재학습이 실패 또는 중단되었습니다.

상태: 실패(exit=$code)
로그: $LOG_FILE"
    fi
    exit "$code"
  }
  trap cleanup EXIT INT TERM

  if [[ "${EASYDOC_REBUILD_KEEP_APP:-0}" != "1" ]]; then
    if bash "$ROOT_DIR/scripts/run-dgx-spark.sh" --status >/dev/null 2>&1; then
      log "EasyDocStation 중지"
      bash "$ROOT_DIR/scripts/run-dgx-spark.sh" --stop || true
      app_stopped=1
    else
      log "EasyDocStation은 이미 중지 상태입니다."
    fi
  else
    log "EASYDOC_REBUILD_KEEP_APP=1: 실행 중인 EasyDocStation은 유지합니다."
  fi

  log "RAG 저장소 초기화"
  bash "$ROOT_DIR/scripts/reset-rag-storage.sh" --yes

  log "모든 팀/채널 게시글, 댓글, 첨부 문서, 이미지 재학습"
  node "$ROOT_DIR/server/scripts/rebuild-rag-all.js"

  if [[ "${EASYDOC_REBUILD_KEEP_APP:-0}" != "1" ]]; then
    log "EasyDocStation 재시작"
    bash "$ROOT_DIR/scripts/run-dgx-spark.sh"
    app_restarted=1
  fi
}

case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --foreground)
    echo "$$" > "$PID_FILE"
    run_foreground
    ;;
  --status)
    if is_running; then
      pid="$(cat "$PID_FILE")"
      log "실행 중 (PID: $pid)"
      log "로그: $LOG_FILE"
      exit 0
    fi
    log "실행 중이 아닙니다."
    exit 1
    ;;
  --stop)
    if is_running; then
      pid="$(cat "$PID_FILE")"
      log "중지 시도 (PID: $pid)"
      kill_tree "$pid"
      rm -f "$PID_FILE"
      log "중지 완료"
      exit 0
    fi
    log "실행 중이 아닙니다."
    rm -f "$PID_FILE"
    exit 0
    ;;
  --log)
    tail -f "$LOG_FILE"
    ;;
  "")
    if is_running; then
      pid="$(cat "$PID_FILE")"
      log "이미 실행 중입니다. (PID: $pid)"
      log "로그: $LOG_FILE"
      exit 0
    fi
    log "백그라운드 전체 RAG 재학습 시작"
    log "로그: $LOG_FILE"
    if command -v setsid >/dev/null 2>&1; then
      setsid bash "$ROOT_DIR/scripts/rebuild-rag-all.sh" --foreground >>"$LOG_FILE" 2>&1 < /dev/null &
    else
      nohup bash "$ROOT_DIR/scripts/rebuild-rag-all.sh" --foreground >>"$LOG_FILE" 2>&1 < /dev/null &
    fi
    new_pid=$!
    disown "$new_pid" >/dev/null 2>&1 || true
    sleep 2
    if is_running; then
      pid="$(cat "$PID_FILE")"
      log "실행 성공 (PID: $pid)"
      log "상태 확인: bash scripts/rebuild-rag-all.sh --status"
      log "로그 확인: tail -f $LOG_FILE"
      exit 0
    fi
    log "실행 실패. 로그를 확인하세요: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
    ;;
  *)
    usage
    exit 1
    ;;
esac
