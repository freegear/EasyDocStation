#!/usr/bin/env bash
set -euo pipefail
cfg=/opt/easydocstation/config.json
[[ -f "$cfg" ]] || { echo "[ERROR] 외부 config.json 마운트가 필요합니다: $cfg" >&2; exit 1; }
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$cfg"
mkdir -p /data/Database/{ObjectFile/FileTrainingData,LanceDB,RAGTrainingData}
ln -sfn /data/Database /opt/easydocstation/Database
exec "$@"
