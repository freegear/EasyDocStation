# ContactBook

## 1. 목적

EasyStation에 CardDAV 기반 통합 주소록(ContactBook)을 구성한다. 주소록은 단순한 공용 연락처 목록이 아니라 **로그인 사용자마다 독립적으로 소유하고 관리하는 개인 데이터**로 취급한다.

한 사용자는 Apple iCloud, Google Contacts, Nextcloud, Fastmail, 사내 CardDAV 등 여러 계정을 연결할 수 있고, 한 계정 안의 여러 주소록(collection)도 가져올 수 있다. 다른 사용자가 같은 외부 CardDAV 계정을 연결하더라도 EasyStation 내부 데이터, 동기화 상태, 인증 정보는 서로 공유하지 않는다.

1차 목표는 다음과 같다.

- 사용자별 CardDAV 계정 연결 및 해제
- 서버가 제공하는 주소록 자동 발견
- 연락처의 최초 전체 동기화와 이후 증분 동기화
- 통합 연락처 목록, 상세 보기, 검색
- 외부 원본과 EasyStation 내부 연락처의 출처 추적
- 향후 메일, 문서, 게시판, 일정, 프로젝트와 사람 중심으로 연결할 수 있는 기반 마련

## 2. 기본 원칙

### 2.1 사용자별 완전 분리

모든 ContactBook 데이터는 `tenant_id`와 `user_id`를 기준으로 분리한다.

```text
Tenant
  └─ User A
      ├─ CardDAV Account 1
      │   ├─ Address Book A
      │   └─ Address Book B
      └─ CardDAV Account 2
          └─ Address Book C

  └─ User B
      └─ CardDAV Account 3
          └─ Address Book D
```

- 계정, 주소록, 연락처, 동기화 상태, 오류 기록에는 모두 `tenant_id`, `user_id`를 둔다.
- API 요청의 `user_id`를 클라이언트 입력에서 신뢰하지 않고 로그인 세션에서 결정한다.
- 모든 조회와 변경은 `tenant_id + user_id` 조건을 필수로 사용한다.
- 외부 계정의 비밀번호나 토큰은 사용자 간 재사용하지 않는다.
- 관리자도 별도의 감사 가능한 권한 없이 사용자의 연락처 원문과 인증 정보를 열람하지 못하게 한다.

### 2.2 원본 보존과 통합 표시 분리

외부 CardDAV 연락처는 원본 vCard와 정규화된 검색용 필드를 구분해 관리한다.

- 원본 계층: 외부 서버의 vCard 의미, UID, resource URL, ETag를 보존한다.
- 표시 계층: 이름, 이메일, 전화번호, 회사 등 자주 사용하는 값을 정규화한다.
- 통합 계층: 동일인으로 추정되는 여러 출처의 연락처를 하나의 사람 카드로 묶을 수 있다.

동일인 자동 병합은 데이터 손실 위험이 있으므로 1차에서는 원본 연락처를 실제로 합치지 않는다. 이메일과 정규화된 전화번호 등을 이용해 `같은 사람 후보`로 표시하고, 사용자가 병합을 확정하거나 연결만 유지하도록 한다.

### 2.3 서버 기능 차이 수용

CardDAV 서버마다 지원 범위와 vCard 버전이 다를 수 있다. 연결 시 서버 capability를 확인하고 지원되는 기능만 사용한다.

- URI를 고정값으로 저장해 가정하지 않고 CardDAV discovery 결과를 사용한다.
- `sync-collection`을 지원하면 sync token 기반 증분 동기화를 사용한다.
- 지원하지 않으면 collection CTag 또는 개별 ETag 비교 방식으로 대체한다.
- vCard 3.0과 4.0을 모두 읽을 수 있게 설계하며, 서버에 쓸 때는 서버 capability에 맞춘다.
- 서버가 읽기 전용이거나 일부 메서드를 지원하지 않으면 UI에서 편집 기능을 비활성화한다.

## 3. 지원 범위

### 3.1 1차 지원

