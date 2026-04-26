#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${EASYDOC_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/rerun-dgx-spark.log"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/rerun-dgx-spark.sh

Description:
  EasyDocStation DGX-SPARK 실행 프로세스를 종료 후 백그라운드 재실행합니다.
  터미널 로그아웃 후에도 계속 실행됩니다.
EOF
  exit 0
fi

echo "[DGX-SPARK] 재실행 시작"
echo "[DGX-SPARK] 로그: $LOG_FILE"

{
  echo "[$(date '+%F %T')] stop old process"
  bash "$ROOT_DIR/scripts/run-dgx-spark.sh" --stop
  echo "[$(date '+%F %T')] start new process"
  bash "$ROOT_DIR/scripts/run-dgx-spark.sh"
} >>"$LOG_FILE" 2>&1
