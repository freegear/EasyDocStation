# 메일 모드 상단 검색 기능 구현 검토 결과

- 검토일: 2026-09-03
- 대상: 메일 화면 활성화 시 상단의 게시글·댓글 검색을 메일 전용 검색으로 전환
- 요구 검색 항목: `보낸사람`, `받는사람`, `참조`, `제목`, `모든`, `파일`

## 1. 결론

현재 코드는 메일 화면 안에 간단한 문자열 필터를 제공하지만, 요청한 메일 검색 기능은 구현되어 있지 않다.

현재 검색은 이미 화면에 불러온 최대 100개의 메일만 브라우저에서 필터링한다. 검색 항목을 선택할 수 없고, 주소의 정확한 일치와 제목·첨부파일명·본문 전체 검색을 구분하지 않는다. 상단 검색창은 메일 화면에서도 계속 게시글·댓글 검색을 실행한다.

검색 대상은 화면에 로드된 100개가 아니라 로그인 사용자가 보유한 전체 메일이어야 한다. `limit=50` 또는 `limit=100` 같은 값은 검색 범위를 제한하는 값으로 사용하면 안 되며, 전체 결과를 여러 페이지로 나누어 전송할 때의 페이지 크기로만 사용해야 한다.

요구사항을 충족하려면 다음 세 영역을 함께 변경해야 한다.

1. `TitleBar`가 현재 화면 모드를 인식해 게시판 검색과 메일 검색 UI를 분리한다.
2. 메일 전체를 검색하는 서버 API와 tenant/user 권한 필터를 추가한다.
3. object storage에만 있는 메일 본문을 검색할 수 있도록 동기화 시 검색용 본문 인덱스를 저장하고 기존 메일을 backfill한다.

특히 `모든` 검색을 현재 `snippet`으로 대신 구현하면 본문 앞부분에 없는 문자열을 찾지 못하므로 완료된 구현으로 볼 수 없다.

## 2. 요구사항 해석과 확정 검색 규칙

화면 레이블과 API 내부 키는 다음처럼 고정하는 것을 권장한다.

| 화면 항목 | API `field` | 일치 규칙 | 검색 대상 |
|---|---|---|---|
| 보낸사람 | `from` | 이메일 주소 전체 정확히 일치 | `from_email` |
| 받는사람 | `to` | 수신자 중 하나의 이메일 주소 전체 정확히 일치 | `to_json[].email` |
| 참조 | `cc` | 참조 수신자 중 하나의 이메일 주소 전체 정확히 일치 | `cc_json[].email` |
| 제목 | `subject` | 대소문자 구분 없는 부분 문자열 일치 | `subject` |
| 모든 | `all` | 대소문자 구분 없는 부분 문자열 일치 | 보낸사람·받는사람·참조의 이름과 주소, 제목, 정제된 전체 본문 |
| 파일 | `file` | 대소문자 구분 없는 부분 문자열 일치 | `mail_attachments.filename` |

세 주소 전용 검색은 앞뒤 공백을 제거하고 이메일 주소를 소문자로 정규화한 뒤 정확히 비교한다. 예를 들어 ` User@Example.com `은 `user@example.com`과 일치하지만 `user` 또는 `@example.com`만 입력한 검색은 실행하지 않는다. 표시 이름은 주소 전용 검색의 일치 대상이 아니다.

`모든`은 검색 필드 전체라는 뜻이며 모든 폴더라는 뜻과 혼동하지 않게 해야 한다. `모든`에는 요구사항에 열거되지 않은 숨은 참조(`bcc`)와 첨부파일명이 포함되지 않는다. 첨부파일명은 `파일`에서 검색한다.

`파일의 제목`은 첨부파일 내부 문서 제목이나 파일 내용이 아니라 저장된 원본 파일명으로 해석한다. 파일 내용 검색은 별도의 문서 추출·OCR 요구사항이다.

공통 규칙은 다음과 같다.

- 빈 문자열과 공백만 있는 문자열은 검색하지 않는다.
- `%`, `_`, 역슬래시 등 SQL wildcard 문자는 일반 문자로 검색한다.
- 한글·영문 제목과 본문은 Unicode 정규화 후 비교한다.
- 결과는 `received_at`, `sent_at`, `created_at` 순으로 계산한 메일 시각의 최신순으로 정렬하고 `id`를 보조 정렬 키로 사용한다.
- 같은 메일이 여러 조건과 일치하거나 스마트 폴더 태그가 여러 개여도 한 번만 반환한다.

## 3. 검색 범위 확정안

메일 모드 검색의 후보 집합은 **현재 화면에 로드된 목록이 아니라 로그인 사용자가 보유한 전체 메일**로 고정한다.

- 로그인 사용자가 연결한 모든 메일 계정
- 해당 계정의 모든 실제 폴더
- 사용자 메일이 여러 mail tenant 또는 shared/dedicated DB에 나뉘어 있으면 모든 저장 위치
- 아직 화면에 한 번도 표시하지 않은 과거 메일
- 현재 무한 스크롤 목록의 첫 100개 이후에 있는 메일
- 휴지통과 스팸 폴더의 메일
- `deleted_at IS NOT NULL`인 영구 삭제 메일만 제외
- 사이트 관리자도 일반 검색에서는 현재 로그인 사용자 이외의 개인 메일을 검색하지 않음

