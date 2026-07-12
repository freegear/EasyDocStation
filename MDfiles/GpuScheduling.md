# GpuScheduling.md — GPU 학습 스케줄링 설계·구현 계획서

> 이 문서는 [RAG.md](./RAG.md) "5. GPU 학습 스케줄링" 장을 **실제 현재 코드 기준으로 구체화한 설계/계획서**다.
> 코드 변경 전에 이 문서로 방향·단계·리스크·롤백·검증 기준을 합의한다.
> 관련: [UploadFolder.md](./UploadFolder.md) 11장(폴더 업로드 대량 학습이 원인), 23.6(현황).

## 0. 한 줄 요약

폴더 업로드 대량 학습이 실시간 검색·답변과 같은 GPU를 서로 모른 채 경합하는 문제를 **5단계로 점진 해소**한다. 핵심은 두 가지다. ① 위험이 낮고 통증 완화 효과가 큰 것부터 한다(협조 게이트 → 임베딩 단일화). ② **가장 큰 인프라(Redis 브로커 큐)는 유실 방지가 실제 요구가 될 때 뒤로 미룬다.** 현재 학습은 `server/folder/ragTrainer.js`가 `rag_train.py`를 fire-and-forget spawn 하므로 어떤 게이트도 걸리지 않는다.

**단계 요약**

| 단계 | 내용 | 핵심 효과 | 위험 | 인프라 |
|---|---|---|---|---|
| **1** | 경량 협조 게이트 (nvidia-smi 물리 게이트 + 협조적 양보, spawn 유지) | 학습이 검색·답변에 양보 | 저 | 없음(선택적 Redis 리스) |
| **2** | 임베딩 단일화 (학습 임베딩을 rag_server `/embed`로 통일) | **OOM 근본 원인(bge-m3 이중 로드) 제거** | 중 | 없음(기존 `/embed` 재사용) |
| **3** | 관측성 (yield/admit 거절/대기시간 메트릭 + 관리 페이지 노출) | 게이트 실효 검증 | 저 | 없음(`aiMetrics.js` 확장) |
| **4** | 정식 단일 브로커 큐 (`ai:queue:*` 소비자 그룹 + 우선순위 레인) | 유실 방지·우선순위 정식화 | 고 | Redis Stream 소비자 |
| **5** | 운영 성숙 (기아 방지·청크 단위 양보·Ollama 협조 강화) | 대규모 운영 안정 | 중 | 상황별 |

> **설계 재정렬 근거:** 이전 판본은 "1단계 게이트 → 2단계 정식 브로커(임베딩 단일화 포함)"의 2분할이었다. 그러나 ① 임베딩 단일화는 OOM을 직접 죽이고 `rag_server.py`의 기존 `/embed` 엔드포인트로 **큐 없이도 가능**하며, ② 관측성 없이는 게이트가 실제로 도는지 검증이 어렵고, ③ Redis 브로커는 위험·비용이 가장 큰데 유실 방지가 급한 요구가 아니므로, 가치/위험 기준으로 **임베딩 단일화와 관측성을 브로커 앞으로 당겨** 5단계로 세분했다.

## 1. 현재 코드 실측 (설계의 근거)

RAG.md 5.2의 서술을 실제 파일/함수로 고정한다.

| 구성요소 | 실제 위치 | 상태 |
|---|---|---|
| 검색 임베딩(상주) | `server/rag_server.py` — bge-m3 상주, `_embed_lock`(프로세스 내부 직렬화), `do_POST`에 `/embed`(action=`embed`) 엔드포인트 존재 | GPU 상주. **`/embed`가 이미 있어 임베딩 단일화의 발판이 마련됨** |
| 학습(임베딩) | `server/folder/ragTrainer.js` `runTrainer()` → `spawn(rag_train.py)` fire-and-forget; `server/routes/rag.js` `callPythonTrainer()`도 동일 spawn | **게이트 없음**. spawn 직결 |
| 학습 임베딩 경유 | `server/rag_train.py` `EMBED_SERVER_RETRIES` 재시도 경로 존재 | rag_server `/embed` 경유가 **부분 존재**(충돌 5 완화 여지 큼) |
| 답변/캡션 | Ollama(dgx-spark) | 별도 GPU 소비. 브로커가 모름 |
| 큐(producer) | `server/aiQueue.js` `enqueueTask()` — `ai:queue:{task}` 스트림, `ai:payload:{id}` 키, **`priority` 필드 이미 있음** | **producer-only. consumer 없음** |
| 큐 설정 | `server/aiOptimization.js` — `redis_enabled`, `queue_enabled`(기본 false), `worker_heartbeat_sec`(기본 5) | 플래그만 존재 |
| Redis | `server/redisClient.js` `getRedisClient()` | 사용 가능 |
| 메트릭 | `server/aiMetrics.js` — `recordGpuCall`, `recordQueue`, `recordRequest`, `snapshot` | GPU/큐 메트릭 훅 존재 |
| 폴더 학습 루프 | `server/rag_train.py` 말미 `for fdoc in folder_documents: ... records.extend(...)` 후 **마지막에 `table.add(records)` 1회** | 파일 단위 양보를 위해 **루프 재구조화 필요** |

