#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_ENV_DIR="${PYTHON_ENV_DIR:-$ROOT_DIR/.venv}"
TORCH_INDEX_URL="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu124}"
TORCH_VERSION="${TORCH_VERSION:-}"

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "[WARN] nvidia-smi를 찾지 못했습니다. GPU 드라이버가 없거나 PATH에 없을 수 있습니다."
  echo "[WARN] 계속 진행하지만, CUDA 가속이 비활성화될 수 있습니다."
else
  echo "[INFO] NVIDIA GPU 확인:"
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
fi

echo "[1/3] Ubuntu 기본 설치 스크립트 실행"
bash "$ROOT_DIR/scripts/setup-ubuntu.sh"

if [[ ! -x "$PYTHON_ENV_DIR/bin/python3" ]]; then
  echo "[ERROR] Python venv를 찾을 수 없습니다: $PYTHON_ENV_DIR"
  exit 1
fi

echo "[2/3] PyTorch CUDA 빌드 설치"
source "$PYTHON_ENV_DIR/bin/activate"
python -m pip uninstall -y torch torchvision torchaudio >/dev/null 2>&1 || true
if [[ -n "$TORCH_VERSION" ]]; then
  python -m pip install "torch==${TORCH_VERSION}" --index-url "$TORCH_INDEX_URL"
else
  python -m pip install --upgrade torch --index-url "$TORCH_INDEX_URL"
fi

echo "[3/3] CUDA 동작 검증"
python - <<'PY'
import torch
print(f"torch={torch.__version__}")
print(f"cuda_available={torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"cuda_device_count={torch.cuda.device_count()}")
    print(f"cuda_device_name={torch.cuda.get_device_name(0)}")
PY
deactivate

echo
echo "DGX Spark 설치가 완료되었습니다."
echo "실행 명령:"
echo "  npm run dev:dgx-spark"