따라서 클라이언트의 `messages`, `displayedMessages`, `currentTenantId`만으로 검색 범위를 정하면 안 된다. 서버가 인증 세션의 `user_id`로 사용자의 mail tenant와 연결 계정을 확인하고, 각 tenant data plane의 전체 검색 인덱스를 조회해야 한다.

### 3.1 전체 검색과 결과 페이징의 차이

검색 범위와 한 번에 내려주는 결과 개수는 서로 다른 개념이다.

```text
검색 후보: 해당 사용자의 전체 메일 N건
필터 적용: N건 전체에 field + query 조건 적용
정렬: 전체 일치 결과를 최신순 정렬
응답: 정렬된 결과 중 첫 50건과 nextCursor 반환
추가 요청: 같은 전체 결과에서 다음 50건 반환
```

서버 쿼리의 `LIMIT`은 반드시 검색 조건을 전체 사용자 메일에 적용한 뒤 실행한다. 메일 목록 API에서 먼저 100건을 가져온 다음 그 배열을 검색하거나, tenant별 첫 100건만 가져와 합치는 방식은 금지한다.

페이지 크기는 50 또는 100으로 제한할 수 있지만 사용자는 다음 페이지를 계속 불러와 모든 검색 결과를 확인할 수 있어야 한다. 화면에 표시하는 결과 수 역시 현재 로드한 배열 길이가 아니라 서버가 전체 검색 범위에서 계산한 `total`을 사용한다.

검색 결과에는 tenant, 계정과 실제 폴더 이름을 표시해 서로 다른 계정과 휴지통·스팸 결과를 사용자가 구분할 수 있게 한다. 제품 정책상 휴지통과 스팸을 기본 제외해야 한다면 API에 추후 `includeJunk` 옵션을 추가할 수 있지만, 첫 구현에서 화면과 서버가 서로 다른 암묵적 범위를 사용해서는 안 된다.

### 3.2 사용자 격리 제약사항 — 필수

검색 범위의 사용자 경계는 기능 옵션이 아니라 변경할 수 없는 보안 제약이다. 검색 결과에는 **현재 인증된 사용자가 소유한 메일만** 포함하며 다른 사용자의 메일은 어떤 경우에도 포함하지 않는다.

- 검색 대상 `user_id`는 요청 body나 query가 아니라 서버 인증 세션의 `req.user.id`만 사용한다.
- 클라이언트가 `userId`, 다른 사용자의 계정 ID 또는 tenant ID를 보내도 검색 범위를 변경할 수 없다.
- 메일, 검색 문서, 첨부파일을 조회하는 모든 SQL에 `mm.user_id = req.user.id`를 적용하고 join 대상의 `user_id`도 일치시킨다.
- 같은 tenant의 구성원이라는 사실만으로 다른 구성원의 메일을 검색할 권한을 부여하지 않는다.
- `site_admin`, tenant owner, team admin도 일반 메일 검색 API에서는 다른 사용자의 메일을 검색할 수 없다. 별도 감사 기능이 필요하면 별도 권한·API·감사 로그를 갖춘 기능으로 분리한다.
- 검색 결과, `total`, 일치 미리보기와 cache에 다른 사용자의 메일 정보가 섞이지 않도록 cache key에도 인증된 `user_id`를 포함한다.

사용자 필터는 검색 결과를 만든 뒤 프론트에서 제거하는 방식이 아니라 DB 검색 조건의 가장 안쪽에서 적용해야 한다. 다른 사용자의 제목·주소·본문·첨부파일명은 결과 건수 계산이나 일치 여부 판단 단계에도 읽히거나 노출되어서는 안 된다.

## 4. 현재 구현 확인

### 4.1 상단 검색은 게시글·댓글 전용이다

[`src/components/TitleBar.jsx`](../src/components/TitleBar.jsx)의 `SearchBar`는 `useChat()`에서 `performSearch`, `searchTerm`, `searchResults`, `isSearchMode`를 직접 가져온다. 입력 중 미리보기 역시 현재 브라우저에 로드된 게시글과 댓글을 순회한다.

`TitleBar`는 이미 `showMail`을 prop으로 받지만 아이콘 활성 표시에만 사용하고 검색 종류를 전환하지 않는다. 따라서 메일 아이콘이 활성화되어도 상단 검색 submit은 `/posts/search`로 전달된다.

### 4.2 게시글 검색 결과 상태가 메일 검색에 재사용되면 안 된다

[`src/contexts/ChatContext.jsx`](../src/contexts/ChatContext.jsx)의 `performSearch()`는 검색과 동시에 `isSearchMode=true`로 바꾸고 `/posts/search`를 호출한다. 이 상태는 [`src/App.jsx`](../src/App.jsx)에서 `SearchResultsArea`와 `ChatArea`를 전환하는 게시판 전용 상태다.

메일 검색이 이 상태를 재사용하면 다음 문제가 생긴다.

- 메일을 검색했는데 게시판 중앙 영역이 열릴 수 있다.
- 메일 결과와 게시글 결과의 데이터 형태가 달라 렌더링할 수 없다.
- 메일 화면을 나갔을 때 마지막 게시글 검색 결과가 의도치 않게 덮어써진다.
- 메일 tenant/account 범위가 `ChatContext`의 team/channel 범위와 섞인다.

메일 검색 상태는 `ChatContext`와 분리해야 한다.

### 4.3 메일 화면 내부 검색은 현재 페이지의 클라이언트 필터다

