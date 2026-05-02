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
- `INSTALL_CASSANDRA=1`, `INSTALL_OLLAMA=1` (`setup:ubuntu` 기본: 0, `setup:dgx-spark` 기본: 1)
- `CASSANDRA_REQUIRED=1|0` (`setup/run:dgx-spark` 기본: 1, 미연결 시 즉시 중단)
- `APP_DB_USER`, `APP_DB_PASS`, `APP_DB_NAME`, `CLIENT_ORIGIN`

## DGX-SPARK 전용 실행

아래 3개 스크립트로 DGX-SPARK 환경을 고정적으로 운영할 수 있습니다.
`run/rerun`은 백그라운드(`nohup`)로 실행되어, 터미널 종료/로그아웃 후에도 계속 동작합니다.

### 1) 설치

```bash
bash scripts/dgx-spark-install.sh
```

### 2) 실행

```bash
bash scripts/dgx-spark-run.sh
```

상태 확인/중지:

```bash
bash scripts/run-dgx-spark.sh --status
bash scripts/run-dgx-spark.sh --stop
```

로그 확인(백엔드 크래시 포함):

```bash
tail -f logs/run-dgx-spark-$(date +%Y%m%d).log
```

### 3) 재실행

```bash
bash scripts/dgx-spark-rerun.sh
```

### 4) 설치/실행 확인

```bash
bash scripts/dgx-spark-install.sh --help
bash scripts/dgx-spark-run.sh --help
bash scripts/dgx-spark-rerun.sh --help
```

### 5) 참고
- 내부적으로 각각 아래 스크립트를 호출합니다.
- `dgx-spark-install.sh` -> `scripts/install-dgx-spark.sh`
- `dgx-spark-run.sh` -> `scripts/run-dgx-spark.sh`
- `dgx-spark-rerun.sh` -> `scripts/rerun-dgx-spark.sh`
- `run-dgx-spark.sh`는 `EASYDOC_DAEMON_MODE=1`로 실행되어 백엔드는 `node server/index.js` 기반으로 자동 재시작됩니다.
- 로그 파일: `logs/run-dgx-spark-{YYYYMMDD}.log`, `logs/rerun-dgx-spark-{YYYYMMDD}.log`
- PID 파일: `logs/dgx-spark.pid`
- 설치 시 프론트 의존성에 아래 컴포넌트가 포함됩니다.
  - `react-to-print`
  - `react-colorful`
  - `mermaid`
  - `echarts`
  - `@tiptap/extension-color`
  - `@tiptap/extension-text-style`
  - `@tiptap/extension-table`
  - `@tiptap/extension-table-row`
  - `@tiptap/extension-table-cell`
  - `@tiptap/extension-table-header`
  - `@tiptap/extension-table-of-contents`

설치 스크립트가 자동으로 수행하는 내용:
- PostgreSQL 설치/기동 및 DB/계정 생성
- Cassandra 설치/기동(`setup:dgx-spark` 기본), Ollama 설치(옵션)
- Node 의존성 설치
- Python venv(`.venv`) 생성 + RAG 의존성 설치
- `config.json` 자동 보정:
  - `EasyDocStationFolder`: 현재 프로젝트 절대경로
  - DB 경로 4개: `Database/...` 상대경로
- `server/.env` 자동 생성 (`DATABASE_URL`, `JWT_SECRET`, `PORT`, `CLIENT_ORIGIN`)

### Local AgenticAI (macOS/Windows) Ollama 설치

```bash
npm run setup:local-ollama
```

Windows PowerShell에서 직접 실행하려면:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-local-ollama.ps1
```

### 2) 실행

```bash
npm run dev:ubuntu
```

`dev:ubuntu`는 `.venv/bin/python3`를 자동으로 사용해 RAG Python 모듈 경로 이슈를 줄입니다.

### 3) 재시작 (관련 프로세스 전체 종료 후 재기동)

```bash
npm run restart:ubuntu
```

`restart:ubuntu`는 EasyDocStation 관련 실행 프로세스(프론트/백엔드/dev runner)를 먼저 종료한 뒤 `dev:ubuntu`로 다시 시작합니다.

DGX Spark 모드 재시작:

```bash
npm run restart:dgx-spark
```

`restart:dgx-spark`는 관련 실행 프로세스를 먼저 종료한 뒤 `dev:dgx-spark`로 다시 시작합니다.

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
