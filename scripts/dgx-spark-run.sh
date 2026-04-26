#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/dgx-spark-run.sh

Description:
  Ubuntu DGX-SPARK 환경용 EasyDocStation 실행 스크립트입니다.
  내부적으로 scripts/run-dgx-spark.sh 를 실행합니다.
EOF
  exit 0
fi

exec bash "$ROOT_DIR/scripts/run-dgx-spark.sh" "$@"
