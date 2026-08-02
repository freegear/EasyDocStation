# EasyStation 업데이트 내역 페이지 구현 검토

## 1. 목적

사이드바 하단에 표시되는 `EasyStation v0.5.8` 버전 번호를 클릭 가능한 버튼으로 변경하고, 클릭하면 EasyStation 소개와 버전별 업데이트 내역을 보여 주는 페이지를 연다.

버전과 업데이트 설명은 프로젝트 루트의 `UpdateHistory.json`을 단일 기준(source of truth)으로 사용한다. 현재 `config.json`에 있는 다음 항목은 제거한다.

```json
"EasyDocStation Version": "0.5.8"
```

서버는 시작할 때 `UpdateHistory.json`을 읽어 현재 버전과 업데이트 내역을 준비하고, 프론트는 서버 API를 통해 이를 조회한다.

이 문서는 구현 방향 검토이며 현재 단계에서는 코드, `config.json`, `UpdateHistory.json`을 변경하지 않는다.

## 2. 현재 구현 확인

### 2.1 버전 표시

현재 [Sidebar.jsx](../src/components/Sidebar.jsx)는 마운트 시 다음 API를 호출한다.

```text
GET /api/config/version
```

응답의 `version`을 `appVersion` 상태에 저장하고 사이드바 하단에서 다음처럼 표시한다.

```text
EasyStation v0.5.8
```

현재 표시 요소는 `<p>`이므로 클릭이나 키보드 포커스가 가능한 버튼이 아니다.

### 2.2 서버 버전 API

[server/index.js](../server/index.js)의 `/api/config/version`은 요청할 때마다 루트 `config.json`을 읽고 `EasyDocStation Version` 값을 반환한다. 파일 읽기 또는 JSON 파싱에 실패하면 `0.0.1`을 반환한다.

### 2.3 버전 증가 스크립트

[scripts/bump-app-version.mjs](../scripts/bump-app-version.mjs)는 `config.json`에서 현재 버전을 읽어 patch 번호를 1 증가시키고 다시 `config.json`에 저장한다. 버전 저장 위치를 변경하면 이 스크립트도 반드시 함께 변경해야 한다.

### 2.4 설정 예제

`config.json.example`에도 `EasyDocStation Version`이 있으므로 실제 설정뿐 아니라 예제에서도 제거해야 한다. 그렇지 않으면 신규 설치 시 다시 구식 버전 항목이 생성될 수 있다.

## 3. 결론

제안한 방식으로 구현할 수 있다. 다만 다음 세 부분을 하나의 변경으로 처리해야 한다.

1. `UpdateHistory.json`을 버전 정보의 단일 기준으로 추가한다.
2. 서버 버전 API와 버전 증가 스크립트가 새 파일을 사용하게 변경한다.
3. 사이드바 버전 버튼과 업데이트 내역 페이지를 추가한다.

`config.json`에서 값만 지우고 나머지 코드를 그대로 두면 화면 버전이 `0.0.1`로 표시되고 버전 증가 스크립트도 잘못 동작한다.

## 4. UpdateHistory.json 구조

요청한 초기 구조는 다음과 같다.

```json
{
  "EasyDocStation Version": "0.5.8",
  "0.5.8": "메일에서 주소 자동 완성 기능을 추가함",
  "0.5.7": "구글 주소록을 production state로 업데이트 함",
  "0.5.6": "주소록을 구현함.\niCloud,\nGoogle 주소록"
}
```

JSON 안에서 `\n`은 실제 줄바꿈을 나타내는 escape 문자다. 화면에서는 문자열을 HTML로 직접 삽입하지 않고 텍스트로 렌더링하면서 줄바꿈을 보존해야 한다.

React에서는 다음 중 하나를 사용한다.

- 설명 영역에 CSS `white-space: pre-line` 적용
- 문자열을 `\n`으로 분리해 각 줄을 안전한 텍스트 요소로 렌더링

