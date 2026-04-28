#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${OLLAMA_MODEL:-gemma4:e4b}"
OS_NAME="$(uname -s)"

echo "[INFO] Local AgenticAI용 Ollama 설치를 시작합니다. (model=${MODEL})"

install_model_if_ready() {
  if ! command -v ollama >/dev/null 2>&1; then
    echo "[WARN] ollama 명령을 찾지 못했습니다. 모델 설치를 건너뜁니다."
    return 0
  fi

  if ! curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "[INFO] Ollama 서버를 시작합니다."
    nohup ollama serve >/tmp/ollama-serve.log 2>&1 &
    sleep 2
  fi

  if ! curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "[WARN] Ollama 서버 연결 실패. 모델 pull은 건너뜁니다."
    return 0
  fi

  echo "[INFO] 모델 설치: ${MODEL}"
  ollama pull "${MODEL}" || true
}

case "${OS_NAME}" in
  Darwin)
    if ! command -v ollama >/dev/null 2>&1; then
      echo "[1/2] macOS: Ollama 설치"
      curl -fsSL https://ollama.com/install.sh | sh
    else
      echo "[1/2] macOS: Ollama 이미 설치됨"
    fi
    echo "[2/2] macOS: 모델 준비"
    install_model_if_ready
    ;;
  Linux)
    echo "[INFO] Linux 환경 감지. 이 스크립트는 macOS/Windows용입니다."
    echo "[INFO] Linux는 기존 setup 스크립트의 INSTALL_OLLAMA=1 옵션을 사용하세요."
    ;;
  MINGW*|MSYS*|CYGWIN*)
    if command -v powershell.exe >/dev/null 2>&1; then
      echo "[1/1] Windows: PowerShell 설치 스크립트 실행"
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ROOT_DIR}/scripts/setup-local-ollama.ps1"
    else
      echo "[ERROR] powershell.exe를 찾지 못했습니다."
      exit 1
    fi
    ;;
  *)
    echo "[ERROR] 지원하지 않는 OS입니다: ${OS_NAME}"
    exit 1
    ;;
esac

echo "[DONE] Local AgenticAI용 Ollama 설치 단계가 완료되었습니다."
