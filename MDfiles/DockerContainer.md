# EasyStation 컨테이너화 검토안

## 1. 결론

현재 EasyStation은 컨테이너로 배포할 수 있다. 다만 기존 `setup-ubuntu.sh`를 이미지 안에서 그대로 실행하는 방식은 적합하지 않다. 이 스크립트는 `sudo`, `systemctl`, 호스트 패키지 설치와 로컬 DB 기동을 전제로 하기 때문이다.

권장 구조는 Docker Compose 기반의 다중 컨테이너 구성이다.

| 서비스 | 역할 | 영속 데이터 |
|---|---|---|
| `app` | Vite로 빌드한 프런트엔드, Node API, Python RAG/STT | ObjectFile, LanceDB, RAGTrainingData, 설정 |
| `postgres` | 관계형 데이터와 사용자·채널·메일 메타데이터 | Docker volume |
| `cassandra` | 게시물·댓글 등 Cassandra 데이터 | Docker volume |
| `redis` | AI 캐시와 선택적 큐 | Docker volume 또는 비영속 캐시 |
| `ollama` | 로컬 LLM/OCR, 선택 서비스 | 모델 volume |

프런트엔드는 별도의 Nginx 컨테이너로 나누지 않고, 현재 `server/index.js`의 정적 파일 제공 기능을 사용해 `app:3001` 한 포트로 서비스하는 것이 가장 단순하다. 운영 시에는 이 앞에 기존 리버스 프록시나 TLS 프록시를 둘 수 있다.

## 2. 현재 코드에서 확인한 사항

- 프런트엔드 빌드 명령은 `npm run build`이고 결과물은 `dist/`이다.
- 백엔드는 `server/package.json`의 `npm start`, 즉 `node index.js`로 실행된다.
- `NODE_ENV=production` 또는 `SERVE_FRONTEND_DIST=1`이면 API 서버가 `dist/`도 함께 서비스한다.
- 기본 API 포트는 `3001`이며 `/api/health`가 존재한다.
- PostgreSQL 접속은 `DATABASE_URL` 환경변수로 변경할 수 있다.
- Cassandra 접속은 `CASSANDRA_CONTACT_POINTS`, `CASSANDRA_LOCAL_DC`, `CASSANDRA_KEYSPACE`로 변경할 수 있다.
- Redis 접속은 `REDIS_URL`로 변경할 수 있다.
- Ollama 접속은 `OLLAMA_HOST`, `OLLAMA_PORT`로 변경할 수 있다.
- ObjectFile과 LanceDB 경로는 `EASYDOC_DB_BASE`, `EASYDOC_LANCEDB_PATH`, `EASYDOC_STATION_FOLDER`로 컨테이너 경로를 지정할 수 있다.
- Node 백엔드가 Python 프로세스를 직접 실행하므로 앱 이미지에는 Node와 Python 런타임이 모두 필요하다.
- RAG 서버는 현재 `127.0.0.1:5001`에 바인딩되고 일부 Node 코드도 포트 `5001`을 고정 사용한다. 따라서 첫 컨테이너화 단계에서는 Node와 Python RAG를 같은 `app` 컨테이너에 둬야 한다.
- PostgreSQL 스키마와 Cassandra keyspace/table은 앱 시작 시 생성 또는 보정된다. 단, DB가 준비되기 전에 앱이 시작되지 않도록 health check와 `depends_on`이 필요하다.

## 3. 권장 파일 구성

구현 단계에서 다음 파일을 추가하는 방식을 권장한다.

```text
Dockerfile
.dockerignore
docker-compose.yml
docker/
  entrypoint.sh
  config.container.json
scripts/
  container-build.sh
  container-install.sh
  container-backup.sh
```

`container-build.sh`는 이미지를 빌드하고 선택적으로 tar 파일로 내보내는 역할만 수행한다. 대상 서버 설치와 볼륨 생성, 환경 설정은 `container-install.sh`로 분리한다. 빌드와 설치를 분리해야 인터넷이 없는 서버에도 이미지를 전달할 수 있다.

