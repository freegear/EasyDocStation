#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -x "$ROOT_DIR/.venv/bin/python3" ]]; then
  export VIRTUAL_ENV="$ROOT_DIR/.venv"
  export PATH="$ROOT_DIR/.venv/bin:$PATH"
  export PYTHON_BIN="$ROOT_DIR/.venv/bin/python3"
fi

export EASYDOC_RAG_DEVICE="${EASYDOC_RAG_DEVICE:-auto}"

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "[DGX] GPU 상태"
  nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader
fi

npm run dev
