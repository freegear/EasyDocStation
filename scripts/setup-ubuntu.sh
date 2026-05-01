#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ensure_frontend_dependency() {
  local pkg="$1"
  if npm ls "$pkg" --depth=0 >/dev/null 2>&1; then
    echo "[INFO] 프론트 의존성 이미 설치됨: $pkg"
    return 0
  fi

  echo "[INFO] 프론트 의존성 설치: $pkg"
  if npm install "$pkg"; then
    return 0
  fi

  echo "[WARN] 일반 설치 실패, --legacy-peer-deps 재시도: $pkg"
  npm install "$pkg" --legacy-peer-deps
}

if ! grep -qi ubuntu /etc/os-release 2>/dev/null; then
  echo "[WARN] Ubuntu가 아닌 환경으로 보입니다. 계속 진행합니다."
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "[ERROR] sudo 명령이 필요합니다."
  exit 1
fi

DB_NAME="${APP_DB_NAME:-easydocstation}"
DB_USER="${APP_DB_USER:-easydocstation}"
DB_PASS="${APP_DB_PASS:-easydocstation1234}"
CLIENT_ORIGIN="${CLIENT_ORIGIN:-http://localhost:5173}"
INSTALL_CASSANDRA="${INSTALL_CASSANDRA:-0}"
INSTALL_OLLAMA="${INSTALL_OLLAMA:-0}"
OLLAMA_MODEL="${OLLAMA_MODEL:-gemma4:e4b}"
INSTALL_HIRES_DEPS="${INSTALL_HIRES_DEPS:-0}"

echo "[1/8] Ubuntu 패키지 설치"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl ca-certificates gnupg lsb-release software-properties-common \
  python3-full python3-venv python3-pip build-essential pkg-config libpq-dev \
  postgresql postgresql-contrib \
  cups cups-client printer-driver-cups-pdf \
  poppler-utils ffmpeg libreoffice libreoffice-impress \
  tesseract-ocr tesseract-ocr-eng tesseract-ocr-kor

if ! command -v node >/dev/null 2>&1; then
  echo "[INFO] Node.js 설치"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

echo "[2/8] PostgreSQL 서비스 기동"
sudo systemctl enable postgresql >/dev/null 2>&1 || true
sudo systemctl start postgresql

echo "[2-0/8] CUPS 인쇄 서비스 기동"
sudo systemctl enable cups >/dev/null 2>&1 || true
sudo systemctl restart cups || true

echo "[3/8] PostgreSQL DB/계정 준비"
sudo -u postgres psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};
SQL

echo "[3-0/8] PostgreSQL 권한 보정(public schema)"
sudo -u postgres psql -d "${DB_NAME}" <<SQL
GRANT CONNECT, TEMP ON DATABASE ${DB_NAME} TO ${DB_USER};
GRANT USAGE, CREATE ON SCHEMA public TO ${DB_USER};
ALTER SCHEMA public OWNER TO ${DB_USER};
DO \$\$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO ${DB_USER}', r.tablename);
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname='public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO ${DB_USER}', r.viewname);
  END LOOP;
  FOR r IN SELECT matviewname FROM pg_matviews WHERE schemaname='public' LOOP
    EXECUTE format('ALTER MATERIALIZED VIEW public.%I OWNER TO ${DB_USER}', r.matviewname);
  END LOOP;
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema='public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO ${DB_USER}', r.sequence_name);
  END LOOP;
END
\$\$;
DO \$\$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO ${DB_USER}', r.proname, r.args);
  END LOOP;
END
\$\$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO ${DB_USER};
SQL

echo "[3-1/8] PostgreSQL 스키마 적용"
PGPASSWORD="${DB_PASS}" psql -h localhost -U "${DB_USER}" -d "${DB_NAME}" -f "$ROOT_DIR/server/schema.sql" >/dev/null

if [[ "$INSTALL_CASSANDRA" == "1" ]]; then
  echo "[4/8] Cassandra 설치/기동"
  if ! command -v cassandra >/dev/null 2>&1; then
    echo "deb https://debian.cassandra.apache.org 50x main" | sudo tee /etc/apt/sources.list.d/cassandra.list >/dev/null
    curl -fsSL https://downloads.apache.org/cassandra/KEYS | sudo gpg --dearmor -o /usr/share/keyrings/cassandra.gpg
    sudo apt-get update -y
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y cassandra
  fi
  sudo systemctl enable cassandra >/dev/null 2>&1 || true
  sudo systemctl start cassandra || true
else
  echo "[4/8] Cassandra 설치는 건너뜀 (INSTALL_CASSANDRA=1 로 활성화 가능)"
fi

