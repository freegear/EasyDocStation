#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f "$ROOT_DIR/server/.env" ]]; then
  echo "[ERROR] server/.env 파일이 없습니다. 먼저 설치 스크립트를 실행하세요:"
  echo "  npm run setup:ubuntu"
  exit 1
fi

if [[ -x "$ROOT_DIR/.venv/bin/python3" ]]; then
  export VIRTUAL_ENV="$ROOT_DIR/.venv"
  export PATH="$ROOT_DIR/.venv/bin:$PATH"
  export PYTHON_BIN="$ROOT_DIR/.venv/bin/python3"
fi

npm run dev