- Apple iCloud CardDAV
- Google CardDAV
- 표준 CardDAV 서버의 사용자 지정 연결
- 연락처 읽기 및 로컬 검색
- 수동 동기화와 주기적 자동 동기화
- 계정별/주소록별 표시와 통합 보기

Google CardDAV는 HTTPS와 OAuth 2.0을 사용하며, 사용자 비밀번호를 이용한 Basic 인증을 사용하지 않는다. Apple iCloud는 지원되는 계정 승인 방식 또는 앱 전용 암호를 사용하고, 앱 전용 암호 사용 시 Apple 계정의 2단계 인증이 필요하다.

### 3.2 후속 지원

- 연락처 생성, 수정, 삭제의 양방향 동기화
- 사용자 확인 기반 연락처 병합 및 분리
- 연락처 그룹과 라벨 편집
- 공유 주소록과 조직 주소록 정책
- LDAP/Active Directory, Microsoft 365 등 CardDAV 이외 공급자 adapter
- Human Knowledge Graph 및 Agentic AI 연결

Microsoft 365나 LDAP를 CardDAV 서버라고 가정하지 않는다. 해당 공급자는 지원 API 또는 전용 connector를 별도 adapter로 연결하고, 내부의 공통 People 모델에 합류시킨다.

## 4. 사용자 화면

### 4.1 ContactBook 메인 화면

왼쪽 메뉴는 다음과 같이 구성한다.

- 모든 연락처
- 즐겨찾기
- 같은 사람 후보
- 계정별 주소록
  - iCloud 계정
    - Contacts
    - 업무 주소록
  - Google 계정
    - 기본 주소록
- 동기화 오류
- 주소록 계정 관리
- 메인 메뉴로 이동

연락처 목록에는 표시 이름, 대표 이메일, 대표 전화번호, 회사, 직책, 출처 아이콘을 표시한다. 검색은 이름, 이름의 구성 요소, 이메일, 전화번호, 회사, 부서, 직책을 대상으로 하며 현재 로그인 사용자의 데이터에서만 수행한다.

### 4.2 연락처 상세 화면

상세 화면에는 다음 정보를 표시한다.

- 사진
- 이름, 별칭, 발음 또는 정렬용 이름
- 여러 이메일과 유형
- 여러 전화번호와 유형
- 회사, 부서, 직책
- 주소
- 생일과 기념일
- URL, 메모
- 연락처 그룹
- 연결 계정과 주소록
- 마지막 동기화 시각과 동기화 상태

원본에 없는 필드를 빈 문자열로 만들거나 서버에 덮어쓰지 않는다. 여러 값과 사용자 지정 유형을 지원하고, 알 수 없는 vCard 속성도 원본 보존 영역에서 유실되지 않게 한다.

### 4.3 계정 관리

계정 관리 화면에서는 다음 기능을 제공한다.

- `Apple iCloud 연결`
- `Google Contacts 연결`
- `기타 CardDAV 연결`
- 연결 테스트
- 발견된 주소록 선택
- 자동 동기화 켜기/끄기와 주기 설정
- 지금 동기화
- 인증 갱신
- 계정 연결 해제

상태는 `연결됨`, `동기화 중`, `인증 필요`, `일시 오류`, `동기화 실패`, `연결 해제됨`으로 구분한다. 비밀번호나 access/refresh token은 화면과 일반 log에 다시 표시하지 않는다.

## 5. CardDAV 연결 및 Discovery

### 5.1 연결 정보

사용자가 공급자를 선택하면 다음 인증 방식을 적용한다.

| 공급자 | 인증 | 시작 위치 |
|---|---|---|
| Google | OAuth 2.0 | 공식 well-known CardDAV discovery URL |
| Apple iCloud | 지원되는 계정 승인 또는 앱 전용 암호 | CardDAV discovery로 실제 resource 확인 |
| 기타 CardDAV | 서버 정책에 따른 OAuth 또는 사용자명/앱 암호 | 사용자가 입력한 HTTPS base URL 또는 도메인의 well-known URL |

