postdisplay_delay.md

# 결론: 매우 좋은 방향입니다 (특히 ①댓글 지연 ②최신 N건)

근거와 우선순위를 정리합니다.

# 1순위 — 댓글 지연 로딩 (효과 최대)

배치화 이후 채널 1회 로딩의 남은 비용 절반 이상이 댓글입니다(글 199건당 댓글 Cassandra 199회 + deleted_items 199회 + 댓글 가공). 초기 응답에서 댓글을 빼고 글 클릭 시 GET /:id/comments로 로딩하면 첫 화면 비용이 급감합니다. 데이터 모델 변경도 거의 없습니다.

# 2순위 — 최신 N건 + 스크롤 추가 로딩

클러스터링이 DESC라 이게 거의 공짜입니다:

초기: SELECT * FROM posts WHERE channel_id=? LIMIT 10 (기본순서가 이미 최신순) → 디스크 순차 10건만
더 보기(스크롤): WHERE channel_id=? AND created_at < ? LIMIT 10 → 클러스터링 키 범위 스캔, 매우 효율적

# "읽지 않은 글 먼저"는 사실상 공짜로 해결됩니다

unread 판정은 channel_last_read.last_read_at보다 나중에 생성된 글 = 곧 가장 최신 글들입니다. 즉 "최신 N건"을 가져오면 안 읽은 글이 자동으로 그 안에 포함됩니다. 별도 "unread 우선 정렬"이 거의 필요 없습니다. (예외: 안 읽은 글이 N건보다 많을 때만 last_read 경계까지 더 당겨오면 됩니다.)

# 접근 ① vs ② — 제 추천: ②를 기본 + ①을 보조

## 장점	단점
① 먼저 표시 후 백그라운드로 전체	구현 단순, 이후 스크롤 즉시	199건짜리 채널은 결국 전부 다 읽음(부하 그대로, 미룬 것뿐)
② 스크롤 시점에 안 보이는 글 로딩	큰 채널에서 실제로 안 읽으면 안 가져옴(부하 최소)	스크롤 시 약간의 지연 가능

# 추천: 

② 무한 스크롤을 기본으로, 다음 페이지 1장만 백그라운드 선반입(prefetch) 하는 하이브리드. 
①의 "끝까지 백그라운드 로딩"은 대형 채널에서 절약 효과를 날립니다(일을 미룰 뿐 줄이지 않음). 표준 채팅 UX(Slack/Discord)도 이 방식입니다.

# 주의할 점 2가지 (꼭 설계에 반영)

## 안 읽은 "댓글" 배지 정확도 
— 지금 unread 배지는 댓글 활동까지 본(buildUnreadMeta) 결과입니다. 댓글을 안 가져오면 "댓글에 새 글 있음" 배지를 못 만듭니다. 

## 해결책: 

posts에 last_comment_at / comment_count를 비정규화 저장(댓글 작성 시 갱신)해서, 댓글 본문 없이 배지만 계산. 이게 이 방향의 유일한 실질 작업입니다.

고정(pinned) 글 — 오래된 고정글은 "최신 10건" 창에 안 들어옵니다. 고정글은 별도 조회 후 상단 병합 필요.
예상 효과

## 현재(배치화 후): 채널 오픈 ≈ 200쿼리 / ~400ms

이 방향 적용 후 초기 화면: 글 10건·댓글 0건 ≈ 20~30쿼리 / 100ms 이하 목표. 첫 페인트 체감이 가장 크게 개선됩니다.

5초 폴링도 "최신 창 + unread 카운트"만 갱신하면 되어 부하가 함께 줄어듭니다.

# 종합 권고

## 순서대로 진행 추천:

댓글 지연 로딩 (데이터모델 변경 최소, 효과 최대) — 단 last_comment_at/comment_count 비정규화 동반
최신 N + 커서 스크롤(②) — DESC 클러스터링이라 구현·성능 모두 유리
unread-우선은 1·2의 부산물로 자연 해결, pinned만 별도 병합
원하시면 이 순서대로 1번부터 구현하겠습니다. 어디부터 진행할까요?

결론과 수정 우선순위

1 IMAP error 이벤트를 처리해 백엔드 전체 종료를 막기
2 실패 계정에 backoff를 적용하고 서버 재시작 직후 자동 동기화 반복을 차단
3 Vite 개발 서버 대신 프로덕션 빌드로 서비스
4 Mail, Calendar, Admin, ContactBook 등을 React.lazy()로 분리
5 5초 게시글 폴링을 WebSocket/SSE 또는 변경 감지 방식으로 교체
6 ChatContext를 분리하고 Provider 값을 memoize
7 팀 멤버 N+1 요청과 Cassandra ALLOW FILTERING 쿼리 개선

요약하면, 현재 체감 지연의 핵심은 IMAP 오류로 인한 백엔드 재시작 루프, 4.9MB짜리 거대한 초기 프론트엔드 번들, 5초마다 발생하는 전역 재렌더링입니다. 분석만 수행했으며 코드는 변경하지 않았습니다.

# IMAP error 이벤트 처리 분석

## 결론

백엔드 전체가 종료되는 직접 원인은 `server/mail/imapSync.js`에서 만든 `ImapFlow` 인스턴스에 `error` 이벤트 리스너가 없기 때문이다.

현재 로그에는 다음 순서가 반복된다.

```text
Error: Socket timeout
Emitted 'error' event on ImapFlow instance
Node.js process exited with code 1
2초 후 백엔드 재시작
```

이 오류는 일반적인 `await` 실패와 성격이 다르다. Node.js의 `EventEmitter`는 이름이 `error`인 이벤트에 리스너가 하나도 없으면 해당 오류를 프로세스 밖으로 throw한다. 따라서 스케줄러와 `syncImapAccount()`에 `try/catch`가 있어도, 이벤트 리스너가 없으면 그 코드가 오류를 처리하기 전에 Node 프로세스가 종료될 수 있다.

## 실제 오류 경로

### 1. 리스너 없는 ImapFlow 생성

`server/mail/imapSync.js`의 `buildImapClient()`는 클라이언트만 생성한다.

```js
function buildImapClient(account, password) {
  return new ImapFlow({
    host: account.imap_host,
    port: Number(account.imap_port),
    secure: account.imap_security !== 'starttls' && account.imap_security !== 'none',
    auth: { user: account.username || account.email_address, pass: password },
    logger: false,
  })
}
```

생성 직후 `client.on('error', ...)` 등록이 없다.

### 2. 연결이 끝난 뒤 소켓 타임아웃 발생

설치된 ImapFlow 구현은 기본 `socketTimeout`이 300,000ms, 즉 5분이다. 연결 중 오류는 `client.connect()`의 Promise를 reject할 수 있지만, 연결이 완료된 뒤 비-IDLE 작업에서 소켓 타임아웃이 발생하면 다음 경로를 탄다.

```text
socket의 timeout 이벤트
→ ImapFlow._socketTimeout()
→ ImapFlow.emitError(err)
→ client.emit('error', err)
→ error 리스너 없음
→ Node 프로세스 종료
```

실제 운영 로그의 약 5분 간격 `Socket timeout`과 이 기본값이 일치한다.