[`src/features/mail/MailPage.jsx`](../src/features/mail/MailPage.jsx)의 `mailSearchQuery`와 `displayedMessages`는 현재 `messages` 배열에서 다음 값을 이어 붙여 부분 문자열을 찾는다.

- 제목
- 목록용 `snippet`
- 보낸사람 이름과 주소
- 받는사람 이름과 주소
- 참조 이름과 주소
- 별도 API로 찾은 개인 메모

하지만 초기 목록은 `MAIL_PAGE_SIZE=100`이고 나머지는 스크롤할 때 추가된다. 따라서 아직 불러오지 않은 메일은 검색되지 않는다. 첨부파일명과 전체 본문도 목록 응답에 없기 때문에 검색되지 않는다. 주소 검색도 정확한 주소 비교가 아닌 전체 문자열 부분 일치다.

또한 메일 사이드바의 `검색` 항목은 `unified:search`라는 메뉴 키만 제공한다. 서버의 통합 목록 쿼리는 이 키에 실제 검색 조건을 추가하지 않으므로 현재는 검색 결과 폴더가 아니라 사실상 필터 없는 목록에 가깝다.

### 4.4 서버 메시지 목록 API에는 검색 조건이 없다

[`server/routes/mail.js`](../server/routes/mail.js)의 `GET /api/mail/messages`는 account/folder, unified folder, smart folder, unread, limit, offset만 처리한다.

[`server/mail/repository.js`](../server/mail/repository.js)의 `listMessages`, `listUnifiedMessages`, `listSmartFolderMessages`도 검색어 또는 검색 필드를 받지 않는다. 목록 응답에는 제목, 주소 JSON, snippet, 첨부 존재 여부만 있으며 첨부파일명과 전체 본문은 없다.

### 4.5 전체 본문은 DB 목록 행에 없다

[`server/mail/schema.js`](../server/mail/schema.js)의 `mail_messages`에는 `body_text_object_key`, `body_html_object_key`만 저장된다. 본문 원문은 object storage에 있고, [`server/routes/mail.js`](../server/routes/mail.js)의 단건 상세 조회가 해당 object를 읽어 `body_text`와 `body_html`을 반환한다.

`mail_message_summaries.clean_body_text`도 존재하지만 요약을 생성한 메일에만 생기고 언어별 요약 행에 종속된다. 모든 메일의 완전한 검색 인덱스로 사용할 수 없다.

메일마다 검색할 때 object storage의 본문을 순차로 읽는 방법은 응답 시간, storage 비용, 동시 요청 수 때문에 사용할 수 없다.

### 4.6 첨부파일명 데이터는 검색 가능하지만 인덱스가 없다

`mail_attachments`에는 `message_id`와 `filename`이 있으므로 파일명 검색 데이터 자체는 이미 있다. 다만 현재 인덱스는 `message_id` 기준뿐이며 `%검색어%` 파일명 검색을 위한 trigram 인덱스는 없다.

### 4.7 결과 선택에 필요한 메일 열기 기반은 이미 있다

`MailPage`의 `initialMailLink` 처리와 `GET /api/mail/messages/:id`는 `tenantId + messageId`로 메일을 찾고, 실제 계정·폴더로 전환한 뒤 상세를 여는 흐름을 이미 제공한다. 검색 결과 선택도 이 흐름 또는 같은 내부 함수를 재사용할 수 있다.

### 4.8 모바일 메일 모드는 상위 `TitleBar`에서 알 수 없다

데스크톱은 `App`의 `showMail` 상태가 `TitleBar`와 `MailPage`에 함께 전달된다. 반면 [`src/components/MobileLayout.jsx`](../src/components/MobileLayout.jsx)는 내부 `tab` 상태로 메일 화면을 열며 이 값을 `App`에 알리지 않는다. 모바일 상단 검색도 올바르게 전환하려면 활성 탭 상태를 상위로 올리거나 `onActiveModeChange` 콜백을 추가해야 한다.

## 5. 권장 UI 동작

### 5.1 화면 모드별 검색창

게시판 모드와 메일 모드는 별도 컴포넌트로 분리하는 편이 안전하다.

```text
게시판: [ 게시글 및 댓글 검색...                         ] [검색] [검색 결과 보기]
메일:   [모든 ▼] [ 메일 검색...                          ] [검색]
```

메일 검색 항목 선택기는 입력창 왼쪽에 둔다. 기본값은 가장 일반적인 `모든`으로 한다. 선택 목록의 표시 순서는 요구사항과 동일하게 유지한다.

1. 보낸사람
2. 받는사람
3. 참조
4. 제목
5. 모든
6. 파일

검색 항목을 선택하면 입력 placeholder도 바꾼다.

- 보낸사람: `보낸사람 이메일 주소 검색...`
- 받는사람: `받는사람 이메일 주소 검색...`
- 참조: `참조 이메일 주소 검색...`
- 제목: `메일 제목 검색...`
- 모든: `메일 검색...`
- 파일: `첨부파일명 검색...`

주소 전용 검색에서 이메일 형식이 완전하지 않으면 서버 요청 전에 입력창 아래에 오류를 표시한다. 키보드 Enter와 `검색` 버튼은 같은 submit 함수를 사용한다.

### 5.2 결과 표시

상단에서 검색을 실행하면 `MailPage`의 활성 목록을 `검색 결과`로 바꾸고 다음을 표시한다.