`dangerouslySetInnerHTML`로 변환하지 않는다. 향후 업데이트 설명에 외부 입력이 포함되더라도 HTML이나 script가 실행되지 않아야 한다.

### 4.1 현재 버전과 내역의 정합성

`EasyDocStation Version` 값과 동일한 버전 key가 반드시 존재해야 한다.

```text
EasyDocStation Version = 0.5.8
업데이트 내역 key     = 0.5.8
```

현재 버전 key가 없으면 버전 번호는 표시할 수 있어도 현재 업데이트 설명이 비게 된다. 서버 시작 시 이 불일치를 검증하는 것이 좋다.

### 4.2 JSON object 순서를 신뢰하지 않음

파일에 최신 버전부터 작성하더라도 화면은 JSON key 입력 순서를 그대로 신뢰하지 않는다. `0.5.10`과 `0.5.9`를 문자열로 정렬하면 순서가 잘못될 수 있으므로 semantic version의 major, minor, patch를 숫자로 비교하여 최신순으로 정렬한다.

`EasyDocStation Version`은 내역 항목이 아니므로 목록에서 제외한다.

### 4.3 요청 구조의 한계

현재 구조는 단순하고 관리하기 쉽지만 버전별 날짜, 분류, 여러 변경 항목, 링크를 구조화하기 어렵다. 이번 요구사항에는 충분하므로 그대로 사용한다. 향후 필요하면 별도의 schema version을 둔 배열 구조로 마이그레이션할 수 있다.

```json
{
  "currentVersion": "0.6.0",
  "releases": [
    {
      "version": "0.6.0",
      "releasedAt": "2026-07-18",
      "changes": ["기능 A", "오류 B 수정"]
    }
  ]
}
```

이번 구현에서 위 확장 구조를 동시에 도입하지는 않는다.

## 5. 서버 시작 시 로딩

### 5.1 파일 위치

서버는 실행 디렉터리에 의존하지 않고 `server/index.js`의 위치를 기준으로 프로젝트 루트 파일을 해석해야 한다.

```text
path.resolve(__dirname, '../UpdateHistory.json')
```

### 5.2 시작 시 한 번 읽기

요구사항에 따라 서버 시작 과정에서 파일을 한 번 읽고 검증한 결과를 메모리에 보관한다.

```text
서버 시작
  → UpdateHistory.json 읽기
  → JSON 파싱
  → 현재 버전 검증
  → 버전 key 형식 검증
  → semantic version 최신순 정렬
  → 메모리 snapshot 저장
  → API 요청에 snapshot 반환
```

요청마다 파일을 다시 읽지 않으므로 파일을 운영 중 직접 편집해도 서버 재시작 전에는 화면에 반영되지 않는다. 이것은 `시작 시 읽어 온다`는 요구사항과 일치한다. 운영 중 즉시 반영이 필요하다면 관리자 reload API 또는 파일 감시가 별도로 필요하지만 이번 범위에서는 제외한다.

### 5.3 오류 정책

다음 오류를 구분해야 한다.

- 파일 없음
- JSON 문법 오류
- `EasyDocStation Version` 누락
- 현재 버전 형식 오류
- 현재 버전에 해당하는 내역 누락
- 잘못된 버전 key
- 내역 값이 문자열이 아님

권장 정책은 서버 시작을 완전히 중단하기보다 명확한 오류를 로그에 남기고 다음 안전한 snapshot으로 실행하는 것이다.

```json
{
  "version": "0.0.0",
  "releases": [],
  "available": false
}
```

이 경우 사이드바에는 `EasyStation`만 표시하거나 버전 버튼을 비활성화하고, 업데이트 페이지에는 `업데이트 내역을 불러오지 못했습니다`를 표시한다. 잘못된 파일을 조용히 `0.0.1` 정상 버전처럼 표시하는 방식은 운영자가 오류를 알아채기 어려우므로 권장하지 않는다.

## 6. API 설계

기존 `/api/config/version`을 유지하면서 데이터 출처만 `UpdateHistory.json` snapshot으로 변경하면 다른 호출부와의 호환성이 유지된다.