핵심 문제(불변): 상주 검색 서버와 학습 서브프로세스는 **별개 OS 프로세스**라 공유 세마포어가 없다. bge-m3가 두 번 로드될 수 있고, 대량 학습이 실시간 검색·답변을 지연시키거나 OOM을 유발한다.

## 2. 목표와 비목표

**목표**
- 학습은 GPU가 비어 있을 때만 진행하고, 대화형 요청(검색·답변)에 양보한다.
- 대량 폴더 업로드 학습 중에도 검색·답변 지연을 임계치 이내로 유지한다.
- 워커가 죽어도 학습 작업이 유실되지 않고 재개된다(정식 단계).

**비목표(현 단계)**
- 실행 중 CUDA 커널의 hard preemption(불가). 협조적 양보(파일 단위 yield)로 대체한다.
- 검색을 큐에 태우는 것(지연 민감, 충돌 1). 검색은 빠른 직결 경로를 유지한다.
- 다중 GPU 스케줄링/분산 학습.

## 3. 아키텍처 결정

RAG.md 5.3의 **단일 GPU 브로커 + 우선순위 레인 + 협조적 양보**를 채택하되, **위험을 낮추기 위해 2계층으로 분리 도입**한다.

### 3.1 GPU 게이트 (공통 기반, 신규 `server/gpu/gpuGate.js`)

두 단계 모두가 쓰는 얇은 판정 계층. 프로세스 간 조정을 Redis로 한다.

- **물리 게이트(보조/항상):** `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total` 파싱. `util >= UTIL_MAX(기본 80%)` 또는 `mem_used/total >= MEM_MAX(기본 85%)`이면 "GPU 바쁨". 브로커가 모르는 외부 사용(Ollama 포함)까지 커버(충돌 6). 결과는 짧게 캐시(예: 2s)해 nvidia-smi 폭주를 막는다.
- **논리 게이트(주):** "대화형 작업 진행 중" 신호. Redis 키 `gpu:interactive:active`(TTL 기반 리스)로 표현.
  - 검색·답변 경로(`server/routes/rag.js` 검색 진입, Ollama 호출 진입)에서 요청 시작 시 `SET gpu:interactive:active <n> EX 10` 류로 리스를 갱신(하트비트), 종료 시 감소/만료.
  - 학습은 매 파일 단위 시작 전에 이 키를 확인해, 존재하면 양보한다.
- 인터페이스(초안):
  ```js
  // server/gpu/gpuGate.js
  async function markInteractiveBusy(ttlSec = 10) // 검색/답변 진입 시 호출(하트비트)
  async function isInteractiveActive()            // 논리 게이트
  async function isGpuPhysicallyBusy()            // nvidia-smi (캐시됨)
  async function canAdmitTraining()               // !interactiveActive && !physicallyBusy
  ```
- **Redis 미가동 폴백:** `getRedisClient()`가 null이면 논리 게이트는 "바쁨 아님"으로 간주하고 물리 게이트만 적용한다(기존 동작 보존, 학습이 완전히 멈추지 않게).

### 3.2 1단계 — 경량 협조 게이트 (spawn 유지, 저위험)

큐 아키텍처 없이 게이트만 얹는다. **검색 경로는 무변경**, 학습 경로만 손댄다.

