#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_ENV_DIR="${PYTHON_ENV_DIR:-$ROOT_DIR/.venv}"
TORCH_VERSION="${TORCH_VERSION:-}"
TORCH_MIN_VERSION="${TORCH_MIN_VERSION:-2.6}"

install_frontend_dependencies() {
  echo "[DGX] 프론트 의존성 정합 시작"
  echo "  1) @vitejs/plugin-react 최신화"
  npm install -D @vitejs/plugin-react@latest

  local packages=(
    "react-to-print"
    "@tiptap/extension-table"
    "@tiptap/extension-table-row"
    "@tiptap/extension-table-cell"
    "@tiptap/extension-table-header"
  )

  for pkg in "${packages[@]}"; do
    echo "  2) 설치 시도: $pkg"
    if npm install "$pkg"; then
      echo "  - $pkg 설치 성공"
      continue
    fi
    echo "  3) 우회 설치(--legacy-peer-deps): $pkg"
    npm install "$pkg" --legacy-peer-deps
  done
}

# ARM64(DGX Spark GB10)는 PyPI에서 CUDA 휠을 제공하므로 별도 인덱스 불필요
ARCH="$(uname -m)"
if [[ -z "${TORCH_INDEX_URL:-}" ]]; then
  if [[ "$ARCH" == "aarch64" ]]; then
    TORCH_INDEX_URL="https://pypi.org/simple"
    echo "[INFO] ARM64 감지 — PyPI 인덱스 사용 (aarch64+CUDA 휠)"
  else
    TORCH_INDEX_URL="https://download.pytorch.org/whl/cu124"
    echo "[INFO] x86_64 감지 — CUDA 전용 인덱스 사용"
  fi
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "[WARN] nvidia-smi를 찾지 못했습니다. GPU 드라이버가 없거나 PATH에 없을 수 있습니다."
  echo "[WARN] 계속 진행하지만, CUDA 가속이 비활성화될 수 있습니다."
else
  echo "[INFO] NVIDIA GPU 확인:"
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
fi

echo "[1/3] Ubuntu 기본 설치 스크립트 실행"
INSTALL_HIRES_DEPS=1 bash "$ROOT_DIR/scripts/setup-ubuntu.sh"

echo "[1-1/3] 프론트 의존성 설치"
install_frontend_dependencies

if [[ ! -x "$PYTHON_ENV_DIR/bin/python3" ]]; then
  echo "[ERROR] Python venv를 찾을 수 없습니다: $PYTHON_ENV_DIR"
  exit 1
fi

echo "[2/3] PyTorch CUDA 빌드 설치"
source "$PYTHON_ENV_DIR/bin/activate"
python -m pip uninstall -y torch torchvision torchaudio timm >/dev/null 2>&1 || true
python -m pip install -U pip wheel packaging "setuptools<82"

if [[ -n "$TORCH_VERSION" ]]; then
  python -m pip install "torch==${TORCH_VERSION}" --index-url "$TORCH_INDEX_URL" --extra-index-url https://pypi.org/simple
else
  if ! python -m pip install "torch>=${TORCH_MIN_VERSION},<3" --index-url "$TORCH_INDEX_URL" --extra-index-url https://pypi.org/simple; then
    echo "[WARN] CUDA 인덱스에서 torch>=${TORCH_MIN_VERSION} 설치 실패. PyPI로 재시도합니다."
    python -m pip install "torch>=${TORCH_MIN_VERSION},<3" --index-url https://pypi.org/simple
  fi
fi

# torch 설치 후 불필요한 오디오 패키지 제거
python -m pip uninstall -y torchaudio >/dev/null 2>&1 || true

echo "[2-1/3] Unstructured hi_res 의존성 설치 (torchvision, timm)"
if ! python -m pip install torchvision timm --index-url "$TORCH_INDEX_URL" --extra-index-url https://pypi.org/simple; then
  echo "[WARN] CUDA 인덱스 torchvision/timm 설치 실패. PyPI로 재시도합니다."
  python -m pip install torchvision timm --index-url https://pypi.org/simple
fi

echo "[3/3] CUDA 동작 검증"
python - <<'PY'
import torch
import torchvision
import timm
from packaging.version import Version
min_ver = Version("2.6")
torch_ver = Version(torch.__version__.split("+")[0])
print(f"torch={torch.__version__}")
print(f"torchvision={torchvision.__version__}")
print(f"timm={timm.__version__}")
print(f"cuda_available={torch.cuda.is_available()}")
if torch_ver < min_ver:
    raise SystemExit(f"[ERROR] torch 버전이 낮습니다: {torch.__version__} (<2.6)")
if torch.cuda.is_available():
    print(f"cuda_device_count={torch.cuda.device_count()}")
    print(f"cuda_device_name={torch.cuda.get_device_name(0)}")
else:
    print("[WARN] CUDA가 비활성화 상태입니다. 드라이버/CUDA 런타임을 확인하세요.")
PY
deactivate

echo
echo "[검증] DGX-SPARK 런타임 의존성"
for cmd in libreoffice pdftoppm ffmpeg tesseract; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "  - $cmd: OK ($(command -v "$cmd"))"
  else
    echo "  - $cmd: MISSING"
  fi
done
echo
echo "[검증] 인쇄 백엔드(CUPS)"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl enable cups >/dev/null 2>&1 || true
  sudo systemctl restart cups || true
  if systemctl is-active --quiet cups; then
    echo "  - cups: active"
  else
    echo "  - cups: inactive"
  fi
fi
if command -v lpstat >/dev/null 2>&1; then
  if command -v lpadmin >/dev/null 2>&1; then
    # CUPS-PDF 큐가 없으면 생성 시도
    if ! lpstat -p 2>/dev/null | awk '{print $2}' | grep -qx "CUPS-PDF"; then
      if lpinfo -v 2>/dev/null | grep -q "cups-pdf"; then
        pdf_model="$(lpinfo -m 2>/dev/null | awk '/cups-pdf|CUPS-PDF|Generic PDF|PDF/{print $1; exit}')"
        if [[ -z "${pdf_model:-}" ]]; then
          pdf_model="drv:///sample.drv/generic.ppd"
        fi
        sudo lpadmin -p CUPS-PDF -E -v cups-pdf:/ -m "$pdf_model" >/dev/null 2>&1 || true
        sudo cupsaccept CUPS-PDF >/dev/null 2>&1 || true
        sudo cupsenable CUPS-PDF >/dev/null 2>&1 || true
      fi
    fi
  fi

  # 기본 프린터 미설정이면 CUPS-PDF 또는 첫 번째 프린터를 기본으로 설정
  if ! lpstat -d >/dev/null 2>&1; then
    if lpstat -p 2>/dev/null | awk '{print $2}' | grep -qx "CUPS-PDF"; then
      lpoptions -d CUPS-PDF >/dev/null 2>&1 || true
    else
      first_printer="$(lpstat -p 2>/dev/null | awk 'NR==1{print $2}')"
      if [[ -n "${first_printer:-}" ]]; then
        lpoptions -d "$first_printer" >/dev/null 2>&1 || true
      fi
    fi
  fi
  lpstat -d 2>/dev/null || echo "  - 기본 프린터 없음 (수동 설정 필요)"
else
  echo "  - lpstat: not found"
fi
echo
echo "DGX Spark 설치가 완료되었습니다."
echo "실행 명령:"
echo "  npm run dev:dgx-spark"