### 3. 재시작이 실패 루프를 증폭

`server/mail/scheduler.js`는 서버가 시작될 때 10분 주기 타이머를 등록하지만, 최초 동기화는 30초 뒤 실행한다.

```js
timer = setInterval(tick, intervalMs)
setTimeout(tick, 30 * 1000)
```

따라서 다음 악순환이 만들어진다.

```text
서버 시작
→ 30초 뒤 자동 메일 동기화
→ IMAP 작업이 5분 뒤 socket timeout
→ 백엔드 종료
→ 실행 스크립트가 2초 뒤 재시작
→ 다시 30초 뒤 자동 동기화
```

원래 10분 주기와 관계없이 실패 계정이 매번 빠르게 재시도되며, 재시작 순간에는 게시글·DM·인증 등 모든 `/api` 요청이 `ECONNREFUSED`가 된다.

## 처리 방향

### 필수 조치 1: 생성 직후 error 리스너 등록

최소한 `buildImapClient()`가 반환되기 전에 리스너를 등록해야 한다.

```js
function buildImapClient(account, password) {
  const client = new ImapFlow({ /* 현재 옵션 */ })

  client.on('error', (err) => {
    console.error(
      `[Mail IMAP] account=${account.id} host=${account.imap_host}:`,
      err,
    )
  })

  return client
}
```

이 조치가 Node의 미처리 `error` 규칙에 의한 프로세스 종료를 즉시 막는다. 비밀번호·토큰은 로그에 포함하지 않고 계정 ID, provider, host, 오류 code 정도만 기록해야 한다.

단, 단순히 로그만 남기고 오류를 무시하면 동기화가 성공한 것처럼 처리될 가능성이 있다. 프로세스 보호와 작업 실패 처리를 함께 구현해야 한다.

### 필수 조치 2: 이벤트 오류를 현재 동기화 작업의 실패로 전달

안전한 구현은 다음 두 조건을 만족해야 한다.

1. `error` 이벤트에는 항상 리스너가 있어 프로세스가 종료되지 않는다.
2. 수신한 오류는 해당 계정의 동기화 Promise를 reject시켜 스케줄러가 그 계정만 `sync_status='error'`로 기록한다.

권장 구조는 공통 실행 래퍼가 IMAP 작업과 terminal error Promise를 `Promise.race()`로 묶는 방식이다.

```js
async function withImapClient(account, password, operation) {
  const client = new ImapFlow({ /* 현재 옵션 */ })
  let rejectTerminalError
  const terminalError = new Promise((_, reject) => {
    rejectTerminalError = reject
  })
  const onError = (err) => rejectTerminalError(err)

  client.on('error', onError)

  try {
    await client.connect()
    return await Promise.race([
      operation(client),
      terminalError,
    ])
  } finally {
    if (client.usable) await client.logout().catch(() => {})
    else client.close()
    client.removeListener('error', onError)
  }
}
```

실제 구현에서는 `finally` 중에도 늦은 `error` 이벤트가 발생할 수 있으므로, 클라이언트를 완전히 닫기 전에 마지막 `error` 리스너를 제거하면 안 된다. 정리 순서는 다음과 같아야 한다.

```text
작업 종료 또는 실패
→ logout/close
→ 소켓이 닫힌 것을 확인
→ error 리스너 제거
```

또는 인스턴스 수명이 짧으므로 안전 리스너를 제거하지 않고 클라이언트와 함께 가비지 컬렉션되도록 두는 방법도 가능하다.

### 필수 조치 3: 계정 단위 격리 유지

`runMailSyncTick()`에는 이미 계정별 `try/catch`가 있다. 이벤트 오류가 정상적으로 Promise rejection으로 변환되면 다음과 같이 동작할 수 있다.

```text
IMAP 계정 A 타임아웃
→ 계정 A만 sync_status='error'
→ 오류 메시지 저장
→ 다음 계정 B 동기화 계속
→ 백엔드 프로세스와 다른 API는 정상 유지
```

따라서 전역 `process.on('uncaughtException')`으로 덮는 방식은 권장하지 않는다. 이 방식은 오류 발생 작업과 계정을 식별하기 어렵고, 손상된 상태로 프로세스를 계속 실행할 위험이 있다. 오류가 발생한 ImapFlow 인스턴스에서 직접 처리해야 한다.

## 적용 범위

`imapSync.js`만 수정하면 자동 동기화에 의한 반복 종료는 막을 수 있지만 완전한 해결은 아니다. 현재 별도의 `new ImapFlow()` 생성 코드가 다음 파일에도 있다.

- `server/mail/imapSync.js`: 자동 동기화, 폴더 목록, 폴더 동기화
- `server/mail/providerMove.js`: IMAP 메일 이동
- `server/mail/providerRename.js`: IMAP 폴더 이름 변경

세 파일 모두 동일하게 리스너 없는 클라이언트를 생성하므로 사용자 작업 중에도 같은 프로세스 종료 위험이 있다. 공통 `createImapClient()` 또는 `withImapClient()` 모듈로 통합하는 것이 최종 권장안이다.

## 검증 항목

구현 후에는 다음을 확인해야 한다.

1. 테스트용 IMAP 서버 또는 네트워크 차단으로 `ETIMEOUT`을 발생시킨다.
2. 로그에 계정 단위 IMAP 오류가 한 번 기록되는지 확인한다.
3. 백엔드 PID가 바뀌지 않는지 확인한다.
4. 오류 중에도 `/api/config/limits`, `/api/auth/me` 같은 비메일 API가 응답하는지 확인한다.
5. 실패 계정은 `sync_status='error'`, 정상 계정은 계속 동기화되는지 확인한다.
6. 이벤트 처리 후 `unhandledRejection`, `uncaughtException`, EventEmitter listener leak 경고가 없는지 확인한다.
7. 메일 이동과 폴더 이름 변경 경로에서도 동일한 타임아웃 테스트를 수행한다.

## 이번 항목의 권장 구현 순서

1. 모든 ImapFlow 생성 직후 동기식으로 `error` 리스너를 등록한다.
2. 이벤트 오류를 현재 계정 작업의 Promise rejection으로 연결한다.
3. `logout/close` 완료 뒤 리스너와 자원을 정리한다.
4. 세 파일의 중복 클라이언트 생성 코드를 공통 모듈로 통합한다.
5. 이후 별도 항목으로 실패 계정 backoff와 서버 시작 직후 재시도 정책을 적용한다.

1~4는 “오류가 나도 백엔드 전체가 죽지 않게 하는 작업”이고, 5는 “죽지는 않지만 같은 실패를 계속 반복하는 문제”를 줄이는 후속 최적화다.

## 구현 반영 상태

위 1~4 항목은 다음 코드에 반영했다.

- `server/mail/imapClient.js`: 공통 ImapFlow 생성, `error` 이벤트의 Promise rejection 변환, 안전한 `logout/close`
- `server/mail/imapSync.js`: 폴더 목록, 단일 폴더 동기화, 계정 자동 동기화에 공통 래퍼 적용
- `server/mail/providerMove.js`: 단일/다중 메일 이동과 교차 계정 append에 공통 래퍼 적용
- `server/mail/providerRename.js`: 폴더 이름 변경과 삭제에 공통 래퍼 적용
- `server/mail/imapClient.test.js`: 정상 작업과 `ETIMEOUT` 이벤트 격리 테스트

