# EasySheet 도입 계획

Univer Sheets를 설치하고 이를 **EasySheet**라는 이름으로 EasyStation에 통합한다.
양식 모음에 `EasySheet` 항목을 추가하고, **더블클릭하면 게시글로 등록**되어 스프레드시트를
편집·열람할 수 있게 한다. (이 문서는 구현 전 설계서이며, 실제 코딩은 별도로 진행한다.)

---

## 1. 목표

- `Univer Sheets`(웹 스프레드시트 SDK)를 설치해 EasyStation 안에서 엑셀형 표를 작성/편집한다.
- 기존 **EasyPage**(Markdown 페이지)와 **동일한 패턴**으로 **EasySheet**(스프레드시트 페이지)를 만든다.
- 사이드바 **양식 모음**에 `📊 EasySheet`를 노출하고, **더블클릭 → 게시글 등록**으로 동작시킨다.
- 등록된 게시글을 열면 Univer 기반 EasySheet 편집기로 렌더링된다.

## 2. 핵심 컨셉 — EasyPage 패턴 그대로 차용

EasyStation은 이미 "특수 게시글" 패턴을 갖고 있다. 게시글 본문 맨 앞의 **마커 주석**으로
타입을 구분하고, 타입별 전용 뷰어로 렌더링한다. EasySheet도 이 검증된 패턴을 따른다.

| 항목 | EasyPage(기존) | EasySheet(신규) |
|---|---|---|
| 마커 | `<!--md-page-->` | `<!--easy-sheet-->` |
| 본문 저장 형식 | 마커 + Markdown 텍스트 | 마커 + Univer 워크북 스냅샷(JSON) |
| 감지 함수 | `isMdPage(content)` | `isEasySheet(content)` (신규) |
| 전용 뷰어 | `src/components/chat/MDPageViewer.jsx` | `EasySheetViewer.jsx` (신규) |
| 양식 모음 라벨 | `EasyPage` (id `md-page`) | `EasySheet` (id `easy-sheet`) |
| 등록 동작 | 더블클릭 → `registerTemplatePost` | 동일 |

> 근거 코드: `src/templates/formTemplates.js`의 `md-page` 템플릿(1267~1271행)과
> `isMdPage`/`getMdPageContent`/`getMdPageTitle`(1278~1303행), 사이드바 양식 모음 렌더
> `src/components/Sidebar.jsx`(355~371행), 게시글 렌더 분기
> `src/components/ChatArea.jsx`의 `isMdPage`/`MDPageViewer` 사용부(3182, 3420, 3757~3846행).

## 3. Univer Sheets 설치

권장: Univer 프리셋 패키지 사용(설정 최소화).

```bash
npm install @univerjs/presets
```

- 프리셋: `@univerjs/preset-sheets-core` (코어 스프레드시트 기능 + UI + 로케일)
- CSS: 프리셋 스타일시트 import 필요
- 데이터 모델: **`IWorkbookData` 스냅샷(JSON)** — 워크북 전체를 직렬화/역직렬화 가능
- 마운트: 빈 `div` 컨테이너에 `createUniver(...)`로 인스턴스를 만들고 워크북을 주입

> 정확한 패키지 구성·API 시그니처·버전은 설치 시점의 공식 문서(univer.ai)로 최종 확정한다.
> (코어 개별 패키지: `@univerjs/core`, `@univerjs/sheets`, `@univerjs/sheets-ui`, `@univerjs/design` 등으로도 구성 가능)

## 4. 데이터 모델 / 저장 방식

게시글 본문(`posts.content`)에 다음 형태로 저장한다.

```
<!--easy-sheet-->
{ ...IWorkbookData 스냅샷 JSON... }
```

- 첫 줄 마커로 EasySheet 게시글임을 식별(`isEasySheet`).
- 마커 이후는 Univer 워크북 스냅샷(JSON 문자열).
- 빈 초기 템플릿: 마커 + 시트 1개(빈 그리드)짜리 최소 스냅샷.
- 제목: 첫 시트 이름 또는 A1 셀 값에서 추출(`getEasySheetTitle`), 없으면 "EasySheet" 폴백.

> EasyPage가 본문에 Markdown을 그대로 넣는 것과 동일하게, EasySheet는 **JSON 스냅샷**을 넣는다.
> DB 스키마 변경은 불필요(기존 `posts.content` 재사용).

## 5. 구현 단계 (파일별)

### 5-1. `src/templates/formTemplates.js`
- `FORM_TEMPLATES` 배열에 항목 추가:
  ```js
  { id: 'easy-sheet', label: 'EasySheet', icon: '📊',
    content: '<!--easy-sheet-->\n' + JSON.stringify(EMPTY_SHEET_SNAPSHOT) }
  ```
- 헬퍼 함수 추가(기존 md-page 헬퍼와 1:1 대응):
  - `isEasySheet(content)` — `<!--easy-sheet-->`로 시작하는지
  - `getEasySheetData(content)` — 마커 제거 후 JSON 파싱하여 스냅샷 반환(파싱 실패 시 빈 워크북)
  - `getEasySheetTitle(content, fallback)` — 시트명/대표 셀에서 제목 추출

### 5-2. `src/components/Sidebar.jsx` (양식 모음)
- 양식 모음은 이미 `FORM_TEMPLATES`를 순회하며 **더블클릭 → `registerTemplatePost`** 로 등록한다
  (355~371행). 따라서 5-1에서 템플릿만 추가하면 `EasySheet` 항목이 자동으로 목록에 나타나고
  더블클릭 등록이 동작한다.
