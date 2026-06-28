# EasyStation Redis 기반 GPU 부하 절감 및 Throughput 최적화 설계

EasyStation(또는 이미지/동영상 생성 및 AI 인프라 환경)에서 Redis를 활용해 GPU 사용량과 대기 시간을 줄이는 핵심 원칙은 다음 두 가지다.

1. GPU가 하지 않아도 되는 일은 절대 GPU로 보내지 않는다.
2. GPU가 일해야 한다면, 짧은 시간에 최대한 꽉 채워 일하게 만든다.

이를 위해 Redis를 단순 캐시 서버가 아니라 AI 요청의 앞단 제어 계층으로 사용한다. Redis는 중복 요청 제거, 임베딩/결과 캐싱, 큐 기반 동적 배치, GPU 워커 부하 라우팅, 대용량 미디어 전달 오프로딩을 담당한다.

---

# 2. 구조 설명

## 2.1 전체 목표

Redis 도입의 목표는 GPU 추론 서버를 더 빠르게 만드는 것이 아니라, GPU가 실제 추론에만 집중하도록 주변 작업을 Redis로 분리하는 것이다.

적용 대상은 다음과 같다.

- EasyStation 백엔드 API
- RAG 임베딩 생성
- LLM 텍스트 추론
- 이미지 생성
- 이미지/동영상 분석
- STT, OCR, Vision 모델 추론
- 향후 GPU 워커 다중화 환경

## 2.2 권장 아키텍처

```txt
Client
  |
  v
EasyStation Backend
  |
  +-- 1. Redis Cache 조회
  |       |
  |       +-- Cache Hit  -> 즉시 응답
  |       +-- Cache Miss -> 아래 단계 진행
  |
  +-- 2. Redis Lua Load Router
  |       |
  |       +-- 가장 부하가 낮은 GPU 워커 선택
  |
  +-- 3. Redis Streams Queue
  |       |
  |       +-- 요청 enqueue
  |
  v
GPU Worker
  |
  +-- 4. Stream에서 짧게 대기하며 Dynamic Batch 구성
  |
  +-- 5. Redis/Object Storage에서 입력 데이터 fetch
  |
  +-- 6. GPU 추론
  |
  +-- 7. Redis에 결과/임베딩/상태 저장
  |
  v
Backend Polling 또는 Callback/SSE/WebSocket
```

## 2.3 Redis의 역할 분리

Redis는 아래 5개 역할로 나누어 사용한다.

| 역할 | Redis 기능 | 목적 |
| --- | --- | --- |
| 결과 캐시 | String, Hash, TTL | 같은 요청의 GPU 재실행 방지 |
| 임베딩/유사도 캐시 | Redis Stack Vector Search | 유사 요청의 GPU 재실행 방지 |
| 비동기 큐 | Redis Streams, Consumer Group | GPU 워커 앞단 요청 버퍼 |
| 부하 라우팅 | Sorted Set, Hash, Lua | 가장 여유 있는 GPU 워커 선택 |
| 미디어 오프로딩 | String, Hash, TTL 또는 외부 Object Storage key | 대용량 payload 직접 전달 방지 |

## 2.4 기본 요청 흐름

1. 백엔드는 요청을 정규화한다.
2. 정규화된 요청으로 cache key를 만든다.
3. Redis에서 정확 일치 캐시를 먼저 조회한다.
4. 정확 일치 캐시가 없으면 프롬프트 임베딩을 만들고 Redis Vector Search로 유사 캐시를 조회한다.
5. 재사용 가능한 결과가 있으면 GPU 워커를 호출하지 않고 즉시 반환한다.
6. 캐시가 없으면 Lua 라우터로 GPU 워커를 선택한다.
7. 요청 본문 또는 대용량 입력 데이터는 Redis에 TTL을 걸어 저장하고, 큐에는 key만 넣는다.
8. GPU 워커는 Redis Streams에서 여러 요청을 모아 batch로 처리한다.
9. 처리 결과는 Redis에 저장하고 cache key와 request id를 연결한다.
10. 백엔드는 결과를 응답하거나 클라이언트가 request id로 조회한다.

## 2.5 적용 우선순위

초기에는 모든 기능을 한 번에 넣지 않는다. 가장 큰 효과부터 적용한다.

1. 결과 캐싱
2. 임베딩 캐싱
3. Redis Streams 기반 비동기 큐
4. GPU 워커 Dynamic Batching
5. Lua 기반 Load-Aware 라우팅
6. 대용량 미디어 key 전달 방식
7. Redis Vector Search 기반 유사 결과 재사용

---

# 3. AI 추론 결과 및 임베딩 캐싱

## 3.1 목적

동일하거나 유사한 요청이 들어왔을 때 GPU 모델을 다시 실행하지 않는다. 캐시 hit가 발생하면 GPU 사용량은 0%가 되고 응답 시간은 밀리초 단위로 줄어든다.

## 3.2 캐싱 대상

