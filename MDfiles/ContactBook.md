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

#### 연락처 삭제 버튼

연락처 상세 화면 상단의 `편집` 버튼 오른쪽에 `삭제` 버튼을 배치한다. `삭제`는 파괴적 동작임을 알 수 있도록 편집 버튼과 구분되는 빨간색 계열로 표시한다.

```text
[편집] [삭제]
```

- 현재 사용자가 소유하고 쓰기 가능한 iCloud 또는 Google 연락처에서만 삭제 버튼을 활성화한다.
- 읽기 전용 주소록, 인증이 만료된 계정 또는 이미 삭제 대기 중인 연락처에서는 버튼을 비활성화하고 이유를 표시한다.
- 사용자가 삭제 버튼을 누르면 연락처 이름, 공급자와 주소록을 포함한 확인 창을 표시한다.
- 확인 문구는 `이 연락처를 Google/iCloud 주소록에서도 삭제합니다. 계속할까요?`처럼 외부 원본도 삭제된다는 사실을 명확히 알린다.
- 사용자가 확인하면 해당 연락처를 즉시 기본 목록과 상세 화면에서 숨기고 `삭제 대기` 상태로 전환한다.
- 사용자가 취소하면 어떤 로컬·외부 데이터도 변경하지 않는다.
- 삭제 요청을 반복해서 눌러도 동일 resource에 DELETE 작업이 중복 생성되지 않게 한다.

삭제 대상은 현재 상세 화면에서 선택한 외부 연락처 resource 한 건이다. 같은 전화번호 또는 이메일 주소로 연결된 다른 iCloud·Google 연락처까지 함께 삭제하지 않는다. 예를 들어 Google 연락처에서 삭제를 실행하면 연결된 iCloud 연락처는 유지한다.

연결된 다른 연락처가 남아 있으면 통합 `Person`과 공유 사진도 유지한다. 마지막 외부 연락처를 삭제한 경우에도 사진을 즉시 제거하지 않고 복구 가능 기간 동안 `Person`, 사진, raw vCard와 tombstone을 보존한다. 보존 기간 이후의 자동 삭제 또는 로컬 사람 카드 유지 여부는 개인정보 보존 정책에 따른다.

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

### 5.3 Google OAuth 운영 연결

Google Contacts는 사용자가 access token을 직접 복사하여 입력하는 방식으로 연결하지 않는다. ContactBook 화면의 Google 공급자는 `OAuth access token` 입력란을 제거하고 `Google 계정으로 연결` 버튼만 제공한다.

```text
사용자가 Google 계정으로 연결 선택
  ↓
서버가 사용자·tenant·연결 시도를 묶은 일회용 state 생성
  ↓
Google 로그인 및 연락처 권한 동의 화면으로 redirect 또는 popup
  ↓
Google이 등록된 HTTPS callback으로 authorization code 반환
  ↓
서버가 state, 만료 시각, 미사용 여부를 검증하고 code를 token endpoint에서 교환
  ↓
Google 사용자 식별 정보 확인 후 access token과 refresh token 암호화 저장
  ↓
CardDAV discovery 및 최초 동기화
  ↓
access token 만료 전에 refresh token으로 자동 갱신
```

#### Google Cloud 사전 설정

- 운영 환경별 Google Cloud project와 OAuth consent screen을 준비한다.
- OAuth client 유형은 서버 기반 웹 애플리케이션으로 등록한다.
- 운영 callback URL은 정확히 일치하는 HTTPS redirect URI로 등록한다.
- 개발·검증·운영 환경의 client와 redirect URI를 분리한다.
- OAuth client secret은 source repository나 프런트엔드 bundle에 두지 않고 서버 secret store 또는 보호된 운영 설정에서만 읽는다.
- 앱이 Testing 상태라면 허용된 test user만 연결할 수 있고 refresh token 정책이 운영과 다를 수 있으므로, 운영 전 consent screen 게시 상태와 Google 검증 필요 여부를 확인한다.

CardDAV 연결에는 Google이 허용하는 최소 연락처 scope만 요청한다. 실제 scope 값과 검증 요구 사항은 구현 시 Google 공식 문서와 Cloud Console에서 다시 확인하며, Gmail·Calendar 등 관계없는 scope를 함께 요청하지 않는다.

#### Authorization 요청 기준

- `response_type=code`인 authorization code flow를 사용한다.
- 장기 동기화가 필요하므로 offline access를 요청한다.
- CSRF 방지를 위해 예측 불가능한 state를 생성하고 서버에 짧은 만료 시간으로 저장한다.
- callback에서 로그인 cookie만 신뢰하지 않고 state에 기록된 `tenant_id + user_id`를 기준으로 연결 대상을 결정한다.
- state는 성공·실패 여부와 관계없이 한 번만 소비하며 재사용을 거부한다.
- 지원되는 경우 PKCE를 함께 사용하고 code verifier는 state와 함께 서버 측에만 임시 저장한다.
- refresh token 재발급이 필요한 경우에만 명시적인 재동의 흐름을 사용하며 매 연결마다 불필요하게 동의를 강제하지 않는다.

#### Callback 및 token 저장 기준

- callback은 `code`, `state`, Google 오류 응답을 구분하여 처리한다.
- code 교환은 브라우저가 아니라 백엔드가 Google token endpoint와 직접 수행한다.
- 발급된 Google 계정 식별자가 사용자가 연결하려는 계정과 일치하는지 확인한다.
- access token, refresh token, 만료 시각, 승인된 scope를 각각 관리한다.
- access token과 refresh token은 모두 암호화하며 API 응답, URL, browser storage, 일반 log에 노출하지 않는다.
- Google이 refresh 응답에서 새 refresh token을 주지 않으면 기존 refresh token을 유지한다.
- 동일 사용자가 동일 Google 계정을 재연결하면 기존 account를 안전하게 갱신하고 연락처 resource를 중복 생성하지 않는다.
- callback 완료 후 토큰을 URL에 포함하지 않은 ContactBook 화면으로 redirect하고 성공·실패의 안전한 상태 코드만 전달한다.

#### 자동 갱신과 인증 실패

CardDAV 요청 전에 access token 만료 시각을 확인한다. 만료가 임박했거나 CardDAV가 인증 실패를 반환하면 동시 갱신을 하나로 묶어 refresh token으로 access token을 갱신한 후 요청을 한 번만 재시도한다. 여러 sync job이 같은 refresh token을 동시에 교환하지 않도록 계정 단위 lock을 사용한다.

다음 경우에는 자동 반복을 중지하고 계정을 `인증 필요` 상태로 전환한다.

- refresh token이 철회·만료되었거나 `invalid_grant`가 반환된 경우
- 필요한 CardDAV scope가 승인되지 않은 경우
- Google 계정 또는 조직 정책이 접근을 차단한 경우
- OAuth client 설정이나 redirect URI가 일치하지 않는 경우

사용자가 연결을 해제하면 로컬 secret을 즉시 폐기하고, 가능한 경우 Google token revoke endpoint에도 철회를 요청한다. 로컬 연락처 유지 또는 삭제는 별도 선택으로 처리한다.

#### 현재 메일 OAuth 기반과의 관계

EasyStation의 기존 Google 메일 OAuth 모듈에 있는 설정 조회, authorization URL 생성, code 교환, refresh, 일회용 state 및 암호화 저장 패턴은 공통 OAuth 기반으로 재사용할 수 있다. 다만 다음 항목은 ContactBook 전용 경계로 분리한다.

- ContactBook 전용 callback 또는 callback의 명확한 provider/purpose 구분
- Gmail scope가 아닌 CardDAV 연락처 scope
- `contact_accounts` 소유권과 상태
- ContactBook 동기화용 access token 갱신 lock
- 메일 계정 삭제와 무관한 연락처 token 철회 및 데이터 보존 정책

메일과 ContactBook이 같은 Google 계정을 사용하더라도 초기 구현에서는 token row를 암묵적으로 공유하지 않는다. 향후 공통 Google connection 모델을 도입할 경우 사용자가 승인한 scope, 서비스별 연결 해제, 최소 권한, 장애 영향 범위를 먼저 정의한다.

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
oauth_access_token_ref   Google OAuth access token의 암호화 참조
oauth_refresh_token_ref  Google OAuth refresh token의 암호화 참조
oauth_token_expires_at   access token 만료 시각
oauth_scopes             실제 승인된 scope 목록
oauth_subject            Google 계정의 안정적인 사용자 식별자
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

`credential_secret_ref` 하나에 Google OAuth token JSON 전체를 넣지 않는다. 앱 전용 암호/BASIC secret과 OAuth access·refresh token을 논리적으로 분리하고, refresh 응답에 refresh token이 없을 때 기존 값을 보존할 수 있어야 한다. 계정 목록 API에는 token 값 대신 연결 상태와 만료·재인증 필요 여부만 반환한다.

### 6.1.1 `contact_oauth_states`

Google OAuth 연결 시도를 짧게 보존한다.

```text
state                     예측 불가능한 일회용 값
provider                  GOOGLE
purpose                   CONTACTBOOK_CONNECT | CONTACTBOOK_REAUTHORIZE
tenant_id
user_id
redirect_to               허용된 내부 경로
pkce_verifier_encrypted   PKCE 사용 시 서버 측 임시 값
expires_at
consumed_at
created_at
```

만료되었거나 소비된 state는 callback에서 거부하고 주기적으로 정리한다. `redirect_to`는 외부 URL을 허용하지 않아 open redirect를 방지한다.

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

### 6.6 통합 사람 사진 관리

ContactBook의 사진은 외부 연락처 resource에 종속시키지 않고 EasyStation의 통합 사람인 `people`에 연결한다. iCloud와 Google에 각각 존재하는 연락처가 같은 사람으로 연결되면 두 연락처는 EasyStation 안에서 같은 사진 목록을 사용한다.

```text
EasyStation Person
  ├─ iCloud Contact Resource
  ├─ Google Contact Resource
  ├─ 정규화된 전화번호
  └─ Person Photos
      ├─ 대표 사진
      ├─ 일반 사진
      └─ 외부 주소록에서 가져온 사진
```

사진의 원본 저장소는 EasyStation으로 한다. DB에는 사진 바이너리를 직접 저장하지 않고 object storage의 key, 크기, 형식, checksum, 출처 등 메타데이터를 저장한다. 목록과 상세 화면에서는 별도의 thumbnail을 사용한다.

사진 개수에는 애플리케이션 차원의 고정 상한을 두지 않는다. 다만 실제 운영에서는 한 파일의 최대 크기, 허용 형식, 최대 해상도, 사용자 또는 tenant별 저장 용량, 업로드 속도 및 보존 정책을 적용한다. 사용자에게는 사진 개수 제한 없음으로 제공할 수 있지만 물리적인 저장 공간까지 무제한임을 의미하지 않는다.

#### `person_contact_links`

통합 사람과 외부 연락처의 연결을 관리한다.

```text
id
tenant_id
user_id
person_id
contact_id
link_type                AUTO_PHONE | AUTO_EMAIL | MANUAL
matched_value            일치한 정규화 전화번호 또는 이메일 주소
match_status             CONFIRMED | REVIEW_REQUIRED | REJECTED
created_at
updated_at
```

- 외부 연락처를 실제로 병합하거나 한쪽 원본을 삭제하지 않고 연결 관계만 저장한다.
- 자동 연결, 사용자 확인 연결, 사용자가 거부한 연결을 구분한다.
- 사용자가 분리하거나 거부한 연락처 조합은 이후 동기화에서 자동으로 다시 연결하지 않는다.
- 연결은 반드시 같은 `tenant_id + user_id` 안에서만 수행한다. 서로 다른 EasyStation 사용자의 연락처와 사진을 전화번호나 이메일 주소만으로 공유하지 않는다.