- 검색 항목과 검색어
- 서버가 반환한 전체 결과 수
- 각 결과의 계정, 폴더, 보낸사람, 제목, 날짜, 첨부 여부
- 일치한 필드와 짧은 안전한 미리보기
- 결과 초기화 또는 이전 폴더로 돌아가기

결과를 선택하면 같은 메일 화면의 상세 패널에서 메일을 연다. 목록 검색은 읽음 상태를 바꾸지 않고, 사용자가 결과를 선택해 상세 API를 호출한 때에만 기존 정책대로 읽음 처리한다.

메일 모드에서는 검색 submit 직후 결과 목록을 보여주므로 게시판용 `검색 결과 보기` 버튼은 숨기는 것을 권장한다. 버튼을 유지해야 한다면 반드시 메일의 마지막 검색 결과를 다시 여는 동작으로 분기하고 `ChatContext.toggleSearchResults()`를 호출해서는 안 된다.

### 5.3 기존 메일 목록 안 검색창 처리

상단 검색과 `MailPage` 내부 검색창을 서로 다른 규칙으로 동시에 유지하면 같은 검색어에 다른 결과가 나타난다. 다음 중 한 가지로 통일해야 한다.

1. 상단 메일 검색을 유일한 검색 UI로 사용하고 목록 내부 입력창을 제거한다. 권장안이다.
2. 목록 내부 입력창을 같은 controlled 검색 상태와 같은 서버 API에 연결한다.

현재의 로드된 목록 클라이언트 필터는 제거한다. 메일 상세 주소 메뉴의 `주소로 검색`도 공통 검색 요청을 사용하고, 가능하면 클릭한 행에 따라 `from`, `to`, `cc`를 함께 전달한다.

### 5.4 상태 독립성

게시판 검색과 메일 검색은 다음처럼 독립적으로 유지한다.

```text
MainLayout
├─ boardSearchState  → ChatContext / SearchResultsArea
└─ mailSearchRequest → TitleBar.MailSearchBar → MailPage
```

메일 화면 진입이 기존 게시판 검색 결과를 삭제할 필요는 없다. 다만 메일 검색이 게시판 검색어와 결과를 수정해서는 안 된다. 사용자가 다시 게시판으로 돌아오면 이전 게시판 검색 상태를 복원할 수 있다.

## 6. 권장 클라이언트 구조

`MainLayout`에 실행 요청만 나타내는 별도 상태를 둔다.

```js
{
  field: 'all',
  query: '계약서',
  requestId: 17
}
```

권장 흐름은 다음과 같다.

1. `TitleBar`는 `searchMode={showMail ? 'mail' : 'board'}`를 받는다.
2. 메일 모드에서는 `MailSearchBar`를 렌더링하고 `onMailSearch({ field, query })`를 호출한다.
3. `App`은 `requestId`를 증가시킨 새 `mailSearchRequest`를 `MailPage`에 전달한다.
4. `MailPage`는 현재 화면의 `messages`나 `currentTenantId`로 범위를 제한하지 않고 사용자 전체 메일 검색 API를 호출한다.
5. 응답 sequence를 비교해 과거 요청이 최신 결과를 덮어쓰지 못하게 한다.
6. 결과 클릭은 기존 `selectMessage()` 또는 공통화한 `openMessageById()`를 사용한다.

`MailPage`가 아직 lazy loading 중이어도 검색 요청을 잃지 않아야 한다. 사용자 전체 검색 범위는 서버가 인증 세션으로 결정하므로 특정 tenant 메타데이터의 로딩 완료를 검색 실행 조건으로 삼지 않는다. `requestId`가 바뀐 마지막 요청을 보관했다가 화면 준비 후 실행한다.

모바일은 `MobileLayout`에 `activeMode`, `mailSearchRequest`를 prop으로 전달하거나 내부 `tab` 변경을 `onActiveModeChange(tab)`로 `MainLayout`에 알려야 한다. 상위 `TitleBar`의 모바일 검색창도 같은 `MailSearchBar`를 재사용한다.

## 7. 서버 API 설계

기존 목록 API에 여러 선택적 조건을 계속 추가하기보다 검색 전용 endpoint를 권장한다.

```text
GET /api/mail/messages/search
  ?field=from|to|cc|subject|all|file
  &q={query}
  &limit=50
  &cursor={opaque-next-cursor}
```

이 라우트는 Express의 `/messages/:id`보다 먼저 선언해야 `search`가 message ID로 해석되지 않는다.

권장 응답은 다음과 같다.

```json
{
  "items": [
    {
      "id": "message-id",
      "tenant_id": "tenant-id",
      "account_id": "account-id",
      "account_email": "me@example.com",
      "folder_id": "folder-id",
      "folder_name": "받은 편지함",
      "folder_type": "inbox",
      "subject": "계약서 검토 요청",
      "from_name": "홍길동",
      "from_email": "hong@example.com",
      "to_json": [],
      "cc_json": [],
      "snippet": "...",
      "has_attachments": true,
      "received_at": "2026-09-03T01:00:00.000Z",
      "matched_fields": ["subject"],
      "match_preview": "계약서 검토 요청"
    }
  ],
  "total": 1,
  "limit": 50,
  "hasMore": false,
  "nextCursor": null
}
```

서버 검증은 다음을 적용한다.

