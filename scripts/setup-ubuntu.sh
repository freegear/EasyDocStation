#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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

echo "[1/8] Ubuntu 패키지 설치"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl ca-certificates gnupg lsb-release software-properties-common \
  python3-full python3-venv python3-pip build-essential pkg-config libpq-dev \
  postgresql postgresql-contrib

if ! command -v node >/dev/null 2>&1; then
  echo "[INFO] Node.js 설치"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

echo "[2/8] PostgreSQL 서비스 기동"
sudo systemctl enable postgresql >/dev/null 2>&1 || true
sudo systemctl start postgresql

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
else
  echo "[5/8] Ollama 설치는 건너뜀 (INSTALL_OLLAMA=1 로 활성화 가능)"
fi

echo "[6/8] Node 패키지 설치"
npm install
npm install --prefix server

echo "[7/8] Python venv 및 RAG 의존성 설치"
python3 -m venv "$ROOT_DIR/.venv"
source "$ROOT_DIR/.venv/bin/activate"
python -m pip install -U pip setuptools wheel
python -m pip install -r "$ROOT_DIR/server/requirements.txt"
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