### 6.1 버전 API

```text
GET /api/config/version
```

```json
{
  "version": "0.5.8"
}
```

### 6.2 업데이트 내역 API

새 endpoint를 권장한다.

```text
GET /api/config/update-history
```

권장 응답:

```json
{
  "productName": "EasyStation",
  "currentVersion": "0.5.8",
  "releases": [
    {
      "version": "0.5.8",
      "description": "메일에서 주소 자동 완성 기능을 추가함",
      "current": true
    },
    {
      "version": "0.5.7",
      "description": "구글 주소록을 production state로 업데이트 함",
      "current": false
    },
    {
      "version": "0.5.6",
      "description": "주소록을 구현함.\niCloud,\nGoogle 주소록",
      "current": false
    }
  ]
}
```

프론트가 raw JSON object를 직접 해석하게 하기보다 서버가 검증·정렬한 배열을 반환하면 모든 클라이언트가 같은 순서를 사용한다.

버전과 업데이트 내역은 비밀정보가 아니므로 현재 `/api/config/version`과 동일하게 로그인 전에도 공개할 수 있다. 업데이트 설명에 내부 보안 정보, 고객명, 취약점 악용 방법 또는 비밀 URL을 기록하지 않는다.

## 7. 사이드바 버전 버튼

현재 `<p>`를 실제 `<button type="button">`으로 변경한다.

```text
[ EasyStation v0.5.8 ]
```

필수 동작:

- 클릭하면 EasyStation 업데이트 내역 페이지를 연다.
- Enter와 Space 키로도 실행할 수 있다.
- hover, focus-visible, active 상태를 표시한다.
- `업데이트 내역 보기`에 해당하는 `title` 또는 `aria-label`을 제공한다.
- 버전을 읽지 못했어도 `EasyStation` 버튼으로 페이지를 열어 오류 상태를 확인할 수 있게 한다.
- 모바일 사이드바에서도 같은 진입점을 제공할지 확인한다. 데스크톱에만 제공하면 모바일 사용자는 업데이트 페이지에 접근할 수 없다.

버튼 클릭 callback은 `Sidebar` 내부에서 화면 상태를 직접 조작하기보다 `onOpenUpdateHistory` prop으로 상위 `App`에 전달하는 편이 기존 화면 전환 구조와 맞는다.

## 8. EasyStation 업데이트 내역 페이지

### 8.1 구현 방식

업데이트 내역은 데이터 기반 React 화면이므로 기존 HTML template iframe 방식보다 네이티브 React 컴포넌트를 권장한다.

예상 컴포넌트:

```text
src/components/UpdateHistoryPage.jsx
```

iframe이나 `srcDoc`를 사용하지 않으면 다음 장점이 있다.

- API 데이터 렌더링이 단순하다.
- 기존 인증·테마·반응형 스타일을 그대로 사용한다.
- 접근성과 키보드 이동을 관리하기 쉽다.
- 브라우저 뒤로가기와 앱 화면 상태 연결이 쉽다.

### 8.2 화면 구성

```text
┌──────────────────────────────────────────┐
│  ← 돌아가기       EasyStation            │
│                   Version 0.5.8          │
├──────────────────────────────────────────┤
│  업데이트 내역                           │
│                                          │
│  v0.5.8                      현재 버전   │
│  메일에서 주소 자동 완성 기능을 추가함   │
│                                          │
│  v0.5.7                                  │
│  구글 주소록을 production state로        │
│  업데이트 함                             │
│                                          │
│  v0.5.6                                  │
│  주소록을 구현함.                        │
│  iCloud                                  │
│  Google 주소록                           │
└──────────────────────────────────────────┘
```

페이지에는 다음을 표시한다.

- 제품명 `EasyStation`
- 현재 버전
- `업데이트 내역` 제목
- 최신 버전부터 과거 버전까지 목록
- 현재 버전 badge
- 각 버전 설명의 줄바꿈
- 로딩, 빈 내역, API 오류 상태
- 기존 화면으로 돌아가는 버튼