이제 연결 후 `Socket timeout`이 발생하면 백엔드 전역 예외가 아니라 해당 IMAP 작업의 Promise 실패가 된다. 자동 동기화에서는 기존 `runMailSyncTick()`의 계정별 `try/catch`가 이를 받아 해당 계정만 오류 상태로 기록하고 다음 계정으로 진행한다.

실패 계정 backoff와 서버 시작 직후 재시도 정책은 아래 후속 구현에서 반영했다.

# 후속 구현 계획 — 우선순위 2~4

아래 세 항목은 1번 IMAP 오류 격리 이후 적용할 후속 작업이다.

2. 실패 계정에 backoff를 적용하고 서버 재시작 직후 자동 동기화 반복을 차단한다.
3. 운영 환경에서는 Vite 개발 서버 대신 프로덕션 빌드를 서비스한다.
4. Mail, Calendar, Admin, ContactBook 등 초기 화면에 필요하지 않은 기능을 `React.lazy()`로 분리한다.

세 작업의 목적은 서로 다르다.

- 2번은 실패한 외부 서비스가 백엔드 자원을 반복 소비하는 것을 막는다.
- 3번은 개발용 변환·파일 감시 비용을 제거하고 압축·캐시 가능한 정적 파일을 제공한다.
- 4번은 사용자가 실제로 열지 않은 기능의 JavaScript를 초기 다운로드와 파싱 대상에서 제외한다.

적용 순서는 **2 → 3 → 4**를 권장한다. 2번으로 운영 안정성을 먼저 확보하고, 3번으로 실제 운영 번들 기준을 만든 뒤, 4번의 청크 분리 효과를 프로덕션 빌드 결과로 측정한다.

# 2. 실패 계정 backoff와 서버 시작 직후 자동 동기화 차단

## 현재 문제

현재 `server/mail/scheduler.js`는 다음 방식으로 동작한다.

- 서버 시작 30초 뒤 첫 자동 동기화를 실행한다.
- 이후 기본 10분 간격으로 모든 동기화 가능 계정을 순회한다.
- 계정 동기화가 실패해도 다음 tick에서 동일한 계정을 다시 시도한다.
- backoff 상태가 메모리나 DB에 없으므로 백엔드가 재시작되면 실패 이력이 사라진다.

따라서 외부 실행 스크립트가 백엔드를 재시작하는 상황에서는 10분 간격이 사실상 무효화되고, 실패 계정이 매번 `시작 + 30초` 시점에 다시 접속한다. 단순한 프로세스 메모리 `Map`으로 backoff를 구현해도 서버 재시작 때 초기화되므로 이 문제를 해결하지 못한다.

## 권장 정책

계정별 연속 실패 횟수와 다음 자동 재시도 가능 시각을 DB에 저장한다.

`mail_accounts`에 다음 컬럼을 추가한다.

```sql
ALTER TABLE mail_accounts
  ADD COLUMN IF NOT EXISTS sync_failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sync_retry_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_attempt_at TIMESTAMPTZ;
```

각 컬럼의 의미는 다음과 같다.

- `sync_failure_count`: 연속 자동 동기화 실패 횟수
- `sync_retry_after`: 자동 동기화를 다시 시도할 수 있는 가장 빠른 시각
- `last_sync_attempt_at`: 마지막 자동 동기화 시도 시각

DB에 저장하므로 백엔드가 재시작되어도 실패 계정의 대기 시간이 유지된다.

권장 backoff는 지수 증가와 최대 상한을 함께 사용한다.

```text
1회 실패:  5분
2회 실패: 10분
3회 실패: 20분
4회 실패: 40분
5회 이상: 60분
```

계산식 예시는 다음과 같다.

```js
const delayMs = Math.min(
  MAIL_SYNC_BACKOFF_MAX_MS,
  MAIL_SYNC_BACKOFF_BASE_MS * (2 ** Math.max(0, failureCount - 1)),
)
```

동시에 여러 서버 인스턴스가 같은 계정을 선택할 가능성이 있다면 `sync_retry_after` 조회만으로는 충분하지 않다. 계정 선택과 `syncing` 전환을 트랜잭션 또는 조건부 `UPDATE`로 묶어 계정 lease를 획득해야 한다. 현재 단일 백엔드 운영을 유지한다면 기존 전역 `running` 잠금을 그대로 사용하되, 다중 인스턴스 전환 전에 DB lease를 추가한다.

## 스케줄러 처리 흐름

자동 동기화 tick의 계정별 흐름을 다음처럼 변경한다.

```text
계정 조회
→ sync_retry_after가 현재보다 미래이면 skip
→ last_sync_attempt_at 기록, sync_status='syncing'
→ 동기화 실행
  ├─ 성공: failure_count=0, retry_after=NULL, last_error=NULL
  └─ 실패: failure_count+1, 계산한 retry_after 저장, sync_status='error'
```

skip된 계정은 오류로 다시 기록하지 않는다. 결과에는 다음과 같이 이유를 남겨 운영 로그에서 실제 실행과 backoff 생략을 구분한다.

```js
{
  accountId: account.id,
  skipped: true,
  reason: 'backoff',
  retryAfter: account.sync_retry_after,
}
```

인증 만료처럼 자동 재시도로 회복되지 않는 오류는 일반 네트워크 오류와 구분한다.

- `MAIL_REAUTH_REQUIRED`: 계정 상태를 `error`로 유지하고 자동 재시도하지 않는다. 사용자가 재인증하면 실패 횟수와 `sync_retry_after`를 초기화한다.
- `ETIMEDOUT`, `ECONNRESET`, 일시적 DNS/서버 오류: 지수 backoff를 적용한다.
- 명시적인 사용자 수동 동기화: backoff를 무시하고 한 번 실행할 수 있다. 성공하면 backoff를 초기화하고, 실패하면 실패 횟수와 다음 재시도 시각을 갱신한다.

## 서버 시작 직후 반복 차단

기존의 고정 `setTimeout(tick, 30 * 1000)`은 제거하거나 설정 가능한 startup delay로 바꾼다.

```text
MAIL_SYNC_STARTUP_DELAY_MS=300000
```

권장 기본값은 5분이다. 다만 startup delay만 적용하면 재시작 간격이 5분보다 길 때 다시 실패할 수 있으므로, 핵심 차단 장치는 DB의 `sync_retry_after`다.

서버 시작 시 다음 정책을 적용한다.

1. 스케줄러 등록은 즉시 수행한다.
2. 첫 tick은 `MAIL_SYNC_STARTUP_DELAY_MS` 뒤 실행한다.
3. 첫 tick에서도 DB의 `sync_retry_after`를 반드시 검사한다.
4. startup delay 안에 서버가 다시 재시작되더라도 계정별 backoff 상태는 보존한다.
5. 정상 종료·시작 자체를 실패로 계산하지 않는다.

타이머는 기존처럼 `unref()`를 적용하고, `stopMailSyncScheduler()`를 추가해 테스트와 graceful shutdown에서 interval 및 startup timer를 모두 정리할 수 있게 한다.