`contacts.icloud.com`과 같은 알려진 host는 초기 안내에만 사용할 수 있다. principal URL, addressbook home set, collection URL은 discovery 응답으로 결정하며 코드에 영구 고정하지 않는다.

### 5.2 Discovery 흐름

```text
계정 인증
  ↓
/.well-known/carddav 확인
  ↓
current-user-principal 확인
  ↓
addressbook-home-set 확인
  ↓
주소록 collection 목록과 capability 확인
  ↓
사용자가 동기화할 주소록 선택
```

redirect는 제한된 횟수만 따라가며 매 단계에서 HTTPS, 허용 host, DNS/IP를 다시 검증한다. 사용자 지정 URL 기능이 내부망 접근 통로가 되지 않도록 loopback, link-local, private network, cloud metadata 주소를 기본 차단하고 운영 정책에서 명시적으로 허용한 서버만 예외 처리한다.

## 6. 데이터 모델

실제 table 명은 기존 DB naming convention에 맞추되 다음 논리 구조를 사용한다.

### 6.1 `contact_accounts`

CardDAV 외부 계정과 인증 상태를 관리한다.

```text
id
tenant_id
user_id
provider                 APPLE | GOOGLE | GENERIC_CARDDAV
display_name
account_identifier       사용자에게 표시할 이메일 또는 계정명
discovery_url
principal_url
addressbook_home_url
auth_type                OAUTH2 | APP_PASSWORD | BASIC
credential_secret_ref    암호화 저장소의 secret 참조값
status
auto_sync_enabled
sync_interval_minutes
last_sync_at
last_success_at
last_error_code
last_error_message_safe
created_at
updated_at
```

비밀번호와 OAuth token 원문을 table에 직접 저장하지 않고 application encryption 또는 secret store로 보호한다. 암호화 key와 암호문을 같은 저장 위치에서 관리하지 않는다.

### 6.2 `contact_addressbooks`

외부 계정에서 발견된 주소록 collection을 관리한다.

```text
id
tenant_id
user_id
account_id
remote_url
remote_display_name
description
color
read_only
selected_for_sync
supported_vcard_versions
supports_sync_collection
sync_token
ctag
last_full_sync_at
last_incremental_sync_at
created_at
updated_at
```

`sync_token`, `ctag`는 주소록 collection마다 별도로 저장한다. 계정 단위 token 하나를 모든 주소록에 공용으로 사용하지 않는다.

### 6.3 `contact_resources`

CardDAV의 개별 address object resource와 동기화 메타데이터를 관리한다.

```text
id
tenant_id
user_id
account_id
addressbook_id
remote_href
remote_uid
etag
vcard_version
raw_vcard_encrypted
content_hash
deleted_at
last_seen_at
created_at
updated_at
```

외부 resource 식별은 로컬 `id`가 아니라 `account_id + addressbook_id + remote_href`를 기준으로 한다. vCard의 `UID`가 없거나 중복되는 비정상 서버도 고려하여 `remote_href`를 함께 보존한다.

### 6.4 `contacts`

목록, 검색, People Hub 연결을 위한 정규화된 연락처를 관리한다.

```text
id
tenant_id
user_id
contact_resource_id
display_name
given_name
family_name
middle_name
prefix
suffix
nickname
organization
department
job_title
birthday
photo_object_key
note
search_text
created_at
updated_at
```

이메일, 전화번호, 주소, URL, 날짜, 그룹처럼 여러 값을 가질 수 있는 항목은 별도 child table로 관리한다. 각 값에는 유형, 원본 label, 선호 여부, 정렬 순서를 함께 둔다. 전화번호는 원본 표시값과 국제 형식으로 정규화한 비교값을 모두 보존한다.

### 6.5 통합 사람 엔티티

향후 `people`과 `person_contact_links`를 두어 한 사람과 여러 연락처 resource를 연결한다.

```text
Person
  ├─ iCloud 연락처
  ├─ Google 연락처
  ├─ 메일 참여자
  └─ 조직 사용자
```

