#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[restart] Ubuntu 재시작: run-ubuntu stop/start 경로로 일원화"
bash "$ROOT_DIR/scripts/run-ubuntu.sh" --stop
exec bash "$ROOT_DIR/scripts/run-ubuntu.sh" "$@"