- `field` whitelist 외 값은 `400 MAIL_SEARCH_FIELD_INVALID`
- 빈 검색어는 `400 MAIL_SEARCH_QUERY_REQUIRED`
- 주소 전용 검색의 잘못된 이메일은 `400 MAIL_SEARCH_EMAIL_INVALID`
- 검색어 최대 길이와 `limit` 최대값을 서버에서 제한
- 검색 범위용 `tenantId`나 `userId`를 클라이언트에서 받지 않고 인증 세션으로 결정
- 각 tenant data plane 쿼리에 인증된 `user_id`와 해당 `tenant_id`를 함께 적용
- raw 검색어와 메일 본문을 운영 로그에 기록하지 않음

목록과 전체 개수를 같은 필터 정의에서 생성해 서로 달라지지 않게 한다. 사용자가 빠르게 연속 검색할 때를 위해 클라이언트의 요청 취소 또는 sequence 검증도 필요하다.

### 7.1 여러 tenant와 DB의 전체 결과 병합

사용자의 메일이 여러 mail tenant 또는 dedicated DB에 저장될 수 있으므로 검색 route는 단일 repository 호출이 아니라 사용자 전체 검색을 조정하는 계층이 되어야 한다.

1. 인증된 `user_id`가 소유한 연결 계정이 있는 mail tenant 목록을 서버에서 조회한다.
2. 각 tenant를 `connectionManager`로 올바른 data plane에 routing한다.
3. 각 data plane에서 해당 사용자의 전체 검색 인덱스에 같은 검색 조건을 적용한다.
4. tenant별 결과와 count를 모아 전체 `total`을 계산한다.
5. 결과를 `(mail_time, tenant_id, message_id)` 최신순으로 병합한 뒤 한 페이지 분량만 반환한다.

여기서 tenant별 `LIMIT`도 SQL의 검색 조건 뒤에 적용해야 한다. 각 tenant의 최신 메일 100개를 먼저 읽어 검색하는 방식은 해당 tenant의 오래된 일치 메일을 누락하므로 허용하지 않는다.

offset은 여러 DB의 데이터가 동기화되는 동안 중복과 누락을 만들기 쉬우므로 keyset cursor를 권장한다. 불투명 cursor에는 마지막 결과의 `mail_time`, `tenant_id`, `message_id`를 포함하고 다음 요청에서 모든 tenant 쿼리에 같은 정렬 경계를 적용한다. cursor는 클라이언트가 임의로 검색 범위를 넓힐 수 없게 서버에서 검증하거나 서명한다.

tenant 조회는 제한된 동시성으로 병렬 실행한다. 하나의 저장 위치가 실패했는데 성공한 tenant 결과만 정상 전체 결과처럼 반환해서는 안 된다. 재시도 후에도 실패하면 `MAIL_SEARCH_INCOMPLETE` 오류 또는 실패 tenant가 명시된 불완전 결과 상태를 반환해 누락 사실을 사용자에게 알려야 한다.

## 8. 검색용 데이터 구조

### 8.1 권장 검색 문서 테이블

본문 원문 저장 정책과 검색용 파생 데이터를 구분하기 위해 tenant data plane에 전용 테이블을 추가하는 방안을 권장한다.

```sql
CREATE TABLE mail_message_search_documents (
  tenant_id       TEXT NOT NULL,
  user_id         INTEGER NOT NULL,
  message_id      TEXT PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,
  from_email_norm TEXT NOT NULL DEFAULT '',
  to_email_norms  TEXT[] NOT NULL DEFAULT '{}',
  cc_email_norms  TEXT[] NOT NULL DEFAULT '{}',
  parties_text    TEXT NOT NULL DEFAULT '',
  subject_text    TEXT NOT NULL DEFAULT '',
  body_text       TEXT NOT NULL DEFAULT '',
  all_text        TEXT NOT NULL DEFAULT '',
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- `from_email_norm`, `to_email_norms`, `cc_email_norms`는 정확한 주소 검색용이다.
- `parties_text`에는 보낸사람·받는사람·참조의 표시 이름과 이메일을 넣는다.
- `body_text`는 `text/plain` 전체 또는 HTML-only 메일을 안전하게 text로 변환한 전체 본문이다.
- `all_text`는 `parties_text + subject_text + body_text`이며 첨부파일명과 BCC는 넣지 않는다.
- 검색 문서는 원본이 아니라 재생성 가능한 파생 데이터로 취급하며 메일 삭제 시 cascade한다.

`mail_message_summaries.clean_body_text`는 요약 생성 여부와 언어에 종속되므로 이 테이블을 대신할 수 없다.

### 8.2 인덱스

정확한 주소 검색에는 B-tree/배열 GIN, 부분 문자열 검색에는 `pg_trgm`을 사용한다.

```sql
CREATE INDEX idx_mail_search_from
  ON mail_message_search_documents (tenant_id, user_id, from_email_norm);

CREATE INDEX idx_mail_search_to
  ON mail_message_search_documents USING GIN (to_email_norms);

CREATE INDEX idx_mail_search_cc
  ON mail_message_search_documents USING GIN (cc_email_norms);

CREATE INDEX idx_mail_search_subject_trgm
  ON mail_message_search_documents USING GIN (subject_text gin_trgm_ops);

CREATE INDEX idx_mail_search_all_trgm
  ON mail_message_search_documents USING GIN (all_text gin_trgm_ops);

CREATE INDEX idx_mail_attachment_filename_trgm
  ON mail_attachments USING GIN (LOWER(filename) gin_trgm_ops);