`contacts`는 외부 원본의 projection이고 `people`은 EasyStation 내부의 사람 개념이다. 두 개를 같은 table로 합치지 않아야 외부 동기화와 AI 연결이 서로의 데이터를 손상시키지 않는다.

## 7. 동기화 설계

### 7.1 최초 동기화

1. 인증하고 discovery를 수행한다.
2. addressbook home에서 collection 목록과 capability를 가져온다.
3. 선택된 collection의 resource href와 ETag를 조회한다.
4. `addressbook-multiget`을 지원하면 resource를 묶어서 가져오고, 그렇지 않으면 제한된 동시성으로 개별 조회한다.
5. vCard를 파싱하고 원본과 정규화 데이터를 하나의 transaction 단위로 저장한다.
6. 전체 목록 처리가 성공한 뒤 sync token 또는 CTag를 확정 저장한다.

중간에 실패한 token을 성공한 상태처럼 저장하지 않는다. pagination 또는 batch 처리 진행 상태를 별도로 기록하여 재시도할 수 있게 한다.

### 7.2 증분 동기화

우선순위는 다음과 같다.

1. RFC 6578 `sync-collection`과 sync token
2. collection CTag 변경 확인 후 href/ETag 비교
3. capability가 부족한 서버에 한해 전체 목록 비교

증분 응답에서 생성/변경된 resource는 다시 가져오고, 삭제된 href는 로컬에서 soft delete한다. 서버가 token을 만료시키거나 거부하면 해당 collection만 전체 재동기화하고 다른 사용자나 다른 collection의 상태에는 영향을 주지 않는다.

### 7.3 동시 실행 제어

- 동일한 `tenant_id + user_id + account_id + addressbook_id`에는 한 번에 하나의 sync job만 실행한다.
- 수동 동기화와 scheduler 작업이 겹치면 기존 작업에 합류하거나 후속 작업 하나만 예약한다.
- 계정별 rate limit과 timeout을 적용한다.
- 재시도는 지수 backoff와 무작위 지연을 사용하고 인증 오류는 자동 반복하지 않는다.
- 한 사용자의 대량 주소록이 다른 사용자의 작업을 막지 않게 사용자별 concurrency와 queue 공정성을 둔다.

### 7.4 양방향 동기화 시 충돌 정책

1차 읽기 중심 단계 이후 쓰기를 허용할 때 다음 정책을 적용한다.

- 수정에는 마지막으로 확인한 ETag와 `If-Match`를 사용한다.
- ETag 불일치로 `412 Precondition Failed`가 발생하면 서버 원본을 다시 받아 충돌 상태로 표시한다.
- 서로 다른 필드의 변경은 안전한 경우에만 병합하고, 같은 필드 변경은 사용자가 선택한다.
- 삭제에는 tombstone과 보존 기간을 두어 오동작으로 인한 대량 삭제를 복구할 수 있게 한다.
- 한 번의 sync에서 삭제 비율이 임계값을 넘으면 자동 반영을 중지하고 사용자 확인 또는 관리자 정책을 요구한다.

## 8. API 경계

API는 다음 책임 단위로 구성한다. 아래 경로는 개념 예시이며 구현 시 기존 route 규칙에 맞춘다.

- ContactBook 계정 목록, 연결 시작, 인증 callback, 연결 해제
- discovery 및 연결 테스트
- 주소록 collection 목록과 선택 변경
- 수동 동기화 요청과 상태 조회
- 연락처 목록, 검색, 상세 조회
- 같은 사람 후보 확인, 연결, 연결 해제
- 후속 단계의 연락처 생성, 수정, 삭제

인증 callback의 `state`는 로그인 사용자와 연결 시도를 묶는 일회용 값으로 검증한다. API 응답에는 access token, refresh token, 앱 전용 암호, 내부 secret 참조값, raw remote credential을 포함하지 않는다.

## 9. 보안과 개인정보 보호