| 대상 | 예시 | Redis 저장 방식 |
| --- | --- | --- |
| LLM 답변 | RAG 최종 답변, 요약, 번역 | String 또는 Hash |
| 임베딩 벡터 | query embedding, document embedding | Hash 또는 Vector index |
| 이미지 생성 결과 | prompt -> image url/path | Hash |
| Vision 분석 결과 | image hash -> caption/OCR 결과 | Hash |
| STT 결과 | audio hash -> transcript | Hash |
| OCR 결과 | file hash/page -> text | Hash |
| RAG 검색 결과 | query+acl+filter -> references | String(JSON) |

## 3.3 Cache Key 설계

Cache key는 반드시 요청 정규화 결과로 만든다.

```txt
ai:cache:{task}:{model}:{version}:{sha256(normalized_payload)}
```

예시:

```txt
ai:cache:llm:gemma4:e4b:v1:6d9b...
ai:cache:embed:bge-m3:v1:aa12...
ai:cache:image:sdxl:v1:f91c...
ai:cache:ocr:gemma4:e4b:v1:7b31...
```

정규화 기준:

- 공백, 줄바꿈, 대소문자 규칙 통일
- JSON key 정렬
- 사용자별 권한/채널 ACL 포함
- 모델명, 모델 버전, temperature, top_p 등 추론 파라미터 포함
- RAG의 경우 `allowed_channel_ids`, 검색 옵션, active table 포함

권한이 다른 사용자가 같은 질문을 해도 접근 가능한 문서가 다를 수 있으므로, RAG 캐시에는 ACL fingerprint를 반드시 포함한다.

## 3.4 TTL 정책

| 캐시 종류 | 권장 TTL |
| --- | --- |
| 임베딩 캐시 | 7일 - 30일 |
| RAG 검색 결과 | 1분 - 10분 |
| LLM 최종 답변 | 10분 - 24시간 |
| 이미지 생성 결과 | 1일 - 30일 |
| OCR/STT 결과 | 7일 - 90일 |
| 실패 결과 | 10초 - 60초 |

실패 결과도 짧게 캐싱한다. 같은 실패 요청이 반복되어 GPU 워커를 계속 때리는 상황을 막기 위함이다.

## 3.5 Redis 자료구조

LLM/RAG 결과:

```txt
SETEX ai:cache:llm:{hash} 3600 "{json_result}"
```

임베딩 캐시:

```txt
HSET ai:embed:{hash} model "BAAI/bge-m3" dim 1024 vector "{binary_or_json}" created_at "{iso}"
EXPIRE ai:embed:{hash} 2592000
```

이미지 생성 결과:

```txt
HSET ai:image:{hash} status done image_url "{url}" prompt_hash "{hash}" created_at "{iso}"
EXPIRE ai:image:{hash} 2592000
```

## 3.6 Redis Vector Search 기반 유사 캐시

정확히 같은 prompt가 아니어도 의미가 매우 유사한 요청은 기존 결과를 재사용할 수 있다.

권장 흐름:

1. 요청 prompt를 임베딩한다.
2. Redis Vector Index에서 cosine similarity로 유사 요청을 찾는다.
3. 유사도 threshold 이상이면 기존 결과를 반환한다.
4. threshold 미만이면 GPU 추론을 실행한다.
5. 추론 결과와 prompt embedding을 Redis Vector Index에 저장한다.

주의:

- 법무/계약/금액/권한 기반 RAG 응답은 유사 캐시 재사용 기준을 보수적으로 둔다.
- 이미지 생성은 seed, style, size, negative prompt까지 포함해야 한다.
- temperature가 높은 창작형 응답은 exact cache만 쓰고 유사 캐시는 끄는 것이 안전하다.

권장 threshold:

| 작업 | 유사 캐시 threshold |
| --- | --- |
| FAQ/고정 답변 | 0.92 이상 |
| RAG 검색 결과 | 0.95 이상 |
| 요약 | 0.94 이상 |
| 이미지 생성 | 0.97 이상 |
| 계약/금액/정책 질의 | 기본 비활성화 |

## 3.7 EasyStation 적용 지점

우선 적용 후보:

- `server/rag_server.py`의 embedding endpoint 앞단
- `server/routes/rag.js`의 RAG search 결과
- 이미지 caption/OCR 결과 저장부
- STT transcript 생성부
- LLM 최종 응답 생성부

RAG 캐시 key에는 아래 요소를 포함한다.

```txt
query
active_table
schema_version
allowed_channel_ids fingerprint
retrieval options
model
prompt version
```

---

# 4. Redis Queue 기반 Dynamic Batching

## 4.1 목적

GPU는 단건 요청을 반복 처리하는 것보다 여러 요청을 batch로 묶어 처리할 때 효율이 높다. Redis Streams를 이용해 요청을 잠깐 모았다가 GPU 워커가 batch 단위로 가져가도록 한다.

## 4.2 Redis Streams 구조

작업 종류별 stream을 분리한다.

```txt
ai:queue:embed
ai:queue:llm
ai:queue:image
ai:queue:vision
ai:queue:stt
ai:queue:ocr
```

Consumer Group:

```txt
ai-workers-embed
ai-workers-llm
ai-workers-image
```

요청 예시:

```txt
XADD ai:queue:embed * request_id "{uuid}" payload_key "ai:payload:{uuid}" route_key "embed" priority "normal" created_at "{iso}"
```

## 4.3 Backend 처리 방식

백엔드는 GPU를 직접 호출하지 않고 Redis Stream에 요청을 넣는다.

1. request id 생성
2. payload를 Redis Hash/String에 TTL과 함께 저장
3. stream에 request id와 payload key만 추가
4. `ai:result:{request_id}`를 polling하거나 SSE/WebSocket으로 완료 이벤트 전달

```txt
SETEX ai:payload:{request_id} 300 "{json_payload}"
XADD ai:queue:llm * request_id "{request_id}" payload_key "ai:payload:{request_id}"
```

## 4.4 GPU Worker Dynamic Batching

GPU 워커는 아래 조건 중 하나가 만족되면 batch를 실행한다.

- 최대 batch size 도달
- 최대 대기 시간 도달
- GPU 메모리 여유 부족
- priority 요청 도착

권장 초기값:

| 작업 | max batch size | max wait |
| --- | ---: | ---: |
| embedding | 32 - 128 | 10 - 30ms |
| LLM | 4 - 16 | 20 - 50ms |
| image generation | 2 - 8 | 50 - 200ms |
| OCR/Vision | 4 - 16 | 30 - 100ms |
| STT | 2 - 8 | 100 - 300ms |

## 4.5 ACK와 재처리

Streams Consumer Group을 사용하면 워커 장애 시 pending entry를 재처리할 수 있다.

필수 운영 정책:

- 처리 성공 시 `XACK`
- 처리 실패 시 retry count 증가
- retry 초과 시 dead letter queue로 이동
- 오래 pending 상태인 작업은 다른 worker가 claim

Dead letter stream:

```txt
ai:queue:dead
```

## 4.6 결과 저장

워커 처리 결과는 Redis에 저장한다.

```txt
HSET ai:result:{request_id} status done result "{json}" completed_at "{iso}"
EXPIRE ai:result:{request_id} 3600
```

실패:

```txt
HSET ai:result:{request_id} status failed error "{message}" failed_at "{iso}"
EXPIRE ai:result:{request_id} 600
```

## 4.7 Backpressure

큐가 너무 길어지면 백엔드는 요청을 제한해야 한다.

확인 지표:

```txt
XLEN ai:queue:llm
XPENDING ai:queue:llm ai-workers-llm
```

정책:

- 큐 길이가 임계값 이상이면 429 또는 대기열 안내 반환
- 무료/일반 사용자는 낮은 priority stream으로 이동
- 관리자/긴급 작업은 별도 priority stream 사용
- GPU 워커 수를 자동 확장할 수 있으면 scale-out trigger로 사용

---

# 5. Redis Lua 스크립트를 이용한 Load-Aware 라우팅

## 5.1 목적

여러 GPU 워커가 있을 때 요청을 균등하게 나누는 것만으로는 부족하다. 각 워커의 현재 batch, token 수, VRAM 사용률, 작업 종류를 고려해 가장 적절한 워커로 보내야 한다.

Redis Lua 스크립트는 "가장 낮은 부하 워커 조회"와 "해당 워커 부하 증가"를 원자적으로 처리한다.

## 5.2 Redis Key 구조

GPU 워커 목록:

```txt
ai:workers:{task}
```

Sorted Set:

```txt
ZADD ai:workers:llm 12 gpu-worker-1
ZADD ai:workers:llm 4 gpu-worker-2
```

Worker 상태:

```txt
HSET ai:worker:gpu-worker-1 status ready gpu_id 0 model gemma4:e4b inflight 3 vram_used 0.72 updated_at "{iso}"
EXPIRE ai:worker:gpu-worker-1 30
```

## 5.3 Load Score 계산

초기 점수:

```txt
load_score =
  inflight_requests * 10
  + queued_tokens / 100
  + vram_used_ratio * 50
  + batch_waiting_count * 2
```

작업별로 score weight를 다르게 둔다.

| 작업 | 주요 부하 기준 |
| --- | --- |
| LLM | 현재 생성 중 토큰 수, context length |
| embedding | batch queue 길이 |
| image | VRAM 사용률, inference step 수 |
| video | 예상 프레임 수, VRAM 사용률 |
| STT | audio duration |
| OCR/Vision | image resolution, page count |

## 5.4 Lua 할당 스크립트

원자적 worker 선택:

```lua
-- KEYS[1] = ai:workers:{task}
-- ARGV[1] = load_increment
-- ARGV[2] = now_ms

local workers = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if #workers == 0 then
  return nil
end

local worker_id = workers[1]
local current_score = tonumber(workers[2])
local increment = tonumber(ARGV[1])

redis.call('ZINCRBY', KEYS[1], increment, worker_id)
redis.call('HINCRBY', 'ai:worker:' .. worker_id, 'inflight', 1)
redis.call('HSET', 'ai:worker:' .. worker_id, 'last_assigned_at', ARGV[2])

return worker_id
```

처리 완료 시 score 감소:

