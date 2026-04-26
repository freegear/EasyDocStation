#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

install_frontend_dependencies() {
  echo "[DGX] 프론트 의존성 정합 시작"
  local plugin_react_version="${PLUGIN_REACT_VERSION:-^4.7.0}"
  echo "  1) @vitejs/plugin-react 호환 버전 설치 (${plugin_react_version})"
  if ! npm install -D "@vitejs/plugin-react@${plugin_react_version}"; then
    npm install -D "@vitejs/plugin-react@${plugin_react_version}" --legacy-peer-deps
  fi

  local packages=(
    "react-to-print"
    "react-colorful"
    "@tiptap/extension-color"
    "@tiptap/extension-text-style"
    "@tiptap/extension-table"
    "@tiptap/extension-table-row"
    "@tiptap/extension-table-cell"
    "@tiptap/extension-table-header"
    "@tiptap/extension-table-of-contents"
  )

  for pkg in "${packages[@]}"; do
    if npm ls "$pkg" --depth=0 >/dev/null 2>&1; then
      echo "  - $pkg: OK"
      continue
    fi
    echo "  2) 설치 시도: $pkg"
    if npm install "$pkg"; then
      echo "  - $pkg 설치 성공"
      continue
    fi
    echo "  3) 우회 설치(--legacy-peer-deps): $pkg"
    npm install "$pkg" --legacy-peer-deps
  done
}

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

echo "[DGX] npm 의존성 점검"
install_frontend_dependencies

echo "[DGX] 문서 변환/학습 의존성 점검"
for cmd in libreoffice pdftoppm ffmpeg tesseract; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "  - $cmd: OK ($(command -v "$cmd"))"
  else
    echo "  - $cmd: MISSING (PPT/PPTX->PDF 또는 OCR/RAG 품질 저하 가능)"
  fi
done

echo "[DGX] 인쇄 백엔드(CUPS) 점검"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet cups; then
    echo "  - cups: active"
  else
    echo "  - cups: inactive (print preview가 '로드 중'에서 멈출 수 있습니다)"
  fi
fi
if command -v lpstat >/dev/null 2>&1; then
  lpstat -d >/dev/null 2>&1 && lpstat -d || echo "  - 기본 프린터 미설정 (PDF 프린터 설정 권장)"
else
  echo "  - lpstat: not found (cups-client 미설치)"
fi

if [[ "${EASYDOC_DAEMON_MODE:-0}" == "1" ]]; then
  echo "[DGX] daemon 모드 실행 (로그아웃 후 지속)"
  BE_LOOP_CMD="bash \"$ROOT_DIR/scripts/backend-loop-dgx.sh\""
  "$ROOT_DIR/node_modules/.bin/concurrently" -p "[{name}]" -n "Ollama,FE,BE" -c "cyan,magenta,green" \
    "npm run ollama:serve" \
    "npm run dev:frontend" \
    "$BE_LOOP_CMD"
else
  npm run dev
fi
