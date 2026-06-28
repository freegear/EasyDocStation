# AgenticAI Mail Thread Monitoring 설계 및 구현 명세

이 문서는 EasyStation의 메일 계정/메일 타래를 AgenticAI가 지속적으로 주시하고, 새 메일 송수신이 발생할 때마다 **신규 메일만 증분 RAG 학습**한 뒤 기존 학습 내용과 기존 보고서를 병합해 사용자에게 요약 보고를 제공하는 기능의 구현 기준이다.

목표는 단순 메일 알림이 아니라, 메일 타래를 업무 단위로 추적하여 아래 산출물을 지속적으로 갱신하는 것이다.

- 중요 이슈
- 진행 사항 요약
- Action Item 정리
- 할 일 목록 추가
- 메일 타래 요약 보고
- 텔레그램 전송

본 기능은 기존 메일 서비스 아키텍처를 따른다.

- 메일 DB 접근은 `server/mail/repository.js`를 통해 수행한다.
- 메일 원문/첨부 저장 구조는 `docs/MailServiceArchitecture.md`의 `object_key` 규칙을 유지한다.
- RAG 학습은 기존 RAG 학습 파이프라인을 재사용한다.
- AgenticAI 분석은 메일 타래 단위의 파생 작업으로 구현한다.

---

# 1. 기능 개요

## 1.1 사용자 시나리오

사용자는 특정 메일 타래 또는 특정 메일 계정을 AgenticAI 모니터링 대상으로 등록한다.

등록 방식은 두 가지다.

1. **제목 기준**
   - 특정 제목 또는 제목 패턴과 일치하는 메일 타래를 모니터링한다.
   - 예: `옵티어스 계약`, `[긴급] 납품 일정`, `Re: Project Alpha`

2. **메일 계정 기준**
   - 특정 메일 계정으로 송수신되는 모든 메일 또는 조건에 맞는 메일을 모니터링한다.
   - 예: `sales@company.com` 계정의 모든 메일
   - 예: `support@company.com` 계정 중 특정 도메인 발신자만

메일이 새로 도착하거나 사용자가 해당 타래에 답장을 보내면, 시스템은 다음을 수행한다.

1. 새 메일을 메일 DB에 동기화한다.
2. 해당 메일이 모니터링 대상인지 판정한다.
3. 대상이면 **신규 메일 본문/첨부만** RAG 학습한다.
4. 신규 학습 완료 후 기존 RAG 컨텍스트와 기존 보고서를 병합해 타래 보고서를 갱신한다.
5. 메일 타래 요약 보고를 생성/갱신한다.
6. 중요 변경 사항을 사용자에게 텔레그램으로 보낸다.
7. 새 Action Item을 할 일 목록에 추가한다.

## 1.2 핵심 원칙

- 메일 단건이 아니라 **메일 타래(thread)** 단위로 분석한다.
- 새 메일이 들어올 때마다 타래 전체를 재학습하지 않는다.
- RAG 학습은 신규/변경 메시지와 신규/변경 첨부파일에 대해서만 수행한다.
- 보고서는 매번 새로 만드는 것이 아니라 **지속 업데이트**한다.
- AgenticAI 분석은 RAG 학습이 끝난 뒤 실행한다.
- 기존 메일 동기화와 발송 흐름을 막지 않도록 비동기 작업으로 처리한다.
- 텔레그램 전송 실패가 RAG 학습이나 분석 완료를 막으면 안 된다.
- 같은 메일을 중복 학습/중복 분석하지 않도록 idempotency key를 둔다.

---

# 2. 대상 메일 타래 정의

## 2.1 모니터링 대상 타입

모니터링 대상은 `watch target`으로 정의한다.

| 타입 | 설명 |
| --- | --- |
| `subject` | 제목 또는 제목 패턴으로 타래를 지정 |
| `account` | 메일 계정 단위로 지정 |
| `account_subject` | 특정 계정 안에서 제목 조건을 지정 |
| `condition_group` | 메일 계정/키워드/제목 조건 그룹을 AND/OR 조합으로 지정 |
| `sender` | 특정 발신자 또는 도메인을 지정 |
| `manual_thread` | 사용자가 특정 thread id를 직접 지정 |

초기 구현은 아래 세 가지를 필수 지원한다.

- `subject`
- `account`
- `condition_group`

나머지는 확장 포인트로 둔다.

## 2.1.1 조건 그룹 기반 모니터링 판정

사용자는 하나의 watch target 안에 아래 조건 그룹을 등록할 수 있다.

- 메일 계정 조건: `[A, B, C, D, ...]`
- 키워드 조건: `[E, F, G, H, ...]`
- 제목 조건: `[I, J, ...]`

각 그룹 안의 값은 `OR` 조건이고, 그룹과 그룹 사이는 `AND` 조건이다.

```txt
monitoring_target =
  (account in [A, B, C, D, ...] OR 계정 조건 없음)
  AND
  (body/summary/attachment_text contains any of [E, F, G, H, ...] OR 키워드 조건 없음)
  AND
  (subject matches any of [I, J, ...] OR 제목 조건 없음)
```

즉, 등록된 조건 그룹만 판정에 참여하고 비어 있는 조건 그룹은 무시한다.

예:

```txt
메일 계정: [sales@company.com, support@company.com]
키워드: [계약, 납품, 장애]
제목: [옵티어스, Project Alpha]
```

위 조건은 아래처럼 해석한다.

```txt
(sales@company.com OR support@company.com)
AND
(계약 OR 납품 OR 장애)
AND
(옵티어스 OR Project Alpha)
```

키워드 조건이 비어 있으면 아래처럼 해석한다.

```txt
(sales@company.com OR support@company.com)
AND
(옵티어스 OR Project Alpha)
```