업데이트 내역이 많아지면 페이지 전체를 세로 스크롤한다. 버전 카드마다 과도한 색을 쓰기보다 현재 버전만 강조한다.

### 8.3 화면 전환 상태

`App.jsx`에 업데이트 내역 화면 상태를 추가하고 페이지를 열 때 메일, 캘린더, 주소록, DM, Welcome 서비스 등과 충돌하지 않게 한다.

권장 동작:

1. 버전 버튼 클릭
2. 현재 화면 정보를 복귀 대상으로 보관
3. 업데이트 내역 페이지 표시
4. `돌아가기` 클릭 시 이전 화면 복원

단순 구현에서는 다른 서비스 화면을 닫고 업데이트 내역을 표시할 수 있다. 그러나 사용자가 메일 작성 중이거나 입력 중인 화면을 잃을 수 있으므로, 가능하면 현재 컴포넌트 상태를 파괴하지 않는 overlay/full panel 또는 명시적인 복귀 상태를 사용한다.

업데이트 페이지는 일반 조회 화면이며 사이트 관리자 전용일 필요가 없다.

## 9. 버전 증가 스크립트 변경

`npm run version:bump`가 계속 동작하도록 [bump-app-version.mjs](../scripts/bump-app-version.mjs)를 다음과 같이 변경해야 한다.

1. `config.json`이 아니라 `UpdateHistory.json`을 읽는다.
2. `EasyDocStation Version`을 semantic version으로 파싱한다.
3. patch 번호를 1 증가시킨다.
4. 새 버전 key가 없으면 기본 설명을 추가하거나 명시적 설명 인자를 요구한다.
5. 새 현재 버전을 저장한다.
6. 임시 파일에 먼저 쓴 뒤 rename하여 파일 손상을 방지한다.

설명 없는 빈 릴리스가 누적되지 않도록 다음과 같은 사용 방식을 권장한다.

```text
npm run version:bump -- "변경 내용"
```

설명이 없으면 실행을 거부하거나 `업데이트 내역을 입력해 주세요`로 실패시키는 편이 안전하다. 자동으로 `업데이트` 같은 의미 없는 설명을 넣지 않는다.

버전 key가 이미 존재하면 덮어쓰지 않고 충돌 오류를 내야 한다.

## 10. config.json 전환 범위

구현 시 다음 작업을 함께 수행한다.

- `config.json`에서 `EasyDocStation Version` 제거
- `config.json.example`에서 같은 항목 제거
- `/api/config/version`의 읽기 대상을 UpdateHistory snapshot으로 변경
- `scripts/bump-app-version.mjs`의 읽기·쓰기 대상 변경
- 코드와 문서에서 `config['EasyDocStation Version']` 참조가 더 없는지 검색
- 배포 및 설치 스크립트가 config의 첫 번째 항목을 가정하지 않는지 확인

`package.json`의 `version: 1.0.0`과 `server/package.json` 버전은 npm package metadata이므로 이번 EasyStation 제품 버전과 별개로 유지한다. 함께 바꾸면 npm dependency/lockfile 변경까지 발생하므로 요구사항 없이 통합하지 않는다.

## 11. 캐시 정책

서버는 시작할 때 snapshot을 읽으므로 API에는 다음 정책을 사용할 수 있다.

- `Cache-Control: public, max-age=300` 또는 짧은 캐시
- ETag를 current version과 파일 내용 hash로 생성
- 현재 버전이 바뀌고 서버가 재시작되면 새 ETag 반환

프론트는 버전 번호를 Sidebar가 이미 가져왔더라도 업데이트 페이지 진입 시 history API를 한 번 조회한다. 같은 세션에서 다시 열 때는 메모리 cache를 재사용할 수 있다.

Service Worker를 사용하는 경우 이전 업데이트 내역이 장기간 남지 않도록 API cache version을 제품 버전과 연결하거나 network-first 정책을 사용한다.

## 12. 예상 문제점

### 12.1 config만 먼저 수정하는 경우