## 4. Dockerfile 초안

Python RAG 의존성이 크기 때문에 프런트엔드는 별도 빌드 단계에서 만들고, 최종 이미지에는 개발 의존성과 소스 캐시를 최소화한다. 아래는 구현 방향을 보여 주는 초안이며, 실제 도입 시 Ubuntu/Debian 패키지 이름과 Python wheel 설치를 대상 CPU/GPU에서 검증해야 한다.

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js postcss.config.js tailwind.config.js ./
COPY public ./public
COPY src ./src
COPY UpdateHistory.json ./UpdateHistory.json
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    SERVE_FRONTEND_DIST=1 \
    PYTHON_BIN=/opt/easystation/venv/bin/python3 \
    EASYDOC_STATION_FOLDER=/opt/easystation \
    EASYDOC_DB_BASE=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
      ffmpeg libsndfile1 tesseract-ocr tesseract-ocr-kor \
      poppler-utils libreoffice \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/easystation
COPY server/requirements.txt ./server/requirements.txt
RUN python3 -m venv venv \
    && venv/bin/pip install --no-cache-dir --upgrade pip \
    && venv/bin/pip install --no-cache-dir -r server/requirements.txt

COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --prefix server && npm cache clean --force

COPY server ./server
COPY config.json.example ./config.json.example
COPY UpdateHistory.json ./UpdateHistory.json
COPY --from=frontend-build /build/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/easystation-entrypoint

RUN mkdir -p /data/ObjectFile /data/LanceDB /data/RAGTrainingData \
    && chmod +x /usr/local/bin/easystation-entrypoint

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3001/api/health || exit 1

ENTRYPOINT ["easystation-entrypoint"]
CMD ["node", "server/index.js"]
```

### CPU와 NVIDIA GPU 이미지

`torch`, `torchaudio`, `pyannote.audio`, `docling`, `unstructured[pdf]` 때문에 최종 이미지는 상당히 커질 수 있다. CPU와 GPU 이미지를 한 Dockerfile에 억지로 합치지 말고 다음 두 대상을 두는 편이 안전하다.

- `runtime-cpu`: CPU PyTorch wheel을 명시적으로 설치한다.
- `runtime-cuda`: NVIDIA CUDA runtime 기반 이미지와 호환되는 PyTorch wheel을 설치한다.

GPU 서버에서는 Docker 외에 NVIDIA Container Toolkit 설치가 필요하며 Compose에 GPU device reservation을 추가해야 한다. `torch>=2.6`처럼 범위만 지정하면 빌드 시점마다 결과가 달라질 수 있으므로 검증된 버전을 고정하는 것이 좋다.

## 5. entrypoint 초안

`config.json`은 이미지에 실제 운영 비밀을 포함하지 않아야 한다. 최초 실행 시 템플릿을 복사하고, 이후에는 외부에서 마운트한 설정을 유지한다.

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/easystation
CONFIG_DIR=/data/config

mkdir -p "$CONFIG_DIR" /data/ObjectFile /data/LanceDB /data/RAGTrainingData

if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
  cp "$APP_DIR/config.json.example" "$CONFIG_DIR/config.json"
fi

ln -sfn "$CONFIG_DIR/config.json" "$APP_DIR/config.json"
exec "$@"
```

단, 현재 `config.json.example`에는 메일 비밀번호와 Telegram 토큰처럼 보이는 값이 들어 있다. 컨테이너 구현 전에 반드시 해당 값들을 폐기·재발급하고 예제 파일에서는 제거해야 한다. Git 이력에 포함됐다면 현재 파일만 지우는 것으로는 충분하지 않다.

## 6. docker-compose.yml 초안

아래 예시는 기본 CPU 배포안이다. 비밀번호와 공개 URL은 `.env`에서 주입한다.

