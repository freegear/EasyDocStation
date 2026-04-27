#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ASSUME_YES=0

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/reset-rag-storage.sh [--yes]

Description:
  LanceDB(Vector Store)와 FileTrainingData를 함께 초기화합니다.
  - LanceDB: config.json의 "lancedb Database Path" 내부 전체 삭제
  - FileTrainingData: config.json의 "ObjectFile Path"/FileTrainingData 내부 전체 삭제
  폴더 자체는 유지/재생성됩니다.

Options:
  --yes   확인 프롬프트 없이 즉시 실행
EOF
  exit 0
fi

if [[ "${1:-}" == "--yes" ]]; then
  ASSUME_YES=1
fi

PATH_INFO="$(node - <<'NODE'
const fs = require('fs')
const path = require('path')

const root = process.cwd()
const cfgPath = path.join(root, 'config.json')
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))

const lancedbRaw = cfg['lancedb Database Path'] || 'Database/LanceDB'
const objectRaw = cfg['ObjectFile Path'] || 'Database/ObjectFile'

const lancedbPath = path.isAbsolute(lancedbRaw) ? lancedbRaw : path.join(root, lancedbRaw)
const objectPath = path.isAbsolute(objectRaw) ? objectRaw : path.join(root, objectRaw)
const fileTrainingPath = path.join(objectPath, 'FileTrainingData')

process.stdout.write(JSON.stringify({ lancedbPath, fileTrainingPath }))
NODE
)"

LANCEDB_PATH="$(echo "$PATH_INFO" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.lancedbPath)})")"
FILE_TRAINING_PATH="$(echo "$PATH_INFO" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.fileTrainingPath)})")"

echo "[Reset] 대상 경로"
echo "  - LanceDB:        $LANCEDB_PATH"
echo "  - FileTrainingData: $FILE_TRAINING_PATH"

if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo
  read -r -p "위 경로의 내부 데이터를 모두 삭제합니다. 계속할까요? (yes/no): " answer
  if [[ "$answer" != "yes" ]]; then
    echo "[Reset] 취소되었습니다."
    exit 0
  fi
fi

clear_dir_contents() {
  local dir="$1"
  mkdir -p "$dir"
  find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

clear_dir_contents "$LANCEDB_PATH"
clear_dir_contents "$FILE_TRAINING_PATH"

echo "[Reset] 완료"
echo "  - LanceDB 내부 초기화 완료"
echo "  - FileTrainingData 내부 초기화 완료"