- CardDAV 통신은 HTTPS만 허용하고 인증서 검증을 끄지 않는다.
- OAuth scope는 연락처에 필요한 최소 범위를 사용한다.
- 앱 전용 암호와 token은 암호화하고 log, 오류 메시지, telemetry에서 제거한다.
- vCard와 사진은 신뢰할 수 없는 외부 입력으로 취급한다.
- vCard 크기, 속성 수, 한 속성의 길이, 사진 크기, redirect 수, XML 응답 크기에 상한을 둔다.
- XML parser의 외부 entity와 DTD 처리를 비활성화하여 XXE를 차단한다.
- vCard의 note, URL, 이름은 HTML로 직접 렌더링하지 않고 escape한다.
- 외부 사진 URL을 브라우저가 직접 읽게 하지 않으며, 허용 정책과 크기 검사를 거쳐 object storage에 보관한다.
- 연락처 조회, export, 계정 연결/해제, 대량 삭제는 감사 log 대상에 포함한다.
- 계정 연결 해제 시 인증 secret은 즉시 폐기하고 로컬 연락처의 유지 또는 삭제는 사용자에게 명확히 선택시킨다.
- 사용자 탈퇴 및 tenant 삭제 시 ContactBook 데이터와 파생 검색 index, 사진, AI embedding을 함께 삭제한다.

연락처는 민감한 개인정보이므로 Agentic AI에는 사용자가 접근할 수 있는 필드만 전달한다. AI index를 만들 경우에도 `tenant_id + user_id` 경계를 유지하고, 외부 model 전송 여부와 보존 정책을 별도로 고지한다.

## 10. 오류 처리

사용자에게는 복구 행동을 알 수 있는 메시지를 제공하고, 내부 오류 원문이나 secret은 노출하지 않는다.

| 상황 | 사용자 안내 및 처리 |
|---|---|
| 인증 만료 또는 철회 | `인증 필요`로 전환하고 재연결 안내 |
| 앱 전용 암호 무효 | 암호 재발급 안내, 자동 재시도 중단 |
| 접근 권한 없음 | 해당 주소록을 읽기 전용 또는 사용 불가로 표시 |
| rate limit | 서버가 지정한 시간 이후 자동 재시도 |
| 일시적 network/5xx | backoff 후 제한적으로 재시도 |
| sync token 무효 | 해당 collection만 전체 재동기화 |
| vCard 일부 손상 | 해당 resource를 격리하고 나머지는 계속 처리 |
| 대량 삭제 감지 | 동기화를 멈추고 확인 필요 상태로 전환 |

계정 화면에는 마지막 성공 시각, 최근 오류의 안전한 요약, 재시도 가능 여부를 표시한다. 운영 log에는 correlation ID, tenant/user/account/addressbook 식별자, 단계, HTTP status를 남기되 연락처 본문과 인증 header는 기록하지 않는다.

## 11. 성능과 운영

- 연락처 목록은 pagination 또는 cursor 방식으로 조회한다.
- 검색용 정규화 필드와 이메일/전화번호 비교값에 사용자 경계를 포함한 index를 둔다.
- sync는 background job으로 실행하고 HTTP 요청에서 전체 주소록 동기화를 기다리지 않는다.
- 대용량 multistatus XML과 vCard는 가능한 경우 streaming 또는 batch로 처리한다.
- 연락처 사진은 별도 object storage에 저장하고 크기 제한 thumbnail을 사용한다.
- metrics는 성공/실패 횟수, 동기화 시간, 변경 resource 수, rate limit, token 초기화, queue 지연을 계정 정보가 노출되지 않는 형태로 수집한다.
- 백업과 복구에서도 tenant/user 경계를 유지하고 암호화 credential의 별도 복구 정책을 둔다.

## 12. 테스트 기준

### 12.1 사용자 격리

- 사용자 A와 B가 같은 CardDAV 계정을 연결해도 서로의 연락처와 상태를 볼 수 없는지 확인한다.
- URL의 account/contact ID를 바꿔 다른 사용자의 데이터에 접근할 수 없는지 확인한다.
- 검색, export, 사진, sync 상태 API에도 동일한 권한 검사가 적용되는지 확인한다.

