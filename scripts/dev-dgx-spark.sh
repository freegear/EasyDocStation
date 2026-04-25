#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f "$ROOT_DIR/server/.env" ]]; then
  echo "[ERROR] server/.env 파일이 없습니다. 먼저 설치 스크립트를 실행하세요:"
  echo "  npm run setup:dgx-spark"
  exit 1
fi

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

echo "[DGX] 문서 변환/학습 의존성 점검"
for cmd in libreoffice pdftoppm ffmpeg tesseract; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "  - $cmd: OK ($(command -v "$cmd"))"
  else
    echo "  - $cmd: MISSING (PPT/PPTX->PDF 또는 OCR/RAG 품질 저하 가능)"
  fi
done

npm run dev