```

실제 쿼리는 tenant/user 선행 조건을 반드시 포함한다. 배열 인덱스는 `to_email_norms @> ARRAY[$email]`과 같은 정확한 포함 비교에 사용한다.

공용 DB는 이미 게시글 검색을 위해 `pg_trgm`을 준비하는 코드가 있지만, 메일 전용 DB 생성 경로는 현재 `pgcrypto`만 보장한다. [`server/mail/connectionManager.js`](../server/mail/connectionManager.js)와 schema 초기화에서 dedicated DB에도 `pg_trgm`을 생성해야 한다. 확장 생성 권한이 없으면 검색 정확성은 유지하되 `ILIKE` 순차 검색으로 동작하고 운영 경고와 성능 점검을 남겨야 한다.

### 8.3 본문 정제

Gmail과 IMAP 동기화 단계에는 이미 파싱된 `bodyText`와 `bodyHtml`이 있다. object storage에 저장하기 전에 같은 데이터로 검색 문서를 만든다.

- `bodyText`가 있으면 전체 text를 사용한다.
- HTML-only 메일은 [`server/mail/textPreview.js`](../server/mail/textPreview.js)의 HTML 제거 로직을 재사용하되 240자 `snippet` 제한은 적용하지 않는다.
- script, style, comment, 조건부 HTML을 제거하고 HTML entity와 공백을 정규화한다.
- 제목과 주소도 같은 Unicode 정규화 정책을 적용한다.
- 원격 이미지 URL이나 첨부파일 본문은 `모든` 검색 본문에 넣지 않는다.

검색 문서 upsert는 `mail_messages`와 첨부파일 저장 트랜잭션 안에서 처리해 재동기화 중 일부 필드만 오래된 상태가 되지 않게 한다. Gmail 동기화, IMAP 동기화, 보낸 메일 로컬 저장, 임시보관 저장·수정 경로를 모두 포함해야 한다.

### 8.4 기존 메일 backfill

schema migration만으로는 object storage의 기존 본문을 읽을 수 없다. 별도의 재실행 가능한 batch 작업이 필요하다.

1. tenant와 사용자 단위로 아직 검색 문서가 없는 메일을 일정 개수씩 조회한다.
2. `body_text_object_key`를 우선 읽고 없으면 `body_html_object_key`를 읽어 text로 변환한다.
3. 주소·제목·본문을 정규화해 검색 문서를 upsert한다.
4. 첨부파일명은 기존 `mail_attachments`에서 조회한다.
5. 실패한 message ID와 오류 종류만 기록하고 본문이나 검색어는 로그에 남기지 않는다.
6. 중단 후 이어서 실행할 수 있게 cursor 또는 `indexed_at` 기준 checkpoint를 둔다.
7. tenant별 전체 대상 수, 완료 수, 실패 수를 확인한 뒤 프론트 기능을 활성화한다.

`snippet`을 임시 본문 인덱스로 넣을 수는 있지만 이 기간에는 본문 전체 검색이 불완전하다는 상태를 운영자가 확인할 수 있어야 한다. backfill 완료 전에 기능을 완전 제공으로 표시하지 않는 것이 안전하다.

## 9. 검색 쿼리 원칙

주소 검색은 다음 의미를 가져야 한다.

```sql
-- 보낸사람
sd.from_email_norm = $email

-- 받는사람
sd.to_email_norms @> ARRAY[$email]::text[]

-- 참조
sd.cc_email_norms @> ARRAY[$email]::text[]
```

부분 문자열 검색은 사용자가 입력한 `%`와 `_`를 escape한 parameter를 사용한다.

```sql
-- 제목
sd.subject_text ILIKE $escaped_pattern ESCAPE '\\'

-- 모든
sd.all_text ILIKE $escaped_pattern ESCAPE '\\'

