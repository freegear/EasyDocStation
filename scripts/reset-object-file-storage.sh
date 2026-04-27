#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ASSUME_YES=0

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/reset-object-file-storage.sh [--yes]

Description:
  ObjectFile 폴더를 초기화합니다.
  - config.json의 "ObjectFile Path" 경로를 읽어 내부를 모두 삭제
  - 폴더 자체는 유지하고 기본 하위 폴더를 재생성

Options:
  --yes   확인 프롬프트 없이 즉시 실행
EOF
  exit 0
fi

if [[ "${1:-}" == "--yes" ]]; then
  ASSUME_YES=1
fi

OBJECT_FILE_PATH="$(
  node - <<'NODE'
const fs = require('fs')
const path = require('path')
const root = process.cwd()
const cfgPath = path.join(root, 'config.json')
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const objectRaw = cfg['ObjectFile Path'] || 'Database/ObjectFile'
const objectPath = path.isAbsolute(objectRaw) ? objectRaw : path.join(root, objectRaw)
process.stdout.write(objectPath)
NODE
)"

echo "[Reset:ObjectFile] 대상 경로"
echo "  - ObjectFile: $OBJECT_FILE_PATH"

if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo
  read -r -p "ObjectFile 내부 데이터를 모두 삭제합니다. 계속할까요? (yes/no): " answer
  if [[ "$answer" != "yes" ]]; then
    echo "[Reset:ObjectFile] 취소되었습니다."
    exit 0
  fi
fi

mkdir -p "$OBJECT_FILE_PATH"
find "$OBJECT_FILE_PATH" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

# 런타임에서 자주 쓰는 기본 폴더 재생성
mkdir -p "$OBJECT_FILE_PATH/DirectMessage"
mkdir -p "$OBJECT_FILE_PATH/FileTrainingData"
mkdir -p "$OBJECT_FILE_PATH/previews"
mkdir -p "$OBJECT_FILE_PATH/thumbnails"

echo "[Reset:ObjectFile] 완료"
echo "  - ObjectFile 내부 초기화 완료"
echo "  - 기본 하위 폴더 재생성 완료"

