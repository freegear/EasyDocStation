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
  EasyDocStation DGX-SPARK 실행 프로세스를 종료 후 재실행합니다.
  내부적으로 scripts/restart-dgx-spark.sh를 실행합니다.
EOF
  exit 0
fi

echo "[DGX-SPARK] 재실행 시작"
echo "[DGX-SPARK] 로그: $LOG_FILE"

bash "$ROOT_DIR/scripts/restart-dgx-spark.sh" "$@" 2>&1 | tee -a "$LOG_FILE"