서버와 bump script를 변경하기 전에 config 값을 제거하면 버전이 fallback으로 표시되고 배포 버전 증가가 잘못된다. 모든 의존성을 한 번에 전환해야 한다.

### 12.2 JSON 문법 오류

업데이트 설명에 실제 줄바꿈 문자를 JSON 문자열 안에 직접 넣으면 JSON 문법 오류가 발생한다. 파일에는 반드시 `\n` escape를 사용해야 한다.

올바른 예:

```json
"0.5.6": "주소록을 구현함.\niCloud,\nGoogle 주소록"
```

잘못된 예:

```text
"0.5.6": "주소록을 구현함.
iCloud,
Google 주소록"
```

### 12.3 버전 정렬 오류

문자열 내림차순 정렬은 `0.5.10`을 `0.5.9`보다 오래된 버전으로 놓을 수 있다. 숫자 기반 semantic version 비교가 필요하다.

### 12.4 버전과 설명의 불일치

현재 버전만 변경하고 동일 버전 key를 추가하지 않거나, 내역 key만 추가하고 current version을 갱신하지 않을 수 있다. bump script에서 두 값을 하나의 transaction처럼 함께 변경해야 한다.

### 12.5 편집 중 화면 손실

버전 버튼을 눌렀을 때 현재 메일 작성 화면을 unmount하면 작성 중인 내용이 사라질 수 있다. 페이지 전환 전에 임시 저장을 강제하는 방식은 불편하므로 업데이트 내역을 overlay 또는 상태를 보존하는 상위 panel로 여는 방식을 검토한다.

### 12.6 여러 서버 인스턴스

서버 인스턴스마다 배포 파일이 다르거나 일부만 재시작되면 서로 다른 버전 snapshot을 반환할 수 있다. 배포 artifact에 `UpdateHistory.json`을 포함하고 모든 인스턴스를 같은 release로 교체해야 한다.

### 12.7 파일 누락

Docker image, 배포 복사, 패키징 또는 설치 스크립트가 새 JSON 파일을 포함하지 않으면 운영에서 버전이 사라진다. 배포 검증에 파일 존재와 JSON schema 검사를 포함한다.

## 13. 예상 변경 대상

| 파일 | 변경 방향 |
|---|---|
| `UpdateHistory.json` | 현재 버전과 버전별 업데이트 설명 추가 |
| `config.json` | `EasyDocStation Version` 제거 |
| `config.json.example` | 버전 항목 제거 |
| `server/index.js` | 시작 시 update history loader 실행, version/history API 제공 |
| `scripts/bump-app-version.mjs` | UpdateHistory.json의 현재 버전과 새 내역을 원자적으로 갱신 |
| `src/components/Sidebar.jsx` | 버전 텍스트를 버튼으로 변경하고 페이지 열기 callback 호출 |
| `src/components/UpdateHistoryPage.jsx` | EasyStation 소개 및 업데이트 내역 화면 추가 |
| `src/App.jsx` | 업데이트 내역 화면 상태·전환·복귀 처리 |
| `src/components/MobileLayout.jsx` | 모바일에서도 버전 진입점이 필요하면 버튼 추가 |
| 테스트 | loader, semver 정렬, API, 줄바꿈, 버튼, 화면 전환 및 오류 상태 검증 |

loader를 `server/updateHistory.js` 같은 별도 모듈로 분리하면 JSON 파싱·검증·정렬을 단위 테스트하기 쉽고 `server/index.js`가 복잡해지는 것을 막을 수 있다.

## 14. 구현 순서

1. 요청 구조의 `UpdateHistory.json`을 추가한다.
2. update history loader와 semver 검증·정렬 테스트를 만든다.
3. 서버 시작 시 loader를 호출하고 `/api/config/version`, `/api/config/update-history`를 연결한다.
4. 버전 API가 새 파일을 정상 반환하는 것을 확인한다.
5. bump script를 새 파일로 전환하고 설명 필수 정책을 적용한다.
6. `config.json`과 `config.json.example`에서 기존 버전을 제거한다.
7. UpdateHistory 페이지를 구현한다.
8. Sidebar 버전 표시를 버튼으로 바꾸고 App 화면 전환을 연결한다.
9. 모바일 접근, 돌아가기, 편집 중 화면 보존을 확인한다.
10. 프로덕션 build와 배포 artifact에 JSON이 포함되는지 검증한다.