모든 조건 그룹이 비어 있는 watch target은 생성할 수 없다. 최소 하나의 조건 그룹에는 값이 있어야 한다.

판정 대상 필드:

| 조건 그룹 | 판정 대상 |
| --- | --- |
| 메일 계정 | `account_id`, `email_address` |
| 키워드 | 메일 본문 텍스트, HTML 추출 텍스트, 첨부파일 추출 텍스트, 기존 요약 후보 텍스트 |
| 제목 | 정규화된 메일 제목 |

키워드와 제목은 기본적으로 대소문자 구분 없이 `contains` 방식으로 판정한다. 고급 옵션에서만 `exact`, `regex`를 허용한다.

## 2.2 제목 기준 지정

제목 기준은 다음 매칭 방식을 지원한다.

| 방식 | 설명 | 예시 |
| --- | --- | --- |
| `exact` | 정규화된 제목이 정확히 일치 | `옵티어스 계약 검토` |
| `contains` | 제목에 문자열 포함 | `옵티어스` |
| `regex` | 정규식 패턴 | `^\\[긴급\\].*납품` |

메일 제목 정규화 규칙:

- `Re:`, `RE:`, `Fw:`, `Fwd:` 제거
- 앞뒤 공백 제거
- 연속 공백 하나로 축소
- 대소문자 구분 없는 비교

예:

```txt
Re: [긴급] 옵티어스 납품 일정
Fwd: [긴급] 옵티어스 납품 일정
```

정규화 후 같은 타래 후보로 취급한다.

## 2.3 메일 계정 기준 지정

메일 계정 기준은 특정 `mail_accounts.id` 또는 `email_address`를 대상으로 한다.

예:

```txt
account_id = acc-001
email_address = sales@siliconcube.co.kr
```

계정 기준 모니터링은 기본적으로 해당 계정의 모든 inbound/outbound 메시지를 후보로 본다.

운영 부담을 줄이기 위해 선택 필터를 둘 수 있다.

- 특정 발신자/수신자
- 특정 도메인
- 특정 키워드
- 첨부파일 포함 여부
- 중요도 라벨
- 날짜 범위

## 2.4 타래 식별 기준

가능하면 Gmail/메일 제공자의 thread id를 우선 사용한다.

우선순위:

1. provider thread id
2. `In-Reply-To`, `References` 헤더 기반 thread
3. 정규화된 제목 + 참여자 집합 + 시간 근접성

메일 DB에는 AgenticAI 분석용 내부 thread id를 둔다.

```txt
agentic_thread_id = mail_thread:{tenant_id}:{account_id}:{provider_thread_id}
```

provider thread id가 없는 경우:

```txt
agentic_thread_id = mail_thread:{tenant_id}:{account_id}:{sha256(normalized_subject + participants)}
```

---

# 3. 전체 처리 흐름

## 3.0 증분 처리 원칙

메일 타래에 새 메일이 추가될 때마다 이전 메일 전체를 다시 RAG 학습하지 않는다.

처리 원칙:

1. 새로 들어온 message id가 이미 학습되었는지 확인한다.
2. 학습되지 않은 신규 메시지만 RAG 학습한다.
3. 신규 첨부파일만 파일 학습 파이프라인에 넣는다.
4. 이미 학습된 이전 메일은 LanceDB/RAG 저장소의 기존 청크를 재사용한다.
5. 분석 단계에서는 기존 RAG 청크 + 신규 RAG 청크 + 기존 thread report를 함께 사용한다.
6. 보고서는 기존 내용을 기반으로 변경분만 병합 갱신한다.

즉, 비용이 큰 작업은 다음처럼 제한한다.

```txt
재학습 대상 = 신규 message + 신규 attachment
분석 대상 = 기존 report + 신규 message + RAG 검색으로 가져온 관련 기존 context
```

전체 타래 재학습은 아래 경우에만 수행한다.

- 사용자가 수동으로 전체 재학습을 요청
- RAG 스키마 또는 parser version 변경
- 기존 학습 데이터가 손상됨
- watch target 조건이 크게 바뀌어 thread scope가 재계산되어야 함

## 3.1 신규 수신 메일 흐름

```txt
Gmail Sync
  -> mail_messages 저장
  -> mail_attachments 저장
  -> object_key 저장
  -> AgenticAI Watch Target 매칭
  -> 대상이면 thread event 생성
  -> 신규 message/attachment 여부 확인
  -> 신규분만 RAG 학습 queue 등록
  -> 신규분 RAG 학습 완료
  -> AgenticAI 분석 queue 등록
  -> 기존 report + 기존 RAG context + 신규 message 병합 분석
  -> thread summary report 증분 갱신
  -> action item/todo 갱신
  -> Telegram 전송
```

## 3.2 발신 메일 흐름

사용자가 EasyStation에서 메일을 작성/회신하면 발신 성공 후 같은 흐름을 탄다.

```txt
Send Mail
  -> provider message id 확보
  -> sent mail 동기화 또는 local mail_messages 저장
  -> watch target 매칭
  -> 신규 발신 message만 RAG 학습
  -> AgenticAI 병합 분석
  -> 보고서 증분 갱신
```

## 3.3 처리 단위

| 처리 | 단위 |
| --- | --- |
| 메일 동기화 | message |
| RAG 학습 | 신규 message + 신규 attachment |
| 분석 | thread, 단 입력은 기존 report + 신규 message + 관련 RAG context |
| 보고서 | thread 증분 갱신 |
| 텔레그램 알림 | thread update event |
| 할 일 등록 | action item |

## 3.4 Idempotency

같은 메일이 여러 번 동기화되어도 중복 학습/중복 분석하면 안 된다.

idempotency key:

```txt
mail_agentic:{tenant_id}:{account_id}:{provider_message_id}:{pipeline_version}
```

처리 상태:

```txt
pending
rag_training
rag_completed
analysis_pending
analysis_completed
notification_sent
failed
```

---

# 4. 데이터 모델

기존 메일 테이블은 유지하고, AgenticAI 메일 모니터링용 테이블을 추가한다.

## 4.1 `mail_agentic_watch_targets`

메일 타래 모니터링 대상을 정의한다.

```sql
CREATE TABLE mail_agentic_watch_targets (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  owner_user_id        INTEGER NOT NULL,
  target_type          TEXT NOT NULL,
  account_id           TEXT,
  email_address        TEXT,
  account_conditions   JSONB NOT NULL DEFAULT '[]',
  keyword_conditions   JSONB NOT NULL DEFAULT '[]',
  subject_conditions   JSONB NOT NULL DEFAULT '[]',
  condition_match_type TEXT NOT NULL DEFAULT 'contains',
  subject_match_type   TEXT,
  subject_pattern      TEXT,
  sender_pattern       TEXT,
  enabled              BOOLEAN NOT NULL DEFAULT true,
  notify_telegram      BOOLEAN NOT NULL DEFAULT true,
  auto_create_todos    BOOLEAN NOT NULL DEFAULT true,
  rag_enabled          BOOLEAN NOT NULL DEFAULT true,
  analysis_enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

필드 설명:

| 필드 | 설명 |
| --- | --- |
| `owner_user_id` | 보고서와 텔레그램 알림을 받을 사용자 |
| `target_type` | `subject`, `account`, `account_subject` 등 |
| `account_id` | 특정 계정 대상일 때 사용 |
| `email_address` | 계정 주소 기준 지정 시 사용 |
| `account_conditions` | OR로 묶을 계정 조건 배열. 예: `["sales@company.com", "support@company.com"]` |
| `keyword_conditions` | OR로 묶을 키워드 조건 배열. 예: `["계약", "납품", "장애"]` |
| `subject_conditions` | OR로 묶을 제목 조건 배열. 예: `["옵티어스", "Project Alpha"]` |
| `condition_match_type` | 조건 그룹의 문자열 매칭 방식. 기본 `contains`, 고급 `exact`, `regex` |
| `subject_match_type` | `exact`, `contains`, `regex` |
| `subject_pattern` | 제목 매칭 문자열 |
| `sender_pattern` | 선택 확장 필터 |
| `auto_create_todos` | Action Item을 할 일 목록에 자동 추가할지 여부 |

`account_id`, `email_address`, `subject_pattern`은 기존 단일 조건 호환용 필드로 유지한다. 신규 UI는 `account_conditions`, `keyword_conditions`, `subject_conditions`를 우선 사용한다.

## 4.2 `mail_agentic_threads`

모니터링 대상이 된 메일 타래를 추적한다.

```sql
CREATE TABLE mail_agentic_threads (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  watch_target_id        TEXT NOT NULL REFERENCES mail_agentic_watch_targets(id) ON DELETE CASCADE,
  account_id             TEXT,
  provider_thread_id     TEXT,
  normalized_subject     TEXT NOT NULL,
  participant_fingerprint TEXT,
  first_message_at       TIMESTAMPTZ,
  last_message_at        TIMESTAMPTZ,
  last_message_id        TEXT,
  status                 TEXT NOT NULL DEFAULT 'active',
  last_rag_trained_at    TIMESTAMPTZ,
  last_analyzed_at       TIMESTAMPTZ,
  last_notified_at       TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## 4.3 `mail_agentic_thread_messages`

타래와 메일 메시지의 연결 테이블이다.

```sql
CREATE TABLE mail_agentic_thread_messages (
  thread_id      TEXT NOT NULL REFERENCES mail_agentic_threads(id) ON DELETE CASCADE,
  message_id     TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  account_id     TEXT,
  direction      TEXT,
  rag_status     TEXT NOT NULL DEFAULT 'pending',
  content_hash   TEXT,
  attachment_hash TEXT,
  rag_trained_at TIMESTAMPTZ,
  analyzed        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, message_id)
);
```

증분 학습 판단 기준:

- `content_hash`가 이전 값과 같으면 본문 재학습 생략
- `attachment_hash`가 이전 값과 같으면 첨부 재학습 생략
- `rag_status='completed'`이고 hash가 동일하면 해당 message는 기존 RAG 청크를 재사용

## 4.4 `mail_agentic_thread_reports`

메일 타래 요약 보고서의 최신 상태를 저장한다.

```sql
CREATE TABLE mail_agentic_thread_reports (
  thread_id             TEXT PRIMARY KEY REFERENCES mail_agentic_threads(id) ON DELETE CASCADE,
  tenant_id             TEXT NOT NULL,
  summary               TEXT NOT NULL DEFAULT '',
  important_issues      JSONB NOT NULL DEFAULT '[]',
  progress_summary      JSONB NOT NULL DEFAULT '[]',
  action_items          JSONB NOT NULL DEFAULT '[]',
  todo_items            JSONB NOT NULL DEFAULT '[]',
  decisions             JSONB NOT NULL DEFAULT '[]',
  risks                 JSONB NOT NULL DEFAULT '[]',
  open_questions        JSONB NOT NULL DEFAULT '[]',
  last_message_id       TEXT,
  learned_message_count INTEGER NOT NULL DEFAULT 0,
  source_message_ids    JSONB NOT NULL DEFAULT '[]',
  analysis_version      INTEGER NOT NULL DEFAULT 1,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`source_message_ids`는 현재 보고서에 반영된 메시지 목록이다. 새 메시지 분석 후 이 목록에 message id를 추가해, 어떤 메시지까지 보고서에 병합되었는지 추적한다.

## 4.5 `mail_agentic_todos`

Action Item에서 생성된 할 일 목록이다.

```sql
CREATE TABLE mail_agentic_todos (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  thread_id       TEXT NOT NULL REFERENCES mail_agentic_threads(id) ON DELETE CASCADE,
  action_item_id  TEXT,
  owner_user_id   INTEGER,
  title           TEXT NOT NULL,
  description     TEXT,
  due_at          TIMESTAMPTZ,
  priority        TEXT NOT NULL DEFAULT 'normal',
  status          TEXT NOT NULL DEFAULT 'open',
  source_message_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## 4.6 `mail_agentic_events`

비동기 처리 및 이력 추적용 이벤트 테이블이다.

```sql
CREATE TABLE mail_agentic_events (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  thread_id       TEXT,
  message_id      TEXT,
  event_type      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  payload         JSONB NOT NULL DEFAULT '{}',
  error_message   TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

# 5. RAG 학습 설계

## 5.0 증분 RAG 학습 원칙

메일 타래가 모니터링 대상으로 지정되더라도, 새 메일이 들어올 때마다 과거 메일 전체를 다시 학습하지 않는다.

RAG 학습 단위는 `thread`가 아니라 `message`다.

```txt
message 단위 학습 -> thread 단위 검색/분석 -> report 단위 병합 갱신
```

증분 학습 절차:

1. 새 메일의 `message_id`와 `content_hash`를 계산한다.
2. `mail_agentic_thread_messages`에서 기존 학습 상태를 조회한다.
3. `rag_status='completed'`이고 hash가 같으면 학습을 생략한다.
4. hash가 다르거나 처음 보는 message이면 해당 message만 학습한다.
5. 첨부파일도 attachment id/hash 기준으로 신규분만 학습한다.
6. 학습 완료 후 해당 message의 `rag_status`, `rag_trained_at`, hash를 갱신한다.
7. 분석 단계는 thread 전체를 대상으로 하되 RAG 검색으로 기존 청크를 가져와 병합한다.

전체 thread 재학습은 예외적인 관리 작업이다.

전체 재학습이 필요한 경우:

- parser version 변경
- RAG schema version 변경
- 기존 RAG table migration
- 메일 원문 재파싱
- 사용자가 명시적으로 `전체 재학습` 실행

## 5.1 학습 대상

메일 타래로 지정된 메시지 중 **신규 또는 변경된 메시지**만 다음 데이터를 RAG 학습한다.

- 제목
- 발신자/수신자/참조
- 발신/수신 시각
- 본문 텍스트
- 본문 HTML에서 추출한 텍스트
- 첨부 파일
- 메일 방향: inbound/outbound
- provider message id
- provider thread id

## 5.2 RAG 문서 메타데이터

메일 RAG 청크는 아래 메타데이터를 포함해야 한다.

```json
{
  "source_type": "mail",
  "document_kind": "mail_message",
  "tenant_id": "...",
  "account_id": "...",
  "thread_id": "...",
  "message_id": "...",
  "provider_message_id": "...",
  "provider_thread_id": "...",
  "mail_subject": "...",
  "from_email": "...",
  "to_emails": "...",
  "direction": "inbound",
  "sent_at": "...",
  "received_at": "...",
  "attachment_id": "...",
  "file_name": "..."
}
```

## 5.3 학습 트리거

학습 트리거는 다음 이벤트에서 발생한다.

- 신규 수신 메일 저장 완료
- 발신 메일 저장 완료
- 첨부 파일 저장 완료
- 사용자가 기존 메일 타래를 모니터링 대상으로 등록
- watch target 조건 변경
- 관리자 수동 재학습

각 트리거는 먼저 증분 학습 여부를 판정한다.

```txt
if message_id already trained and content_hash unchanged:
  skip RAG training
else:
  train only this message
```

## 5.4 학습 완료 조건

메일 타래 분석은 아래 조건 중 하나를 만족할 때 실행한다.

1. 신규 메시지의 본문 RAG 학습 완료
2. 신규 첨부파일이 있으면 첨부파일 학습까지 완료
3. 신규 첨부파일 파싱 실패 시 실패 상태를 기록하고 본문 기준 분석 진행
4. 신규 학습 대상이 없으면 기존 RAG context와 기존 보고서만으로 필요 시 재분석

첨부파일 실패가 전체 분석을 막으면 안 된다.

## 5.5 기존 RAG와의 연결

기존 RAG 학습 함수에 메일용 payload를 추가한다.

권장 payload:

```json
{
  "mail_messages": [
    {
      "id": "mail-message-id",
      "thread_id": "mail-thread-id",
      "account_id": "mail-account-id",
      "channel_id": "",
      "content": "메일 본문 텍스트",
      "subject": "메일 제목",
      "from_email": "sender@example.com",
      "to_emails": ["to@example.com"],
      "attachments": []
    }
  ]
}
```

메일 RAG는 채널 권한 기반 게시글 RAG와 다르므로 ACL 처리를 별도로 둔다.

메일 RAG 접근 권한:

- watch target owner
- 해당 tenant 관리자
- 해당 mail account 접근 권한이 있는 사용자

---

# 6. AgenticAI 분석 설계

## 6.1 분석 입력

분석 입력은 RAG 검색 결과와 메일 메타데이터를 함께 사용한다.

분석은 `thread` 단위로 수행하지만, 매번 전체 메일 원문을 모두 프롬프트에 넣지 않는다. 기본 입력은 아래 3가지를 병합한다.

1. 기존 `mail_agentic_thread_reports`의 최신 보고서
2. 새로 들어온 message 또는 아직 보고서에 반영되지 않은 message
3. RAG 검색으로 가져온 관련 기존 context

따라서 신규 메일이 들어오면 AI는 "전체 재작성"이 아니라 "기존 보고서에 변경분을 반영하는 갱신"을 수행한다.

입력 구성:

- thread id
- watch target 정보
- 최신 메시지 또는 미반영 메시지 목록
- 필요 시 최근 N개 메시지 메타데이터
- RAG 검색 context
- 기존 thread report
- 기존 open action items
- 기존 todo 상태
- `source_message_ids`

## 6.2 분석 출력 형식

AgenticAI는 반드시 구조화 JSON을 반환해야 한다.

```json
{
  "summary": "메일 타래 전체 요약",
  "important_issues": [
    {
      "id": "issue-...",
      "title": "중요 이슈 제목",
      "description": "이슈 설명",
      "severity": "high",
      "status": "open",
      "evidence_message_ids": ["..."]
    }
  ],
  "progress_summary": [
    {
      "date": "2026-06-28",
      "description": "진행 사항",
      "evidence_message_ids": ["..."]
    }
  ],
  "action_items": [
    {
      "id": "action-...",
      "title": "해야 할 일",
      "owner_hint": "담당자 후보",
      "due_at": "2026-07-01T09:00:00+09:00",
      "priority": "high",
      "status": "open",
      "source_message_id": "..."
    }
  ],
  "todo_items": [
    {
      "action_item_id": "action-...",
      "title": "할 일 제목",
      "description": "할 일 상세",
      "due_at": "2026-07-01T09:00:00+09:00",
      "priority": "high"
    }
  ],
  "decisions": [],
  "risks": [],
  "open_questions": []
}
```

## 6.3 분석 프롬프트 기준

분석 프롬프트는 다음을 명확히 지시한다.

- 메일 본문에 없는 내용을 추측하지 않는다.
- 기존 보고서를 유지하면서 새 메시지에서 확인된 변경분만 반영한다.
- 기존 요약과 충돌하는 새 사실이 있으면 새 메시지의 근거를 표시하고 상태를 갱신한다.
- 중요 이슈는 업무 리스크/일정/비용/계약/납품/장애/고객 요구사항 중심으로 식별한다.
- Action Item은 실행 주체, 기한, 산출물이 명확할 때만 만든다.
- 기존 Action Item과 중복되면 새로 만들지 않고 상태를 갱신한다.
- 완료된 항목은 `status=done`으로 갱신한다.
- 기한이 불명확하면 `due_at=null`로 둔다.
- 텔레그램 메시지는 짧고 실행 중심으로 요약한다.

## 6.4 분석 버전

분석 로직이 바뀌면 `analysis_version`을 올린다.

```txt
analysis_version = 1
```

버전이 바뀌면 기존 보고서를 다시 분석할 수 있어야 한다. 단, 버전 변경으로 인한 재분석도 기본은 기존 RAG 청크를 재사용하며, RAG 스키마가 바뀐 경우에만 전체 재학습을 수행한다.

---

# 7. 메일 타래 요약 보고서

## 7.1 보고서 구성

메일 타래 요약 보고서는 아래 섹션을 가진다.

```md
# 메일 타래 요약 보고

## 기본 정보
- 제목:
- 계정:
- 참여자:
- 마지막 업데이트:

## 중요 이슈
- ...

## 진행 사항 요약
- ...

## Action Item
- [ ] ...

## 할 일 목록
- [ ] ...

## 결정 사항
- ...

## 리스크
- ...

## 미해결 질문
- ...
```

## 7.2 지속 업데이트 방식

새 메일이 들어올 때마다 보고서는 전체 재생성하지 않고, 기존 보고서를 입력으로 넣어 갱신한다.

갱신 기준:

- `source_message_ids`에 없는 신규 메시지만 보고서 반영 대상으로 삼음
- 기존 이슈가 해결되었는지 확인
- 기존 Action Item 상태 변경
- 새 Action Item 추가
- 중복 Action Item 병합
- 진행 사항에 새 이벤트 추가
- 요약의 날짜/상태 갱신
- 반영 완료 후 `source_message_ids`, `learned_message_count`, `last_message_id` 갱신

보고서 병합 규칙:

- 기존 항목의 `id`가 유지되면 같은 이슈/Action Item으로 본다.
- 새 메시지가 기존 항목의 상태를 바꾸면 기존 항목을 갱신한다.
- 새 메시지가 별도 업무를 만들면 새 항목으로 추가한다.
- 해결 또는 완료 근거가 있으면 `status`를 변경하고 evidence message id를 추가한다.
- RAG 검색으로 가져온 과거 context는 판단 근거로 사용하되, 이미 보고서에 반영된 메시지를 새 이벤트처럼 중복 추가하지 않는다.

## 7.3 보고서 저장 위치

최신 보고서는 `mail_agentic_thread_reports`에 저장한다.

추가로 버전 이력이 필요하면 아래 테이블을 둔다.

```sql
CREATE TABLE mail_agentic_thread_report_versions (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  report_json   JSONB NOT NULL,
  report_md     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

# 8. 할 일 목록 추가

## 8.1 생성 기준

Action Item 중 아래 조건을 만족하는 항목만 할 일로 만든다.

- 실행해야 할 일이 명확함
- 중복 todo가 없음
- 상태가 `open` 또는 `in_progress`
- `auto_create_todos=true`

## 8.2 중복 방지

중복 판단 key:

```txt
thread_id + normalized_action_title + source_message_id
```

또는 AgenticAI가 반환한 `action_item_id`를 사용한다.

## 8.3 담당자 결정

초기 구현에서는 담당자를 watch target owner로 둔다.

향후 확장:

- 메일 수신자/참조에서 담당자 추정
- 사용자 이메일과 EasyStation 사용자 매핑
- AgenticAI의 `owner_hint` 기반 추천

---

# 9. 텔레그램 전송

## 9.1 전송 대상

기본 전송 대상은 watch target owner다.

전송 가능 조건:

- 사용자 `telegram_id`가 등록되어 있음
- 사이트 설정의 Telegram bot이 활성화되어 있음
- watch target의 `notify_telegram=true`

## 9.2 텔레그램 메시지 형식

텔레그램은 전체 보고서를 길게 보내지 않고 변경 요약 중심으로 보낸다.

```md
[AgenticAI 메일 타래 업데이트]

제목: 옵티어스 납품 일정
계정: sales@siliconcube.co.kr
마지막 메일: 2026-06-28 10:30

중요 이슈
- 납품 일정이 7/1에서 7/3으로 변경될 가능성

진행 사항
- 고객이 수정 견적서를 요청함

Action Item
- [high] 수정 견적서 재전송 - 기한: 2026-06-29

보고서 보기: {EasyStation link}
```

## 9.3 전송 시점

텔레그램은 아래 조건에서 보낸다.

- 새 중요 이슈 발생
- 새 Action Item 발생
- 기존 Action Item 기한 변경
- 리스크 severity 상승
- watch target 최초 등록 후 초기 분석 완료

단순 메일 수신마다 매번 보내면 알림 피로도가 커지므로, 중요 변경 중심으로 보낸다.

## 9.4 실패 처리

전송 실패 시:

- `mail_agentic_events.status=failed`
- `retry_count` 증가
- 최대 재시도 초과 시 알림 실패 상태만 유지
- 보고서 생성/갱신은 성공으로 유지

---

# 10. 백엔드 모듈 구조

권장 파일 구조:

```txt
server/mail/agentic/
  watchTargets.js
  threadMatcher.js
  threadRepository.js
  ragTrainer.js
  analyzer.js
  reportRenderer.js
  todoService.js
  telegramNotifier.js
  worker.js
```

## 10.1 `watchTargets.js`

책임:

- watch target 생성/수정/삭제
- 사용자 권한 검증
- target validation

## 10.2 `threadMatcher.js`

책임:

- 새 메일이 watch target에 해당하는지 판정
- `condition_group`의 그룹 내부 OR, 그룹 간 AND 조건 평가
- 비어 있는 조건 그룹 무시
- 제목 정규화
- thread id 생성
- account 기준 매칭

## 10.3 `ragTrainer.js`

책임:

- 메일 메시지 RAG 학습 payload 생성
- 첨부파일 학습 연결
- `content_hash`, `attachment_hash` 비교
- 이미 학습된 메시지/첨부파일 학습 생략
- 학습 상태 저장

## 10.4 `analyzer.js`

책임:

- RAG 검색 context 생성
- 기존 보고서와 미반영 신규 메일을 포함해 AgenticAI 병합 분석 요청
- JSON 결과 검증
- 보고서 증분 갱신
- `source_message_ids` 갱신

## 10.5 `todoService.js`

책임:

- Action Item을 todo로 변환
- 중복 todo 방지
- todo 상태 갱신

## 10.6 `telegramNotifier.js`

책임:

- 텔레그램 메시지 생성
- Telegram Bot API 호출
- 전송 이력/실패 기록

## 10.7 `worker.js`

책임:

- pending event 처리
- retry
- dead letter 처리
- 주기적 재분석

---

# 11. API 설계

## 11.1 Watch Target API

```txt
GET    /api/mail/agentic/watch-targets
POST   /api/mail/agentic/watch-targets
PUT    /api/mail/agentic/watch-targets/:id
DELETE /api/mail/agentic/watch-targets/:id
```

생성 payload:

```json
{
  "target_type": "condition_group",
  "account_conditions": ["sales@company.com", "support@company.com"],
  "keyword_conditions": ["계약", "납품", "장애"],
  "subject_conditions": ["옵티어스", "Project Alpha"],
  "condition_match_type": "contains",
  "notify_telegram": true,
  "auto_create_todos": true
}
```

조건 payload 규칙:

- `account_conditions`, `keyword_conditions`, `subject_conditions` 안의 값은 각각 OR 조건으로 처리한다.
- 세 조건 배열 사이에는 AND 조건을 적용한다.
- 빈 배열은 판정에서 제외한다.
- 세 배열이 모두 빈 배열이면 `400 Bad Request`를 반환한다.
- 조건 문자열은 앞뒤 공백을 제거하고 빈 문자열은 저장하지 않는다.

## 11.2 Thread Report API

```txt
GET  /api/mail/agentic/threads
GET  /api/mail/agentic/threads/:threadId/report
POST /api/mail/agentic/threads/:threadId/reanalyze
POST /api/mail/agentic/threads/:threadId/retrain
```

API 의미:

- `reanalyze`: 기존 RAG 학습 데이터와 기존 보고서를 사용해 보고서만 다시 분석한다. 기본적으로 메일을 다시 학습하지 않는다.
- `retrain`: 관리 목적의 명시적 전체 재학습이다. parser/RAG schema 변경, 데이터 손상, 사용자의 명시 요청에만 사용한다.
- 신규 메일 유입 시에는 `retrain`이 아니라 message 단위 RAG 학습 이벤트를 생성한다.

## 11.3 Manual Attach API

메일 화면에서 사용자가 특정 타래를 직접 모니터링 대상으로 지정할 수 있어야 한다.

```txt
POST /api/mail/agentic/threads/:threadId/watch
```

payload:

```json
{
  "account_id": "acc-001",
  "notify_telegram": true,
  "auto_create_todos": true
}
```

---

# 12. UI 설계

## 12.1 메일 타래 화면 옵션

메일 타래 또는 메일 상세 화면에서 메일을 클릭하면 나오는 팝업 메뉴에 아래 항목을 추가한다.

- `EasyAI가 글타래로 모니터링 하도록 등록`

해당 메뉴를 클릭하면 조건 등록 화면으로 이동한다.

이동 시 현재 메일 정보를 조건 등록 화면의 초기값으로 전달한다.

| 전달 값 | 사용 방식 |
| --- | --- |
| `thread_id` | 현재 글타래를 즉시 모니터링 대상으로 연결할 때 사용 |
| `account_id` / `email_address` | 메일 계정 조건 초기값 |
| `subject` | 제목 조건 초기값. `Re:`, `Fw:` 제거 후 입력 |
| `message_id` | 등록 직후 초기 분석 대상 메시지 |
| `from_email`, `to_emails` | 향후 발신자/수신자 조건 확장용 |

팝업 메뉴에는 기존/확장 옵션으로 아래 기능도 둘 수 있다.

- `AgenticAI로 이 타래 모니터링`
- `제목 기준으로 유사 타래 모니터링`
- `이 계정 전체 모니터링`
- `요약 보고서 보기`
- `Action Item 보기`

단, 신규 등록의 기본 진입점은 `EasyAI가 글타래로 모니터링 하도록 등록`으로 통일한다.

## 12.2 모니터링 설정 화면

조건 등록 화면은 메일 계정, 키워드, 제목을 각각 여러 개 등록할 수 있는 태그 입력 UI로 구성한다.

필드:

- 메일 계정 조건
  - 예: `sales@company.com`, `support@company.com`
  - 태그 내부는 OR 조건
- 키워드 조건
  - 예: `계약`, `납품`, `장애`
  - 태그 내부는 OR 조건
- 제목 조건
  - 예: `옵티어스`, `Project Alpha`
  - 태그 내부는 OR 조건
- 조건 매칭 방식
  - 기본: `contains`
  - 고급: `exact`, `regex`
- 텔레그램 알림 여부
- 할 일 자동 생성 여부
- 활성/비활성

조건 그룹 사이의 관계는 화면에 고정 안내로 표시한다.

```txt
메일 계정 조건 AND 키워드 조건 AND 제목 조건
각 조건 박스 안의 항목은 OR로 판정
비어 있는 조건 박스는 무시
```

초기값:

- 메일 팝업 메뉴에서 진입한 경우 현재 메일의 계정과 정규화 제목을 자동 입력한다.
- 사용자는 자동 입력된 조건을 삭제하거나 추가할 수 있다.
- 키워드 조건은 빈 값으로 시작한다.

저장 버튼 처리:

1. 각 태그 입력값의 앞뒤 공백을 제거한다.
2. 중복 값을 제거한다.
3. 빈 조건 그룹은 저장 payload에서 빈 배열로 보낸다.
4. 세 조건 그룹이 모두 비어 있으면 저장을 막고 최소 하나의 조건을 입력하도록 안내한다.
5. 저장 성공 후 현재 글타래가 조건에 부합하면 `mail_thread_watch_created` 이벤트를 생성한다.

UI 예시:

```txt
메일 계정: [ sales@company.com ] [ support@company.com ]
AND
키워드: [ 계약 ] [ 납품 ] [ 장애 ]
AND
제목: [ 옵티어스 ] [ Project Alpha ]
```

## 12.3 보고서 화면

보고서 화면은 다음을 보여준다.

- 최신 요약
- 중요 이슈
- 진행 사항
- Action Item
- 할 일 목록
- 관련 메일 목록
- 마지막 분석 시각
- 수동 재분석 버튼
- 텔레그램 재전송 버튼

---

# 13. Worker 처리 설계

## 13.1 이벤트 종류

```txt
mail_message_synced
mail_message_sent
mail_thread_watch_created
rag_train_skipped
rag_train_requested
rag_train_completed
analysis_requested
analysis_completed
telegram_notify_requested
telegram_notify_completed
```

## 13.2 Worker 루프

```txt
1. pending event 조회
2. event_type에 따라 handler 실행
3. message hash와 rag_status 확인
4. 이미 학습된 메시지이면 rag_train_skipped 기록 후 analysis_requested로 이동
5. 신규/변경 메시지이면 해당 message만 RAG 학습
6. 성공 시 status=done
7. 실패 시 retry_count 증가
8. retry 초과 시 status=failed
```

분석 worker는 `mail_agentic_thread_reports.source_message_ids`를 확인해 아직 보고서에 반영되지 않은 메시지만 변경분으로 전달한다. 이미 반영된 메시지는 RAG 검색 context로만 사용할 수 있다.

## 13.3 재시도 정책

| 작업 | 재시도 |
| --- | --- |
| RAG 학습 | 3회 |
| AgenticAI 분석 | 3회 |
| Telegram 전송 | 5회 |
| 메일 매칭 | 1회 |

재시도 간격은 exponential backoff를 사용한다.

---

# 14. 보안 및 권한

## 14.1 메일 접근 권한

사용자는 자신이 접근 가능한 tenant/account/thread에 대해서만 watch target을 만들 수 있다.

권한 체크:

- tenant member 여부
- mail account 접근 권한
- watch target owner 여부
- site_admin 예외

## 14.2 RAG 보안

메일 RAG 검색은 게시글 채널 ACL과 분리한다.

메일 RAG ACL:

- tenant id
- account id
- owner user id
- authorized user ids

RAG 검색 시 위 조건을 metadata filter로 적용해야 한다.

## 14.3 민감정보 처리

메일 본문에는 개인정보/계약정보/금액정보가 포함될 수 있다.

정책:

- 보고서는 권한 있는 사용자에게만 표시
- 텔레그램에는 민감 원문 전체를 보내지 않음
- 텔레그램은 요약/할 일 중심
- 첨부파일 링크는 인증 URL 사용
- 외부 LLM 사용 시 메일 데이터 전송 정책 별도 승인 필요

---

# 15. 운영 설정

config 예시:

```json
{
  "agenticai_mail": {
    "enabled": true,
    "sync_trigger_enabled": true,
    "rag_training_enabled": true,
    "analysis_enabled": true,
    "telegram_enabled": true,
    "worker_interval_sec": 30,
    "max_messages_per_analysis": 50,
    "max_retry_count": 3,
    "analysis_language": "ko",
    "telegram_min_severity": "normal"
  }
}
```

환경 변수 예시:

```bash
AGENTICAI_MAIL_ENABLED=true
AGENTICAI_MAIL_WORKER_INTERVAL_SEC=30
AGENTICAI_MAIL_MAX_MESSAGES_PER_ANALYSIS=50
AGENTICAI_MAIL_ANALYSIS_MODEL=gemma4:e4b
```

---

# 16. 구현 순서

## 16.1 1단계: DB와 Watch Target

- AgenticAI mail 테이블 추가
- watch target CRUD API 구현
- `condition_group` watch target 구현
- 계정/키워드/제목 조건 배열 저장 및 validation 구현
- 메일 화면에서 수동 watch 등록
- 제목/account/condition group 매칭 구현

## 16.2 2단계: 메일 동기화 연동

- Gmail sync 완료 후 `mail_message_synced` event 생성
- 발신 성공 후 `mail_message_sent` event 생성
- watch target 매칭 후 thread 생성/갱신

## 16.3 3단계: RAG 학습

- 메일 메시지 RAG payload 생성
- message id/hash 기반 증분 학습 판정
- 신규/변경 본문만 학습
- 신규/변경 첨부파일만 학습 연결
- 이미 학습된 메시지는 skip 처리
- 학습 상태 저장

## 16.4 4단계: AgenticAI 분석

- thread 단위 RAG context 조회
- 기존 report + 미반영 신규 message 포함 분석
- 구조화 JSON 검증
- report 병합 저장
- `source_message_ids` 갱신

## 16.5 5단계: Todo와 Telegram

- Action Item 중복 제거
- todo 생성/갱신
- Telegram 메시지 생성
- 전송 이력 저장

## 16.6 6단계: UI 완성

- 모니터링 대상 관리 화면
- 메일 클릭 팝업 메뉴에 `EasyAI가 글타래로 모니터링 하도록 등록` 추가
- 팝업 메뉴에서 조건 등록 화면으로 이동
- 계정/키워드/제목 태그 입력 UI 구현
- 조건 그룹 OR, 그룹 간 AND 규칙 표시
- 메일 타래 요약 보고 화면
- Action Item/Todo 화면
- 수동 재분석/재전송 버튼

---

# 17. 완료 기준

기능 완료 기준:

- 제목 기준 watch target 생성 가능
- 계정 기준 watch target 생성 가능
- 조건 그룹 watch target 생성 가능
- 메일 계정 조건 `[A, B, C, D, ...]` 내부 OR 판정 가능
- 키워드 조건 `[E, F, G, H, ...]` 내부 OR 판정 가능
- 제목 조건 `[I, J, ...]` 내부 OR 판정 가능
- 메일 계정/키워드/제목 조건 그룹 사이 AND 판정 가능
- 비어 있는 조건 그룹은 판정에서 제외됨
- 메일 클릭 팝업 메뉴에서 `EasyAI가 글타래로 모니터링 하도록 등록` 선택 가능
- 메뉴 선택 후 조건 등록 화면으로 이동 가능
- 신규 수신 메일이 watch target에 매칭됨
- 신규 발신 메일도 watch target에 매칭됨
- 매칭된 신규 메일 본문만 RAG 학습됨
- 이미 학습된 이전 메일은 다시 학습하지 않음
- 첨부파일이 있으면 신규/변경 첨부파일만 학습 시도됨
- RAG 학습 완료 후 thread report가 생성됨
- 새 메일 수신 후 기존 report가 증분 병합 갱신됨
- 중요 이슈/진행 사항/Action Item/todo가 구조화되어 저장됨
- 사용자에게 텔레그램 알림이 전송됨
- 같은 메일을 중복 처리하지 않음
- 수동 재분석 가능
- 명시적 전체 재학습은 수동 요청 또는 schema/parser 변경 시에만 수행됨
- 권한 없는 사용자가 보고서를 볼 수 없음

---

# 18. CODEX 구현 시 주의사항

- `docs/MailServiceArchitecture.md`의 메일 DB 접근 원칙을 반드시 따른다.
- 라우트에서 직접 SQL을 많이 작성하지 말고 repository 또는 agentic 전용 repository로 분리한다.
- Gmail sync 흐름을 막지 말고 이벤트 기반 비동기 처리로 연결한다.
- 새 메일마다 과거 메일을 모두 다시 RAG 학습하지 않는다.
- RAG 학습 idempotency는 `message_id + content_hash + attachment_hash + rag_schema_version`으로 판단한다.
- 분석 idempotency는 `thread_id + source_message_ids + analysis_version`으로 판단한다.
- RAG 학습 실패와 Telegram 실패를 분리한다.
- 보고서 업데이트는 기존 보고서를 기준으로 병합하며 idempotent하게 만든다.
- AgenticAI 분석 결과는 JSON schema validation을 거친 뒤 저장한다.
- 텔레그램에는 민감한 메일 원문 전체를 보내지 않는다.
- 최초 구현은 제목/account watch target만 지원하고, sender/manual thread는 확장으로 둔다.