```lua
-- KEYS[1] = ai:workers:{task}
-- ARGV[1] = worker_id
-- ARGV[2] = load_decrement
-- ARGV[3] = now_ms

redis.call('ZINCRBY', KEYS[1], -tonumber(ARGV[2]), ARGV[1])
redis.call('HINCRBY', 'ai:worker:' .. ARGV[1], 'inflight', -1)
redis.call('HSET', 'ai:worker:' .. ARGV[1], 'last_completed_at', ARGV[3])
return 1
```

## 5.5 Heartbeat와 장애 처리

각 GPU 워커는 5초 이내 주기로 heartbeat를 갱신한다.

```txt
HSET ai:worker:{worker_id} status ready updated_at "{iso}" vram_used "0.63"
EXPIRE ai:worker:{worker_id} 15
```

백엔드 또는 scheduler는 만료된 worker를 `ai:workers:{task}`에서 제거한다.

```txt
ZREM ai:workers:llm gpu-worker-1
```

## 5.6 EasyStation 적용 지점

초기에는 단일 GPU라도 동일 인터페이스를 사용한다.

이유:

- 추후 GPU 추가 시 백엔드 변경 최소화
- 작업별 queue 분리 쉬움
- batch worker와 API server의 책임 분리
- 부하 지표를 운영 대시보드에 바로 연결 가능

---

# 6. 대용량 미디어 데이터 전달 오프로딩

## 6.1 목적

이미지, 동영상, 오디오, PDF 같은 대용량 데이터를 API 서버와 GPU 워커 사이에서 직접 주고받지 않는다. 큐에는 payload 자체가 아니라 payload key 또는 object path만 전달한다.

## 6.2 기본 원칙

- Redis Streams에는 작은 metadata만 넣는다.
- 대용량 binary는 Redis String에 짧은 TTL로 저장하거나 ObjectFile/Object Storage에 저장한다.
- GPU 워커는 필요할 때 key/path로 데이터를 읽는다.
- Base64 JSON 전달은 피한다.

## 6.3 권장 저장 방식

작은 이미지 또는 중간 결과:

```txt
SETEX ai:blob:{request_id}:input 300 "{binary}"
```

큰 파일:

```txt
HSET ai:payload:{request_id} file_path "/Database/ObjectFile/..." mime "video/mp4" size "12345678"
EXPIRE ai:payload:{request_id} 300
```

중간 tensor 또는 feature map:

```txt
SETEX ai:tensor:{request_id}:{stage} 60 "{binary_or_msgpack}"
```

## 6.4 TTL 필수 정책

미디어 payload는 반드시 TTL을 둔다.

| 데이터 | TTL |
| --- | --- |
| 입력 payload key | 5분 |
| 중간 tensor | 1분 |
| 처리 결과 metadata | 1시간 |
| 실패 결과 | 10분 |
| 생성 이미지 URL/path | 1일 이상 |

## 6.5 Zero-Copy 지향 설계

완전한 zero-copy는 언어 런타임과 네트워크 구조상 어렵다. 대신 아래 목표를 따른다.

- API 서버에서 Base64 변환하지 않기
- JSON body에 대용량 binary 넣지 않기
- Redis Stream에는 key만 넣기
- GPU 워커가 local filesystem 또는 Redis에서 직접 읽기
- 가능하면 ObjectFile path를 그대로 전달하기

---

# 7. 추가 설정

## 7.1 Redis 배포 방식

Vector Search까지 사용할 경우 Redis Stack을 권장한다.

개발 환경:

```bash
docker run -d \
  --name easystation-redis \
  -p 6379:6379 \
  -p 8001:8001 \
  redis/redis-stack:latest
```

운영 환경:

```bash
docker run -d \
  --name easystation-redis \
  --restart unless-stopped \
  -p 6379:6379 \
  -v easystation-redis-data:/data \
  redis/redis-stack-server:latest \
  redis-server --appendonly yes --maxmemory 16gb --maxmemory-policy allkeys-lru
```

## 7.2 환경 변수

서버:

```bash
REDIS_URL=redis://127.0.0.1:6379
REDIS_AI_CACHE_ENABLED=true
REDIS_AI_QUEUE_ENABLED=true
REDIS_AI_VECTOR_CACHE_ENABLED=false
REDIS_AI_DEFAULT_TTL_SEC=3600
REDIS_AI_PAYLOAD_TTL_SEC=300
REDIS_AI_RESULT_TTL_SEC=3600
```

GPU 워커:

```bash
REDIS_URL=redis://127.0.0.1:6379
AI_WORKER_ID=gpu-worker-1
AI_WORKER_TASKS=embed,llm,vision
AI_WORKER_GPU_ID=0
AI_BATCH_MAX_SIZE=16
AI_BATCH_MAX_WAIT_MS=50
AI_WORKER_HEARTBEAT_SEC=5
```

## 7.3 Node.js 의존성

EasyStation 백엔드에서 Redis를 사용할 경우:

```bash
npm install redis
```

권장 래퍼 모듈:

```txt
server/redisClient.js
server/aiCache.js
server/aiQueue.js
server/aiLoadRouter.js
```

## 7.4 Python Worker 의존성

GPU 워커 또는 RAG 서버에서 Redis를 사용할 경우:

```bash
pip install redis
```

비동기 워커를 쓴다면:

```bash
pip install redis[hiredis]
```

## 7.5 Redis Key Naming 규칙

```txt
ai:cache:{task}:{hash}
ai:embed:{hash}
ai:queue:{task}
ai:result:{request_id}
ai:payload:{request_id}
ai:blob:{request_id}:{name}
ai:tensor:{request_id}:{stage}
ai:workers:{task}
ai:worker:{worker_id}
ai:metrics:{task}:{yyyyMMddHHmm}
ai:lock:{resource}
```

## 7.6 보안 설정

운영 환경에서는 반드시 아래를 적용한다.

- Redis bind address 제한
- requirepass 또는 ACL 설정
- 외부 인터넷 직접 노출 금지
- TLS 또는 사설망 사용
- payload TTL 필수
- 사용자 입력이 key 이름에 직접 들어가지 않도록 hash 처리
- Redis에 장기 보관이 필요한 개인정보 저장 금지

## 7.7 모니터링 지표

필수 지표:

- cache hit rate
- cache miss rate
- queue length
- pending count
- batch size 평균
- batch wait time 평균
- GPU utilization
- GPU VRAM usage
- worker heartbeat age
- retry count
- dead letter count
- Redis memory usage
- Redis evicted keys

대시보드에 표시할 핵심 값:

```txt
cache_hit_rate_by_task
queue_lag_by_task
gpu_load_score_by_worker
avg_batch_size_by_task
p95_request_latency
redis_memory_used
dead_letter_count
```

## 7.8 설치 스크립트 업그레이드

Redis 적용 시 수동 설치에만 의존하지 않도록 기존 EasyStation 설치 스크립트도 함께 업그레이드한다. 목표는 `npm run setup:ubuntu`, `npm run setup:dgx-spark` 실행만으로 Redis 사용 준비가 끝나는 것이다.

대상 스크립트:

```txt
scripts/setup-ubuntu.sh
scripts/setup-dgx-spark.sh
scripts/dev-ubuntu.sh
scripts/dev-dgx-spark.sh
scripts/run-dgx-spark.sh
server/package.json
server/requirements.txt
```

### 7.8.1 Ubuntu 설치 스크립트

`scripts/setup-ubuntu.sh`에는 Redis 설치 옵션을 추가한다.

권장 환경 변수:

```bash
INSTALL_REDIS=1
REDIS_STACK=0
REDIS_PORT=6379
REDIS_MAXMEMORY=4gb
REDIS_MAXMEMORY_POLICY=allkeys-lru
```

동작 정책:

- `INSTALL_REDIS=1`이면 Redis를 설치하고 기동한다.
- 기본 Ubuntu 환경에서는 `redis-server` 패키지를 우선 사용한다.
- Vector Search가 필요한 경우에는 `REDIS_STACK=1`로 Redis Stack Docker 구성을 사용한다.
- 설치 후 `redis-cli ping` 또는 Docker health check로 `PONG`을 확인한다.
- 이미 Redis가 실행 중이면 재설치하지 않고 설정 검증만 수행한다.
- 서버 `.env`가 없으면 생성하고, 있으면 Redis 관련 값만 누락 시 추가한다.

`.env`에 추가할 기본값:

```bash
REDIS_URL=redis://127.0.0.1:6379
REDIS_AI_CACHE_ENABLED=true
REDIS_AI_QUEUE_ENABLED=false
REDIS_AI_VECTOR_CACHE_ENABLED=false
REDIS_AI_DEFAULT_TTL_SEC=3600
REDIS_AI_PAYLOAD_TTL_SEC=300
REDIS_AI_RESULT_TTL_SEC=3600
```

초기 단계에서는 `REDIS_AI_QUEUE_ENABLED=false`를 기본값으로 둔다. 캐시 기능이 안정화된 뒤 queue를 활성화한다.

### 7.8.2 DGX Spark 설치 스크립트

`scripts/setup-dgx-spark.sh`에는 GPU 워커와 Redis Queue를 고려한 설정을 추가한다.

권장 기본값:

```bash
INSTALL_REDIS=1
REDIS_STACK=1
REDIS_MAXMEMORY=16gb
REDIS_AI_CACHE_ENABLED=true
REDIS_AI_QUEUE_ENABLED=true
AI_BATCH_MAX_SIZE=16
AI_BATCH_MAX_WAIT_MS=50
AI_WORKER_HEARTBEAT_SEC=5
```

DGX 환경에서는 Redis Stack을 기본 권장한다. Redis Vector Search, Streams, worker heartbeat, load-aware routing을 같은 Redis 인스턴스에서 검증하기 쉽기 때문이다.

추가 동작:

- Docker가 설치되어 있지 않으면 Redis Stack 설치 전에 Docker 설치 여부를 확인한다.
- `easystation-redis` 컨테이너가 이미 있으면 재생성하지 않고 `docker start`로 기동한다.
- 운영 모드에서는 volume `easystation-redis-data:/data`를 사용한다.
- `appendonly yes`, `maxmemory`, `maxmemory-policy` 설정을 명시한다.
- 설치 완료 후 Redis memory policy와 stream 명령 사용 가능 여부를 확인한다.