## 수정 대상

- `server/mail/schema.js`
  - `mail_accounts` backoff 컬럼 migration 추가
- `server/mail/repository.js`
  - 동기화 대상 조회 시 backoff 필드 반환
  - 시도 시작, 성공 초기화, 실패 증가를 위한 repository 함수 추가
- `server/mail/scheduler.js`
  - `sync_retry_after` 검사
  - 오류 유형별 backoff 계산
  - 설정 가능한 startup delay
  - scheduler stop/cleanup 지원
- 메일 계정 재인증 및 재연결 처리 경로
  - 성공 시 `sync_failure_count=0`, `sync_retry_after=NULL` 초기화
- scheduler 테스트
  - fake timer와 고정 시각을 사용해 backoff 계산 및 재시작 후 skip 검증

## 환경 설정

```text
MAIL_SYNC_INTERVAL_MS=600000
MAIL_SYNC_STARTUP_DELAY_MS=300000
MAIL_SYNC_BACKOFF_BASE_MS=300000
MAIL_SYNC_BACKOFF_MAX_MS=3600000
```

환경 변수 값은 하한과 상한을 검증해야 한다. 잘못된 값이나 `NaN` 때문에 즉시 반복 tick이 생기지 않도록 안전한 기본값으로 되돌린다.

## 검증 및 완료 기준

1. 특정 계정에서 연속 실패를 발생시키면 retry 시간이 5분, 10분, 20분 순으로 증가한다.
2. `sync_retry_after` 이전 tick에서는 해당 계정의 IMAP 연결이 실행되지 않는다.
3. backoff 중 백엔드를 재시작해도 해당 계정이 즉시 다시 연결되지 않는다.
4. 정상 계정은 실패 계정의 backoff와 관계없이 계속 동기화된다.
5. 성공한 계정은 실패 횟수와 retry 시간이 초기화된다.
6. 재인증 필요 계정은 매 tick마다 자동 로그인하지 않는다.
7. 사용자 수동 동기화는 정책대로 backoff를 우회하며 결과를 DB에 반영한다.
8. 로그에 계정 ID, 실패 횟수, 다음 시도 시각, skip 이유가 남고 비밀번호·토큰은 포함되지 않는다.

# 3. Vite 개발 서버 대신 프로덕션 빌드로 서비스

## 현재 문제

현재 `scripts/run-dgx-spark.sh`는 운영 성격의 백그라운드 실행에서도 다음 명령으로 프론트엔드를 시작한다.

```bash
npm run dev:frontend
```

이는 Vite 개발 서버이므로 파일 감시, 개발용 모듈 변환, HMR 연결을 유지한다. 프로덕션 빌드의 minify, content hash, 정적 자산 캐시 전략을 실제 서비스 경로에서 충분히 활용하지 못한다.

`npm run build` 결과는 이미 `dist/`에 생성되지만, 현재 백엔드 `server/index.js`는 `dist/`를 정적 서비스하지 않는다.

## 권장 서비스 구조

운영에서는 다음 두 구조 중 하나를 선택한다.

### 권장안 A: Express가 API와 `dist/`를 함께 서비스

현재 단일 서버 배포 구조에 가장 단순하다.

```js
const distDir = path.resolve(__dirname, '../dist')

app.use(express.static(distDir, {
  index: false,
  maxAge: '1y',
  immutable: true,
}))

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.setHeader('Cache-Control', 'no-cache')
  return res.sendFile(path.join(distDir, 'index.html'))
})
```

실제 적용 시 다음 캐시 정책을 구분한다.

- `/assets/*`: 파일명에 content hash가 있으므로 `public, max-age=31536000, immutable`
- `index.html`: 새 배포 청크 이름을 즉시 받도록 `no-cache` 또는 `no-store`
- `sw.js`: 이전 서비스 워커가 남지 않도록 `no-cache`
- `/api/*`: 정적 fallback보다 먼저 API router가 처리
- SPA 딥링크: 존재하지 않는 정적 경로는 `index.html`로 fallback

Express 버전에 따라 `app.get('*')` path 문법이 다를 수 있으므로 현재 설치 버전에서 동작하는 fallback 패턴을 사용한다. API 404가 `index.html` 200 응답으로 바뀌지 않도록 정적 fallback은 모든 API router와 API 404 처리 뒤, 최종 오류 처리 앞에 둔다.

### 대안 B: Nginx/Caddy가 `dist/`를 서비스하고 `/api`만 백엔드로 프록시

정적 파일 처리와 TLS를 웹 서버에 맡길 수 있어 장기적으로 더 적합하다. 다만 현재 실행 스크립트와 배포 구성을 더 많이 바꿔야 하므로 1차 적용은 Express 통합 서비스를 권장한다.

`vite preview`는 빌드 결과 확인용이며 운영 서버로 권장하지 않는다. 개발 서버를 `preview`로 이름만 바꾸는 것이 아니라, 실제 운영 프로세스가 정적 파일과 API를 안정적으로 제공하도록 구성한다.

## 실행 스크립트 변경

`scripts/run-dgx-spark.sh` 시작 흐름을 다음처럼 변경한다.

```text
환경 변수 로드
→ VITE_* 빌드타임 환경 변수 설정
→ npm run build
→ dist/index.html 존재 확인
→ 백엔드 및 Ollama 시작
→ 백엔드 한 프로세스가 API와 프론트엔드 서비스
```

프론트엔드 Vite 프로세스와 `FE_PID_FILE`은 운영 모드에서 제거할 수 있다. 포트도 5173 대신 백엔드 포트 3001 하나만 사용한다. 외부 reverse proxy가 현재 5173을 바라보고 있다면 배포 전에 3001로 변경하거나 별도의 정적 서버를 5173에 두어야 한다.

빌드타임 플래그인 `VITE_CONSTRUCT_SAFE_KANBAN_TEMPLATE`, `VITE_EASY_CODE_GENERATION_TEMPLATE`, `VITE_SHOW_WELCOME_BOARD`는 반드시 `npm run build`를 실행하는 프로세스 환경에 전달한다. 런타임에만 전달하면 이미 만들어진 번들에는 반영되지 않는다.

개발 흐름은 유지한다.

- 로컬 개발: `npm run dev` 또는 `npm run dev:frontend`
- 운영 실행: `npm run build` 후 `npm run start --prefix server`

운영 시작 때마다 빌드하면 시작 시간이 늘고 실패 지점이 많아진다. 최종적으로는 배포 단계에서 한 번 빌드하고, 실행 단계에서는 검증된 `dist/`만 서비스하는 방식을 권장한다.

## 수정 대상

- `server/index.js`
  - 프로덕션에서만 `dist/` 정적 서비스
  - `/assets`, `index.html`, `sw.js` 캐시 정책 분리
  - SPA fallback과 API 404 순서 정리
- `scripts/run-dgx-spark.sh`
  - 운영 Vite dev server 제거
  - 빌드 또는 빌드 산출물 검증 단계 추가
  - PID 및 포트 검사 로직을 단일 프론트/백엔드 서비스 구조에 맞게 수정