if [[ "$INSTALL_OLLAMA" == "1" ]]; then
  echo "[5/8] Ollama 설치"
  if ! command -v ollama >/dev/null 2>&1; then
    curl -fsSL https://ollama.com/install.sh | sh
  fi

  echo "[5-1/8] Ollama 서버 준비"
  if ! curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^ollama\.service'; then
      sudo systemctl enable ollama >/dev/null 2>&1 || true
      sudo systemctl restart ollama
    else
      nohup ollama serve >/tmp/ollama-serve.log 2>&1 &
      sleep 2
    fi
  fi

  if ! curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "[WARN] Ollama 서버를 시작하지 못했습니다. 모델 설치는 건너뜁니다."
  else
    echo "[5-2/8] Ollama 모델 설치 (${OLLAMA_MODEL})"
    if ! ollama pull "${OLLAMA_MODEL}"; then
      echo "[WARN] ${OLLAMA_MODEL} pull 실패. gemma3:4b 기반 별칭을 생성합니다."
      ollama pull gemma3:4b
      tmp_modelfile="$(mktemp)"
      cat > "${tmp_modelfile}" <<'EOF'
FROM gemma3:4b
EOF
      ollama create "${OLLAMA_MODEL}" -f "${tmp_modelfile}"
      rm -f "${tmp_modelfile}"
    fi
  fi
else
  echo "[5/8] Ollama 설치는 건너뜀 (INSTALL_OLLAMA=1 로 활성화 가능)"
fi

echo "[6/8] Node 패키지 설치"
npm install
npm install --prefix server
sudo npx playwright install-deps
npx playwright install
ensure_frontend_dependency "@tiptap/extension-table"
ensure_frontend_dependency "mermaid"

echo "[7/8] Python venv 및 RAG 의존성 설치"
if [[ -e "$ROOT_DIR/.venv" && ! -w "$ROOT_DIR/.venv" ]]; then
  echo "[INFO] 기존 .venv 권한이 현재 사용자와 달라 복구합니다."
  sudo chown -R "$(id -un):$(id -gn)" "$ROOT_DIR/.venv" || true
fi
if [[ -e "$ROOT_DIR/.venv" && ! -w "$ROOT_DIR/.venv" ]]; then
  echo "[WARN] .venv 권한 복구 실패. 재생성을 위해 삭제 시도합니다."
  sudo rm -rf "$ROOT_DIR/.venv"
fi
python3 -m venv --clear "$ROOT_DIR/.venv"
source "$ROOT_DIR/.venv/bin/activate"
python -m pip install -U pip wheel packaging "setuptools<82"
# 오디오 패키지는 미사용이므로 충돌 방지 차원에서 제거
python -m pip uninstall -y torchaudio >/dev/null 2>&1 || true
# 기본 설치에서는 torchvision 제거(hi_res 의존성은 DGX 스크립트에서 설치)
if [[ "$INSTALL_HIRES_DEPS" != "1" ]]; then
  python -m pip uninstall -y torchvision timm >/dev/null 2>&1 || true
fi
python -m pip install -r "$ROOT_DIR/server/requirements.txt"
python - <<'PY'
import torch
from packaging.version import Version
ver = Version(torch.__version__.split("+")[0])
print(f"[INFO] installed torch={torch.__version__}")
if ver < Version("2.6"):
    raise SystemExit("[ERROR] torch>=2.6 이 필요합니다. scripts/setup-dgx-spark.sh 를 실행해 CUDA torch를 재설치하세요.")
PY
deactivate

echo "[8/8] 프로젝트 설정 파일 자동 구성"
mkdir -p "$ROOT_DIR/Database/PoseSQLDB" "$ROOT_DIR/Database/CassandraDB" "$ROOT_DIR/Database/ObjectFile" "$ROOT_DIR/Database/LanceDB"

node <<'NODE'
const fs = require('fs')
const path = require('path')
const root = process.cwd()
const configPath = path.join(root, 'config.json')
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
cfg.EasyDocStationFolder = root
cfg['PostgreSQL Database Path'] = 'Database/PoseSQLDB'
cfg['Cassandra Database Path'] = 'Database/CassandraDB'
cfg['ObjectFile Path'] = 'Database/ObjectFile'
cfg['lancedb Database Path'] = 'Database/LanceDB'
cfg.PostgreSQL = cfg.PostgreSQL || {}
cfg.PostgreSQL.host = 'localhost'
cfg.PostgreSQL.port = 5432
cfg.PostgreSQL.database = process.env.APP_DB_NAME || 'easydocstation'
cfg.Cassandra = cfg.Cassandra || {}
cfg.Cassandra.contactPoints = cfg.Cassandra.contactPoints || ['127.0.0.1']
cfg.Cassandra.localDataCenter = cfg.Cassandra.localDataCenter || 'datacenter1'
cfg.Cassandra.keyspace = cfg.Cassandra.keyspace || 'easydocstation'
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2))
NODE

JWT_SECRET_VALUE="$(openssl rand -hex 24)"
cat > "$ROOT_DIR/server/.env" <<EOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
JWT_SECRET=${JWT_SECRET_VALUE}
PORT=3001
CLIENT_ORIGIN=${CLIENT_ORIGIN}
EOF

echo "[8-1/8] 기본 사용자 시드 적용"
npm run seed --prefix "$ROOT_DIR/server" >/dev/null || true

echo
echo "완료되었습니다."
echo "다음 명령으로 실행하세요:"
echo "  cd ${ROOT_DIR}"
echo "  npm run dev:ubuntu"
