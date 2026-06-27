# CLAUDE.md — EasyDocStation 작업 규칙

이 파일은 매 세션 시작 시 자동으로 로드됩니다. 아래 규칙을 항상 지켜 일관성을 유지하세요.

## 공통 규칙
- **모든 답변과 설명은 한글로 작성한다.** (코드/식별자/로그 메시지는 예외)
- 설계 결정은 임의로 바꾸지 않는다. 변경이 필요하면 먼저 근거를 설명하고 확인을 받는다.

## 메일 서비스(MailService) 아키텍처 — 반드시 준수
상세 설계와 모듈 구조는 [docs/MailServiceArchitecture.md](docs/MailServiceArchitecture.md) 를 먼저 읽고 따른다.

핵심 5원칙(절대 위반 금지):
1. 모든 메일 테이블에는 `tenant_id`를 둔다.
2. 메일 DB 접근은 반드시 `server/mail/repository.js`(mailRepository)를 통한다.
3. SQL을 라우트(`server/routes/*`)나 UI에 흩뿌리지 않는다.
4. 스토리지 `object_key`는 `tenants/{tenant_id}/users/{user_id}/mail/{account_id}/...` 형태로 저장한다.
5. tenant 라우팅 정보는 `mail_tenants` 테이블(`storage_mode`, `db_connection_key`)에 두고, 런타임 라우팅은 `server/mail/connectionManager.js`가 담당한다.

초기 모드는 `shared_db`(공용 DB + tenant_id 분리)이며, 특정 tenant만 `dedicated_db`로 전환 가능하도록 설계되어 있다. 새 기능을 추가할 때 위 구조를 깨지 않는다.