- `package.json`
  - 필요하면 `start:production`, `build:production` 명령을 명확히 분리
- reverse proxy 및 방화벽 설정
  - 외부 서비스 포트가 5173에 고정되어 있는지 확인

## 배포 안전장치

빌드 도중 기존 `dist/`를 직접 덮어쓰면 사용자가 요청하는 순간 일부 청크만 새 버전이 되는 문제가 생길 수 있다. CI 또는 배포 스크립트에서 임시 디렉터리에 빌드한 뒤 검증하고 원자적으로 교체한다.

```text
새 소스 빌드
→ index.html 및 주요 asset 존재 확인
→ smoke test
→ dist 디렉터리 교체
→ 백엔드 graceful restart
```

이전 `index.html`을 받은 브라우저가 잠시 이전 hash 청크를 요청할 수 있으므로, 무중단 배포가 필요하면 이전 assets를 일정 시간 보존한다.

## 검증 및 완료 기준

1. 운영 프로세스 목록에 `vite`와 HMR WebSocket이 없다.
2. `/`, 메일 딥링크, 연락처 딥링크를 새로고침해도 SPA가 정상 열린다.
3. `/api/health`와 존재하지 않는 `/api/...`가 정적 `index.html`로 응답하지 않는다.
4. hash가 포함된 asset은 장기 캐시, `index.html`과 `sw.js`는 재검증 정책을 가진다.
5. `VITE_*` 빌드 플래그가 운영 화면에 정확히 반영된다.
6. 프론트엔드 포트 변경 후 reverse proxy와 CORS 설정이 정상 동작한다.
7. gzip 또는 Brotli 압축이 적용되는지 확인한다. Express 직접 제공 시 `compression` middleware 또는 앞단 proxy에서 처리한다.

# 4. Mail, Calendar, Admin, ContactBook의 `React.lazy()` 분리

## 현재 문제

`src/App.jsx`는 초기 진입 시 다음 대형 화면을 정적 import한다.

```js
import SiteAdminPage from './components/SiteAdminPage'
import CalendarView from './components/CalendarView'
import MailPage from './features/mail/MailPage'
import ContactBookPage from './features/contactbook/ContactBookPage'
```

정적 import는 해당 화면을 열지 않아도 의존 모듈을 초기 번들 그래프에 포함시킨다. 특히 Mail과 Admin은 하위 기능과 라이브러리가 많아 초기 JavaScript 다운로드, 압축 해제, 파싱 및 실행 비용을 키운다.

현재 프로덕션 빌드의 주 앱 청크가 약 4.9MB이므로, 먼저 화면 경계에서 route 수준 code splitting을 적용하는 것이 효과 대비 구현 위험이 낮다.

## 권장 분리 방식

`App.jsx`에서 `lazy`와 `Suspense`를 사용한다.

```jsx
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'

const MailPage = lazy(() => import('./features/mail/MailPage'))
const CalendarView = lazy(() => import('./components/CalendarView'))
const SiteAdminPage = lazy(() => import('./components/SiteAdminPage'))
const ContactBookPage = lazy(() => import('./features/contactbook/ContactBookPage'))
```

각 기능이 실제로 렌더링되는 위치를 `Suspense`로 감싼다.

```jsx
<Suspense fallback={<ServicePageFallback />}>
  <MailPage {...props} />
</Suspense>
```

모든 화면을 하나의 최상위 `Suspense`로 감싸면 한 청크 로딩 때문에 전체 앱이 fallback으로 바뀔 수 있다. 기존 TitleBar와 Sidebar는 유지하고, 메인 서비스 영역과 관리자 modal처럼 독립된 경계별로 `Suspense`를 둔다.

권장 경계는 다음과 같다.

- Mail 메인 영역
- Calendar 메인 영역
- ContactBook 메인 영역
- SiteAdmin modal
- 필요하면 DirectMessage, UpdateHistory, GroqPanel을 2차 분리

fallback은 빈 화면 대신 기존 레이아웃 크기를 유지하는 간단한 로딩 UI를 사용한다. 접근성을 위해 `role="status"`와 언어별 로딩 문구를 제공한다.

## 모바일 진입 경로 주의

`src/components/MobileLayout.jsx`도 `CalendarView`와 `MailPage`를 정적 import한다. `App.jsx`만 바꾸면 모바일 경로 때문에 두 모듈이 초기 번들에 계속 포함될 수 있다.

따라서 다음 중 하나를 적용해야 한다.

1. `MobileLayout.jsx`에서도 동일한 두 화면을 lazy import한다.
2. lazy 컴포넌트를 `App.jsx`에서 생성해 MobileLayout prop으로 전달한다.
3. 데스크톱/모바일 공통 service route 컴포넌트를 만들고 그 경계에서 한 번만 lazy import한다.

중복 선언 자체는 Vite가 같은 모듈 청크를 재사용할 수 있지만, 로딩 fallback과 오류 처리를 일관되게 유지하려면 공통 service boundary 방식이 가장 깔끔하다.

## 청크 로드 실패 처리

배포 직후 사용자가 이전 `index.html`을 오래 열어 둔 상태에서 삭제된 청크를 요청하면 `Failed to fetch dynamically imported module`이 발생할 수 있다. `Suspense`는 Promise 대기만 처리하며 import 실패는 처리하지 않으므로 기능 영역에 Error Boundary도 둔다.

오류 UI는 다음 동작을 제공한다.

- “화면을 불러오지 못했습니다” 안내
- 다시 시도
- 새 버전 배포로 인한 청크 불일치일 경우 한 번만 페이지 새로고침

무한 reload를 막기 위해 `sessionStorage`에 재시도 여부를 기록한다. 3번 배포 정책에서 이전 asset을 일정 시간 보존하면 이 오류 가능성도 줄어든다.

## 선택적 prefetch

lazy 분리 후 처음 메뉴를 누를 때만 청크를 받으면 저속 네트워크에서 짧은 대기가 생긴다. 초기 화면이 안정된 뒤 또는 사용자가 메뉴에 포인터를 올렸을 때 선택적으로 prefetch할 수 있다.

```js
const loadMailPage = () => import('./features/mail/MailPage')
const MailPage = lazy(loadMailPage)

// 메일 메뉴 hover/focus 시
loadMailPage()
```

단, 앱 시작 직후 모든 lazy 청크를 즉시 prefetch하면 초기 분리 효과를 상쇄한다. 자주 사용하는 화면만 idle 시점이나 실제 사용자 의도(`hover`, `focus`, `touchstart`)가 보일 때 가져온다.

## 분리 우선순위

1. `MailPage`
2. `SiteAdminPage`
3. `CalendarView`
4. `ContactBookPage`
5. 빌드 분석 결과에 따라 `DirectMessageView`, `UpdateHistoryPage`, `GroqPanel`

우선순위는 파일 크기만이 아니라 해당 기능의 하위 의존성과 일반 사용자의 진입 빈도를 함께 고려한다. 사이트 관리자만 쓰는 Admin은 사용 빈도가 낮아 lazy 분리 효율이 특히 높다.

## 수정 대상

- `src/App.jsx`
  - 정적 import를 `lazy()`로 변경
  - 기능별 `Suspense` 및 Error Boundary 적용
