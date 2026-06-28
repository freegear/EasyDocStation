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
- `REDIS_URL` 환경 변수 추가
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