```yaml
name: easystation

services:
  app:
    image: easystation:${EASYSTATION_TAG:-latest}
    build:
      context: .
      target: runtime
    restart: unless-stopped
    env_file: .env.container
    environment:
      NODE_ENV: production
      PORT: 3001
      SERVE_FRONTEND_DIST: "1"
      CLIENT_ORIGIN: ${CLIENT_ORIGIN}
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      CASSANDRA_CONTACT_POINTS: cassandra
      CASSANDRA_LOCAL_DC: datacenter1
      CASSANDRA_KEYSPACE: easydocstation
      CASSANDRA_REQUIRED: "1"
      REDIS_URL: redis://redis:6379
      OLLAMA_HOST: ollama
      OLLAMA_PORT: 11434
      EASYDOC_STATION_FOLDER: /opt/easystation
      EASYDOC_DB_BASE: /data
      EASYDOC_LANCEDB_PATH: /data/LanceDB
      EASYDOC_FILE_TRAINING_PATH: /data/ObjectFile/FileTrainingData
    ports:
      - "${APP_BIND_IP:-0.0.0.0}:${APP_PORT:-3001}:3001"
    volumes:
      - easystation_object:/data/ObjectFile
      - easystation_lancedb:/data/LanceDB
      - easystation_training:/data/RAGTrainingData
      - easystation_config:/data/config
    depends_on:
      postgres:
        condition: service_healthy
      cassandra:
        condition: service_healthy
      redis:
        condition: service_healthy

  postgres:
    image: postgres:16-bookworm
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 10s
      timeout: 5s
      retries: 12

  cassandra:
    image: cassandra:5.0
    restart: unless-stopped
    environment:
      CASSANDRA_CLUSTER_NAME: EasyStation
      CASSANDRA_DC: datacenter1
      CASSANDRA_ENDPOINT_SNITCH: GossipingPropertyFileSnitch
      MAX_HEAP_SIZE: ${CASSANDRA_MAX_HEAP:-2G}
      HEAP_NEWSIZE: ${CASSANDRA_HEAP_NEWSIZE:-400M}
    volumes:
      - cassandra_data:/var/lib/cassandra
    healthcheck:
      test: ["CMD-SHELL", "cqlsh -e 'DESCRIBE CLUSTER' 127.0.0.1 9042"]
      interval: 15s
      timeout: 10s
      retries: 20
      start_period: 60s

  redis:
    image: redis:7-bookworm
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "4gb", "--maxmemory-policy", "allkeys-lru"]
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 10

  ollama:
    image: ollama/ollama:latest
    profiles: ["ollama"]
    restart: unless-stopped
    volumes:
      - ollama_data:/root/.ollama

volumes:
  postgres_data:
  cassandra_data:
  redis_data:
  ollama_data:
  easystation_object:
  easystation_lancedb:
  easystation_training:
  easystation_config:
```

`ollama`를 profile로 둘 경우 app이 Ollama를 필수 `depends_on` 대상으로 삼아서는 안 된다. 외부 Ollama를 사용하면 `OLLAMA_HOST`만 해당 서버 주소로 바꾼다. 운영 재현성을 위해 최종 구현에서는 모든 이미지의 patch 버전 또는 digest를 고정하는 것이 좋다.

## 7. 환경변수 예시

`.env.container.example`만 Git에 저장하고 실제 `.env.container`는 저장하지 않는다.

```dotenv
EASYSTATION_TAG=1.0.0
APP_BIND_IP=0.0.0.0
APP_PORT=3001
CLIENT_ORIGIN=https://station.example.com

POSTGRES_USER=easystation
POSTGRES_PASSWORD=change-this-long-random-password
POSTGRES_DB=easydocstation

JWT_SECRET=change-this-to-at-least-32-random-bytes
DATA_ENCRYPTION_KEY=change-this-with-the-format-required-by-the-app
REDIS_AI_CACHE_ENABLED=true
REDIS_AI_QUEUE_ENABLED=false
REDIS_AI_VECTOR_CACHE_ENABLED=false
HF_TOKEN=
```