- `server/folder/ragTrainer.js` `trainFolderDocuments()`를 **파일 그룹 단위 분할 + 게이트 확인**으로 재구성:
  - 문서 배열을 N개(설정 `train_yield_batch`, 기본 1) 단위로 나눠 순차 실행하고, 각 그룹 실행 전 `gpuGate.canAdmitTraining()`을 확인. 바쁨이면 백오프 sleep(지수, 상한) 후 재확인.
  - **Python(`rag_train.py`)을 건드리지 않고 JS 쪽에서 파일 단위 양보를 구현**한다(권장 — Python에 Redis 의존성 추가 회피). rag_train.py를 여러 번 나눠 호출하는 형태.
  - `gpu_gate_enabled=false`(또는 `EASYDOC_GPU_GATE=off`)면 게이트 무시(기존 fire-and-forget과 동일).
- 검색·답변 경로에 `markInteractiveBusy()` 하트비트만 삽입(`server/routes/rag.js` 검색 진입부, Ollama 호출 래퍼). 순수 추가라 검색 로직을 바꾸지 않는다.

**효과:** 학습이 검색/답변에 양보하고, GPU 물리 포화 시 admit 정지. 되돌리기 쉬움. **한계:** bge-m3 이중 로드는 그대로 → OOM 근본 원인은 2단계가 해결.

### 3.3 2단계 — 임베딩 단일화 (OOM 근본 해결, 큐 없이 가능)

학습 임베딩을 rag_server `/embed`로 완전히 몰아 **bge-m3를 단 하나만 상주**시킨다(충돌 4·5). Redis 브로커 없이 가능한 것이 핵심.

- `server/rag_server.py`에 이미 `/embed`(action=`embed`, `_embed_lock` 직렬화) 엔드포인트가 있다. `server/rag_train.py`에도 `EMBED_SERVER_RETRIES` 재시도 경로가 부분 존재한다 → **이 경로를 정식화·확장**한다.
- 학습 시 자체 bge-m3 로드를 제거하고, 청크 임베딩을 rag_server `/embed`로 요청. 검색과 학습이 같은 GPU 소유자(단일 상주 모델)를 공유하므로 VRAM 이중 점유가 사라진다.
- rag_server가 학습 임베딩까지 받으면 검색 지연이 커질 수 있으므로, **1단계 게이트가 선행**되어야 한다(학습 임베딩 요청 자체가 대화형에 양보). `/embed`는 `_embed_lock`으로 이미 직렬화되어 프로세스 내부 경합은 안전.
- rag_server 미가동/`/embed` 실패 시 기존 자체 로드로 폴백(플래그·재시도).

**효과:** OOM 위험 근본 완화, GPU 소유자 단일화로 이후 조정이 쉬워짐.

### 3.4 3단계 — 관측성 (게이트 실효 검증)

게이트·양보가 실제로 도는지 수치로 확인한다. 없으면 1·2단계가 "동작하는 척"만 할 수 있다.

- `server/aiMetrics.js`에 yield 횟수, training admit 거절 수, 학습 대기시간, 물리 게이트 차단 수를 기록.
- 사이트 관리 페이지(`src/components/SiteAdminPage.jsx` 등)에 노출: 현재 GPU 상태(util/mem), 최근 yield/대기 추이, 학습 큐/진행 상태.
- 검증 기준(§8)을 이 지표로 측정한다.

### 3.5 4단계 — 정식 단일 GPU 브로커 큐 (유실 방지·우선순위)

RAG.md 5.5의 정식안. **유실 방지가 실제 운영 요구가 될 때** 진행한다(위험·비용 최고).

- **GPU 브로커 워커 신설(`server/gpu/broker.js`):** `ai:queue:*`를 소비하는 **유일한** GPU 디스패처. 소비자 그룹(`XGROUP`/`XREADGROUP`)으로 재개 보장. `worker_heartbeat_sec`로 생존 신호.
- **우선순위 레인:** `interactive`(high) / `training`(low). enqueue 시 `priority`로 구분(`aiQueue.js`에 필드 이미 존재). high가 비고 `canAdmitTraining()`일 때만 training admit.
- **학습을 큐 잡으로 전환:** `ragTrainer`/`routes/rag.js`의 spawn 직결을 `enqueueTask('training', payload, { priority: 'batch' })`로 대체. **`gpu_broker_enabled=false`면 기존 spawn 경로로 폴백**(병존, 즉시 롤백).
- 물리 게이트(1단계)·임베딩 단일화(2단계)를 admit 조건·실행에 그대로 재사용.

### 3.6 5단계 — 운영 성숙 (필요 시)

가치 순:

1. **기아(starvation) 방지:** 검색이 끊임없으면 학습이 영영 안 도는 문제. 최소 진행 보장(`max_yield_wait_sec` 초과 시 1파일 강제 진행)·저부하 시간대 윈도우. 1단계에 최소한만 넣고 여기서 다듬는다.
2. **청크 단위 양보:** 지금 설계는 파일 단위 양보. 아주 큰 단일 PDF/Excel 한 개가 GPU를 오래 점유하는 문제가 실제로 생기면 청크 단위로 세분.
3. **Ollama 협조 강화:** 지금은 nvidia-smi 물리 게이트로 "간접" 감지만. 답변 생성 폭주와 학습을 더 정밀히 조율하려면 Ollama 요청도 논리 레인에 편입. 우선순위 낮음.

## 4. 충돌 해소 매핑 (RAG.md 5.4)

| 충돌 | 해소 방식 | 단계 |
|---|---|---|
| 1. 검색은 큐 우회 필요 | 검색은 직결 유지, `markInteractiveBusy()` 하트비트로 "진행 중"만 알림 | 1 |
| 2. 학습 spawn이라 게이트 미적용 | 1단계: JS에서 파일 단위 분할 + 게이트. 4단계: 큐 잡 전환 | 1 → 4 |
| 3. 큐에 소비자 없음 | `server/gpu/broker.js` consumer 신설(소비자 그룹) | 4 |
| 4. 프로세스 간 GPU 락 없음 | Redis 리스(`gpu:interactive:active`) + 임베딩 단일화로 GPU 소유자 단일화 | 1(리스) → 2(단일화) |
| 5. bge-m3 이중 로드 | 학습 임베딩을 rag_server `/embed` 경유로 통일 | 2 |
| 6. Ollama 별도 소비자 | nvidia-smi 물리 게이트로 전체 GPU 상태 반영 | 1 (정밀화는 5) |

## 5. 설정 플래그 (신규/확장)

**구현 위치:** `config.json`의 `gpu_scheduling` 블록 + 환경변수. `server/gpu/gpuGate.js` `gpuConfig()`가 읽는다. redis_ai(aiOptimization) 흐름과 **분리**해 저위험으로 둔다(원안은 aiOptimization 확장이었으나, redis_ai의 env sync·관리 UI 매핑을 건드리지 않으려고 별도 블록으로 뒀다).

| 키 (`gpu_scheduling.*`) | env | 기본 | 의미 |
|---|---|---|---|
| `gate_enabled` | `EASYDOC_GPU_GATE_ENABLED` / `EASYDOC_GPU_GATE=off` | `true` | 게이트 전체 on/off. off면 완전 기존 fire-and-forget. |
| `util_max_percent` | `EASYDOC_GPU_UTIL_MAX` | `80` | 물리 게이트 util 임계치(%). |
| `mem_max_percent` | `EASYDOC_GPU_MEM_MAX` | `85` | 물리 게이트 mem 임계치(%). |
| `gate_cache_ms` | `EASYDOC_GPU_GATE_CACHE_MS` | `2000` | nvidia-smi 결과 캐시(ms). |
| `train_yield_batch` | `EASYDOC_TRAIN_YIELD_BATCH` | `1` | 몇 파일마다 커밋/양보 확인(=양보 단위). |
| `train_backoff_ms` / `train_backoff_max_ms` | `EASYDOC_TRAIN_BACKOFF_MS` / `_MAX_MS` | `500` / `15000` | 양보 대기 지수 백오프. |
| `interactive_lease_ttl_sec` | `EASYDOC_INTERACTIVE_LEASE_TTL_SEC` | `10` | 대화형 리스 TTL(초). |
| `max_yield_wait_sec` | `EASYDOC_MAX_YIELD_WAIT_SEC` | `120` | 기아 방지: 이 시간 초과 시 1단위 강제 진행(0=무제한). |
| `broker_enabled` | `EASYDOC_GPU_BROKER_ENABLED` | `false` | 4단계 브로커 큐 사용. `redis_ai.queue_enabled`도 함께 켜야 실동작. |

임베딩 단일화(2단계)는 별도 플래그로 `config.json` `rag.embed_with_rag_server`(env `EASYDOC_EMBED_WITH_RAG_SERVER`, 기본 `1`)를 쓴다 — `server/rag_train.py` `embed_texts()`.

## 6. 리스크와 완화