#### `contact_phone_numbers`

전화번호 비교를 위해 원본 표시값과 정규화된 값을 별도로 관리한다.

```text
id
tenant_id
user_id
contact_id
raw_number
normalized_number        가능한 경우 E.164 형식
country_code
extension
type
is_primary
created_at
updated_at
```

전화번호 정규화에는 사용자의 기본 국가 설정을 사용한다. 예를 들어 한국 번호 `010-1234-5678`, `+82 10 1234 5678`, `821012345678`은 비교 시 `+821012345678`로 정규화할 수 있다. 원본 번호는 화면 표시와 외부 주소록 재저장을 위해 그대로 보존한다.

#### `contact_email_addresses`

이메일 주소 비교를 위해 원본 표시값과 정규화된 비교값을 별도로 관리한다.

```text
id
tenant_id
user_id
contact_id
raw_email
normalized_email
type
is_primary
created_at
updated_at
```

이메일 주소는 앞뒤 공백을 제거하고 domain 부분을 소문자로 정규화한다. 동일인 비교 시에는 일반적인 iCloud·Google 주소의 대소문자 차이로 인한 누락을 피하기 위해 전체 주소를 소문자로 비교한다. 다만 `.` 제거, `+tag` 제거, Gmail 별칭 치환처럼 공급자 정책에 의존하는 변환은 서로 다른 실제 주소를 합칠 수 있으므로 적용하지 않는다. 원본 이메일은 화면 표시와 외부 주소록 재저장을 위해 그대로 보존한다.

#### `person_photos`

통합 사람 한 명에 여러 사진을 연결한다.

```text
id
tenant_id
user_id
person_id
object_key
thumbnail_object_key
mime_type
byte_size
width
height
sha256
source                   LOCAL | ICLOUD | GOOGLE
source_contact_id
is_primary
caption
taken_at
created_at
updated_at
deleted_at
```

- 한 사람에게 여러 사진을 저장할 수 있다.
- 한 사람의 활성 대표 사진은 하나만 허용한다.
- 동일 checksum의 사진은 중복 업로드 여부를 확인할 수 있게 한다.
- 외부 주소록에서 가져온 사진은 공급자와 원본 연락처를 추적한다.
- 삭제는 즉시 object를 제거하지 않고 짧은 복구 기간을 둘 수 있으며, 보존 기간이 끝나면 원본과 thumbnail을 함께 삭제한다.

### 6.7 전화번호 또는 이메일 주소 기반 동일인 연결 정책

iCloud와 Google의 연락처는 다음 조건 중 하나라도 충족하면 같은 사람 후보로 판단한다.

1. 정규화된 전화번호가 하나 이상 정확히 일치한다.
2. 정규화된 이메일 주소가 하나 이상 정확히 일치한다.

즉 전화번호와 이메일 주소가 모두 같을 필요는 없다. 둘 중 하나만 같아도 같은 주소록 인물로 판단하여 동일한 `Person`에 연결하고 사진을 공유한다.

자동 연결은 다음 원칙을 따른다.

1. 현재 로그인 사용자의 `tenant_id + user_id` 범위 안에서만 비교한다.
2. 전화번호는 유효한 정규화 전체 번호가 정확히 일치할 때만 사용한다. 일부 자리만 같거나 국가 코드를 확정할 수 없는 번호는 자동 연결에 사용하지 않는다.
3. 이메일은 정규화된 전체 주소가 정확히 일치할 때만 사용한다. domain만 같거나 local part 일부만 같은 경우에는 연결하지 않는다.
4. 전화번호 또는 이메일 중 하나가 일치하면 자동 연결할 수 있으며, 두 항목이 모두 일치하면 같은 사람이라는 근거가 더 강한 것으로 기록한다.
5. 전화번호는 같지만 이메일이 서로 다르거나, 이메일은 같지만 전화번호가 서로 다른 경우에도 새 규칙에 따라 같은 사람으로 연결한다. 화면에서는 어떤 값으로 연결되었는지 출처를 확인할 수 있게 한다.
6. 하나의 전화번호나 이메일 주소가 여러 사람 또는 여러 이름에 공용으로 사용되면 오병합 가능성을 표시하고 사용자가 분리할 수 있게 한다.
7. 대표번호, 가족 공용번호, 재사용된 번호, 공용 메일함, 그룹 메일 주소는 오병합 가능성이 있으므로 수동 분리를 지원한다.
8. 사용자가 연결을 분리하거나 거부한 조합은 전화번호 또는 이메일이 계속 일치하더라도 이후 동기화에서 자동으로 다시 연결하지 않는다.
9. 연결 근거가 된 전화번호나 이메일이 변경·삭제되어도 이미 사용자가 확인한 연결은 즉시 해제하지 않고 재검토 상태로 전환한다.
10. 유효한 전화번호와 이메일 주소가 모두 없는 연락처는 자동 연결하지 않으며 사용자가 직접 기존 사람에 연결할 수 있게 한다.

전화번호 또는 이메일 일치만으로 외부 vCard를 하나로 합치거나 한쪽 원본을 삭제하지 않는다. 연결 결과는 EasyStation의 통합 표시와 사진 공유에 사용하고, iCloud와 Google의 원본 연락처 및 동기화 식별자는 각각 유지한다.

### 6.8 사진과 외부 주소록의 동기화 범위

EasyStation의 다중 사진 목록과 외부 주소록의 대표 연락처 사진을 구분한다.

#### EasyStation 내부 사진 공유

- 사용자가 iCloud 연락처 화면 또는 Google 연락처 화면에서 사진을 추가하더라도 실제 저장 대상은 연결된 `Person`이다.
- 같은 전화번호 또는 이메일 주소로 연결된 iCloud와 Google 연락처는 동일한 `Person`의 사진 목록을 표시한다.
- 사진 추가, 삭제, 대표 사진 변경은 연결된 모든 연락처 화면에 즉시 동일하게 보인다.
- 한 외부 계정의 연결이 해제되어도 다른 연락처와 연결된 `Person` 및 로컬 사진의 보존 여부를 별도 정책으로 결정한다.

#### iCloud 및 Google 대표 사진 연동

외부 주소록은 EasyStation의 여러 사진 전체를 보관하는 사진 갤러리로 사용하지 않는다. 공급자별 제약을 고려하여 EasyStation의 대표 사진 한 장만 외부 연락처의 대표 사진으로 선택적으로 반영한다.

- 로컬 사진 전체: EasyStation object storage에 저장
- 대표 사진 한 장: 사용자 설정에 따라 연결된 iCloud 및 Google 연락처에 전파 가능
- 외부에서 변경된 사진: 검증 후 EasyStation으로 가져오고 출처 표시
- 외부의 기존 사진과 로컬 대표 사진이 동시에 변경된 경우: 자동 덮어쓰기하지 않고 충돌 상태로 표시
- 외부 쓰기가 실패한 경우: 로컬 사진 추가는 유지하고 해당 공급자의 동기화 상태만 실패로 기록

대표 사진을 외부로 전파할 때 각 연락처 resource의 최신 ETag와 쓰기 capability를 확인한다. iCloud 반영 성공 후 Google 반영이 실패하는 부분 성공도 허용하고, 공급자별 결과를 별도로 기록하여 재시도할 수 있게 한다.

초기 제공 범위는 EasyStation 내부 다중 사진 공유와 외부 대표 사진 가져오기로 제한하는 것이 안전하다. 외부 주소록에 대표 사진을 쓰는 기능은 공급자별 호환성, 크기 제한, ETag 충돌 및 삭제 정책을 검증한 뒤 단계적으로 제공한다.

### 6.9 iCloud 주소록 그룹 구조 보존

EasyStation은 iCloud의 그룹을 단순한 로컬 태그로 변환하지 않고 CardDAV의 독립된 그룹 vCard resource로 보존한다. 이미지의 `5B2U`, `가족`, `개인 메일`과 같은 그룹 이름은 iCloud에 저장된 이름과 동일하게 표시하고, 그룹에 속한 연락처 목록도 iCloud의 멤버십을 기준으로 구성한다.

#### 기본 원칙

- 그룹 이름, 그룹 UID, 원격 href, ETag, 원본 vCard와 멤버 참조를 보존한다.
- 같은 이름의 그룹이 여러 iCloud 계정이나 주소록에 있어도 하나로 합치지 않는다.
- 그룹의 소유 범위는 `tenant_id + user_id + account_id + addressbook_id`이다.
- 그룹 이름을 EasyStation에서 임의로 번역·정규화하거나 연락처 회사명으로 대체하지 않는다.
- iCloud 그룹과 Google label은 공급자별 원본으로 각각 보존한다. 이름이 같다는 이유만으로 자동 병합하지 않는다.
- 통합 `Person`과 외부 그룹 멤버십을 분리한다. 그룹에는 `Person`이 아니라 원본 외부 연락처 resource가 속한다.

#### iCloud 그룹 vCard 판별

vCard 4.0 표준에서는 그룹 resource를 `KIND:group`으로 구분하고 `MEMBER` 속성으로 멤버를 참조할 수 있다. iCloud가 vCard 3.0 호환 형식을 반환하는 경우에는 다음 Apple/CardDAV 호환 확장을 함께 인식한다.

```text
BEGIN:VCARD
VERSION:3.0
UID:<group-uid>
FN:5B2U
X-ADDRESSBOOKSERVER-KIND:group
X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:<contact-uid-1>
X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:<contact-uid-2>
END:VCARD
```

파서는 다음 속성을 동등한 논리 필드로 읽는다.

| 논리 필드 | vCard 4.0 | iCloud/vCard 3.0 호환 |
|---|---|---|
| resource 종류 | `KIND:group` | `X-ADDRESSBOOKSERVER-KIND:group` |
| 멤버 | `MEMBER` | `X-ADDRESSBOOKSERVER-MEMBER` |
| 그룹 이름 | `FN` | `FN`, 필요한 경우 `N` fallback |
| 안정 식별자 | `UID` | `UID` |

`CATEGORIES`가 개별 연락처에 포함되어 있더라도 그룹 vCard의 멤버 목록을 우선적인 원본으로 사용한다. `CATEGORIES`는 호환성 확인 또는 누락 진단에 활용하되 그룹 vCard와 충돌할 때 자동으로 그룹 멤버십을 덮어쓰지 않는다.

실제 iCloud 응답의 속성명과 값 형식은 계정 및 vCard 버전에 따라 다를 수 있으므로 최초 연결 시 수신한 원본을 보존하고 capability와 샘플 resource를 기준으로 adapter 동작을 결정한다.

#### 데이터 모델

그룹 resource와 멤버십을 다음과 같이 분리한다.

```text
contact_groups
  id
  tenant_id
  user_id
  account_id
  addressbook_id
  contact_resource_id       그룹 vCard의 contact_resources 행
  remote_uid
  display_name
  group_kind                ICLOUD_GROUP | GOOGLE_LABEL | GENERIC_GROUP
  etag
  raw_vcard_encrypted
  content_hash
  deleted_at
  created_at
  updated_at

contact_group_members
  id
  tenant_id
  user_id
  group_id
  member_resource_id          개인 연락처 또는 하위 그룹 resource
  member_kind                 CONTACT | GROUP | EXTERNAL
  member_reference_raw      원본 MEMBER 값
  member_uid_normalized
  resolution_status         RESOLVED | MISSING | EXTERNAL | INVALID
  sort_order
  created_at
  updated_at
```