- `src/components/MobileLayout.jsx`
  - Mail/Calendar의 우회 정적 import 제거
- 공통 로딩 및 청크 오류 UI
  - 예: `src/components/LazyServiceBoundary.jsx`
- 필요하면 `src/components/TitleBar.jsx`
  - 메뉴 hover/focus 기반 preload callback 연결

## 측정 방법

개발 서버의 모듈 요청 수가 아니라 반드시 `npm run build` 결과로 비교한다.

변경 전후에 다음을 기록한다.

- 초기 `index-*.js`의 raw/gzip 크기
- Mail, Calendar, Admin, ContactBook별 비동기 청크 크기
- 첫 화면의 transferred JavaScript
- Lighthouse 또는 Performance 패널의 FCP, LCP, TBT
- 저사양 CPU throttling에서 초기 JavaScript parse/evaluate 시간
- 각 기능을 처음 열 때의 청크 로드 시간

청크가 분리됐어도 공통 의존성이 초기 App 또는 다른 정적 import를 통해 참조되면 초기 번들 크기가 줄지 않을 수 있다. 빌드 manifest 또는 bundle visualizer로 해당 모듈이 어느 청크에 포함됐는지 확인한다.

## 검증 및 완료 기준

1. 초기 화면 네트워크 요청에 Mail, Calendar, Admin, ContactBook 전용 청크가 포함되지 않는다.
2. 각 메뉴를 처음 열 때 해당 청크가 한 번 로드되고 화면이 정상 표시된다.
3. 데스크톱과 모바일 진입 경로 모두 같은 방식으로 분리된다.
4. lazy 로딩 중 기존 레이아웃이 크게 흔들리거나 전체 앱이 빈 화면으로 바뀌지 않는다.
5. 청크 로드 실패 시 복구 가능한 오류 UI가 표시되고 무한 새로고침하지 않는다.
6. 메일·캘린더 딥링크는 필요한 청크를 로드한 뒤 기존 대상 화면으로 정상 이동한다.
7. 프로덕션 빌드에서 초기 주 앱 청크와 초기 transferred JavaScript가 유의미하게 감소한다.

# 2~4번 통합 배포 및 회귀 검증 순서

## 1단계: 백엔드 안정성

1. DB migration을 적용한다.
2. repository와 scheduler에 persistent backoff를 적용한다.
3. 실패 계정, 정상 계정, 재인증 계정 테스트를 실행한다.
4. 백엔드 재시작 전후 `sync_retry_after` 유지 여부를 확인한다.

## 2단계: 프로덕션 정적 서비스

1. 현재 reverse proxy와 외부 공개 포트를 확인한다.
2. `npm run build` 산출물을 Express 또는 전용 웹 서버에서 서비스한다.
3. SPA fallback, API 404, cache header, 압축을 확인한다.
4. Vite 개발 서버 없이 전체 기능 smoke test를 수행한다.

## 3단계: 프론트엔드 lazy 분리

1. 변경 전 프로덕션 번들 크기와 성능 기준값을 저장한다.
2. Mail과 Admin부터 분리하고 모바일 우회 import를 제거한다.
3. Calendar와 ContactBook을 분리한다.
4. 기능별 `Suspense`와 Error Boundary를 적용한다.
5. 빌드 청크 및 실제 초기 네트워크 전송량을 비교한다.

## 최종 기대 효과

```text
실패 IMAP 계정
→ DB 기반 backoff
→ 백엔드 재시작 후에도 즉시 재시도하지 않음

운영 프론트엔드
→ Vite dev server 제거
→ minify된 hash 정적 자산 + 장기 캐시

초기 앱 진입
→ 핵심 게시글 화면만 다운로드
→ Mail/Calendar/Admin/ContactBook은 실제 진입 시 로드
```

2번은 장애 반복과 백엔드 부하를 줄이고, 3번과 4번은 초기 화면의 전송량·파싱 시간·개발 서버 오버헤드를 줄인다. 세 항목을 모두 적용한 뒤에야 4.9MB 초기 번들 문제와 서버 재시작 직후 동기화 반복 문제를 각각 독립적으로 해소했는지 정확히 평가할 수 있다.

## 구현 반영 상태 (2026-07-29)

- `server/mail/schema.js`, `repository.js`, `scheduler.js`: DB 기반 실패 횟수와 retry 시각, 지수 backoff, 5분 startup delay 반영
- `server/mail/schedulerPolicy.js`, `scheduler.test.js`: DB 연결 없는 backoff 정책 단위 테스트 추가
- `server/index.js`: 프로덕션 `dist/` 정적 서비스, asset 캐시, SPA fallback, API 404 분리, graceful scheduler 종료 반영
- `scripts/run-dgx-spark.sh`: Vite 개발 서버 대신 `npm run build` 후 Express 프로덕션 서비스로 전환
- 운영 접근 포트 호환: 프론트엔드는 기존 5173, API는 기존 3001을 동일 백엔드 프로세스에서 서비스
- `src/components/LazyServiceBoundary.jsx`: 공통 `Suspense`, 로딩 UI, 청크 오류 복구 UI 추가
- `src/App.jsx`, `src/components/MobileLayout.jsx`: Mail, Calendar, SiteAdmin, ContactBook의 정적 import 제거

프로덕션 빌드 기준 초기 주 앱 청크는 약 `4,904KB (gzip 1,468KB)`에서 `4,199KB (gzip 1,274KB)`로 감소했다. 분리된 주요 청크는 Mail 약 453KB, SiteAdmin 약 168KB, Calendar 약 56KB, ContactBook 약 23KB다.

# 신규 기능 제안 — 게시글·댓글 Mermaid 다이어그램 렌더링

## 목적

게시글 또는 댓글 본문에 Mermaid 코드 블록이 포함되어 있으면 해당 블록을 일반 코드가 아닌 다이어그램으로 표시한다.

사용자가 작성한 Mermaid 원문은 그대로 보존하고, 게시글이나 댓글을 조회하는 시점에 프런트엔드가 다이어그램으로 변환하는 방식을 적용한다. 이 기능은 일반 게시글과 댓글뿐 아니라 동일한 Markdown 표시 구조를 사용하는 화면에서도 일관되게 동작해야 한다.

## 인식 기준

Mermaid 다이어그램은 Markdown의 fenced code block에서 언어가 `mermaid`로 명시된 경우에만 인식한다.

- `mermaid` 언어가 지정된 코드 블록: 다이어그램으로 렌더링
- 다른 언어가 지정된 코드 블록: 현재와 같이 일반 코드 블록으로 표시
- 인라인 코드: 현재 표시 방식 유지
- 일반 문장 안의 Mermaid 유사 문구: 자동 변환하지 않음

일반 텍스트까지 Mermaid 문법으로 추정하면 오탐과 렌더링 오류가 발생할 수 있으므로 명시적인 코드 블록만 대상으로 한다.

## 현재 프로젝트 상태

현재 프로젝트에는 Mermaid 패키지가 이미 포함되어 있고, MD 페이지 편집기에는 Mermaid 미리보기와 SVG·PNG 내보내기 관련 기능이 구현되어 있다.