- **학습 기아(starvation):** 검색이 끊임없으면 학습이 무한 대기. → 최소 진행 보장(예: `max_yield_wait_sec` 초과 시 1파일 강제 진행), 저부하 시간대 우선.
- **nvidia-smi 부재/실패:** 파싱 실패 시 물리 게이트는 "바쁨 아님"으로 폴백(학습 정지 방지) + 로그. GPU가 없는 개발 환경 고려.
- **Redis 장애:** 논리 게이트 비활성 + 물리 게이트만. 큐(4단계)는 `queue_enabled=false`면 기존 spawn 경로로 자동 폴백.
- **하트비트 삽입이 검색 지연:** `markInteractiveBusy`는 fire-and-forget(await 최소화), 실패해도 검색 진행.
- **임베딩 단일화(2단계)가 검색 지연 유발:** 학습 임베딩이 rag_server `/embed`로 몰리면 검색과 경합. → 1단계 게이트가 선행되어 학습 임베딩 요청 자체가 대화형에 양보하게 한다. `/embed` 실패 시 자체 로드 폴백.
- **4단계 학습 큐 전환은 되돌리기 어려움:** 플래그(`gpu_broker_enabled`)로 spawn 경로와 병존시켜 즉시 롤백 가능하게 설계.

## 7. 롤백 전략

- 1단계(게이트): `gpu_gate_enabled=false` 또는 `EASYDOC_GPU_GATE=off` → 게이트 무시, 기존 fire-and-forget과 동일.
- 2단계(임베딩 단일화): rag_server `/embed` 실패·비활성 시 학습이 자체 bge-m3 로드로 폴백(플래그·재시도).
- 4단계(브로커 큐): `gpu_broker_enabled=false` → enqueue 대신 기존 spawn 직결로 폴백. 브로커 워커 미기동이어도 학습이 멈추지 않도록 이중 경로 유지.

## 8. 검증 기준 (RAG.md 5.6 대응)

- 대량 폴더 업로드 학습 중 실시간 검색·답변 p95 지연이 임계치 이내.
- 학습 중 검색 요청 유입 시, 학습이 **다음 파일 단위에서 양보**하고 검색이 먼저 처리됨(로그로 yield 지점 확인).
- GPU VRAM/util이 임계치 초과 시 신규 학습 파일 단위가 admit되지 않음.
- (2단계) 검색·학습이 bge-m3를 이중 로드하지 않음(nvidia-smi 프로세스/VRAM 확인).
- (3단계) yield 횟수·admit 거절·학습 대기시간이 메트릭/관리 페이지에서 확인됨.
- (4단계) 워커 강제 종료 후 재기동 시 큐의 학습 잡이 소비자 그룹 pending에서 재개됨.

## 9. 단계별 작업 목록 (구현 착수 시)

**1단계 — 경량 협조 게이트 (저위험, 권장 선착수)**
1. `server/gpu/gpuGate.js` 신설: 물리 게이트(nvidia-smi 캐시) + 논리 리스(Redis) + `canAdmitTraining()`.
2. `server/aiOptimization.js`에 §5 플래그 추가(재실행 안전, env 반영).
3. `server/folder/ragTrainer.js` `trainFolderDocuments()`를 파일 그룹 분할 + 게이트/백오프로 재구성(**Python 무변경 경로 우선**).
4. 검색/답변 진입부에 `markInteractiveBusy()` 하트비트 삽입: `server/routes/rag.js` 검색 핸들러, Ollama 호출 래퍼.

**2단계 — 임베딩 단일화 (OOM 근본 해결)**
5. `server/rag_train.py`의 자체 bge-m3 로드 제거, 청크 임베딩을 rag_server `/embed`로 요청(`EMBED_SERVER_RETRIES` 경로 정식화·확장).
6. rag_server 미가동/`/embed` 실패 시 자체 로드 폴백 유지(플래그·재시도).

**3단계 — 관측성 (게이트 실효 검증)**
7. `server/aiMetrics.js`에 yield/대기/admit 거절/물리 게이트 차단 카운트 연동.
8. 사이트 관리 페이지에 GPU 상태·yield 추이·학습 진행 노출.