- `member_reference_raw`에는 `urn:uuid:...`, `mailto:...` 등 원본 값을 그대로 저장한다.
- `member_uid_normalized`는 비교를 위해 `urn:uuid:` prefix와 대소문자를 안전하게 정규화한 값이다.
- 멤버 연결은 같은 계정과 주소록의 `remote_uid`를 우선 사용하고, href나 이메일은 명시적인 fallback 정책이 있을 때만 사용한다.
- 아직 동기화되지 않았거나 삭제된 UID는 멤버십에서 제거하지 않고 `MISSING` 상태로 유지한다.
- 하나의 연락처는 여러 그룹에 속할 수 있으며 그룹 내 중복 멤버는 원본을 보존하되 화면에서는 한 번만 표시한다.
- 멤버 UID가 다른 그룹 resource를 가리키면 하위 그룹 관계로 보존하고 임의로 평탄화하지 않는다.

#### 그룹 계층과 순환 참조

iCloud가 그룹 안에 다른 그룹을 멤버로 제공하면 `parent_group → child_group` 관계를 그대로 저장하고 화면에서도 tree로 표시한다. 다만 계정이나 iCloud 버전에 따라 그룹이 평면 목록으로만 제공될 수 있으므로 서버 원본에 없는 부모·자식 관계를 이름이나 접두어만으로 추론하지 않는다.

- 같은 하위 그룹이 여러 상위 그룹에 포함되는 경우 하나의 tree node를 복제 생성하지 않고 동일 group resource를 참조한다.
- 그룹 간 순환 참조가 발견되면 동기화를 실패시키지 않고 해당 edge를 `INVALID_CYCLE`로 표시한다.
- 그룹 확장 조회에는 최대 깊이와 최대 총 멤버 수를 적용하여 무한 순회와 과도한 응답을 방지한다.
- 하위 그룹을 선택했을 때는 직접 멤버와 재귀 포함 멤버를 UI에서 구분할 수 있게 한다.
- iCloud의 스마트 그룹이나 로컬 Mac 전용 그룹이 CardDAV resource로 내려오지 않으면 EasyStation에서 임의로 생성하지 않고 `CardDAV에서 동기화되지 않는 그룹`으로 지원 범위를 안내한다.

#### 동기화 순서

최초 및 전체 동기화는 다음 두 단계로 처리한다.

1. 모든 CardDAV resource를 가져와 개인 연락처와 그룹 vCard를 분류하고 UID index를 만든다.
2. 그룹의 `MEMBER` 또는 `X-ADDRESSBOOKSERVER-MEMBER`를 UID index에 연결하여 멤버십을 확정한다.

그룹을 먼저 파싱했을 때 멤버 연락처가 아직 저장되지 않았다는 이유로 멤버를 삭제하지 않는다. 모든 batch 저장이 끝난 뒤 멤버 참조를 해석하며, 전체 resource 수와 그룹/개인 연락처 수가 맞는지 검증한 후 sync token을 확정한다.

증분 동기화에서는 다음 규칙을 적용한다.

- 그룹 vCard ETag 변경: 해당 그룹의 이름과 전체 멤버 목록을 새 snapshot으로 교체한다.
- 개인 연락처 변경: UID가 유지되면 기존 그룹 멤버십을 유지한다.
- 개인 연락처 삭제: 멤버십을 즉시 hard delete하지 않고 원격 그룹 vCard 갱신 여부를 확인할 때까지 `MISSING`으로 표시한다.
- 그룹 삭제: 그룹을 soft delete하고 기본 그룹 목록에서 숨긴다. 멤버 연락처 자체는 삭제하지 않는다.
- sync token 만료: 그룹을 포함해 해당 collection을 전체 재동기화한다.

#### 사용자 화면

ContactBook 왼쪽 메뉴의 iCloud 계정 아래에 iCloud의 그룹 목록을 원본 이름 그대로 표시한다.

```text
iCloud · freegear@me.com
  ├─ 모든 연락처
  ├─ 5B2U
  ├─ 가족
  │   └─ 친척
  ├─ 개인 메일
  └─ ...
```

- 그룹을 선택하면 가운데 목록에는 해당 iCloud 그룹의 멤버 연락처만 표시한다.
- 그룹명 옆에는 해석된 멤버 수를 표시한다.
- 연락처 상세에는 현재 연락처가 속한 iCloud 그룹 이름과 출처 계정을 표시한다.
- 통합 연락처가 iCloud와 Google 양쪽에 있어도 iCloud 그룹 화면에는 그 그룹이 참조하는 iCloud 원본 연락처만 표시한다.
- `모든 연락처` 화면에서는 통합 `Person`을 사용할 수 있지만 그룹 필터 결과와 원본 멤버십의 관계를 잃지 않는다.
- 같은 이름의 그룹은 계정명 또는 공급자 badge로 구분한다.

#### 그룹 편집 및 양방향 반영

첫 단계에서는 그룹 조회와 필터만 제공한다. 그룹 생성, 이름 변경, 멤버 추가·제거, 그룹 삭제는 iCloud의 실제 group vCard 쓰기 동작을 검증한 뒤 활성화한다.

쓰기 기능을 제공할 때는 다음 원칙을 따른다.

- 그룹 이름 변경은 기존 group vCard의 `FN`을 patch하고 알 수 없는 속성은 보존한다.
- 멤버 추가·제거는 그룹 vCard의 member 속성만 변경하며 개인 연락처 vCard를 다시 만들지 않는다.
- `If-Match: <group-etag>` 조건부 PUT을 사용한다.
- `412` 충돌 시 최신 그룹 vCard를 다시 가져와 로컬 변경과 원격 변경을 비교한다.
- 그룹 삭제는 group resource만 DELETE하고 소속 연락처는 삭제하지 않는다.
- 부분 실패 시 로컬에서 성공한 것처럼 확정하지 않고 그룹별 pending/conflict 상태를 표시한다.

Google Contacts와 함께 사용할 경우 Google label을 iCloud 그룹 vCard로 자동 복제하지 않는다. 사용자가 명시적으로 그룹/label 연결을 선택하는 후속 기능을 제공할 수 있지만, 이때도 양쪽 원본 식별자와 멤버십을 별도로 유지한다.

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
- Google OAuth 연결 URL 발급, callback, 재인증, 연결 철회
- discovery 및 연결 테스트
- 주소록 collection 목록과 선택 변경
- 수동 동기화 요청과 상태 조회
- 연락처 목록, 검색, 상세 조회
- 같은 사람 후보 확인, 연결, 연결 해제
- 통합 사람 상세 조회와 연결된 외부 연락처 조회
- 통합 사람 사진 목록, 업로드, 삭제, 대표 사진 설정
- 외부 대표 사진 가져오기와 공급자별 전파 상태 조회
- 계정·주소록별 그룹 목록과 그룹 멤버 연락처 조회
- 그룹 동기화 상태, 해석되지 않은 멤버와 충돌 조회
- 후속 단계의 그룹 생성, 이름 변경, 멤버 추가·제거와 삭제
- 후속 단계의 연락처 생성, 수정, 삭제

인증 callback의 `state`는 로그인 사용자와 연결 시도를 묶는 일회용 값으로 검증한다. API 응답에는 access token, refresh token, 앱 전용 암호, 내부 secret 참조값, raw remote credential을 포함하지 않는다.

Google OAuth API의 개념적 경계는 다음과 같다.

- `POST /contactbook/oauth/google/start`: 로그인 사용자에 대한 state를 만들고 Google authorization URL을 반환
- `GET /contactbook/oauth/google/callback`: state와 code를 검증·교환하고 계정을 연결한 뒤 안전한 내부 화면으로 redirect
- `POST /contactbook/accounts/:id/reauthorize`: 인증 필요 계정의 새 OAuth 연결 시작
- `DELETE /contactbook/accounts/:id`: token 철회 시도, local secret 폐기, 선택한 데이터 보존 정책 적용

callback 경로 자체는 Google redirect를 받을 수 있도록 세션 유무와 무관하게 진입할 수 있지만, 유효한 미사용 state 없이는 어떤 계정도 생성하거나 변경하지 않는다.

## 9. 보안과 개인정보 보호

- CardDAV 통신은 HTTPS만 허용하고 인증서 검증을 끄지 않는다.
- OAuth scope는 연락처에 필요한 최소 범위를 사용한다.
- authorization code와 token을 query string, browser storage, analytics 또는 referrer에 남기지 않는다.
- OAuth callback과 token 교환 오류에는 Google 응답 전문을 사용자에게 노출하지 않는다.
- 앱 전용 암호와 token은 암호화하고 log, 오류 메시지, telemetry에서 제거한다.
- vCard와 사진은 신뢰할 수 없는 외부 입력으로 취급한다.
- vCard 크기, 속성 수, 한 속성의 길이, 사진 크기, redirect 수, XML 응답 크기에 상한을 둔다.
- 업로드 사진은 확장자가 아니라 실제 content signature를 검사하고 허용된 image 형식만 저장한다.
- 업로드 원본은 이미지 decoder로 검증하고 pixel 수와 압축 해제 후 메모리 사용량을 제한하여 image bomb을 차단한다.
- 사진 조회 API는 `tenant_id + user_id + person_id` 소유권을 확인하고 object storage의 내부 경로를 직접 노출하지 않는다.
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
- 목록 API는 전체 검색 결과 수와 다음 페이지 존재 여부를 반환하고, 화면의 `모든 연락처` 수는 현재 내려받은 배열 길이가 아니라 전체 결과 수를 표시한다.
- 초기 화면은 100개 단위로 조회할 수 있지만 100개를 전체 상한으로 사용하지 않으며, 사용자가 후속 페이지를 계속 불러올 수 있어야 한다.
- 검색용 정규화 필드와 이메일/전화번호 비교값에 사용자 경계를 포함한 index를 둔다.
- sync는 background job으로 실행하고 HTTP 요청에서 전체 주소록 동기화를 기다리지 않는다.
- 대용량 multistatus XML과 vCard는 가능한 경우 streaming 또는 batch로 처리한다.
- 연락처 사진은 별도 object storage에 저장하고 크기 제한 thumbnail을 사용한다.
- 사진 업로드와 thumbnail 생성은 연락처 동기화 transaction과 분리하고 실패 시 재시도 가능한 작업으로 처리한다.
- 원본 사진과 thumbnail의 orphan object를 주기적으로 탐지하고 안전한 유예 기간 후 정리한다.
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
- Google OAuth 승인·거부, state 누락·변조·재사용·만료, callback 재호출을 확인한다.
- access token 정상 갱신, refresh token 미반환 시 기존 값 유지, 동시 갱신 lock을 확인한다.
- refresh token 철회, `invalid_grant`, scope 부족, 계정 재연결과 중복 방지를 확인한다.
- OAuth callback의 open redirect, token log 노출, 다른 사용자의 state 탈취를 확인한다.
- vCard 3.0/4.0, 여러 이메일/전화번호, 한글/emoji, folded line, escaped 문자, embedded photo를 확인한다.
- sync token 지원/미지원 서버와 token 만료를 각각 확인한다.
- 생성, 변경, 삭제, ETag 충돌, 중복 UID를 확인한다.
- XML 숫자 문자 참조 `&#13;`, `&#10;`, `&#xD;`, `&#xA;`가 vCard 파싱 전에 실제 줄바꿈으로 복원되는지 확인한다.
- 이름 없는 연락처, 이메일만 있는 연락처, 전화번호만 있는 연락처도 동기화되는지 확인한다.
- 동일 사용자의 iCloud와 Google 연락처에서 같은 전화번호가 동일 `Person`으로 연결되는지 확인한다.
- 동일 사용자의 iCloud와 Google 연락처에서 같은 이메일 주소가 동일 `Person`으로 연결되는지 확인한다.
- 전화번호만 같고 이메일이 다른 경우와 이메일만 같고 전화번호가 다른 경우 모두 동일 `Person`으로 연결되는지 확인한다.
- 전화번호와 이메일이 모두 다른 경우에는 서로 다른 `Person`으로 유지되는지 확인한다.
- 서로 다른 사용자의 같은 전화번호가 서로 연결되거나 사진을 공유하지 않는지 확인한다.
- 서로 다른 사용자의 같은 이메일 주소가 서로 연결되거나 사진을 공유하지 않는지 확인한다.
- 국가 코드와 표시 형식이 다른 같은 전화번호가 올바르게 정규화되는지 확인한다.
- 대소문자와 앞뒤 공백이 다른 같은 이메일 주소가 올바르게 정규화되는지 확인한다.
- 이메일의 `+tag` 또는 `.`을 임의로 제거하여 서로 다른 주소를 오병합하지 않는지 확인한다.
- 공용 대표번호, 내선번호, 재사용 번호 및 하나의 번호를 여러 연락처가 사용하는 경우 자동 오병합을 막는지 확인한다.
- 사용자가 분리하거나 거부한 연락처가 다음 동기화에서 자동으로 다시 연결되지 않는지 확인한다.
- Apple의 grouped property와 `X-ABLabel`, 복수 `TYPE`, `VALUE=uri`, quoted-printable 및 charset을 확인한다.
- iCloud의 `X-ADDRESSBOOKSERVER-KIND:group`과 `X-ADDRESSBOOKSERVER-MEMBER` 그룹 vCard를 개인 연락처와 구분하는지 확인한다.
- vCard 4.0의 `KIND:group`과 `MEMBER`도 같은 논리 그룹 모델로 처리하는지 확인한다.
- 그룹명, UID, href, ETag, 원본 vCard와 멤버 순서가 전체·증분 동기화 후에도 보존되는지 확인한다.
- 같은 이름의 그룹이 서로 다른 계정이나 주소록에 있을 때 합쳐지지 않는지 확인한다.
- 그룹 resource가 멤버 연락처보다 먼저 처리되어도 전체 batch 완료 후 UID로 정상 연결되는지 확인한다.
- 존재하지 않는 UID, 삭제된 연락처, `mailto:` 멤버 참조를 유실하지 않고 resolution 상태로 관리하는지 확인한다.
- 하위 그룹 참조를 원본 계층으로 보존하고 순환 그룹 참조에서 무한 순회하지 않는지 확인한다.
- 그룹 삭제가 멤버 연락처 삭제로 전파되지 않는지 확인한다.
- iCloud 그룹 필터에서 해당 iCloud 원본 멤버만 표시하고 통합된 Google 연락처를 임의로 멤버로 추가하지 않는지 확인한다.
- 100개 및 1,000개 이상 주소록에서 전체 건수, 페이지 추가 조회, 검색 결과 건수가 일치하는지 확인한다.