### 12.2 공급자 및 프로토콜

- Google OAuth 연결, discovery, vCard 3.0, sync token 동작을 확인한다.
- Apple 연결, 앱 전용 암호 철회, discovery URL 변경 상황을 확인한다.
- vCard 3.0/4.0, 여러 이메일/전화번호, 한글/emoji, folded line, escaped 문자, embedded photo를 확인한다.
- sync token 지원/미지원 서버와 token 만료를 각각 확인한다.
- 생성, 변경, 삭제, ETag 충돌, 중복 UID를 확인한다.

### 12.3 보안 및 장애

- 사용자 지정 URL의 SSRF, redirect 우회, DNS rebinding 방어를 확인한다.
- XXE, 과대 XML/vCard, 과대 사진, 악성 URL, HTML 문자열을 확인한다.
- timeout, 401/403/404/412/429/5xx와 부분 실패 후 재시도를 확인한다.
- 중복 job이 동일 연락처를 이중 생성하지 않는지 확인한다.
- 대량 삭제 보호와 계정 연결 해제 후 secret 폐기를 확인한다.

## 13. 단계별 구현 권장안

### 1단계: 사용자별 기반

- 사용자별 계정, 주소록, resource, 연락처 schema
- credential 암호화와 접근 경계
- CardDAV discovery와 capability 확인
- Apple, Google, Generic CardDAV 연결
- 읽기 전용 최초/증분 동기화
- 목록, 상세, 검색, 계정별 필터

### 2단계: 안정성 및 운영

- background scheduler와 queue
- sync token fallback, 재시도, token 초기화
- 상태/오류 UI와 감사 log
- 대용량 주소록 성능 개선
- 같은 사람 후보 탐지

### 3단계: 양방향 동기화

- 생성, 수정, 삭제
- ETag 기반 충돌 처리
- 삭제 보호와 복구
- 그룹/라벨 지원

### 4단계: People Hub

- 사용자 확인 기반 사람 엔티티 연결
- 메일 참여자, 문서 작성자, 회의 참석자, 프로젝트 구성원 연결
- 사람 중심 활동 timeline
- 권한과 출처를 보존하는 Agentic AI 검색

## 14. 완료 조건

- 로그인 사용자마다 독립적인 ContactBook이 생성된다.
- 한 사용자가 여러 CardDAV 계정과 여러 주소록을 연결할 수 있다.
- discovery 결과를 사용하며 공급자 URL을 내부 구조로 고정하지 않는다.
- 최초 동기화 후 sync token 또는 ETag/CTag fallback으로 변경분을 반영한다.
- 생성, 변경, 삭제가 중복 없이 로컬에 반영되고 부분 실패를 재시도할 수 있다.
- 모든 계층에서 tenant/user 권한 검사가 적용된다.
- 인증 정보와 연락처 개인정보가 log나 API 응답에 노출되지 않는다.
- 계정 연결 해제, 사용자 탈퇴, 데이터 삭제 정책이 화면과 서버 동작에서 일치한다.
- 후속 People Hub가 외부 연락처 원본을 손상시키지 않고 사람 엔티티를 연결할 수 있다.

## 15. 참고 표준 및 공식 문서

- [RFC 6352: CardDAV](https://www.rfc-editor.org/rfc/rfc6352)
- [RFC 6578: WebDAV Collection Synchronization](https://www.rfc-editor.org/rfc/rfc6578)
- [RFC 6764: CardDAV/CalDAV Service Discovery](https://www.rfc-editor.org/rfc/rfc6764)
- [RFC 6350: vCard 4.0](https://www.rfc-editor.org/rfc/rfc6350)
- [Google: CardDAV로 연락처 관리](https://developers.google.com/people/carddav)
- [Apple: 앱 전용 암호로 Apple Account에 로그인](https://support.apple.com/102654)

공급자별 인증 방식과 지원 capability는 변경될 수 있으므로 구현 시점에 공식 문서를 다시 확인한다.