검증 명령 예시:

```bash
redis-cli -u "$REDIS_URL" PING
redis-cli -u "$REDIS_URL" XADD ai:queue:healthcheck '*' created_at "$(date -Iseconds)"
redis-cli -u "$REDIS_URL" XLEN ai:queue:healthcheck
```

### 7.8.3 Node/Python 의존성 자동 반영

설치 스크립트는 Redis 기능에 필요한 의존성을 자동으로 설치해야 한다.

Node.js 서버:

```bash
npm install --prefix server redis
```

Python RAG/GPU worker:

```bash
python -m pip install redis
```

비동기 worker 또는 고성능 Redis IO가 필요하면 다음을 사용한다.

```bash
python -m pip install 'redis[hiredis]'
```

의존성은 스크립트에서만 임시 설치하지 말고 `server/package.json`, `server/package-lock.json`, `server/requirements.txt`에도 반영한다.

### 7.8.4 실행 스크립트 연동

`scripts/dev-ubuntu.sh`, `scripts/dev-dgx-spark.sh`, `scripts/run-dgx-spark.sh`는 서버 실행 전 Redis 상태를 점검한다.

권장 처리:

- `REDIS_AI_CACHE_ENABLED=true` 또는 `REDIS_AI_QUEUE_ENABLED=true`인데 Redis 연결 실패 시 경고를 출력한다.
- 캐시만 사용하는 경우에는 Redis 장애를 cache miss로 보고 서버를 계속 실행한다.
- queue가 필수인 DGX worker 모드에서는 Redis 장애 시 명확한 에러로 실행을 중단한다.
- 개발 모드에서는 `INSTALL_REDIS=1 npm run setup:ubuntu` 또는 `npm run setup:dgx-spark` 안내 메시지를 출력한다.

예시 메시지:

```txt
[WARN] Redis 연결 실패: redis://127.0.0.1:6379
[INFO] 캐시 기능은 비활성 fallback으로 실행됩니다.
[INFO] Redis를 설치하려면 INSTALL_REDIS=1 npm run setup:ubuntu 를 실행하세요.
```

### 7.8.5 설치 후 자동 검증

설치 스크립트 마지막 단계에서 아래 항목을 검증한다.

- Redis 프로세스 또는 컨테이너 실행 여부
- `REDIS_URL` 접속 가능 여부
- `PING` 응답
- `SETEX`/`GET` 테스트
- Streams 사용 시 `XADD`/`XLEN` 테스트
- Redis Stack 사용 시 Vector Search module 로드 여부
- 서버 `.env` Redis 설정 존재 여부
- Node `redis` 패키지 설치 여부
- Python `redis` 패키지 import 가능 여부

검증 실패 시 설치 자체를 무조건 실패 처리하지 말고, Redis 기능 사용 가능 여부를 명확히 출력한다. 단, `REDIS_AI_QUEUE_ENABLED=true`인 DGX worker 설치에서는 Redis 연결 실패를 치명 오류로 본다.

## 7.9 사이트 관리 GPU 최적화 UI

사이트 관리 페이지에는 Redis 기반 GPU 최적화 효과를 설정하고 측정할 수 있는 UI를 추가한다.

배치 위치:

- 사이트 관리 페이지의 `RAG 학습 옵션 설정` 버튼 바로 밑에 `GPU 최적화` 버튼을 둔다.
- `GPU 최적화` 버튼은 사이트 관리자에게만 표시한다.
- 버튼을 클릭하면 `GPU 최적화` 설정/측정 페이지를 연다.

### 7.9.1 GPU 최적화 페이지 목적

이 페이지의 목적은 Redis 기능을 단순히 켜고 끄는 것이 아니라, Redis 적용 효과를 On/Off 방식으로 비교 측정하는 것이다.

핵심 원칙:

- Redis 전체 On/Off만 제공하지 않는다.
- `Cache`, `Queue`, `Vector Cache`를 각각 독립적으로 On/Off할 수 있어야 한다.
- 각 기능을 켰을 때 GPU 호출 감소, 응답 시간 개선, throughput 증가가 실제로 발생했는지 측정한다.
- 측정 결과는 관리자에게 숫자로 보여준다.

### 7.9.2 기본 토글 구성

페이지 상단에는 Redis 기능별 토글을 둔다.

```txt
GPU 최적화

[ ] Redis 사용
[ ] Cache 사용
[ ] Queue 사용
[ ] Vector Cache 사용
[ ] Dynamic Batching 사용
[ ] Load-Aware Routing 사용
```

토글 정책:

- `Redis 사용`이 꺼져 있으면 하위 기능은 모두 비활성화한다.
- `Cache 사용`은 `REDIS_AI_CACHE_ENABLED`와 연결한다.
- `Queue 사용`은 `REDIS_AI_QUEUE_ENABLED`와 연결한다.
- `Vector Cache 사용`은 `REDIS_AI_VECTOR_CACHE_ENABLED`와 연결한다.
- `Dynamic Batching 사용`은 Queue가 켜져 있을 때만 활성화한다.
- `Load-Aware Routing 사용`은 Queue 또는 worker heartbeat가 준비된 경우에만 활성화한다.