### 12.3 보안 및 장애

- 사용자 지정 URL의 SSRF, redirect 우회, DNS rebinding 방어를 확인한다.
- XXE, 과대 XML/vCard, 과대 사진, 악성 URL, HTML 문자열을 확인한다.
- 한 사람에게 여러 사진을 추가·삭제하고 대표 사진을 변경해도 연결된 iCloud와 Google 연락처 화면에서 같은 목록이 보이는지 확인한다.
- 사진 개수에 고정 상한이 없어도 pagination, thumbnail 및 지연 로딩으로 대량 사진을 안정적으로 조회하는지 확인한다.
- 위조된 MIME, 손상된 이미지, 과도한 pixel 수, 중복 사진 및 다른 사용자의 사진 ID 접근을 거부하는지 확인한다.
- iCloud와 Google 대표 사진 전파의 전체 성공, 부분 성공, ETag 충돌 및 재시도를 각각 확인한다.
- 계정 연결 해제, 사용자 탈퇴 및 보존 기간 만료 시 사진과 thumbnail이 정책대로 유지 또는 삭제되는지 확인한다.
- timeout, 401/403/404/412/429/5xx와 부분 실패 후 재시도를 확인한다.
- 중복 job이 동일 연락처를 이중 생성하지 않는지 확인한다.
- 대량 삭제 보호와 계정 연결 해제 후 secret 폐기를 확인한다.

## 13. 단계별 구현 권장안

### 1단계: 사용자별 기반

- 사용자별 계정, 주소록, resource, 연락처 schema
- credential 암호화와 접근 경계
- CardDAV discovery와 capability 확인
- Apple, Google, Generic CardDAV 연결
- Google access token 수동 입력을 제거하고 authorization code + refresh token 기반 연결 제공
- 읽기 전용 최초/증분 동기화
- 목록, 상세, 검색, 계정별 필터

### 2단계: 안정성 및 운영

- background scheduler와 queue
- sync token fallback, 재시도, token 초기화
- 상태/오류 UI와 감사 log
- 대용량 주소록 성능 개선
- 전화번호 국제 형식 및 이메일 주소 정규화와 같은 사람 후보 탐지
- 통합 `Person`과 외부 연락처 연결 및 수동 분리
- 자체 object storage 기반 다중 사진과 대표 사진 관리
- iCloud 그룹 vCard 판별, 원본 보존, 멤버 UID 연결과 그룹별 필터

### 3단계: 양방향 동기화

- 생성, 수정, 삭제
- ETag 기반 충돌 처리
- 삭제 보호와 복구
- 그룹/라벨 지원

### 4단계: People Hub

- 사용자 확인 기반 사람 엔티티 연결
- iCloud와 Google의 기존 대표 사진 가져오기
- 공급자별 capability 검증 후 대표 사진 선택적 전파
- 검증된 공급자에서 그룹 이름 변경과 멤버 추가·제거의 조건부 양방향 동기화
- 메일 참여자, 문서 작성자, 회의 참석자, 프로젝트 구성원 연결
- 사람 중심 활동 timeline
- 권한과 출처를 보존하는 Agentic AI 검색

## 14. 완료 조건

- 로그인 사용자마다 독립적인 ContactBook이 생성된다.
- 한 사용자가 여러 CardDAV 계정과 여러 주소록을 연결할 수 있다.
- discovery 결과를 사용하며 공급자 URL을 내부 구조로 고정하지 않는다.
- 최초 동기화 후 sync token 또는 ETag/CTag fallback으로 변경분을 반영한다.
- 생성, 변경, 삭제가 중복 없이 로컬에 반영되고 부분 실패를 재시도할 수 있다.
- 연락처 상세 화면의 편집 버튼 오른쪽에서 선택한 외부 연락처 한 건을 안전하게 삭제할 수 있고, 연결된 다른 공급자의 연락처와 공유 사진은 유지된다.
- 모든 계층에서 tenant/user 권한 검사가 적용된다.
- 인증 정보와 연락처 개인정보가 log나 API 응답에 노출되지 않는다.
- Google 사용자는 token을 직접 입력하지 않고 동의 화면으로 연결하며, access token 만료 후에도 refresh token으로 동기화가 지속된다.
- Google OAuth state는 사용자·tenant에 귀속되고 일회용으로 소비되며, 인증 철회 시 `인증 필요` 상태와 재연결 동작이 일치한다.
- 계정 연결 해제, 사용자 탈퇴, 데이터 삭제 정책이 화면과 서버 동작에서 일치한다.
- 같은 사용자의 iCloud와 Google 연락처가 정규화된 전화번호 또는 이메일 주소 중 하나라도 같으면 안전하게 한 `Person`에 연결된다.
- 연결된 연락처는 EasyStation 안에서 동일한 다중 사진 목록과 대표 사진을 공유한다.
- 사진 개수에 고정 상한을 두지 않으면서 파일 크기, 저장 용량, 보안 검사와 thumbnail 정책을 적용한다.
- 외부 주소록의 다중 사진과 EasyStation 사진 목록을 동일한 기능으로 간주하지 않고, 외부에는 대표 사진 한 장만 선택적으로 동기화한다.
- iCloud 그룹 이름과 멤버십이 group vCard 원본 구조, 계정 및 주소록 경계를 유지한 채 표시된다.
- 같은 이름의 그룹과 다른 공급자의 label을 자동 병합하지 않으며 그룹 삭제가 멤버 연락처 삭제를 일으키지 않는다.
- 후속 People Hub가 외부 연락처 원본을 손상시키지 않고 사람 엔티티를 연결할 수 있다.

## 15. 참고 표준 및 공식 문서