- `package.json`: Mermaid 의존성 포함
- `src/components/chat/md-page/extensions/diagramPreviewExtensions.js`: MD 페이지 편집기의 Mermaid 초기화와 렌더링 처리
- `src/styles/tiptap.css`: Mermaid 미리보기, 작업 버튼, 오류 상태 관련 스타일
- `src/components/ChatArea.jsx`: 일반 게시글·댓글 본문의 ReactMarkdown 렌더링 영역
- `src/components/chat/MDPageViewer.jsx`: MD 페이지 댓글의 ReactMarkdown 렌더링 영역

따라서 새로운 렌더링 엔진을 추가하기보다 기존 MD 페이지 편집기의 Mermaid 처리 원칙과 보안 설정을 공통 기능으로 분리하여 재사용하는 방향이 적합하다.

## 권장 구조

### 1. 공통 Mermaid 렌더러

게시글과 댓글이 함께 사용할 수 있는 공통 Mermaid 렌더러를 구성한다.

공통 렌더러의 책임은 다음과 같다.

- Mermaid 원문 수신
- Mermaid 라이브러리의 단일 초기화
- 각 다이어그램에 충돌하지 않는 고유 ID 부여
- 원문을 SVG 다이어그램으로 변환
- 렌더링 중 상태 표시
- 문법 오류를 해당 블록 안에서만 처리
- 본문 변경 시 해당 다이어그램 다시 렌더링
- 화면에서 제거될 때 생성한 렌더링 결과와 리소스 정리
- 필요 시 원본 보기, 복사, SVG·PNG 다운로드 기능 제공

Mermaid 초기화가 게시글 또는 댓글마다 반복되지 않도록 애플리케이션 범위에서 한 번만 초기화하는 구조가 필요하다.

### 2. 공통 Markdown 본문 렌더러

현재 여러 화면에서 각각 ReactMarkdown을 직접 구성하고 있으므로, 게시글과 댓글이 동일하게 사용하는 공통 Markdown 본문 렌더러를 두는 방안을 권장한다.

공통 Markdown 렌더러는 코드 블록의 언어를 확인한 뒤 다음과 같이 분기한다.

```text
Markdown 본문
→ fenced code block 확인
→ language-mermaid이면 공통 Mermaid 렌더러 사용
→ 그 외 코드 블록은 기존 코드 UI 유지
→ 일반 Markdown 요소는 기존 스타일 유지
```

이 구조를 사용하면 일반 게시글, 일반 댓글, MD 페이지 댓글 등 표시 위치마다 Mermaid 처리 로직을 중복해서 구현하지 않아도 된다. 또한 링크, 표, 목록, 멘션, 글꼴과 같은 기존 Markdown 표시 기능도 공통으로 유지할 수 있다.

### 3. 저장 및 API 정책

DB와 API에는 렌더링된 SVG 또는 HTML을 저장하지 않고 사용자가 입력한 Mermaid 원문을 포함한 Markdown만 저장한다.

이 방식을 적용하면 다음 장점이 있다.

- Mermaid 버전이나 테마를 변경해도 기존 게시물을 다시 저장할 필요가 없음
- 게시글과 댓글 수정 시 원본 문법을 그대로 제공할 수 있음
- 생성된 HTML 또는 SVG 저장에 따른 보안 위험을 줄일 수 있음
- 검색, RAG 학습, 백업 및 복구에서 원본 텍스트를 유지할 수 있음
- 현재 게시글·댓글 DB 스키마와 API 구조를 변경하지 않아도 됨

## 화면 표시 정책

정상적인 Mermaid 블록은 본문 폭 안에서 다이어그램으로 표시하고, 폭이 큰 다이어그램은 본문 레이아웃을 깨뜨리지 않도록 블록 내부에서 가로 스크롤을 제공한다.

권장 UI는 다음과 같다.

- 렌더링 중에는 간단한 로딩 문구 또는 스켈레톤 표시
- 렌더링 성공 시 SVG 다이어그램 표시
- 문법 오류 시 오류 안내와 원본 코드 보기 제공
- 다이어그램이 너무 큰 경우 확대 보기 또는 새 창 보기 제공 검토
- 필요하면 원본 복사, SVG 다운로드, PNG 다운로드 제공
- 모바일에서는 최소 폭을 강제하지 않고 스크롤과 확대 조작을 지원
- 다크 모드가 있다면 Mermaid 테마와 본문 배경의 대비를 함께 조정

다운로드 기능은 필수 범위가 아니며, 1차 적용에서는 다이어그램 표시와 오류 처리만 구현하고 이후 기존 MD 페이지의 내보내기 기능을 재사용하는 단계적 적용도 가능하다.

## 오류 처리 정책

잘못된 Mermaid 문법 하나 때문에 게시글이나 댓글 전체가 표시되지 않는 상황을 방지해야 한다. 오류는 반드시 개별 Mermaid 블록 단위로 격리한다.

오류가 발생하면 다음 정보를 제공한다.

- 다이어그램을 생성할 수 없다는 사용자용 안내
- 원본 코드 보기 또는 복사 기능
- 게시글이나 댓글을 수정할 권한이 있는 사용자에게 수정 경로 제공

운영 환경에서는 Mermaid 내부 스택 트레이스나 시스템 정보를 그대로 노출하지 않는다. 상세 오류는 개발자 로그에 남기고 화면에는 정제된 메시지만 표시한다.

## 보안 정책

게시글과 댓글은 사용자 입력이므로 Mermaid를 제한된 보안 수준으로 실행해야 한다.

- 기존 MD 페이지 기능과 동일하게 Mermaid의 `strict` 보안 수준 유지
- Mermaid가 생성한 결과 이외의 사용자 HTML은 허용하지 않음
- 사용자 입력을 직접 `dangerouslySetInnerHTML`에 전달하지 않음
- JavaScript URL, 임의 이벤트 핸들러 및 외부 리소스 삽입 제한
- 새 창 링크에는 `noopener`와 `noreferrer` 정책 유지
- Mermaid 문법을 서버에서 실행하거나 동적 코드 실행 방식으로 처리하지 않음
- 렌더링 결과를 삽입할 때 현재 콘텐츠 보안 정책과 충돌하지 않는지 확인

SVG를 화면에 삽입하는 구현을 선택할 경우 Mermaid의 보안 설정이 모든 표시 경로에서 동일하게 적용되는지 검증해야 한다.

## 성능 정책

댓글이 많은 게시글에서 여러 다이어그램을 동시에 렌더링하면 첫 표시가 지연될 수 있다. 기존 게시글·댓글 지연 로딩 정책과 함께 다음 기준을 적용한다.

- Mermaid 코드 블록이 있는 경우에만 Mermaid 렌더링 기능 로드
- 댓글은 해당 댓글 목록이 실제로 로드된 이후 렌더링
- 화면에 가까운 다이어그램부터 지연 렌더링하는 방식 검토
- 동일한 원문은 해시를 기준으로 렌더링 결과 재사용
- 원문이 변경된 경우에만 다시 렌더링
- 게시글 또는 댓글 하나에 허용할 Mermaid 블록 수 제한
- Mermaid 블록 하나의 최대 문자 수 제한
- 렌더링 시간 초과 또는 실패 시 원본 코드 블록으로 대체