### 7.9.3 On/Off 측정 모드

Redis 효과 측정은 아래 실험 모드로 제공한다.

```txt
측정 모드

1. Redis Off
2. Redis Cache On
3. Redis Cache + Queue On
4. Redis Cache + Queue + Dynamic Batch On
5. Redis Cache + Queue + Dynamic Batch + Vector Cache On
```

관리자는 각 모드를 선택해 동일한 테스트 요청 세트로 비교 측정할 수 있어야 한다.

측정 시 반드시 구분할 상태:

- Cold Cache: Redis는 켜져 있지만 캐시가 비어 있는 상태
- Warm Cache: 동일 요청이 반복되어 캐시가 채워진 상태

Cold Cache와 Warm Cache 결과를 분리해서 보여준다. Cold Cache에서는 Redis 조회 비용 때문에 개선이 작거나 느려질 수 있고, Warm Cache에서 실제 캐시 효과가 드러난다.

### 7.9.4 측정 지표

GPU 최적화 페이지에는 아래 지표를 표시한다.

기본 지표:

```txt
p50 latency
p95 latency
p99 latency
GPU 호출 수
GPU 호출 감소율
cache hit rate
cache miss rate
error rate
timeout count
Redis memory used
```

Queue 사용 시 추가 지표:

```txt
queue wait ms
pending count
average batch size
dead letter count
GPU utilization
GPU VRAM usage
worker heartbeat age
```

기능별 지표:

```txt
RAG embedding cache hit rate
RAG search cache hit rate
LLM answer cache hit rate
STT transcript cache hit rate
OCR result cache hit rate
Vision analysis cache hit rate
```

### 7.9.5 비교 결과 UI

측정 결과는 비교 표로 보여준다.

예시:

```txt
항목                  Redis Off   Cache On   Cache+Queue On
p95 latency           8.2s        2.1s       2.5s
GPU 호출 수           100         58         58
GPU 호출 감소율       0%          42%        42%
cache hit rate        0%          42%        42%
timeout count         6           1          1
avg batch size        -           -          8.4
queue wait ms         -           -          45ms
```

관리자가 한눈에 아래 내용을 판단할 수 있어야 한다.

- Cache가 GPU 호출을 몇 % 줄였는가
- Queue가 API timeout을 줄였는가
- Dynamic Batching이 평균 batch size와 throughput을 올렸는가
- Vector Cache가 정확도 위험 없이 hit rate를 올렸는가
- Redis memory 사용량이 적절한가

### 7.9.6 측정 실행 버튼

페이지에는 다음 버튼을 둔다.

```txt
[현재 설정 저장]
[Redis 연결 테스트]
[Cold Cache 측정 시작]
[Warm Cache 측정 시작]
[측정 결과 초기화]
[CSV 다운로드]
```

동작:

- `현재 설정 저장`: Redis 기능별 On/Off 값을 저장한다.
- `Redis 연결 테스트`: `PING`, `SETEX/GET`, 필요 시 `XADD/XLEN`을 확인한다.
- `Cold Cache 측정 시작`: 관련 테스트 cache key를 비운 뒤 측정한다.
- `Warm Cache 측정 시작`: 같은 요청 세트를 반복 실행해서 캐시가 채워진 상태를 측정한다.
- `측정 결과 초기화`: 저장된 실험 결과를 삭제한다.
- `CSV 다운로드`: 비교 결과를 파일로 내려받는다.

### 7.9.7 테스트 요청 세트

측정에는 동일한 요청 세트를 사용한다.

기본 테스트 세트:

- RAG 질문 100개
- 중복 질문 포함
- 권한이 다른 사용자 포함
- 긴 문서 검색 포함
- STT/OCR/Vision 같은 무거운 작업 포함
- 실패가 예상되는 요청 일부 포함

권한이 다른 사용자 테스트는 중요하다. RAG 캐시는 사용자 ACL에 따라 결과가 달라질 수 있으므로, cache key에 ACL fingerprint가 반영되었는지 검증해야 한다.

### 7.9.8 관리자 경고 문구

GPU 최적화 페이지에는 아래 안내 문구를 표시한다.

```txt
Redis 효과 측정은 On/Off 방식이 가장 설득력 있는 검증 방법입니다.
다만 전체 Redis를 한 번에 켜고 끄기보다 Cache, Queue, Vector Cache를 따로 켜고 끄는 구조가 좋습니다.
그래야 "Redis가 효과 있다"가 아니라 "캐시가 GPU 호출을 몇 % 줄였고, Queue가 throughput을 몇 % 올렸다"까지 확인할 수 있습니다.
```

### 7.9.9 권한 및 안전 정책