- [RFC 6352: CardDAV](https://www.rfc-editor.org/rfc/rfc6352)
- [RFC 6578: WebDAV Collection Synchronization](https://www.rfc-editor.org/rfc/rfc6578)
- [RFC 6764: CardDAV/CalDAV Service Discovery](https://www.rfc-editor.org/rfc/rfc6764)
- [RFC 6350: vCard 4.0](https://www.rfc-editor.org/rfc/rfc6350)
- [Google: CardDAV로 연락처 관리](https://developers.google.com/people/carddav)
- [Apple: 앱 전용 암호로 Apple Account에 로그인](https://support.apple.com/102654)

공급자별 인증 방식과 지원 capability는 변경될 수 있으므로 구현 시점에 공식 문서를 다시 확인한다.

## 16. iCloud 호환성 및 데이터 복구 기준

### 16.1 XML과 vCard 처리 경계

iCloud CardDAV 응답의 `address-data`에는 CR/LF가 XML 숫자 문자 참조인 `&#13;`, `&#10;`, `&#xD;`, `&#xA;`로 포함될 수 있다. 큰따옴표, 작은따옴표, ampersand, 부등호도 XML 기본 문자 참조인 `&quot;`, `&apos;`, `&amp;`, `&lt;`, `&gt;`로 전달될 수 있다. 이를 화면에서 제거하거나 DB 저장 후 치환하지 않고 다음 순서로 처리한다.

```text
CardDAV XML 수신
  ↓
외부 entity와 DTD를 비활성화한 안전한 XML 파싱
  ↓
표준 숫자 문자 참조와 XML 기본 문자 참조만 실제 Unicode 문자로 복원
  ↓
CRLF/LF 줄바꿈 정규화
  ↓
표준 vCard 3.0/4.0 파서에 전달
```

XML 보안을 위해 임의의 named entity나 외부 entity 처리를 활성화하지 않는다. 허용 대상은 유효한 Unicode 숫자 문자 참조와 XML 표준의 다섯 기본 문자 참조로 제한한다.

문자 참조 복원은 `address-data`를 XML에서 꺼낸 직후 정확히 한 번만 수행한다. 예를 들어 XML 안의 `&quot;`은 실제 `"`로 복원하지만, 원래 vCard 값에 문자 그대로 `&quot;`이 들어 있어 XML에서 `&amp;quot;`로 전송된 경우에는 한 번의 복원 후 `&quot;`을 유지해야 한다. 반복적인 HTML entity decode는 원본 사용자 데이터를 바꿀 수 있으므로 금지한다.

React 화면에서 entity decode를 하거나 `dangerouslySetInnerHTML`로 표시하지 않는다. 화면은 일반 text rendering을 유지하며, XML/vCard 경계에서 정규화된 값을 DB에 저장한다. 원본 `FN`에 포함된 `#` 같은 실제 사용자 문자는 임의로 제거하지 않고, `FN`, 구조화된 `N`, 원본 vCard를 비교하여 표시 이름을 결정한다.

이미 `&quot;` 또는 `&amp;`가 정규화 필드와 암호화 원본 vCard에 저장된 경우에는 코드 배포만으로 기존 행이 바뀌지 않는다. 새 처리기를 적용한 뒤 해당 주소록을 전체 재동기화하거나, 보존된 remote 원본의 인코딩 상태를 확인하여 재파싱한다. `&amp;` 문자열은 실제 사용자 입력일 수도 있으므로 DB 전체에 대한 무조건적인 문자열 치환은 수행하지 않는다.

### 16.2 vCard 정규화 기준

- 검증된 RFC 기반 파서를 사용하고 자체적인 단순 `:`/`;` 문자열 분해에 의존하지 않는다.
- vCard 3.0/4.0, folded line, escaped 문자, quoted-printable, charset, base64, 복수 값과 Apple grouped property를 처리한다.
- 이메일과 전화번호의 모든 `TYPE`, 원본 label, 선호 여부를 보존한다.
- `tel:` URI는 표시·검색 projection에서 정규화하되 원본 vCard는 변경하지 않는다.
- 파싱할 수 없는 resource는 격리하고 전체 동기화 결과에서 실패 건수와 href를 개인정보가 노출되지 않는 방식으로 기록한다.

### 16.3 완전한 전체 동기화와 삭제 안전성

이름이 없는 연락처도 정상 resource로 취급하므로 최초 목록 조회에 `FN` 필수 필터를 사용하지 않는다. 먼저 href와 ETag 전체 목록을 확보하고 `addressbook-multiget`을 제한된 batch로 수행한다. 요청한 batch의 일부만 반환되거나 파싱·네트워크 오류가 발생하면 전체 동기화를 실패로 처리하며, 해당 실행에서 보이지 않은 기존 resource를 삭제 처리하지 않는다.

삭제 표시는 모든 batch가 성공하여 서버의 전체 resource 집합을 확보한 뒤 하나의 transaction 안에서만 수행한다. 동기화 결과는 최소한 다음 관계를 검증할 수 있어야 한다.

```text
서버 전체 resource 수
= 정상 저장 수 + 격리된 파싱 실패 수 + 정책상 제외 수
```

### 16.4 기존 오염 데이터 복구

파서 수정만으로 기존 DB의 `&#13;` 값은 복구되지 않는다. 배포 시 다음 절차를 따른다.

1. DB와 암호화된 원본 vCard를 백업한다.
2. 저장된 원본이 정상이라면 새 파서로 projection을 재생성한다.
3. 원본에도 XML 문자 참조가 남아 있으면 iCloud에서 전체 재동기화한다.
4. UID뿐 아니라 addressbook ID, remote href, ETag와 전체 건수로 전후 결과를 비교한다.
5. 검증 완료 후 기존 정규화 데이터를 교체하고 일정 기간 건수 차이와 파싱 실패를 감시한다.

## 17. 양방향 편집 도입 계획

### 17.1 목표와 기본 원칙

양방향 편집은 EasyStation에서 만든 변경을 iCloud, Google 또는 기타 CardDAV 원본에 반영하고, 외부에서 발생한 변경도 EasyStation으로 다시 가져오는 기능이다. 단순히 로컬 DB를 수정한 뒤 나중에 덮어쓰는 방식이 아니라, 외부 resource의 최신 상태와 ETag를 기준으로 안전하게 쓰고 결과를 다시 확인해야 한다.

- 외부 CardDAV resource를 최종 원본(source of truth)으로 취급한다.
- 사용자의 편집 요청은 먼저 로컬에 안전하게 기록한 뒤 background worker가 외부 서버에 전달한다.
- 외부 반영이 확인되기 전에는 화면에 `동기화 대기` 또는 `전송 중` 상태를 표시한다.
- 성공 응답에서 받은 resource URL, ETag와 vCard를 다시 저장하여 로컬 상태를 확정한다.
- 읽기 전용 주소록에서는 생성·수정·삭제 UI를 제공하지 않는다.
- 한 공급자의 장애가 다른 계정이나 주소록의 편집을 막지 않도록 작업을 계정·주소록 단위로 격리한다.
- 자동 병합보다 데이터 보존을 우선하며 판단하기 어려운 충돌은 사용자에게 선택하게 한다.

### 17.2 구현 전 확인 사항

계정 연결 또는 discovery 단계에서 주소록별 쓰기 capability를 확인하고 저장한다.

- `OPTIONS`, `DAV` header와 실제 허용 method를 확인한다.
- 새 resource 생성에 `POST`가 가능한지, client가 지정한 href에 `PUT`해야 하는지 구분한다.
- `PUT`, `POST`, `DELETE`, `If-Match`, `If-None-Match` 동작을 작은 테스트 resource로 검증한다.
- 서버가 허용하는 vCard 버전, 필수 속성, 최대 크기와 사진 처리 방식을 확인한다.
- Google OAuth scope가 CardDAV 쓰기를 포함하는지 실제 승인 scope와 API 응답으로 검증한다.
- iCloud 앱 전용 암호 또는 공급자 인증 정책이 쓰기 작업에도 유효한지 확인한다.
- 공유·위임·조직 주소록처럼 읽기만 가능한 collection을 구분한다.

서버가 capability를 명확히 알리지 않으면 읽기 전용을 기본값으로 사용하고, 명시적인 연결 테스트가 성공한 경우에만 쓰기를 활성화한다.

### 17.3 데이터 모델 확장

기존 `contact_resources`와 `contacts` 외에 편집 의도와 전송 상태를 보존하는 outbox가 필요하다. 개념적으로 다음 필드를 둔다.

```text
contact_change_outbox
  id
  tenant_id
  user_id
  account_id
  addressbook_id
  contact_resource_id       생성 전에는 null 가능
  operation                 CREATE | UPDATE | DELETE
  base_etag                 사용자가 편집을 시작할 때의 ETag
  base_vcard_encrypted      충돌 비교용 기준 원본
  desired_vcard_encrypted   사용자가 저장하려는 결과
  idempotency_key
  status                    PENDING | SENDING | APPLIED | CONFLICT | RETRY | FAILED | CANCELLED
  attempt_count
  next_attempt_at
  last_http_status
  last_error_code
  last_error_message_safe
  created_at
  updated_at
  applied_at
```

`contact_resources`에는 다음 상태를 추가하거나 동등한 별도 상태 table을 둔다.

```text
sync_state                 SYNCED | LOCAL_PENDING | CONFLICT | DELETE_PENDING | ERROR
base_etag                  로컬 편집이 시작된 외부 버전
pending_change_id          현재 적용 대기 중인 outbox 작업
remote_updated_at          공급자가 제공하는 경우의 원격 수정 시각
```

핵심 제약은 다음과 같다.

- outbox를 포함한 모든 행에 `tenant_id + user_id` 소유권을 강제한다.
- 동일 resource에는 한 번에 하나의 활성 변경만 허용하거나 후속 편집을 하나의 원하는 최종 상태로 합친다.
- 재시도 시 같은 생성 요청이 중복 연락처를 만들지 않도록 idempotency key와 UID를 사용한다.
- 원격 반영 성공 전에는 기존 ETag와 기준 vCard를 삭제하지 않는다.
- 편집 중 알 수 없는 vCard 속성, 공급자 확장 필드와 그룹 정보를 그대로 보존한다.

### 17.4 로컬 편집과 outbox 기록

사용자가 저장을 누를 때 브라우저가 외부 CardDAV 서버를 직접 호출하지 않는다. EasyStation API가 다음 작업을 하나의 DB transaction으로 처리한다.

1. 로그인 세션에서 `tenant_id + user_id`를 결정한다.
2. 계정과 주소록 소유권, 쓰기 가능 여부, 현재 resource 상태를 확인한다.
3. 사용자가 본 버전과 현재 로컬 ETag 또는 revision을 비교한다.
4. 기존 raw vCard를 기준으로 사용자가 수정한 필드만 반영해 원하는 vCard를 만든다.
5. 정규화된 `contacts` projection과 outbox 작업을 함께 저장한다.
6. resource를 `LOCAL_PENDING` 또는 `DELETE_PENDING`으로 표시한다.
7. transaction commit 후 background worker에 작업을 알린다.

API 응답은 외부 반영 완료를 거짓으로 알리지 않고 `accepted + pending` 상태를 반환한다. UI는 로컬에서 즉시 변경 내용을 보여 줄 수 있지만 `외부 주소록 반영 대기 중` 표시를 유지한다.

### 17.5 연락처 생성 흐름

```text
사용자가 대상 계정과 주소록 선택
  ↓
서버가 안정적인 UID와 vCard 생성
  ↓
로컬 임시 resource + CREATE outbox 저장
  ↓
worker가 POST 또는 If-None-Match: * PUT 실행
  ↓
서버가 반환한 Location/resource URL 확인
  ↓
새 resource를 GET하여 최종 vCard와 ETag 확인
  ↓
임시 resource를 실제 remote href에 연결하고 SYNCED 확정
```

- `UID`는 재시도해도 변하지 않게 최초 요청 시 생성한다.
- POST 응답에 `Location` 또는 ETag가 없으면 collection을 조회해 UID로 실제 resource를 확인한다.
- timeout으로 성공 여부가 불명확하면 같은 UID가 이미 존재하는지 확인한 뒤 재시도한다.
- 생성 중 사용자가 다시 편집하면 별도 CREATE를 만들지 않고 같은 임시 resource의 원하는 최종 vCard를 갱신한다.

### 17.6 연락처 수정 흐름

```text
사용자가 기준 ETag의 연락처 수정
  ↓
UPDATE outbox와 원하는 vCard 저장
  ↓
worker가 최신 인증 확보
  ↓
If-Match: <base_etag>을 포함한 PUT
  ├─ 성공: GET 또는 응답 ETag로 최종 상태 확인
  └─ 412: 최신 원격 vCard를 받아 충돌 판정
```

- 전체 vCard를 새로 조립하면서 모르는 속성을 버리지 않고 기존 raw vCard에 변경 필드를 patch한다.
- 서버 성공 후 반환된 ETag만 신뢰하고, ETag가 없으면 GET으로 다시 확인한다.
- 같은 resource의 여러 빠른 편집은 아직 전송 전이라면 하나의 최종 UPDATE로 합칠 수 있다.
- 전송 중 추가 편집이 발생하면 먼저 진행 중인 결과를 확정한 뒤 새 ETag를 기준으로 후속 UPDATE를 만든다.

### 17.7 연락처 삭제 흐름

삭제는 즉시 hard delete하지 않는다.

1. 사용자가 상세 화면의 `편집` 오른쪽에 있는 `삭제` 버튼을 누르고 삭제 대상, 외부 계정과 주소록을 확인한다.
2. 로컬에 tombstone과 DELETE outbox를 저장하고 기본 목록에서는 숨긴다.
3. worker가 `If-Match: <base_etag>`을 포함하여 DELETE를 요청한다.
4. `2xx` 또는 이미 존재하지 않는 것이 확인된 `404/410`이면 적용 완료로 처리한다.
5. `412`이면 원격 변경과 삭제 의도가 충돌한 것으로 표시한다.
6. 보존 기간 동안 raw vCard와 감사 정보를 유지한 뒤 정책에 따라 purge한다.

계정 전체 또는 대량 연락처 삭제는 일반 단건 삭제와 분리한다. 일정 개수 또는 주소록의 일정 비율을 넘으면 외부 전송을 중지하고 추가 확인을 요구한다. `계정 연결 삭제`는 기본적으로 외부 연락처 삭제를 의미하지 않는다.

같은 `Person`에 여러 외부 연락처가 연결되어 있어도 DELETE outbox에는 사용자가 선택한 `contact_resource_id` 하나만 기록한다. 나머지 연결은 유지하고 삭제된 연락처의 `person_contact_links`만 적용 완료 후 해제한다. 마지막 연결이 삭제되더라도 통합 사람과 사진은 tombstone 보존 기간이 끝나기 전에 hard delete하지 않는다.

### 17.8 충돌 탐지와 병합

충돌 비교에는 세 버전을 사용한다.

```text
Base    사용자가 편집을 시작했을 때의 vCard
Local   사용자가 저장하려는 vCard
Remote  412 발생 후 다시 가져온 최신 vCard
```

- Base와 비교해 Local만 바뀐 필드는 Local을 사용할 수 있다.
- Base와 비교해 Remote만 바뀐 필드는 Remote를 유지한다.
- Local과 Remote가 서로 다른 필드를 바꿨다면 자동 병합 후보로 만들되 vCard 의미가 보존되는지 검증한다.
- 같은 단일 값 필드를 양쪽이 다르게 바꿨다면 자동 선택하지 않는다.
- 이메일·전화번호 같은 다중 값은 값, type, label, 선호 순서를 함께 비교한다.
- 사진, 메모, 그룹, 구조화된 이름처럼 손실 위험이 큰 필드는 보수적으로 사용자 확인을 요구한다.

충돌 화면은 `내 변경`, `외부 변경`, 가능한 경우 `병합 결과`를 보여주고 다음 선택을 제공한다.

- 외부 변경 유지
- 내 변경으로 다시 적용
- 필드별 병합 후 적용
- 나중에 해결

`내 변경으로 다시 적용`도 최신 Remote ETag를 기준으로 새 PUT을 수행하며 조건 없는 덮어쓰기는 하지 않는다.

### 17.9 외부 변경 수신과 pending 작업의 관계

증분 동기화가 로컬 pending resource의 원격 변경을 발견하면 곧바로 projection을 덮어쓰지 않는다.

- 원격 ETag가 outbox의 base ETag와 같으면 로컬 변경 전송을 계속한다.
- 원격 ETag가 달라졌으면 Base/Local/Remote 충돌 비교를 수행한다.
- worker가 방금 적용한 변경의 ETag라면 outbox를 `APPLIED`로 확정하고 중복 알림을 만들지 않는다.
- 원격 삭제와 로컬 수정이 겹치면 `원격에서 삭제됨` 충돌로 표시하고 복원 생성 여부를 사용자가 선택한다.
- 로컬 삭제 대기 중 원격 수정이 발견되면 자동 삭제하지 않고 사용자 확인 정책을 적용한다.

### 17.10 재시도, 순서와 중복 방지

- 동일 account/addressbook/resource 작업은 순서대로 직렬 처리한다.
- 네트워크 오류, timeout, `429`, 일시적 `5xx`만 제한적으로 재시도한다.
- `Retry-After`가 있으면 우선 적용하고 그 외에는 지수 backoff와 jitter를 사용한다.
- `401`은 token 갱신 후 한 번 재시도하고 계속 실패하면 `인증 필요`로 전환한다.
- `403`은 권한·읽기 전용·scope 문제를 구분하고 자동 반복하지 않는다.
- `409/412`는 일반 오류가 아니라 충돌 흐름으로 보낸다.
- 요청 결과가 불명확한 timeout은 GET/UID 조회로 외부 적용 여부를 먼저 확인한다.
- 최대 재시도 횟수를 넘겨도 사용자의 변경 의도와 기준 원본을 삭제하지 않는다.

### 17.11 API와 화면 변경 범위

개념적인 API 경계는 다음과 같다.

- 연락처 생성 요청과 대상 주소록 선택
- 연락처 수정 요청과 클라이언트가 확인한 revision/ETag 전달
- 연락처 삭제 요청, 삭제할 외부 resource 식별자와 클라이언트가 확인한 revision/ETag 전달
- 삭제 대기 상태와 복구 가능 기간 안내
- pending/failed/conflict 작업 목록과 상태 조회
- 실패 작업 재시도 또는 취소
- 충돌 상세 조회와 해결안 제출
- 주소록 쓰기 capability 및 읽기 전용 상태 조회

화면에는 최소한 다음 상태를 구분해서 표시한다.

- 저장됨: EasyStation과 외부 주소록이 일치
- 반영 대기: 로컬에는 저장됐지만 외부 전송 전
- 전송 중
- 재시도 예정
- 충돌 확인 필요
- 외부 반영 실패
- 읽기 전용

사용자가 화면을 닫아도 outbox 작업은 계속되어야 하며, 실패와 충돌은 다음 접속 때 다시 확인할 수 있어야 한다. 저장 버튼을 반복해서 눌러도 중복 생성이나 중복 작업이 생기지 않아야 한다.

### 17.12 보안과 감사

- 모든 쓰기 API와 worker query에서 `tenant_id + user_id` 소유권을 재검증한다.
- browser에는 CardDAV credential, access token, raw 인증 header를 전달하지 않는다.
- 감사 log에는 작업 유형, 대상 계정/주소록/resource의 내부 ID, 결과, HTTP status와 correlation ID를 남긴다.
- 이름, 이메일, 전화번호, note, raw vCard와 token은 일반 log에 남기지 않는다.
- 대량 생성·수정·삭제, export 후 재업로드와 AI 자동 편집에는 별도의 확인과 rate limit을 둔다.
- AI가 제안한 변경은 사용자가 승인하기 전에는 outbox에 넣지 않는다.
- 사용자의 편집 이력과 외부 반영 이력을 개인정보 보존 정책에 따라 삭제할 수 있어야 한다.

### 17.13 단계별 적용 순서

1. **준비 단계**
   - 공급자별 쓰기 capability 조사
   - resource 상태와 outbox schema 설계
   - 감사 log, queue, 계정·resource lock 준비
2. **내부 편집 단계**
   - UI와 API에서 로컬 편집 의도 저장
   - 외부 전송 없이 pending 상태와 취소/복구 동작 검증
3. **제한된 수정 단계**
   - 테스트 주소록에서 ETag 기반 UPDATE부터 활성화
   - 412 충돌과 token 갱신, timeout 재확인 검증
4. **생성 단계**
   - UID/idempotency와 POST/PUT 공급자 차이 검증
   - 생성 성공 여부가 불명확한 경우 중복 방지 검증
5. **삭제 단계**
   - tombstone, 보존 기간, 대량 삭제 차단을 적용한 뒤 활성화
6. **충돌 및 운영 단계**
   - 3-way merge와 사용자 충돌 해결 화면 제공
   - metrics, 경보, retry queue와 운영 복구 절차 확립
7. **점진적 출시**
   - 내부 테스트 계정 → 소수 사용자 opt-in → 공급자별 단계 확대
   - 문제 발생 시 주소록별 쓰기 feature flag를 끄고 읽기 동기화는 유지

### 17.14 테스트 기준

- 생성·수정·삭제 후 Google/iCloud 웹 또는 기기에서 같은 결과가 확인되는지 검증한다.
- 외부에서 수정한 뒤 EasyStation의 오래된 화면에서 저장하여 `412` 충돌이 정상 표시되는지 확인한다.
- 다른 필드 변경은 병합되고 같은 필드 변경은 사용자 선택으로 남는지 확인한다.
- timeout 직전에 서버가 생성 또는 수정한 경우 재시도가 중복 resource를 만들지 않는지 확인한다.
- pending 상태에서 서버 재시작, worker 중단, token 만료가 발생해도 작업이 유실되지 않는지 확인한다.
- 동일 연락처를 여러 탭과 여러 기기에서 편집했을 때 순서와 충돌이 보존되는지 확인한다.
- 읽기 전용 collection, 철회된 인증, scope 부족, `429`, `5xx`를 각각 확인한다.
- 알 수 없는 vCard 속성, 사진, 그룹, 사용자 지정 label이 수정 후에도 보존되는지 비교한다.
- 삭제 후 복구 기간, 원격 `404`, 대량 삭제 차단과 계정 연결 해제를 검증한다.
- 상세 화면에서 삭제 버튼이 편집 버튼 오른쪽에 표시되고, 읽기 전용 연락처에서는 비활성화되는지 확인한다.
- 삭제 확인을 취소하면 로컬 상태, outbox와 외부 연락처가 변경되지 않는지 확인한다.
- 삭제 확인 후 연락처가 즉시 기본 목록에서 숨겨지고 DELETE outbox가 정확히 한 건 생성되는지 확인한다.
- 같은 전화번호 또는 이메일로 연결된 Google·iCloud 연락처 중 하나를 삭제해도 다른 공급자의 연락처와 공유 사진이 유지되는지 확인한다.
- 마지막 연결 연락처를 삭제한 경우 복구 기간 동안 `Person`, 사진, raw vCard와 tombstone이 유지되는지 확인한다.
- 사용자 A의 작업이 사용자 B의 계정이나 연락처에 절대 적용되지 않는지 확인한다.

### 17.15 양방향 편집 완료 조건

- EasyStation의 생성·수정·삭제가 지원되는 외부 주소록에 정확히 한 번의 효과로 반영된다.
- 모든 수정과 삭제가 ETag 조건부 요청을 사용하며 충돌 시 원본을 덮어쓰지 않는다.
- 외부 반영 전후 상태가 UI에 명확히 표시되고 실패 작업을 재시도·취소할 수 있다.
- 서버나 worker가 재시작되어도 pending 작업과 사용자의 편집 의도가 유실되지 않는다.
- 외부 변경과 로컬 pending 변경이 3-way 비교를 통해 병합 또는 충돌 처리된다.
- 읽기 전용 주소록과 쓰기 불가 계정에서는 편집 기능이 안전하게 비활성화된다.
- 공급자 장애나 대량 삭제 징후가 있을 때 쓰기를 중단하고 읽기 동기화와 기존 데이터를 보존한다.
- token, raw credential과 연락처 개인정보가 API 응답이나 일반 log에 노출되지 않는다.

## 18. Google 주소록 상품화 전환 계획

### 18.1 목적과 현재 판단

이 장의 일차 목적은 Google 주소록만 별도 상품으로 만드는 것이 아니다. **EasyStation을 정식 서비스로 제공할 때 일반 사용자가 관리자 개입 없이 자신의 Google 계정을 직접 연결하고 주소록을 사용할 수 있게 하는 것**이다.

현재 Google Cloud의 OAuth 동의 화면이 Testing 상태이고 테스트 사용자 방식으로 운영되어, 새로운 사용자가 Google 계정을 연결하려면 관리자가 Google Cloud Console에 해당 이메일을 먼저 등록해야 한다. 이 방식은 내부 개발과 제한된 검증에는 적합하지만 실제 EasyStation 고객을 대상으로 하는 셀프서비스에는 사용할 수 없다.

목표 상태는 다음과 같다.

```text
EasyStation 사용자가 ContactBook에서 Google 계정 연결 선택
  ↓
Google 로그인 및 EasyStation 연락처 접근 동의
  ↓
관리자의 이메일 사전 등록 없이 OAuth callback 완료
  ↓
사용자 자신의 Google 주소록 연결 및 동기화 시작
  ↓
만료 시 자동 token 갱신, 철회 시 사용자 재인증
```

따라서 최우선 상품화 과제는 **Google OAuth 앱을 테스트 사용자 제한 방식에서 외부 사용자가 이용할 수 있는 운영 게시 상태로 전환하는 것**이다. 그 다음으로 여러 사용자와 대량 연락처, 인증 만료, 동시 편집, 네트워크 장애, 서버 재시작 상황에서도 데이터가 유실되거나 잘못 덮어써지지 않게 해야 한다.

현재 구현되어 확인된 범위는 다음과 같다.

- Google OAuth 2.0 authorization code 방식으로 계정을 연결한다.
- access token과 refresh token을 서버에 암호화하여 저장하고 만료 시 access token을 갱신한다.
- Google CardDAV에서 연락처를 가져와 EasyStation 사용자별 DB에 저장한다.
- 최초 100개를 먼저 표시하고 나머지를 백그라운드에서 페이지 단위로 화면에 불러온다.
- UID가 있는 Google 연락처 전체를 EasyStation에서 수정할 수 있다.
- 기존 raw vCard를 patch하여 UID와 알 수 없는 속성을 최대한 보존한다.
- `If-Match`와 ETag를 사용하는 조건부 `PUT`으로 동시 변경을 감지한다.
- 저장 성공 후 Google에서 같은 resource를 다시 `GET`하여 최종 vCard와 ETag를 로컬 DB에 반영한다.
- Google에서 먼저 변경되어 `412 Precondition Failed`가 발생하면 최신 원격 값을 받아 사용자에게 충돌을 알린다.
- Google에서 변경한 내용은 다음 동기화 때 EasyStation으로 다시 가져온다.

따라서 현재 상태는 **관리자가 사전 승인한 Google 테스트 사용자만 연결 가능한 연락처 조회 및 단건 수정 MVP**로 판단한다. EasyStation 정식 서비스에서 공개하려면 먼저 테스트 사용자 의존성을 제거하고, 이후 아래의 제품 안정성 기준을 완료해야 한다.

### 18.2 정식 출시 범위 결정

첫 정식 버전의 공개 범위를 명확히 고정한다.

#### 권장 1차 상품 범위

- 개인 Google 계정과 지원되는 Google Workspace 계정 연결
- 연락처 목록 조회, 검색, 상세 조회
- 기존 연락처의 이름, 전화번호, 이메일, 회사, 부서, 직책, 별칭과 메모 수정
- Google 외부 변경 가져오기
- ETag 기반 충돌 방지와 최신 원격 값 표시
- 연결 해제, 재인증, 수동 동기화와 안전한 오류 안내

#### 1차 범위에서 제외하거나 별도 Beta로 둘 항목

- 연락처 생성과 삭제
- 사진 변경
- 연락처 그룹 또는 label 편집
- 다중 이메일·전화번호의 추가, 삭제, 순서 및 사용자 지정 label 편집
- 여러 연락처 일괄 수정·삭제
- AI가 자동으로 외부 주소록을 변경하는 기능
- Google 외 다른 공급자의 연락처와 자동 병합

현재 편집 화면은 첫 번째 이메일과 전화번호 중심이므로, 이 제한을 UI와 이용 안내에 명확히 표시한다. 지원하지 않는 필드는 raw vCard에 그대로 보존되어야 하며 사용자가 저장할 때 조용히 삭제되면 안 된다.

### 18.3 Google Cloud 운영 전환

개발·테스트용 OAuth 설정을 그대로 운영에 사용하지 않는다.

#### 현재 문제

- OAuth 동의 화면의 게시 상태가 Testing이면 Google Cloud Console에 등록된 테스트 사용자만 연결할 수 있다.
- 고객이 가입할 때마다 관리자가 Google 이메일을 수동 등록해야 하므로 셀프서비스 가입이 불가능하다.
- 테스트 사용자 수 제한과 테스트 상태의 token 정책 때문에 고객 수 증가와 장기간 연결 유지에 적합하지 않다.
- EasyStation 사용자 등록과 Google Cloud 테스트 사용자 등록이라는 두 개의 관리 절차가 생겨 운영 실수와 고객 지원 비용이 증가한다.

#### 목표 운영 방식

- 사용자는 EasyStation 계정으로 로그인한 뒤 자신의 Google 계정을 직접 연결한다.
- EasyStation 관리자는 개별 고객의 Google 이메일을 Google Cloud Console에 등록하지 않는다.
- Google 계정 선택, 동의, callback, 계정 생성과 최초 동기화가 하나의 셀프서비스 흐름으로 완료된다.
- 사용자가 여러 Google 계정을 보유한 경우 자신이 선택한 계정만 EasyStation 사용자에게 귀속한다.
- 사용자가 권한을 거부하면 계정을 생성하지 않고 다시 연결할 수 있는 안전한 안내를 제공한다.
- 조직 관리자가 OAuth 앱 사용을 제한한 Google Workspace 계정은 EasyStation의 결함과 구분하여 조직 관리자 승인 필요 상태로 안내한다.

#### Google Cloud Console 전환 작업

- 운영 전용 Google Cloud project 또는 명확히 분리된 운영 OAuth client를 사용한다.
- OAuth 동의 화면을 실제 서비스명, 로고, 공식 도메인, 고객 지원 이메일로 구성한다.
- 홈페이지, 개인정보처리방침, 이용약관과 계정·데이터 삭제 안내 URL을 공개 HTTPS 주소로 제공한다.
- 승인된 JavaScript origin과 redirect URI는 운영 도메인만 최소한으로 등록한다.
- 현재 callback인 `https://www.easystation.co.kr/api/contactbook/oauth/google/callback`이 Google Cloud 설정과 완전히 일치하는지 배포마다 검사한다.
- 앱 게시 상태를 Testing에서 Production으로 전환하고 외부 사용자 유형과 조직 내부 사용자 유형을 서비스 정책에 맞게 선택한다.
- 요청 scope는 Google 연락처 기능에 필요한 최소 범위만 유지한다.
- Google에서 민감하거나 제한된 scope로 분류하는 경우 OAuth 앱 검증에 필요한 설명, 데모 영상과 테스트 계정을 준비한다.
- OAuth client secret과 token 암호화 key는 저장소 밖의 운영 secret 관리 체계에서 주입하고 정기 회전 절차를 마련한다.
- 개발·스테이징·운영 client ID, secret, callback과 데이터베이스를 서로 분리한다.

운영 전환은 단순히 테스트 사용자 목록을 늘리는 작업이 아니다. Google 인증 플랫폼에서 앱의 대상 사용자 유형, 브랜딩, 연락처 정보, 승인된 도메인, 데이터 사용 목적과 요청 scope를 운영 서비스 기준으로 구성한 뒤 앱을 Production으로 게시해야 한다. 요청 scope의 분류에 따라 Google의 앱 검증이 필요하면 검증 완료 전까지 정식 공개하지 않는다.

OAuth 앱이 Testing 상태이면 일반 고객 연결이 제한되거나 refresh token 수명 정책이 운영과 다를 수 있으므로, **Production 게시와 필요한 검증 완료를 EasyStation 외부 고객 출시의 필수 선행 조건**으로 둔다. 기존 테스트 사용자는 개발·스테이징 환경에서만 유지한다.

#### EasyStation 셀프서비스 연결 기준

- `Google 계정 연결` 버튼은 로그인한 EasyStation 사용자만 사용할 수 있다.
- 연결 시작 시 서버가 사용자·tenant에 귀속된 일회용 `state`와 PKCE 값을 생성한다.
- callback에서는 Google 이메일 문자열만 신뢰하지 않고 Google의 안정적인 subject ID를 확인한다.
- 동일 EasyStation 사용자가 동일 Google 계정을 다시 연결하면 중복 계정을 만들지 않는다.
- 다른 EasyStation 사용자가 같은 Google 계정을 연결하는 정책은 서비스 약관과 tenant 격리 원칙에 따라 명시적으로 결정한다.
- 연결 완료 후 자동으로 최초 동기화를 시작하고 진행 상태를 사용자에게 표시한다.
- 관리자는 개별 연결을 승인하는 사람이 아니라 OAuth 앱 상태, 실패율, 보안 경보와 공급자 장애를 운영하는 역할을 맡는다.
- 고객 지원 화면에는 token이나 연락처 본문 없이 연결 단계와 안전한 오류 코드만 제공한다.

### 18.4 인증과 계정 생명주기

- OAuth `state`는 로그인 사용자, tenant, 목적, 만료 시각에 귀속하고 한 번만 소비한다.
- PKCE를 항상 사용하고 callback code 교환은 백엔드에서만 수행한다.
- 실제 발급 scope를 저장하고 필요한 연락처 scope가 빠졌으면 연결 성공으로 처리하지 않는다.
- 동일 사용자가 같은 Google 계정을 다시 연결하면 중복 계정을 만들지 않고 기존 연결을 갱신한다.
- access token은 만료 전에 갱신하고 refresh token이 새로 오지 않으면 기존 값을 유지한다.
- `invalid_grant`, token 철회, 비밀번호·조직 정책 변경을 구분해 계정을 `AUTH_REQUIRED`로 전환한다.
- 인증 실패 상태에서는 자동 재시도를 반복하지 않고 사용자가 재인증할 수 있게 한다.
- 연결 해제 시 로컬 token을 즉시 폐기하고 가능한 경우 Google revoke endpoint도 호출한다.
- 계정 연결 해제가 Google 연락처 삭제를 의미하지 않는다는 점을 확인 화면에 명시한다.
- 사용자가 요청하면 로컬에 동기화된 연락처와 관련 인증·감사 데이터를 정책에 따라 삭제할 수 있어야 한다.

### 18.5 동기화 엔진의 상품화

현재 수동 전체 동기화가 정상 작동하더라도 고객 수와 연락처 수가 늘어나면 요청 하나가 모든 연락처를 직렬 처리하는 구조는 timeout과 중복 실행에 취약하다.

- 최초 동기화, 증분 동기화, 사용자 요청 동기화를 background job으로 실행한다.
- 계정·주소록별 lock을 두어 동일 계정 동기화가 동시에 실행되지 않게 한다.
- Google이 제공하는 sync token 또는 동등한 증분 기준을 사용할 수 있으면 저장하고, 만료 시에만 전체 동기화로 복구한다.
- 전체 동기화 중 일부 batch가 실패하면 성공분과 실패 지점을 기록하고 안전하게 이어서 처리한다.
- 원격 목록 조회 실패를 원격 삭제로 판단하지 않는다.
- 성공한 전체 목록을 확보한 뒤에만 보이지 않는 resource를 삭제 후보로 표시한다.
- 삭제는 즉시 hard delete하지 않고 tombstone과 보존 기간을 둔다.
- `429`와 일시적 `5xx`, timeout은 지수 backoff, jitter와 `Retry-After`를 사용하여 재시도한다.
- 사용자별·계정별 동기화 rate limit과 전체 worker concurrency를 제한한다.
- 대량 연락처에서도 최초 화면 응답 시간과 백그라운드 전체 적재 시간이 운영 목표를 만족하는지 측정한다.

### 18.6 쓰기 처리의 상품화

현재 동기식 단건 `PUT`은 수정 MVP에는 적합하지만 서버 재시작이나 외부 장애가 저장 도중 발생하면 사용자의 편집 의도를 지속적으로 추적하기 어렵다. 정식 버전에서는 17장의 Outbox 설계를 적용한다.

- 편집 요청과 `base_etag`, 기준 vCard, 원하는 vCard를 DB transaction으로 Outbox에 저장한다.
- worker가 조건부 `PUT`을 수행하고 성공 후 Google에서 다시 읽어 `APPLIED`로 확정한다.
- 네트워크 timeout으로 성공 여부가 불분명하면 무조건 재전송하지 않고 먼저 원격 resource와 ETag를 조회한다.
- 동일 연락처에 대한 작업은 순서대로 처리하고 저장 버튼을 반복해도 중복 작업이 생성되지 않게 한다.
- `401`, `403`, `409/412`, `429`, `5xx`를 서로 다른 상태와 사용자 조치로 매핑한다.
- Google scope 부족과 주소록 읽기 전용 상태에서는 편집 버튼을 제공하지 않는다.
- 조건 없는 `PUT`과 무조건 덮어쓰기는 금지한다.
- 공급자 장애 시 Google 쓰기 feature flag만 즉시 끄고 읽기 및 기존 로컬 데이터 조회는 유지할 수 있게 한다.

연락처 생성과 삭제를 상품 범위에 포함하려면 UPDATE 안정화 후 별도 단계로 출시한다. 생성은 안정적인 UID와 중복 방지 전략, 삭제는 ETag 조건부 `DELETE`, tombstone, 복구 기간과 대량 삭제 차단이 준비된 후에만 활성화한다.

### 18.7 충돌과 데이터 보존

- 사용자가 본 `Base`, 사용자가 만든 `Local`, Google 최신 `Remote`의 3-way 비교를 구현한다.
- 서로 다른 필드의 변경만 안전성이 확인된 경우 자동 병합한다.
- 같은 필드를 양쪽에서 변경했으면 사용자에게 두 값을 보여주고 선택하게 한다.
- 이메일과 전화번호는 값뿐 아니라 type, label, 선호 여부와 순서를 함께 비교한다.
- 사진, 그룹, 사용자 지정 속성과 알 수 없는 vCard 속성은 손실 여부를 회귀 테스트한다.
- `내 변경 사용`을 선택하더라도 최신 Remote ETag를 기준으로 다시 조건부 요청한다.
- 충돌 해결 전 사용자의 편집 의도와 세 버전을 삭제하지 않는다.
- 외부 변경 동기화가 로컬 pending 변경을 덮어쓰지 않도록 한다.

### 18.8 사용자 경험

화면에서 다음 상태를 구분해 표시한다.

- Google에 저장됨
- Google 반영 대기 중
- 전송 중
- 재시도 예정
- 충돌 확인 필요
- 재인증 필요
- 권한 또는 scope 부족
- 읽기 전용
- 외부 반영 실패

추가 UI 기준은 다음과 같다.

- 최초 100개가 보인 뒤 나머지를 가져오는 진행 상태와 완료 여부를 표시한다.
- 목록의 총 개수와 실제 로컬 적재 개수를 혼동하지 않게 한다.
- 마지막 성공 동기화 시각과 최근 안전한 오류 요약을 계정 카드에 표시한다.
- 저장 버튼을 여러 번 누르지 않도록 진행 상태를 표시하되, 화면을 닫아도 작업은 계속되어야 한다.
- 충돌 화면에서 내 값과 Google 값을 필드별로 비교할 수 있게 한다.
- 지원하지 않는 필드와 1차 출시 제한 사항을 편집 화면에서 안내한다.
- 계정 삭제, 로컬 데이터 삭제와 Google 원본 삭제를 서로 다른 동작으로 구분한다.

### 18.9 보안, 개인정보와 감사

- 모든 API와 worker query에서 `tenant_id + user_id + account_id` 소유권을 검증한다.
- access token, refresh token, client secret과 token 암호화 key를 브라우저 또는 일반 log에 노출하지 않는다.
- raw vCard와 이름, 이메일, 전화번호, 주소, 메모를 일반 운영 log에 기록하지 않는다.
- 로그에는 correlation ID, 내부 account/resource ID, 동작, 단계, HTTP status, 안전한 오류 코드만 기록한다.
- token과 raw vCard 암호화의 key rotation 및 기존 ciphertext 재암호화 절차를 마련한다.
- 관리자도 필요 이상으로 다른 사용자의 연락처 본문을 조회할 수 없게 권한과 감사 정책을 둔다.
- 개인정보처리방침에 수집 항목, 이용 목적, Google 데이터 사용 방식, 보관 기간, 제3자 제공, 삭제 방법을 반영한다.
- Google API Services User Data Policy와 Limited Use 요구 사항 적용 여부를 법무·운영 검토에 포함한다.
- 데이터 export, 계정 연결 해제, 회원 탈퇴와 보존 기간 만료 시 삭제 절차를 자동화한다.
- 백업에도 동일한 접근 통제, 암호화와 보존 기간을 적용한다.

### 18.10 관측성 및 운영 대응

최소한 다음 지표를 공급자·환경별로 수집한다.

- OAuth 연결 성공률과 callback 실패 코드
- token refresh 성공률과 `AUTH_REQUIRED` 전환 수
- 동기화 계정 수, 처리 연락처 수, 지연 시간과 실패율
- CardDAV HTTP status별 요청 수
- 수정 성공률, 확인 GET 실패율과 ETag 충돌률
- pending/retry/conflict/failed Outbox 수와 가장 오래된 작업의 대기 시간
- `429`, timeout과 `5xx` 비율
- 사용자별 연락처 수와 batch 처리 시간의 분포

연락처 본문이나 token을 포함하지 않는 dashboard와 alert를 구성한다. 장애 대응 문서에는 Google 장애, OAuth 설정 오류, scope 누락, token 대량 철회, queue 적체, 잘못된 대량 변경 징후와 암호화 key 사고의 확인·차단·복구 절차를 포함한다.

### 18.11 테스트 체계

#### 자동 테스트

- OAuth state 생성·만료·변조·재사용과 PKCE 검증
- token 갱신, refresh token 보존과 인증 철회 처리
- 사용자·tenant·계정 간 접근 차단
- vCard 3.0의 한글, 다국어, 줄 접기, escape, quoted-printable과 사용자 지정 속성
- 단일·다중 이메일과 전화번호, label, 조직, 메모와 빈 값 처리
- `If-Match` 포함 여부와 `412` 충돌 처리
- timeout, `401`, `403`, `404`, `409/412`, `429`, `5xx` 처리
- 저장 후 확인 GET과 DB projection 일치
- 동기화와 쓰기가 겹칠 때 pending 변경 보존
- 재시작 후 Outbox 복구와 중복 전송 방지

#### 통합 및 실서비스 유사 테스트

- 별도 Google 개인 계정과 Google Workspace 테스트 계정을 사용한다.
- 0개, 1개, 100개, 5천 개 이상 연락처 계정에서 동작과 성능을 확인한다.
- EasyStation 수정 후 Google Contacts 웹과 모바일 기기에서 반영을 확인한다.
- Google에서 수정 후 EasyStation 동기화 결과를 확인한다.
- 두 화면에서 같은 필드와 다른 필드를 동시에 수정하여 충돌·병합을 확인한다.
- token 만료, 권한 철회, 서버 재시작과 네트워크 단절 중에도 작업이 유실되지 않는지 확인한다.
- 수정 전후 vCard를 비교하여 지원하지 않는 속성이 사라지지 않는지 확인한다.

운영 데이터로 파괴적 자동 테스트를 실행하지 않는다. 테스트 계정과 테스트 주소록을 사용하고 생성·수정·삭제 테스트는 실행 전후 UID 목록을 비교해 정리한다.

### 18.12 단계별 출시 계획

1. **셀프서비스 OAuth 전환 준비**
   - 테스트 사용자 사전 등록이 필요한 현재 운영 상태를 외부 출시 차단 조건으로 명시
   - 운영 Google Cloud project와 OAuth client 결정
   - 홈페이지, 개인정보처리방침, 이용약관, 고객 지원과 데이터 삭제 안내 공개
   - 동의 화면 브랜딩, 승인된 도메인, redirect URI와 최소 scope 확정
2. **Google 앱 운영 게시**
   - OAuth 앱을 Production으로 게시
   - 요청 scope에 필요한 Google 검증 완료
   - 관리자 사전 등록 없이 신규 개인 Google 계정으로 연결 시험
   - Google Workspace의 허용 계정과 조직 관리자 차단 계정을 각각 시험
3. **상품 범위 고정**
   - 1차 버전을 기존 연락처 조회·수정으로 제한
   - 지원 필드와 제외 기능을 제품 화면과 약관에 반영
4. **쓰기 내구성 확보**
   - Outbox, worker, 상태 표시, 재시도와 멱등성 구현
   - 서버 재시작 및 timeout 테스트 통과
5. **충돌과 데이터 보존 완성**
   - 3-way 비교와 충돌 해결 UI
   - 알 수 없는 vCard 속성 보존 회귀 테스트 통과
6. **보안·운영 준비**
   - secret 관리, key rotation, 감사, metrics, alert와 장애 대응 절차 준비
   - 개인정보 및 Google 사용자 데이터 정책 검토 완료
7. **단계적 공개**
   - 사내 계정
   - Google Cloud 테스트 사용자로 등록하지 않은 소수 고객의 opt-in Beta
   - 오류율과 데이터 손실 여부를 검토한 제한 공개
   - 목표 지표를 충족하면 정식 공개
8. **후속 기능**
   - 기존 연락처 수정 안정화 후 생성
   - tombstone과 대량 삭제 보호 완성 후 삭제
   - 그룹, 사진, 다중 값 전체 편집은 별도 검증 후 추가

각 단계에는 Google 쓰기를 즉시 비활성화할 수 있는 server-side feature flag와 rollback 기준을 둔다. rollback은 새 쓰기 요청만 차단하고 기존 pending 작업, 읽기 동기화와 로컬 조회를 안전하게 보존해야 한다.

### 18.13 출시 승인 기준

다음 조건을 모두 만족할 때 Google 주소록을 테스트 표시에서 정식 상품 기능으로 전환한다.

- Google OAuth 앱이 Production 운영 게시 상태이며 필요한 검증과 공식 정책 페이지가 준비되어 있다.
- 신규 고객의 Google 이메일을 관리자가 테스트 사용자로 등록하지 않아도 연결이 완료된다.
- 개인 Google 계정과 허용된 Google Workspace 계정의 셀프서비스 연결·재인증·연결 해제가 검증되어 있다.
- 조직 정책으로 차단된 Workspace 계정에는 관리자 사전 등록 문제와 구분되는 정확한 안내가 제공된다.
- 운영 secret과 암호화 key가 저장소 밖에서 관리되고 회전·복구 절차가 검증되어 있다.
- 사용자 및 tenant 간 연락처와 token 격리 테스트가 통과한다.
- 최초·증분·수동 동기화가 중복 실행과 부분 실패 상황에서도 데이터 손실 없이 복구된다.
- 모든 수정이 ETag 조건부 요청을 사용하고 충돌 시 Google 원본을 무조건 덮어쓰지 않는다.
- 저장 도중 서버가 재시작되어도 사용자의 편집 의도와 작업 상태가 유실되지 않는다.
- 지원하지 않는 vCard 속성과 다중 값이 수정 후에도 보존된다.
- 사용자에게 저장·대기·실패·충돌·재인증 상태가 정확히 표시된다.
- metrics, alert, 감사 log와 공급자별 kill switch가 운영 환경에서 동작한다.
- 개인정보 삭제, 연결 해제, 회원 탈퇴와 token 철회 절차가 검증되어 있다.
- 소수 사용자 Beta에서 정의한 기간 동안 치명적 데이터 손실 또는 다른 계정 오수정이 발생하지 않는다.

이 승인 기준을 충족하기 전에는 화면과 영업 문서에서 기능을 `Google 주소록 수정 Beta`로 표시한다. 단건 수정 성공만으로 `완전한 양방향 동기화`라고 표현하지 않는다.