**4단계 — 정식 단일 브로커 큐 (유실 방지·우선순위, 요구 생길 때)**
9. `server/gpu/broker.js` 신설: `ai:queue:*` 소비자 그룹, admission·양보 제어, 하트비트.
10. 학습 경로(`ragTrainer.js`/`routes/rag.js`)를 `enqueueTask('training', …, {priority:'batch'})`로 전환(`gpu_broker_enabled` 플래그로 spawn 경로 병존).
11. `rag_train.py`를 파일 단위 실행 + 매 단위 high 레인 확인 지점 노출.

**5단계 — 운영 성숙 (필요 시)**
12. 기아 방지(최소 진행 보장·저부하 윈도우).
13. 청크 단위 양보(대용량 단일 파일 대응).
14. Ollama 요청의 논리 레인 편입(답변 생성·학습 정밀 조율).

## 9.1 구현 현황 (2026-07-11 기준) — 1~5단계 반영 완료

| 단계 | 상태 | 실제 구현 |
|---|---|---|
| 1. 경량 협조 게이트 | **완료** | `server/gpu/gpuGate.js` 신설(물리 게이트 nvidia-smi + 논리 리스 Redis + `waitForTrainingSlot`). `server/folder/ragTrainer.js` 파일 배치 단위 게이트/양보로 재구성. 검색 하트비트 `server/routes/rag.js`(`markInteractiveBusy`), Ollama 하트비트 `server/llmClient.js`(`requestOllama`를 `withInteractiveLease`로 래핑). |
| 2. 임베딩 단일화 | **완료(기존)** | `server/rag_train.py` `embed_texts()`가 rag_server `/embed`(`EMBED_WITH_RAG_SERVER` 기본 on) + 재시도 + 로컬 폴백. 단일 임베딩 호출부. |
| 3. 관측성 | **완료** | `server/aiMetrics.js` GPU 스케줄링 메트릭(`recordTrainingSlot`/`setGpuStatus`/`summarizeGpu`). 라우트 `GET /api/admin/gpu-optimization`에 `gpu_scheduling` 상태(nvidia-smi/게이트) 추가. `src/components/SiteAdminPage.jsx` "GPU 학습 스케줄링" 패널. |
| 4. 정식 브로커 큐 | **완료(opt-in)** | `server/gpu/broker.js` 신설(전용 Redis 커넥션 소비자 그룹 `gpu-broker`, `trainBatchDirect` 재사용). `ragTrainer.trainFolderDocuments`가 `broker_enabled`면 `enqueueTask('training', …, {priority:'batch'})`, 아니면 직접 게이트 학습. `server/index.js`에서 `startBroker()` 기동. `broker_enabled`+`queue_enabled` 둘 다 켜야 실동작(기본 off → 직접 경로). |
| 5. 운영 성숙 | **완료(핵심)** | 기아 방지 `waitForTrainingSlot`의 `max_yield_wait_sec`(강제 진행). 파일 단위 양보 `train_yield_batch`(기본 1). Ollama 논리 레인 = `requestOllama` 리스. (사후 청크 단위 세분 양보는 Python↔Redis 결합 회피 원칙에 따라 파일 단위를 최소 양보 단위로 둠 — 필요 시 확장.) |

`folder_documents.training_status`는 `trainBatchDirect`가 파일 배치 단위로 소유한다(직접·브로커 경로 모두 정확한 완료/실패 시점 반영). 모든 단계는 `gate_enabled`/`broker_enabled` 플래그와 nvidia-smi/Redis 폴백으로 활성 시스템을 깨지 않는다(기본값에서 검색·기존 학습 경로 동작 보존).

## 10. 결론

가치/위험 기준으로 5단계로 나눈다. **1단계(협조 게이트)**로 "학습이 검색·답변에 양보"를 저위험·즉시 롤백 형태로 확보하고, **2단계(임베딩 단일화)**로 OOM 근본 원인인 bge-m3 이중 로드를 큐 없이 제거한다(가장 가치 높음). **3단계(관측성)**로 게이트가 실제로 도는지 검증한다. 여기까지가 폴더 업로드 대량 학습의 실질 통증을 잡는 핵심 구간이다.

**4단계(정식 브로커 큐)**는 위험·비용이 가장 크므로 "학습 유실 방지"가 실제 운영 요구가 될 때 진행하고, **5단계(운영 성숙)**는 대규모 운영에서 문제가 드러날 때 선택적으로 얹는다. 모든 단계에서 검색 직결 경로와 기존 spawn 경로를 플래그로 보존해, 활성 시스템을 깨지 않는 것을 최우선으로 한다.