- `displayLabel` 분기(`md-page → 'EasyPage'`)처럼 라벨을 보정할 필요는 없음(템플릿 label이 이미 `EasySheet`).

### 5-3. `src/components/chat/EasySheetViewer.jsx` (신규)
- `MDPageViewer.jsx`를 참고한 전용 뷰어/편집기.
- props: `post`, 저장 콜백 등 MDPageViewer와 동일한 인터페이스를 지향.
- 동작:
  1. 마운트 시 컨테이너 div에 Univer 인스턴스 생성
  2. `getEasySheetData(post.content)`로 스냅샷 로드 → 워크북 주입
  3. 편집 후 저장 시 Univer 스냅샷 직렬화 → `<!--easy-sheet-->\n` + JSON 으로 게시글 본문 업데이트
  4. 언마운트 시 Univer 인스턴스 dispose(메모리 누수 방지)
- 읽기 전용/편집 모드 토글은 EasyPage 동작에 맞춰 정렬.

### 5-4. `src/components/ChatArea.jsx` (게시글 렌더 분기)
- 기존 `isMdPage` 분기와 나란히 `isEasySheet` 분기를 추가:
  - 게시글 미리보기/목록: `isEasySheet` → 아이콘 `📊` + `getEasySheetTitle`로 제목 표시
    (참고: 3182, 3420, 3460행 근처의 md 분기)
  - 선택된 게시글 본문 영역: `isEasySheetSelected` → `<EasySheetViewer>` 렌더
    (참고: 3757~3846행의 `isMdPageSelected` + `MDPageViewer` 분기)
- HTML 템플릿(iframe) 경로와 충돌하지 않도록 분기 순서를 정리.

### 5-5. `src/i18n/index.js`
- `t.easySheet.*` 라벨 추가(제목 폴백, 버튼 등) — `t.mdPage.*` 구조 참고. ko/en/ja 3개 로케일.

## 6. 더블클릭 → 게시글 등록 흐름

```
사용자: 양식 모음에서 [📊 EasySheet] 더블클릭
  → Sidebar.registerTemplatePost(easySheetTemplate)
  → addPost(selectedChannel.id, { content: '<!--easy-sheet-->\n{빈 워크북}', security_level: 1 })
  → 채널에 EasySheet 게시글 생성
사용자: 그 게시글 클릭
  → ChatArea: isEasySheet(post.content) === true
  → <EasySheetViewer post={post}/> 로 스프레드시트 편집기 렌더
사용자: 표 편집 후 저장
  → Univer 스냅샷 직렬화 → 게시글 content 업데이트
```

## 7. 고려사항 / 리스크

- **번들 크기**: Univer는 비교적 무겁다. 코드 스플리팅(동적 `import()` / `React.lazy`)으로
  EasySheet 뷰어를 지연 로딩하여 초기 로딩 영향을 최소화한다.
- **스냅샷 크기**: 큰 표는 JSON이 커진다. `posts.content` 크기/전송량을 확인하고 필요 시 압축을 검토.
- **보안/렌더링**: HTML 템플릿은 iframe로 렌더하지만, EasySheet는 Univer 캔버스라 XSS 표면이 다르다.
  외부 입력은 스냅샷 JSON뿐이므로 파싱 실패 방어(try/catch → 빈 워크북)가 필요.
- **RAG/검색 인덱싱**: 본문이 JSON이라 그대로 인덱싱하면 의미 없는 토큰이 들어간다.
  검색·RAG 파이프라인에서 EasySheet 게시글은 **셀 텍스트만 추출**하거나 제외하는 정책 결정 필요.
- **권한/보안등급**: 일반 게시글과 동일하게 `security_level` 및 채널 ACL을 따른다(별도 처리 불필요).
- **모바일**: Univer의 모바일 사용성을 확인(읽기 전용 폴백 등 고려).

## 8. 검증 체크리스트

- [ ] `npm install` 후 vite 빌드 정상, 번들 에러 없음
- [ ] 양식 모음에 `📊 EasySheet` 노출(이미지의 EasyPage 주변)
- [ ] 더블클릭 시 현재 채널에 EasySheet 게시글 생성
- [ ] 생성된 게시글을 열면 Univer 스프레드시트 편집기 렌더
- [ ] 표 편집 → 저장 → 새로고침 후에도 내용 유지(스냅샷 round-trip)
- [ ] 게시글 목록/미리보기에서 EasySheet 제목·아이콘 표시
- [ ] 일반 게시글/EasyPage/HTML 템플릿 렌더와 충돌 없음
- [ ] 권한(채널 ACL)·보안등급 정상 적용

## 9. 작업 순서 (구현 시)

1. [ ] Univer 설치 및 최소 예제로 마운트 검증(독립 스파이크)
2. [ ] `formTemplates.js`: `easy-sheet` 템플릿 + `isEasySheet`/`getEasySheetData`/`getEasySheetTitle` 추가
3. [ ] `EasySheetViewer.jsx` 작성(로드/편집/저장/dispose)
4. [ ] `ChatArea.jsx` 렌더 분기 추가(미리보기 + 본문)
5. [ ] `i18n` 라벨 추가
6. [ ] (정책) RAG/검색에서 EasySheet 본문 처리 방식 결정·반영
7. [ ] 검증 체크리스트 수행

---

> 이 문서는 설계/계획 단계 산출물이다. 위 패턴(EasyPage)이 이미 검증돼 있으므로,
> EasySheet는 "마커 + 전용 뷰어 + 양식 모음 등록" 세 축만 동일하게 맞추면 된다.
> 실제 코딩 착수 전에 7장(리스크) 중 **번들 지연 로딩**과 **RAG 인덱싱 정책**을 먼저 합의할 것.