## 15. 테스트 시나리오

1. 서버 시작 시 `UpdateHistory.json`의 현재 버전이 메모리에 로드된다.
2. `/api/config/version`이 `0.5.8`을 반환한다.
3. update history API가 `0.5.8`, `0.5.7`, `0.5.6` 순서로 반환한다.
4. `0.5.10`이 `0.5.9`보다 먼저 정렬된다.
5. `0.5.6` 설명의 `\n`이 화면에서 실제 줄바꿈으로 표시된다.
6. 사이드바 버전 버튼을 클릭하면 EasyStation 업데이트 내역 페이지가 열린다.
7. 키보드 Enter와 Space로도 페이지가 열린다.
8. 돌아가기를 누르면 이전 화면으로 복귀한다.
9. 메일 작성 중 페이지를 열고 닫아도 작성 내용이 보존된다.
10. 현재 버전에 `현재 버전` badge가 표시된다.
11. 내역이 많으면 페이지 안에서 정상적으로 스크롤된다.
12. history API 실패 시 빈 화면이 아니라 오류 안내와 재시도 버튼이 보인다.
13. JSON 파일이 없거나 잘못돼도 서버가 정의된 오류 정책으로 실행된다.
14. 현재 버전 key가 없으면 시작 로그에 정합성 오류가 기록된다.
15. `npm run version:bump -- "변경 설명"`이 current version과 새 내역을 함께 갱신한다.
16. 설명 없이 bump를 실행하면 파일을 변경하지 않고 실패한다.
17. `config.json`과 `config.json.example`에 제품 버전이 남아 있지 않다.
18. 다른 `package.json` 버전은 변경되지 않는다.
19. 데스크톱과 모바일 화면에서 버튼과 업데이트 내역이 정상 표시된다.
20. 업데이트 설명에 HTML 문자열이 있어도 HTML로 실행되지 않고 텍스트로 표시된다.

## 16. 완료 기준

- 사이드바의 버전 번호가 접근 가능한 버튼으로 표시된다.
- 버튼 클릭 시 EasyStation 페이지에서 최신순 업데이트 내역을 확인할 수 있다.
- 설명의 `\n`이 실제 줄바꿈으로 표시된다.
- `UpdateHistory.json`이 제품 현재 버전과 내역의 단일 기준이다.
- 서버는 시작할 때 파일을 읽어 검증된 snapshot을 사용한다.
- 기존 `/api/config/version` 호출부가 호환성을 유지한다.
- `config.json`과 `config.json.example`에서 제품 버전 정보가 제거된다.
- 버전 증가 스크립트가 새 파일을 안전하게 갱신한다.
- 잘못된 JSON, 파일 누락, 정합성 오류가 명확하게 처리된다.
- 업데이트 페이지를 열고 닫아도 사용자의 기존 작업 상태가 손실되지 않는다.

## 17. 최종 의견

요구사항은 구현 가능하며 버전과 변경 내역을 한 파일에서 관리한다는 점에서 현재보다 일관성이 좋아진다. 핵심은 `config.json` 항목만 이동하는 것으로 끝내지 않고 서버 API, bump script, 예제 설정과 배포 artifact를 함께 전환하는 것이다.

업데이트 페이지는 기존 template iframe보다 React 컴포넌트로 구현하는 것을 권장한다. 현재 메일 작성이나 다른 작업 상태를 잃지 않도록 화면 전환 방식은 overlay 또는 상태 보존 panel을 우선 검토한다. `UpdateHistory.json`은 요청한 단순 구조를 사용하되 서버에서 semantic version 정렬과 정합성 검증을 수행해야 한다.
