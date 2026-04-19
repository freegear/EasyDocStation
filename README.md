# EasyDocStation

## Ubuntu 이관/실행

### 1) 자동 설치/설정 (권장)
프로젝트 루트에서:

```bash
npm run setup:ubuntu
```

옵션:

```bash
INSTALL_CASSANDRA=1 INSTALL_OLLAMA=1 APP_DB_USER=freegear APP_DB_PASS='your-pass' APP_DB_NAME=easydocstation npm run setup:ubuntu
```

### DGX Spark 설치/실행 (GPU 가속)
DGX Spark 환경에서는 아래 명령을 권장합니다.

```bash
npm run setup:dgx-spark
```

필요시 CUDA PyTorch 버전/인덱스 지정:

```bash
TORCH_VERSION=2.6.0 TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124 npm run setup:dgx-spark
```

실행:

```bash
npm run dev:dgx-spark
```

설치 검증:

```bash
.venv/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

`torch` 버전이 `2.6` 미만이면 다시 설치:

```bash
npm run setup:dgx-spark
```

추가 옵션:
- `EASYDOC_RAG_DEVICE=auto|cuda|cpu|mps` (기본: `auto`)
- `INSTALL_CASSANDRA=1`, `INSTALL_OLLAMA=1` (기본: 0)
- `APP_DB_USER`, `APP_DB_PASS`, `APP_DB_NAME`, `CLIENT_ORIGIN`

설치 스크립트가 자동으로 수행하는 내용:
- PostgreSQL 설치/기동 및 DB/계정 생성
- (옵션) Cassandra/Ollama 설치
- Node 의존성 설치
- Python venv(`.venv`) 생성 + RAG 의존성 설치
- `config.json` 자동 보정:
  - `EasyDocStationFolder`: 현재 프로젝트 절대경로
  - DB 경로 4개: `Database/...` 상대경로
- `server/.env` 자동 생성 (`DATABASE_URL`, `JWT_SECRET`, `PORT`, `CLIENT_ORIGIN`)

### 2) 실행

```bash
npm run dev:ubuntu
```

`dev:ubuntu`는 `.venv/bin/python3`를 자동으로 사용해 RAG Python 모듈 경로 이슈를 줄입니다.

## 코드의 Ubuntu 자동 조정 방식
- DB/스토리지 경로는 `config.json`의
  - `EasyDocStationFolder`
  - `PostgreSQL/Cassandra/ObjectFile/lancedb Database Path`
  를 조합해서 계산합니다.
- Linux/macOS 간 절대경로 불일치가 있으면 안전하게 fallback합니다.
- Python 실행 파일은 우선순위로 자동 선택합니다:
  - `PYTHON_BIN` 환경변수
  - `VIRTUAL_ENV/bin/python3`
  - `python3`

## 수동 실행 (기존 방식)
```bash
npm run dev
```
