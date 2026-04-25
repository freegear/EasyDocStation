#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${EASYDOC_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/install-dgx-spark.log"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/install-dgx-spark.sh

Description:
  EasyDocStation을 Ubuntu DGX-SPARK 환경에 설치합니다.
  내부적으로 scripts/setup-dgx-spark.sh를 실행합니다.
EOF
  exit 0
fi

echo "[DGX-SPARK] 설치 시작"
echo "[DGX-SPARK] 로그: $LOG_FILE"

bash "$ROOT_DIR/scripts/setup-dgx-spark.sh" "$@" 2>&1 | tee "$LOG_FILE"
