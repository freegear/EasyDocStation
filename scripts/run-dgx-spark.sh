#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${EASYDOC_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/run-dgx-spark.log"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/run-dgx-spark.sh

Description:
  EasyDocStation을 DGX-SPARK 모드로 실행합니다.
  내부적으로 scripts/dev-dgx-spark.sh를 실행합니다.
EOF
  exit 0
fi

if [[ ! -f "$ROOT_DIR/server/.env" ]]; then
  echo "[ERROR] server/.env 파일이 없습니다."
  echo "먼저 설치를 실행하세요: bash scripts/install-dgx-spark.sh"
  exit 1
fi

echo "[DGX-SPARK] 실행 시작"
echo "[DGX-SPARK] 로그: $LOG_FILE"

bash "$ROOT_DIR/scripts/dev-dgx-spark.sh" "$@" 2>&1 | tee -a "$LOG_FILE"