현재 일부 애플리케이션 설정은 환경변수가 아니라 `config.json`에서만 읽는다. 메일, Telegram, Google OAuth, Groq 설정은 별도 secret 파일 또는 Docker secret으로 마운트하는 방향이 필요하다. 장기적으로는 모든 비밀 값을 환경변수로 override할 수 있게 코드에서 통일하는 것을 권장한다.

## 8. 빌드 및 전달 스크립트 초안

### `scripts/container-build.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-$(node -p "require('./package.json').version")}" 
IMAGE="easystation:${TAG}"
OUTPUT="${2:-$ROOT_DIR/release/easystation-${TAG}.tar.gz}"

cd "$ROOT_DIR"
docker build --pull --target runtime -t "$IMAGE" .
docker image inspect "$IMAGE" >/dev/null
mkdir -p "$(dirname "$OUTPUT")"
docker save "$IMAGE" | gzip > "$OUTPUT"
sha256sum "$OUTPUT" > "${OUTPUT}.sha256"

echo "생성 완료: $OUTPUT"
```

실제 스크립트에서는 `package.json`이 ESM 프로젝트라는 점 때문에 `require('./package.json')` 대신 `UpdateHistory.json` 또는 명시적 인자를 버전 기준으로 삼는 편이 안전하다. 또한 프로젝트 규칙상 빌드 산출물 `release/`는 `.gitignore`에 추가해야 한다.

### 대상 서버 설치 흐름

```bash
sha256sum -c easystation-1.0.0.tar.gz.sha256
gzip -dc easystation-1.0.0.tar.gz | docker load
cp .env.container.example .env.container
# .env.container와 /data/config/config.json의 비밀 값 수정
docker compose up -d postgres cassandra redis
docker compose up -d app
# 로컬 Ollama도 사용할 때만 다음 명령 사용
docker compose --profile ollama up -d ollama
docker compose ps
curl -fsS http://127.0.0.1:3001/api/health
```

인터넷이 차단된 대상 서버에서는 앱 이미지만 전달해서는 부족하다. Compose가 사용하는 PostgreSQL, Cassandra, Redis, Ollama 이미지도 같은 방식으로 저장해 전달하거나 사설 레지스트리를 사용해야 한다. Ollama 모델 파일도 별도로 준비해야 한다.

## 9. `.dockerignore` 필수 항목

현재 저장소에는 운영 DB, 로그, 캐시, 로컬 환경 파일과 대용량 모델 데이터가 있다. 이를 제외하지 않으면 빌드 컨텍스트가 매우 커지고 비밀 또는 개인정보가 이미지에 포함될 수 있다.

```dockerignore
.git
.env
server/.env
config.json
node_modules
server/node_modules
.venv
dist
release
logs
tmp
scratch
Database
server/__pycache__
**/__pycache__
*.log
*.pid
*.gz
.DS_Store
```

`Database/RAGTrainingData`도 `Database` 규칙으로 제외된다. 초기 데이터가 필요하면 이미지에 포함하지 말고 검증된 백업 파일로 별도 이관해야 한다.

## 10. 기존 서버 데이터 이관

현재 저장소의 DB 디렉터리를 그대로 이미지에 `COPY`하거나 새 컨테이너 볼륨에 복사하는 방식은 사용하지 않는다. PostgreSQL과 Cassandra의 물리 데이터는 버전, 파일 소유권, 실행 중 복사 여부에 영향을 받는다.

권장 순서는 다음과 같다.

1. 기존 서비스에 쓰기 중지 또는 유지보수 시간을 설정한다.
2. PostgreSQL은 `pg_dump` 또는 `pg_dumpall`로 논리 백업한다.
3. Cassandra는 현재 설치 버전을 확인한 뒤 `nodetool snapshot`과 `sstableloader`, 또는 테이블별 `COPY TO/COPY FROM` 전략을 정한다.
4. ObjectFile, LanceDB, RAGTrainingData는 서비스 중지 후 파일 단위 백업한다.
5. 새 서버의 빈 volume에서 DB 컨테이너를 먼저 기동한다.
6. 논리 백업을 복원하고 앱 컨테이너를 기동한다.
7. 사용자 수, 채널 수, 최근 게시물, 첨부 다운로드, RAG 검색을 원본과 대조한다.

LanceDB는 DB 레코드와 색인 내용의 시점이 일치해야 한다. 이관 중 데이터 변경 가능성이 있다면 LanceDB 파일 복사보다 원본 문서 이관 후 전체 RAG 재색인을 수행하는 편이 안전하다.

## 11. 배포 전 해결해야 할 위험

### 필수

- `config.json.example`의 실제로 보이는 SMTP 앱 비밀번호와 Telegram 토큰을 즉시 폐기·재발급하고 저장소에서 제거한다.
- `server/.env`, OAuth client secret, DB 파일, 로그, 첨부 파일이 Docker build context에 포함되지 않게 한다.
- 기본 사용자 비밀번호 `password123`이 자동 생성되는 현재 동작을 운영 환경에서 차단하거나 최초 로그인 강제 변경 정책을 추가한다.
- Docker 이미지의 Node, Python, PostgreSQL, Cassandra 버전을 실제 운영 데이터 버전과 맞춰 검증한다.
- 대상 서버의 CPU 아키텍처(`amd64`/`arm64`)와 GPU 종류를 확인한다. 다른 아키텍처로 전달하려면 `docker buildx build --platform ...`이 필요하다.

### 권장

- `/api/health`를 단순 프로세스 상태와 DB 준비 상태로 분리한다. 예: `/api/health/live`, `/api/health/ready`.
- 앱 프로세스를 root가 아닌 전용 사용자로 실행하고 volume 권한을 맞춘다.
- Compose에서 DB 포트 `5432`, `9042`, `6379`, Ollama `11434`는 호스트에 공개하지 않는다.
- TLS 종료, 요청 본문 크기, 백업, 로그 순환은 리버스 프록시 및 운영 정책에 포함한다.
- RAG 모델 다운로드를 컨테이너 첫 요청에 맡기지 말고 이미지 빌드 또는 별도 모델 volume 준비 단계로 명시한다.
- `requirements.txt`의 모든 Python 패키지 버전을 고정하고 SBOM 및 취약점 검사를 수행한다.

## 12. 구현 순서와 판정 기준

### 1단계: CPU 신규 설치 검증

- 빈 볼륨으로 전체 Compose 기동
- `/api/health` 성공
- 로그인, 게시물·댓글, 첨부 업로드/다운로드 성공
- PostgreSQL·Cassandra·Redis 재시작 후 데이터 유지
- 컨테이너 재생성 후 ObjectFile·LanceDB 유지

### 2단계: 데이터 이관 검증

- 테스트 서버에서 PostgreSQL/Cassandra 백업과 복원 리허설
- 원본과 주요 레코드 건수 비교
- 첨부 파일 checksum 표본 비교
- RAG 검색 결과와 권한 필터 확인

### 3단계: GPU/Ollama 검증

- `torch.cuda.is_available()` 확인
- 임베딩, STT, OCR, Ollama 응답 확인
- GPU 메모리 부족 시 큐와 동시 실행 제한 확인

### 4단계: 운영 전환

- 버전 태그와 이미지 digest 기록
- 자동 백업 및 복원 문서화
- TLS, 방화벽, 모니터링, 로그 순환 적용
- 롤백할 이전 이미지와 DB 백업 확보

최종적으로는 먼저 CPU 기반 Compose 배포를 완성하고, 실제 데이터 이관을 별도 리허설한 뒤 GPU/Ollama profile을 추가하는 순서가 가장 위험이 낮다.
