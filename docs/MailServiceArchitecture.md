# MailService 아키텍처 (멀티테넌트 / 하이브리드 DB)

이 문서는 메일 서비스의 데이터·저장 구조에 대한 **확정 설계**다. 새 기능을 추가하거나
리팩터링할 때 이 구조를 깨지 않는다. (요약 규칙은 루트 `CLAUDE.md` 참고)

## 1. 큰 그림 — 하이브리드 구조

초기에는 공용 DB 하나에 `tenant_id`로 데이터를 분리한다. 나중에 대형 고객 등 특정
tenant만 전용 DB(`dedicated_db`)로 분리할 수 있도록 설계되어 있다.

```
공용(메인) DB = control plane
- mail_tenants            (tenant 정의 + 라우팅 정보)
- mail_tenant_members     (tenant 멤버/권한)
- mail_service_settings   (Google OAuth 앱 설정 등)
- mail_db_connections     (dedicated_db 연결 문자열, 암호화 저장)
- mail_oauth_states       (OAuth state, 임시)

tenant 데이터 = data plane
- mail_accounts
- mail_folders
- mail_messages
- mail_attachments
- mail_sync_state
- mail_usage
  → shared_db tenant: 공용 DB에 함께 저장 (tenant_id로 분리)
  → dedicated_db tenant: 전용 DB에 저장
```

## 2. 5가지 설계 원칙 (위반 금지)

1. **모든 메일 테이블에 `tenant_id`를 둔다.**
2. **메일 DB 접근은 `server/mail/repository.js`(mailRepository)를 통해서만 한다.**
3. **SQL을 라우트/UI에 흩뿌리지 않는다.** 라우트는 HTTP·권한·검증만 담당한다.
4. **`object_key`는 `tenants/{tenant_id}/users/{user_id}/mail/{account_id}/...` 형태로 저장한다.**
5. **tenant 라우팅 정보는 별도(`mail_tenants`)에 두고**, 런타임 라우팅은
   `server/mail/connectionManager.js`가 담당한다.

## 3. 모듈 구조

| 파일 | 책임 |
|---|---|
| `server/mail/schema.js` | 스키마 정의. `ensureMailControlSchema` / `ensureMailDataSchema(client, {standalone})` / `backfillMailTenants` / `ensureMailSchema`(메인 DB 전체). `standalone:true`는 dedicated 전용 DB용으로 cross-plane FK(users/mail_tenants)를 제거한다. |
| `server/mail/connectionManager.js` | tenant 라우팅 런타임. `getTenantPool(tenantId)` / `resolveTenant(tenantId)`로 shared_db는 공용 풀, dedicated_db는 `db_connection_key`로 전용 Pool을 생성·캐시(+최초 1회 data 스키마 부트스트랩). |
| `server/mail/repository.js` | **모든 메일 SQL의 단일 진입점.** control/data plane 라우팅을 내부에서 처리. |
| `server/mail/gmailOAuth.js` | Google OAuth + Gmail API 호출 (네트워크 only). |
| `server/mail/gmailSync.js` | Gmail 동기화 오케스트레이션 (네트워크 + 파싱 + 스토리지 + repo). |
| `server/mail/messageParser.js` | Gmail 메시지 payload → 정규화 필드/본문/첨부 파싱 (순수 함수). |
| `server/mail/storage/` | object 저장소(local fs, S3 확장 가능). `buildMailObjectKey`로 키 생성. |
| `server/mail/settings.js` | Google OAuth 앱 설정(공용 DB) 읽기/쓰기. |
| `server/routes/mail.js` | HTTP 라우트(얇게). DB 접근은 전부 repository 위임. |

## 4. object_key 규칙

기준 prefix는 `mail_tenants.storage_prefix`(= `tenants/{tenant_id}`)이며 그 아래에 저장한다.

```
tenants/{tenant_id}/users/{user_id}/mail/{account_id}/messages/{provider_message_id}/raw.json
tenants/{tenant_id}/users/{user_id}/mail/{account_id}/messages/{provider_message_id}/body.txt
tenants/{tenant_id}/users/{user_id}/mail/{account_id}/messages/{provider_message_id}/body.html
tenants/{tenant_id}/users/{user_id}/mail/{account_id}/messages/{provider_message_id}/attachments/{idx}-{filename}
```

- object_key 경로의 메시지 식별자는 DB 내부 uuid가 아니라 **provider_message_id**(Gmail 메시지 id)를 쓴다. (DB insert 이전에 키를 만들 수 있고, 재동기화 시 안정적)
- 본문/첨부 원본은 object 저장소에, 메타데이터·`object_key`만 DB에 기록한다.

## 5. dedicated_db로 전환하는 방법 (미래)

1. 사이트 관리자가 전용 DB 연결을 등록: `POST /api/mail/db-connections`
2. tenant를 전용 모드로 전환: `PUT /api/mail/tenants/:id/storage-mode { storage_mode: 'dedicated_db', db_connection_key }`
3. 이후 해당 tenant의 data plane 접근은 `connectionManager`가 자동으로 전용 Pool로 라우팅한다. 라우트/리포지토리 코드 변경 불필요.

주의: dedicated tenant의 **전 tenant 통합 조회**는 공용 DB tenant만 집계한다. dedicated tenant는 `tenantId`를 명시해 조회해야 한다.

## 6. 동기화 동작 요약

- 수동 동기화: `POST /api/mail/accounts/:id/sync?tenantId=...&limit=N`
- 흐름: access token 유효성 확인(만료 시 refresh token으로 갱신) → Gmail 메시지 목록 조회 → 신규 메시지만 상세 조회/파싱 → 본문·첨부 object 저장 → `mail_messages`/`mail_attachments` 적재 → `mail_sync_state`·`mail_usage` 갱신.
- 모든 DB 쓰기는 repository를 통하고, tenant 라우팅이 자동 적용된다.