초기 제한값은 블록당 약 20KB, 게시글 또는 댓글 하나당 최대 10개 수준으로 시작하고 실제 사용량과 성능 측정 결과에 따라 조정하는 방안을 검토한다.

## 적용 대상

1차 적용 대상은 다음과 같다.

1. 일반 게시글 본문
2. 일반 게시글의 댓글
3. MD 페이지의 댓글
4. 게시글 상세 보기와 동일한 본문 렌더러를 사용하는 화면

목록 미리보기나 알림에는 다이어그램을 직접 렌더링하지 않는 것을 권장한다. 미리보기에서는 Mermaid 블록을 짧은 대체 문구로 표시하여 목록 렌더링 부하를 방지한다.

AI 응답, 메일 본문 등 다른 Markdown 화면으로의 확대 적용은 1차 범위의 안정성과 성능을 확인한 뒤 별도 결정한다.

## 단계별 적용 순서

1. 기존 MD 페이지 Mermaid 기능에서 공통으로 사용할 수 있는 초기화·렌더링 책임을 분리한다.
2. 공통 Mermaid 렌더러의 입력, 로딩, 성공, 오류 상태를 정의한다.
3. 공통 Markdown 본문 렌더러에서 `language-mermaid` 코드 블록을 식별하도록 한다.
4. 일반 게시글 본문에 우선 적용한다.
5. 일반 댓글과 MD 페이지 댓글에 같은 렌더러를 적용한다.
6. 모바일, 다크 모드, 긴 다이어그램과 다수 댓글 환경을 점검한다.
7. 보안 및 성능 검증 후 필요하면 원본 복사와 다운로드 기능을 추가한다.

## 검증 항목

### 기능 검증

1. 올바른 Mermaid flowchart가 게시글과 댓글에서 정상적으로 표시된다.
2. sequence diagram, class diagram 등 주요 Mermaid 유형이 정상적으로 표시된다.
3. 일반 코드 블록과 인라인 코드는 기존 방식으로 표시된다.
4. Mermaid 블록 앞뒤의 Markdown 표, 목록, 링크, 멘션이 정상적으로 유지된다.
5. 게시글이나 댓글 수정 후 다이어그램이 새로운 원문으로 갱신된다.
6. 같은 화면의 여러 Mermaid 블록이 ID 충돌 없이 각각 표시된다.
7. 삭제되거나 화면 밖으로 제거된 댓글의 렌더링 리소스가 정리된다.

### 오류 및 보안 검증

1. 잘못된 Mermaid 문법이 해당 블록에만 오류로 표시된다.
2. 오류가 발생해도 나머지 게시글과 댓글은 정상적으로 표시된다.
3. HTML, 스크립트, 이벤트 핸들러 및 위험한 링크 삽입 시도가 실행되지 않는다.
4. 매우 긴 입력과 반복적인 렌더링 요청이 화면 전체를 멈추게 하지 않는다.
5. 운영 화면에 내부 스택 트레이스나 민감한 정보가 노출되지 않는다.

### 성능 검증

1. Mermaid가 없는 게시글과 댓글의 초기 표시 성능이 기존보다 유의미하게 저하되지 않는다.
2. 댓글 지연 로딩 시 아직 조회하지 않은 댓글의 Mermaid를 미리 렌더링하지 않는다.
3. 여러 다이어그램이 있는 게시글에서도 스크롤과 입력 반응성이 유지된다.
4. 모바일과 저사양 장치에서 대형 다이어그램의 렌더링 시간과 메모리 사용량을 확인한다.

## 완료 기준

1. 명시적인 Mermaid 코드 블록만 다이어그램으로 표시된다.
2. 게시글과 댓글이 동일한 렌더링 규칙과 보안 설정을 사용한다.
3. 원본 Markdown은 변경 없이 DB에 저장된다.
4. 잘못된 Mermaid 블록이 다른 본문 렌더링에 영향을 주지 않는다.
5. Mermaid가 없는 콘텐츠의 표시 속도에 유의미한 회귀가 없다.
6. 모바일 화면에서 다이어그램이 본문 영역을 깨뜨리지 않는다.
7. 기존 MD 페이지 Mermaid 미리보기와 일반 게시글·댓글의 결과가 가능한 범위에서 일관된다.

## 구현 반영 상태 (2026-08-01)

- `src/components/markdown/MermaidBlock.jsx`: 공통 Mermaid 읽기 화면 렌더러 추가
  - `strict` 보안 수준과 HTML 라벨 비활성화 적용
  - 화면 진입 전 지연 렌더링, 소스 기준 최대 20KB 제한, 최근 100개 결과 캐시 적용
  - 블록 단위 로딩·오류 처리와 원본 보기·복사 기능 제공
- `src/components/markdown/MarkdownPreBlock.jsx`: Markdown fenced code block을 공통으로 분기하는 렌더러 추가
- `src/components/markdown/markdownCode.js`: `language-mermaid` 판별과 코드 원문 추출 유틸리티 추가
- `src/components/ChatArea.jsx`: 일반 게시글과 일반 댓글의 Mermaid 코드 블록 렌더링 적용
- `src/components/chat/MDPageViewer.jsx`: MD 페이지 댓글의 Mermaid 코드 블록 렌더링 적용
- `src/index.css`: 넓은 SVG의 본문 영역 보호와 가로 스크롤을 위한 공통 스타일 추가
- DB 스키마와 게시글·댓글 API는 변경하지 않고 원본 Markdown 저장 방식을 유지

검증 결과 신규 Mermaid 관련 파일의 ESLint 검사, 코드 블록 언어 판별 확인, 프로덕션 빌드가 통과했다. 전체 저장소 ESLint는 가상환경과 업로드 데이터 및 기존 소스에 누적된 오류로 통과하지 않으므로 이번 변경 파일을 별도로 검사했다.

### Gemma Mermaid 생성 안전장치 (2026-08-01)

- AgenticAI 시스템 프롬프트에 안전한 Mermaid 생성 규칙을 강제했다.
  - 모든 노드 라벨 인용
  - 연결선 라벨의 파이프 문법 사용
  - 영문 subgraph ID 사용
  - LaTeX, HTML, 줄 끝 세미콜론 및 불안정한 연결선 문법 금지
  - 노드·연결선 중복 선언 금지와 괄호 자체 검사 지시
- `src/lib/mermaidSafety.js`에 모델 출력 후처리 안전장치를 추가했다.
  - 완전히 닫힌 `mermaid` fenced code block만 정규화
  - 인용되지 않은 사각형·마름모 노드 라벨을 자동 인용
  - 따옴표형 연결선 라벨을 파이프 문법으로 변환
  - 제목만 지정한 subgraph에 안전한 영문 ID 부여
  - 줄 끝 세미콜론 제거
- 같은 정규화를 게시글·댓글 Mermaid 렌더링 직전에도 적용하여 기존에 저장된 잘못된 코드도 가능한 범위에서 복구한다.
- 일반 본문과 JavaScript 등 다른 언어의 코드 블록은 변경하지 않는다.
- Mermaid 안전장치 단위 테스트 4건과 프로덕션 빌드가 통과했다.