-- 파일
EXISTS (
  SELECT 1
  FROM mail_attachments att
  WHERE att.tenant_id = mm.tenant_id
    AND att.user_id = mm.user_id
    AND att.message_id = mm.id
    AND LOWER(att.filename) LIKE $escaped_pattern ESCAPE '\\'
)
```

결과 쿼리의 기본 필터는 다음과 같다.

```sql
mm.tenant_id = $routedTenantId
AND mm.user_id = $authenticatedUserId
AND mm.deleted_at IS NULL
```

위 조건은 서버가 찾아낸 각 mail tenant data plane에서 실행한다. 검색 endpoint는 클라이언트가 보낸 tenant ID, user ID 또는 관리자 여부를 검색 범위로 신뢰해서는 안 된다.

## 10. 변경 대상

| 파일 | 변경 방향 |
|---|---|
| `src/components/TitleBar.jsx` | `BoardSearchBar`와 `MailSearchBar` 분리, `showMail`에 따른 검색 UI·submit 분기, 메일 항목 selector 추가 |
| `src/App.jsx` | 독립된 `mailSearchRequest` 상태와 `onMailSearch` 추가, `MailPage`로 요청 전달 |
| `src/components/MobileLayout.jsx` | 내부 mail tab을 상위에 알리고 동일한 메일 검색 요청을 모바일 `MailPage`에 전달 |
| `src/features/mail/MailPage.jsx` | 현재 페이지 필터 제거, 서버 검색 실행·결과 페이징·초기화·결과 선택 처리 |
| `src/features/mail/MailViewer.jsx` | 주소 context 검색을 공통 메일 검색 요청으로 연결하고 검색 필드 전달 |
| `src/features/mail/MailMessageList.jsx` | 검색 결과의 계정·폴더·일치 필드·미리보기 표시 보강 |
| `src/features/mail/mailText.js` 또는 `src/i18n/index.js` | 3개 언어의 검색 항목, placeholder, 오류, 결과 문구 추가 |
| `server/routes/mail.js` | `GET /messages/search`를 `GET /messages/:id` 앞에 추가하고 인증 사용자 전체 검색 service 호출 |
| 신규 `server/mail/searchService.js` | 사용자의 전체 mail tenant 조회, 제한 병렬 검색, total 합산, 전역 정렬과 cursor 처리 |
| `server/mail/repository.js` | 검색 문서 upsert, tenant별 전체 corpus 검색·count·keyset paging 쿼리 추가 |
| `server/mail/schema.js` | 검색 문서 테이블과 주소·trigram 인덱스 추가 |
| `server/mail/connectionManager.js` | dedicated mail DB의 `pg_trgm` 준비 |
| `server/mail/gmailSync.js` | Gmail 저장 시 전체 본문 검색 문서 전달 |
| `server/mail/imapSync.js` | IMAP 저장 시 전체 본문 검색 문서 전달 |
| 메일 발송·임시보관 저장 경로 | 로컬 생성 메일도 같은 검색 문서 upsert 적용 |
| 신규 backfill script | 기존 object storage 본문을 읽어 검색 문서 생성 |
| 신규 unit/integration/E2E 테스트 | 정규화, 필드별 검색, 권한 격리, UI 모드 전환 검증 |

## 11. 구현 순서

1. 검색 항목 enum, 검색어 정규화, SQL wildcard escape 함수를 순수 모듈로 만들고 unit test를 작성한다.
2. tenant data schema에 검색 문서와 인덱스를 추가하고 shared/dedicated DB 모두에서 migration을 검증한다.
3. 신규 동기화와 발송·임시보관 경로가 검색 문서를 원자적으로 upsert하게 한다.
4. 기존 메일 backfill 작업을 구현하고 coverage를 검증한다.
5. tenant별 검색 repository와 사용자 전체 tenant 결과를 병합하는 search service 및 `GET /api/mail/messages/search`를 구현한다.
6. `MailPage`에 서버 전체 결과 수와 cursor 기반 추가 로딩을 연결한다.
7. 상단 검색을 게시판/메일 모드로 분리하고 내부 중복 검색창을 제거한다.
8. 모바일 활성 모드 전달을 추가한다.
9. 권한·대용량·회귀 E2E 테스트 후 기능을 활성화한다.

## 12. 테스트 시나리오

### 12.1 검색 정확성

1. `보낸사람`에서 대소문자와 앞뒤 공백이 다른 완전한 주소가 정확히 검색된다.
2. `보낸사람`에서 이름, local-part 일부, domain 일부만 입력하면 validation 오류가 난다.
3. 여러 받는사람 중 하나의 주소가 정확히 일치하면 `받는사람` 결과에 포함된다.
4. 같은 주소가 참조에만 있으면 `받는사람`에는 없고 `참조`에는 나타난다.
5. 제목의 한글·영문 일부 문자열과 전체 문자열이 모두 검색된다.
6. `모든`에서 보낸사람 이름·주소, 받는사람, 참조, 제목, 본문 중 어느 하나와 부분 일치하면 검색된다.
7. 본문 첫 240자 이후에만 있는 문자열도 `모든`에서 검색된다.
8. text/plain이 없는 HTML-only 본문의 보이는 문자열이 검색된다.
9. BCC에만 있는 문자열과 첨부파일명에만 있는 문자열은 `모든`에 나타나지 않는다.
10. 첨부파일명 일부와 전체가 `파일`에서 검색되고 첨부파일 내용은 검색하지 않는다.
11. `%`, `_`, `\\`를 입력했을 때 wildcard가 아니라 해당 문자 자체를 찾는다.
12. 동일 메일의 여러 첨부파일명이 일치해도 결과는 한 건이다.

### 12.2 범위와 권한

1. 사용자에게 250개 이상의 메일을 만들고 101번째 이후 메일에만 있는 검색어도 첫 검색 요청에서 전체 `total`에 반영된다.
2. 같은 사용자의 여러 계정과 모든 폴더에 있는 메일이 함께 검색된다.
3. 같은 사용자의 메일이 여러 mail tenant와 shared/dedicated DB에 나뉘어 있어도 한 결과 집합으로 검색된다.
4. cursor로 모든 페이지를 끝까지 조회한 결과의 합집합이 전체 일치 메일과 같고 중복이나 누락이 없다.
5. 휴지통과 스팸 메일도 tenant·계정·폴더 표시와 함께 검색된다.
6. `deleted_at`이 설정된 메일은 검색되지 않는다.
7. 같은 tenant의 다른 사용자 메일이 검색되지 않는다.
8. 사용자가 소유 계정을 두지 않은 다른 tenant의 메일은 검색되지 않는다.
9. 클라이언트가 임의의 `tenantId`나 `userId`를 보내도 검색 범위를 바꿀 수 없다.
10. 검색 결과의 message ID를 조작해도 다른 사용자의 상세가 노출되지 않는다.
11. 일부 tenant DB 조회 실패가 성공 결과만으로 조용히 처리되지 않고 불완전 검색 오류로 표시된다.

### 12.3 UI와 상태

1. 게시판 화면에서는 기존 `게시글 및 댓글 검색...`과 게시글 검색이 유지된다.
2. 메일 화면으로 이동하면 즉시 메일 검색 selector와 `메일 검색...`으로 바뀐다.
3. 메일 검색 중 `/posts/search`가 호출되지 않고 게시글 검색 상태가 변경되지 않는다.
4. 검색 항목 변경 후 Enter와 버튼 클릭이 같은 요청을 보낸다.
5. 잘못된 주소는 서버 요청 없이 오류가 표시된다.
6. 빠르게 두 검색을 실행해도 늦게 도착한 첫 응답이 두 번째 결과를 덮지 않는다.
7. 검색 결과를 선택하면 올바른 실제 폴더와 메일 상세가 열리고 그때 읽음 처리된다.
8. 검색 결과에서 돌아가면 이전 활성 폴더와 목록 scroll 상태를 복구한다.
9. 데스크톱과 모바일에서 같은 검색 항목과 결과를 제공한다.
10. 메일에서 게시판으로 돌아가면 게시판 검색 상태가 메일 검색으로 덮이지 않는다.
11. 한국어·영어·일본어에서 selector, placeholder, 오류, 결과 수가 올바르게 표시된다.

### 12.4 데이터 전환과 성능

1. 신규 수신, 신규 발신, 임시보관 및 재동기화 메일의 검색 문서가 생성·갱신된다.
2. 메일 영구 삭제 시 검색 문서가 cascade 삭제된다.
3. backfill을 중단하고 재실행해도 중복 없이 이어서 처리된다.
4. object storage 본문 읽기 실패가 다른 메일의 backfill을 중단시키지 않는다.
5. backfill 대상 수와 완료·실패 합계가 일치한다.
6. 실운영 크기 데이터에서 제목·모든·파일 검색의 실행 계획이 의도한 인덱스를 사용한다.
7. 결과가 많은 검색도 서버 최대 page size를 지키면서 cursor로 마지막 결과까지 조회된다.
8. 서버 쿼리 계획에서 검색 조건보다 먼저 100건으로 잘라내는 단계가 없다.
9. 여러 tenant의 count 합계가 API의 `total`과 일치한다.

## 13. 완료 기준

- 메일 화면에서 상단 검색이 게시글·댓글 검색을 호출하지 않는다.
- 여섯 검색 항목을 모두 선택할 수 있고 정의된 정확/부분 일치 규칙대로 동작한다.
- 현재 화면의 `messages.length`와 관계없이 로그인 사용자의 전체 메일을 서버에서 검색한다.
- 첫 100개 이후의 과거 메일과 다른 연결 계정·mail tenant의 메일도 검색된다.
- page size는 응답 전송량만 제한하며 검색 후보 집합을 제한하지 않는다.
- cursor를 계속 조회하면 전체 `total`에 포함된 모든 결과를 확인할 수 있다.
- `모든`이 snippet이 아닌 전체 정제 본문을 검색한다.
- `파일`이 첨부파일명 전체를 대상으로 검색한다.
- 결과 선택 시 올바른 메일 상세가 열리고 계정·폴더 문맥을 확인할 수 있다.
- 검색 결과 항목, `total`, 일치 미리보기는 모두 인증된 현재 사용자의 메일만으로 계산한다.
- 같은 tenant의 다른 사용자 메일은 물론 관리자 권한으로도 일반 검색 결과에 포함되지 않는다.
- tenant와 `req.user.id` 경계를 모든 검색·count·상세 요청에서 강제한다.
- 기존 게시판 검색과 메일 검색의 상태 및 결과가 서로 영향을 주지 않는다.
- desktop과 mobile에서 같은 기능을 제공한다.
- 기존 메일 backfill 완료율과 검색 성능을 배포 전에 확인한다.

## 14. 최종 의견

프론트의 검색창 문구와 selector만 바꾸는 수정으로는 요구사항을 충족할 수 없다. 현재 `MailPage`의 검색은 최대 100개로 제한된 목록 필터이고, 메일 본문은 object storage에 있으므로 서버 검색 인덱스와 기존 데이터 backfill이 필수다.

가장 안전한 구현은 게시판 검색과 메일 검색을 UI·상태·API 차원에서 분리하고, 메일 저장 시 재생성 가능한 검색 문서를 함께 upsert하는 방식이다. 첨부파일명은 기존 `mail_attachments`를 사용하고, 주소 검색은 정규화된 이메일 정확 일치, 제목·모든·파일은 literal 부분 문자열 일치로 구현하면 요청한 여섯 동작을 일관되게 제공할 수 있다.

최종적으로 검색 대상은 `MailPage`가 보유한 100개 배열이 아니라 인증된 사용자의 모든 연결 계정·폴더·mail tenant에 저장된 전체 메일이어야 한다. API의 page size는 전송과 화면 렌더링을 위한 분할 단위일 뿐 검색 범위 제한으로 사용해서는 안 된다.

단, 여기서 `전체 메일`은 시스템 전체 사용자의 메일이 아니라 **현재 인증된 해당 사용자 한 명의 전체 메일**을 뜻한다. 다른 사용자의 메일은 같은 tenant에 있거나 요청자가 관리자여도 일반 메일 검색 범위에 포함하지 않는다.