- GPU 최적화 페이지는 사이트 관리자만 접근할 수 있다.
- Redis Off 또는 Queue Off 변경은 실행 중인 worker가 있으면 확인 dialog를 띄운다.
- Vector Cache 활성화 시 RAG 권한/계약/금액/정책 질의에는 보수적인 threshold 또는 비활성화를 기본값으로 둔다.
- 설정 변경은 감사 로그에 남긴다.
- 측정 실행 중에는 같은 사이트에서 중복 측정을 시작하지 못하게 lock을 둔다.
- 운영 중 측정은 실제 사용자 요청과 분리된 synthetic test set을 우선 사용한다.

---

# 8. 장애 대응

## 8.1 Redis 장애 시 fallback

Redis가 장애 상태여도 EasyStation의 핵심 기능이 완전히 멈추지 않아야 한다.

정책:

- 캐시 장애: 캐시 miss로 간주하고 기존 GPU 직접 처리
- 큐 장애: 동기 처리 또는 503 반환
- 라우팅 장애: round-robin 또는 local worker fallback
- 결과 저장 장애: 파일/DB fallback 또는 즉시 응답만 제공

## 8.2 중복 처리 방지

같은 request id가 중복 처리될 수 있으므로 idempotency key를 둔다.

```txt
SET ai:lock:{request_hash} "{request_id}" NX EX 60
```

이미 처리 중인 요청이면 기존 request id를 반환한다.

## 8.3 Dead Letter 처리

retry 초과 요청은 `ai:queue:dead`로 보낸다.

저장 필드:

```txt
request_id
task
payload_key
error
retry_count
failed_at
worker_id
```

관리자 페이지에서는 dead letter를 조회하고 재실행할 수 있어야 한다.

---

# 9. EasyStation 적용 로드맵

## 9.1 1단계: 캐싱

우선 GPU 재실행을 막는다.

적용:

- RAG query embedding cache
- RAG search result cache
- OCR/STT/image caption 결과 cache
- 실패 결과 short TTL cache

완료 기준:

- 반복 요청 cache hit 확인
- GPU 호출 횟수 감소 확인
- RAG 권한별 cache key 분리 확인

## 9.2 2단계: Redis Streams Queue

GPU 요청을 직접 실행하지 않고 queue에 넣는다.

적용:

- `ai:queue:embed`
- `ai:queue:vision`
- `ai:queue:llm`
- `ai:result:{request_id}`

완료 기준:

- request id 기반 비동기 처리
- pending/retry/dead letter 동작
- API timeout 감소

## 9.3 3단계: Dynamic Batching

GPU 워커가 queue에서 요청을 모아 batch로 처리한다.

적용:

- embedding batch
- OCR/Vision batch
- LLM batch 가능한 모델부터 적용

완료 기준:

- 평균 batch size 증가
- GPU utilization 안정화
- p95 latency가 허용 범위 안에서 throughput 증가

## 9.4 4단계: Load-Aware 라우팅

다중 GPU 또는 다중 워커 환경에서 Lua 라우팅을 적용한다.

완료 기준:

- 워커별 load score 균등화
- 특정 GPU 쏠림 제거
- 장애 워커 자동 제외

## 9.5 5단계: 미디어 오프로딩

대용량 이미지/동영상/오디오를 Redis key 또는 ObjectFile path로 전달한다.

완료 기준:

- Stream payload 크기 감소
- API 서버 메모리 사용량 감소
- GPU worker 입력 대기 시간 감소

---

# 10. 구현 체크리스트

- Redis Stack 설치
- Ubuntu/DGX 설치 스크립트 Redis 옵션 추가
- 실행 스크립트 Redis health check 추가
- `REDIS_URL` 환경 변수 추가
- 서버 `.env` Redis 기본값 자동 추가
- Node/Python Redis 의존성 설치 자동화
- Redis client singleton 추가
- cache key normalizer 구현
- task별 TTL 정책 구현
- RAG ACL fingerprint 구현
- Redis Streams queue wrapper 구현
- GPU worker consumer group 구현
- result polling API 구현
- Lua load router 구현
- worker heartbeat 구현
- dead letter queue 구현
- 관리자 모니터링 화면 추가
- 사이트 관리 페이지에 `GPU 최적화` 버튼 추가
- GPU 최적화 페이지 Cache/Queue/Vector Cache 개별 On/Off UI 추가
- Redis On/Off 효과 측정 비교표 추가
- Cold Cache/Warm Cache 측정 실행 기능 추가
- Redis 장애 fallback 구현
- 운영 maxmemory/eviction 정책 설정

---

# 11. 최종 권장 구조

최종적으로 EasyStation의 AI 요청은 아래 순서로 처리한다.

```txt
Request
  -> Normalize
  -> Exact Cache Lookup
  -> Optional Vector Similar Cache Lookup
  -> Idempotency Lock
  -> Payload Offload
  -> Lua Load Routing
  -> Redis Stream Enqueue
  -> GPU Worker Dynamic Batch
  -> Inference
  -> Result Cache Save
  -> Response
```

이 구조의 핵심 효과:

- 반복 요청은 GPU를 전혀 사용하지 않는다.
- GPU 요청은 batch로 묶여 throughput이 올라간다.
- GPU 워커 간 부하 쏠림이 줄어든다.
- 대용량 payload 전달 비용이 줄어든다.
- Redis 장애 시에도 단계별 fallback이 가능하다.
