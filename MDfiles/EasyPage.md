# EasyPage.md

# 1. 선택 텍스트 팝업 메뉴: 하위 페이지 만들기

## 1.1 요구사항

EasyPage 편집 화면에서 텍스트를 선택하면 나타나는 팝업 메뉴에 현재 `링크 추가`만 보인다.

이 팝업 메뉴에 `하위 페이지 만들기` 버튼을 추가한다.

사용자가 `하위 페이지 만들기`를 선택하면 다음 동작을 수행한다.

1. 선택한 텍스트를 새 EasyPage의 타이틀로 사용한다.
2. 현재 게시판(현재 channel)에 새 EasyPage 게시글을 등록한다.
3. 새 EasyPage의 링크를 선택된 텍스트에 연결한다.
4. 링크가 반영된 현재 EasyPage를 저장한다.

## 1.2 현재 구조 검토

관련 구현 위치는 다음과 같다.

- [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx)
  - EasyPage 전용 뷰어/편집기다.
  - TipTap editor를 생성하고 `LinkBubbleMenu`를 렌더한다.
  - `useChat()`에서 `updatePost`, `deletePost`, `addComment` 등을 가져온다.
  - 현재 EasyPage 저장은 `handleSave()`에서 `updatePost(channelId, post.id, { content })`로 처리한다.
- [src/components/chat/md-page/toolbar/LinkBubbleMenu.jsx](../src/components/chat/md-page/toolbar/LinkBubbleMenu.jsx)
  - 선택 영역이 있을 때 TipTap `BubbleMenu`로 나타난다.
  - 현재 메뉴는 `링크 추가/수정`, 링크가 있을 때 `링크 해제`만 제공한다.
  - 링크 적용은 `editor.chain().focus().extendMarkRange('link').setLink({ href }).run()` 패턴을 사용한다.
- [src/contexts/ChatContext.jsx](../src/contexts/ChatContext.jsx)
  - `addPost(channelId, { content, attachmentIds, security_level })`로 새 게시글을 만든다.
  - 현재 `addPost`는 생성 결과를 내부 state에 반영하지만 호출자에게 생성된 post를 반환하지 않는다.
- [src/templates/formTemplates.js](../src/templates/formTemplates.js)
  - EasyPage 본문 marker는 `<!--md-page-->`다.
  - 신규 EasyPage content는 `<!--md-page-->\n# {title}\n\n` 형태로 만들면 기존 EasyPage 렌더러가 인식한다.

## 1.3 구현 방안

### 1.3.1 메뉴 확장

`LinkBubbleMenu`에 `하위 페이지 만들기` 버튼을 추가한다.

- 표시 조건:
  - editor가 editable 상태여야 한다.
  - selection이 비어 있지 않아야 한다.
  - 기존 `링크 추가` 버튼과 같은 BubbleMenu 안에 배치한다.
- 버튼 위치:
  - 기본 메뉴 상태에서 `링크 추가/수정` 옆 또는 아래에 표시한다.
  - 텍스트가 긴 한국어 버튼이므로 메뉴가 너무 좁아지지 않게 `maxWidth`를 넓히거나 세로 배치를 허용한다.

### 1.3.2 필요한 callback 전달

`LinkBubbleMenu`는 현재 editor만 알고 있으므로 게시글 생성 권한이 없다.

따라서 `MDPageViewer`에서 하위 페이지 생성 handler를 만들고 `LinkBubbleMenu`로 전달한다.

예상 prop:

```jsx
<LinkBubbleMenu
  editor={editor}
  onCreateChildPage={handleCreateChildPageFromSelection}
  creatingChildPage={creatingChildPage}
/>
```

`handleCreateChildPageFromSelection`은 `MDPageViewer` 내부에서 구현한다. 이 함수는 `channelId`, `post.id`, `addPost`, `updatePost`, 현재 editor, 저장 helper에 접근할 수 있다.

### 1.3.3 새 EasyPage 생성

선택 텍스트는 TipTap selection에서 가져온다.

처리 기준:

1. 선택 텍스트를 trim한다.
2. 연속 공백과 줄바꿈은 한 칸으로 정리한다.
3. 비어 있으면 생성하지 않는다.
4. 너무 긴 제목은 기존 `getMdPageTitle` 정책과 맞춰 80자 정도로 제한한다.

새 EasyPage content:

```md
<!--md-page-->
# 선택한 텍스트

```

게시판 등록:

- 현재 EasyPage가 속한 `channelId`에 등록한다.
- `security_level`은 부모 EasyPage의 `freshPost.security_level` 또는 `post.security_level`을 우선 상속한다.
- 첨부파일은 없다.

생성 API는 기존 `addPost`를 재사용하는 것이 좋다. 다만 링크를 만들려면 생성된 post id가 필요하므로 다음 중 하나를 선택한다.

권장안:

- `ChatContext.addPost()`가 생성된 post 또는 optimistic post를 반환하도록 개선한다.
- 기존 호출자와 호환되도록 반환값만 추가하고 동작은 유지한다.

대안:

- `MDPageViewer`에서 직접 `apiFetch('/posts', { method: 'POST', ... })`를 호출한다.
- 하지만 state 병합 로직이 `ChatContext.addPost()`에 있으므로 중복 구현이 생긴다.

따라서 권장은 `addPost()` 반환값 추가다.

### 1.3.4 선택 텍스트에 링크 연결

새 게시글 생성 후 링크 URL을 만든다.

```txt
/?channelId={channelId}&postId={createdPost.id}
```

절대 URL이 필요한 경우:

```txt
{window.location.origin}{window.location.pathname}?channelId={channelId}&postId={createdPost.id}
```

현재 EasyPage 내부 링크는 기존 `InternalLinkAutocomplete`도 `/?channelId=...&postId=...` 형식을 사용하므로, 같은 형식의 상대 URL을 우선 사용한다.

비동기 생성 중 selection이 사라질 수 있으므로, 버튼 클릭 직전에 selection range를 저장한다.

권장 흐름:

1. `const { from, to } = editor.state.selection` 저장
2. 선택 텍스트 저장
3. 새 EasyPage 생성
4. `editor.chain().focus().setTextSelection({ from, to }).setLink({ href }).run()`
5. 현재 EasyPage 저장

이미 선택 영역에 링크가 있으면 새 하위 페이지 링크로 덮어쓴다.

### 1.3.5 현재 EasyPage 자동 저장

새 하위 페이지를 만든 뒤 현재 EasyPage의 선택 텍스트에 링크만 삽입하고 저장하지 않으면, 사용자가 화면을 벗어날 때 링크가 사라질 수 있다.

따라서 `하위 페이지 만들기`는 아래 두 작업을 연속으로 수행한다.

1. 새 EasyPage 게시글 생성
2. 현재 EasyPage에 링크 삽입 후 `updatePost()`로 저장

저장 content 구성은 기존 `handleSave()`와 동일해야 한다.

- `MD_PAGE_MARKER` 유지
- image meta 유지
- preview mode에서는 `attachDocMeta(..., editor.getJSON())` 유지
- source mode는 BubbleMenu가 뜨지 않으므로 대상에서 제외

구현 시 `handleSave()` 내부 로직을 재사용 가능한 helper로 분리하는 것이 좋다.

예:

- `buildCurrentMdPageContent()`
- `saveCurrentMdPage({ silent })`

## 1.4 UX 상태

버튼을 누른 뒤 처리 중에는 다음 상태를 제공한다.

- 버튼 문구: `생성 중...`
- 같은 버튼 중복 클릭 방지
- 성공 시 BubbleMenu 닫기
- 실패 시 새 페이지 생성/링크 저장 중 어느 단계에서 실패했는지 알 수 있는 toast 또는 alert 표시

실패 처리 기준:

- 새 EasyPage 생성 실패:
  - 링크 삽입을 하지 않는다.
- 새 EasyPage 생성 성공, 현재 EasyPage 저장 실패:
  - editor에는 링크를 남기되 `isChanged = true` 상태를 유지한다.
  - 사용자에게 현재 페이지 저장 실패를 알려 수동 저장할 수 있게 한다.

## 1.5 권한과 대상 게시판

- 현재 EasyPage를 편집할 수 있는 사용자에게만 메뉴를 보여준다.
- 현재 channel에 게시글을 추가할 수 없는 경우 `addPost()`의 기존 권한 처리 흐름을 따른다.
- 새 하위 EasyPage는 현재 EasyPage와 같은 channel에 생성한다.
- 보안 등급은 부모 EasyPage의 `security_level`을 상속하는 것을 기본으로 한다.

## 1.6 수락 기준

1. EasyPage 편집 모드에서 텍스트를 선택하면 BubbleMenu에 `링크 추가`와 함께 `하위 페이지 만들기`가 보인다.
2. `하위 페이지 만들기`를 누르면 선택 텍스트를 제목으로 하는 새 EasyPage 게시글이 현재 channel에 생성된다.
3. 선택 텍스트에는 생성된 EasyPage로 이동하는 링크가 적용된다.
4. 현재 EasyPage를 새로고침하거나 다시 열어도 링크가 유지된다.
5. 생성 중 중복 클릭으로 하위 페이지가 여러 개 만들어지지 않는다.
6. 선택 텍스트가 비어 있거나 공백뿐이면 버튼 동작을 수행하지 않는다.
7. 기존 `링크 추가/수정/해제` 동작은 그대로 유지된다.
8. 선택한 텍스트에 이미 링크가 있으면 `하위 페이지 만들기` 버튼은 보이지 않는다.

## 1.7 구현 대상 파일

| 파일 | 변경 내용 |
|---|---|
| [src/components/chat/md-page/toolbar/LinkBubbleMenu.jsx](../src/components/chat/md-page/toolbar/LinkBubbleMenu.jsx) | `하위 페이지 만들기` 버튼 추가, 생성 callback 호출, 생성 중 상태 표시 |
| [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx) | selection 기반 하위 EasyPage 생성 handler 추가, LinkBubbleMenu에 callback 전달, 현재 페이지 저장 helper 분리 |
| [src/contexts/ChatContext.jsx](../src/contexts/ChatContext.jsx) | `addPost()`가 생성된 post를 반환하도록 보강 |
| [src/templates/formTemplates.js](../src/templates/formTemplates.js) | 필요 시 EasyPage marker/content 생성 helper 추가 |

## 1.8 구현 상태

구현 완료.

- `LinkBubbleMenu`에 `하위 페이지 만들기` 버튼을 추가한다.
- `MDPageViewer`에서 선택 텍스트 기반 하위 EasyPage 생성, 선택 텍스트 링크 적용, 현재 EasyPage 자동 저장을 처리한다.
- `ChatContext.addPost()`는 생성 직후 호출자가 새 post id를 사용할 수 있도록 생성된 post 객체를 반환한다.

## 1.9 [보정] 이미 링크가 있는 선택 영역에서는 하위 페이지 만들기 숨김

### 1.9.1 요구사항

EasyPage에서 선택한 텍스트에 이미 링크가 걸려 있으면 팝업 메뉴에 `하위 페이지 만들기`를 표시하지 않는다.

이미 링크가 있는 선택 영역에서는 기존 링크 편집 흐름만 제공한다.

- `링크 수정`
- `링크 해제`

### 1.9.2 구현 방안

`LinkBubbleMenu`는 TipTap editor 상태를 이미 알고 있으므로, 별도 API나 부모 state 없이 현재 selection의 link mark 활성 여부를 확인한다.

기준:

```js
const selectedHasLink = editor.isActive('link')
```

렌더링 규칙:

1. `selectedHasLink === false`
   - `링크 추가`
   - `하위 페이지 만들기`
2. `selectedHasLink === true`
   - `링크 수정`
   - `링크 해제`
   - `하위 페이지 만들기`는 숨김

### 1.9.3 구현 상태

구현 완료.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/components/chat/md-page/toolbar/LinkBubbleMenu.jsx](../src/components/chat/md-page/toolbar/LinkBubbleMenu.jsx) | `editor.isActive('link')` 값을 `selectedHasLink`로 계산하고, 링크 선택 상태에서는 `하위 페이지 만들기` 버튼을 렌더하지 않음 | 완료 |

## 1.10 [보정] 게시판 EasyPage 카드의 링크 URL 숨김

### 1.10.1 요구사항

EasyPage를 게시글로 올린 뒤 본문에 링크가 있으면 게시판 카드 미리보기에서 Markdown 링크 원문이 그대로 보인다.

예:

```md
[GUNDAM](/?channelId=...&postId=...)
```

게시판 카드에서는 URL을 노출하지 않고 링크 텍스트만 보여준다.
사용자가 링크임을 인식할 수 있도록 링크 텍스트에는 밑줄을 표시한다.

### 1.10.2 구현 방안

EasyPage 본문 데이터는 그대로 유지한다.
변경 대상은 게시판 카드 미리보기 렌더링만으로 한정한다.

현재 게시판 카드는 [src/components/ChatArea.jsx](../src/components/ChatArea.jsx)의 `PostCard`에서 EasyPage 본문을 `getMdPageContent()`로 가져온 뒤 텍스트 미리보기로 표시한다.
이 과정에서 Markdown 전체 렌더러를 쓰지 않기 때문에 `[텍스트](URL)` 문법이 그대로 노출된다.

따라서 카드 미리보기 전용 토큰 렌더러를 둔다.

처리 규칙:

1. `![alt](url)` 이미지는 카드 미리보기에서 URL 없이 `alt` 텍스트만 표시한다.
2. `[label](url)` 링크는 `label`만 표시한다.
3. `label`에는 `underline` 스타일을 적용한다.
4. 기존 mention 표시(`@사용자`)는 유지한다.
5. EasyPage 상세 화면과 저장 Markdown은 변경하지 않는다.

### 1.10.3 구현 상태

구현 완료.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/components/ChatArea.jsx](../src/components/ChatArea.jsx) | `renderPostPreviewTokens()` 추가. 게시판 카드의 `leadLine`/`bodyPreview`에서 Markdown 링크 URL을 숨기고 링크 텍스트만 밑줄로 표시 | 완료 |

## 1.11 [보정] 게시판 EasyPage 카드의 줄 끝 백슬래시 숨김

### 1.11.1 요구사항

EasyPage 게시글 카드 미리보기에서 각 행 끝에 `\` 문자가 보이지 않게 한다.

이 `\`는 Markdown에서 줄바꿈을 표현하기 위해 들어간 hard-break 표기이며, 카드 미리보기에서는 사용자에게 노출할 필요가 없다.

### 1.11.2 구현 방안

EasyPage 원본 Markdown은 수정하지 않는다.
게시판 카드 미리보기 텍스트를 만드는 정리 단계에서만 줄 끝 백슬래시를 제거한다.

적용 범위:

1. 게시판 카드의 `leadLine`, `bodyPreview`
2. 줄 끝 또는 줄바꿈 직전의 `\`
3. 본문 중간의 일반 백슬래시는 유지

구현 위치는 [src/components/ChatArea.jsx](../src/components/ChatArea.jsx)의 `sanitizePostPreviewTextKeepLines()`다.

추가 규칙:

```js
.replace(/\\[ \t]*(?=\n|$)/g, '')
```

### 1.11.3 구현 상태

구현 완료.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/components/ChatArea.jsx](../src/components/ChatArea.jsx) | 카드 미리보기 텍스트 정리 시 줄 끝 hard-break 백슬래시 제거 | 완료 |

## 1.12 [보정] EasyPage 내부 링크를 같은 창에서 열기

### 1.12.1 요구사항

EasyPage에서 하위 페이지 링크를 클릭하면 새 창이 아니라 같은 EasyDocStation 화면 안에서 하위 EasyPage가 열려야 한다.

대상 링크 형식:

```txt
/?channelId={channelId}&postId={postId}
```

외부 웹 링크는 기존처럼 새 창으로 연다.

### 1.12.2 구현 방안

EasyPage 링크 클릭은 [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx)의 TipTap `handleClick`에서 처리한다.
기존 구현은 모든 링크를 `window.open(..., '_blank')`로 열기 때문에 내부 하위 페이지 링크도 새 창으로 열린다.

변경 방향:

1. 클릭한 링크를 `new URL(href, window.location.origin)`으로 파싱한다.
2. 현재 origin과 같고 `channelId`, `postId` query가 있으면 내부 게시글 링크로 판단한다.
3. 내부 게시글 링크는 `window.open`을 호출하지 않고 부모 콜백 `onOpenPostLink(channelId, postId)`로 전달한다.
4. [src/components/ChatArea.jsx](../src/components/ChatArea.jsx)는 같은 채널이면 `setSelectedPost()`로 즉시 현재 EasyPage 영역을 하위 EasyPage로 교체한다.
5. 다른 채널이면 기존 `navigateToPost(channelId, postId)` 흐름을 재사용한다.
6. 내부 링크가 아닌 외부 링크는 기존처럼 새 창으로 연다.

### 1.12.3 구현 상태

구현 완료.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx) | 내부 `channelId/postId` 링크 판별 helper 추가, 내부 링크 클릭 시 `onOpenPostLink` 호출 | 완료 |
| [src/components/ChatArea.jsx](../src/components/ChatArea.jsx) | `handleOpenPostLink()` 추가, 같은 채널은 현재 선택 게시글 교체, 다른 채널은 `navigateToPost()` 사용 | 완료 |

## 1.13 EasyPage `/` 입력: 상하위 EasyPage 링크 삽입

### 1.13.1 요구사항

EasyPage 편집 중 `/`를 입력하면 현재 EasyPage와 연결된 EasyPage 목록을 보여준다.

목록 기준:

1. 현재 EasyPage에 링크로 연결된 하위 페이지
2. 현재 EasyPage를 링크로 참조하는 상위 페이지
3. 상위/하위 관계를 따라 이어지는 EasyPage
4. 연결된 EasyPage가 없으면 현재 게시판의 EasyPage 목록

사용자가 목록에서 하나를 선택하면 `/검색어` 입력을 선택한 EasyPage 제목으로 바꾸고, 해당 텍스트에 내부 EasyPage 링크를 적용한다.

링크 형식:

```txt
/?channelId={channelId}&postId={postId}
```

### 1.13.2 구현 방안

기존 `[[...]]` 내부 문서 링크 자동완성은 유지하고, `/` 전용 자동완성 컴포넌트를 별도로 추가한다.

대상 파일:

| 파일 | 변경 |
|---|---|
| [src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx](../src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx) | 신규. `/` 입력 감지, EasyPage 후보 목록 표시, 선택 시 링크 삽입 |
| [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx) | 현재 EasyPage, channelId, channelPosts를 slash menu에 전달 |

후보 목록 구성:

1. 현재 채널에 로드된 게시글 중 `<!--md-page-->` marker가 있는 글만 EasyPage로 본다.
2. 각 EasyPage 본문에서 `/?channelId=...&postId=...` 내부 링크를 추출한다.
3. 링크를 양방향 그래프로 구성한다.
   - A가 B를 링크하면 A -> B는 하위 관계다.
   - B 입장에서는 A가 상위 관계다.
4. 현재 EasyPage를 시작점으로 BFS를 수행해 연결된 상하위 EasyPage를 찾는다.
5. 연결된 후보가 없으면 현재 채널의 전체 EasyPage를 후보로 사용한다.
6. `/검색어`가 있으면 제목 기준으로 필터링한다.

입력 감지:

- TipTap selection이 비어 있고 현재 위치가 text block일 때만 동작한다.
- 현재 줄에서 마지막 토큰이 `/` 또는 `/검색어` 형태이면 메뉴를 연다.
- URL 입력 중인 `http://`, 경로 입력 중인 `a/b` 같은 일반 slash는 트리거하지 않도록 `/` 앞이 줄 시작 또는 공백일 때만 감지한다.

선택 동작:

1. `/검색어` range를 저장한다.
2. 사용자가 항목을 클릭하거나 Enter를 누르면 해당 range를 삭제한다.
3. EasyPage 제목 텍스트를 삽입한다.
4. 삽입 텍스트에 link mark를 적용한다.
5. 뒤에 공백 하나를 넣어 계속 입력할 수 있게 한다.

### 1.13.3 UX

- `/`만 입력하면 상하위 EasyPage 후보를 즉시 보여준다.
- `/gun`처럼 입력하면 후보 목록을 제목 기준으로 필터링한다.
- 키보드 조작:
  - `ArrowDown`/`ArrowUp`: 후보 이동
  - `Enter`: 선택
  - `Escape`: 닫기
- 검색 결과가 없으면 `연결된 EasyPage가 없습니다.` 또는 `검색 결과가 없습니다.`를 표시한다.

### 1.13.4 제한 사항

초기 구현은 현재 클라이언트에 로드된 채널 게시글을 기준으로 상하위 그래프를 구성한다.

채널의 모든 과거 EasyPage를 반드시 포함해야 하면 별도 API가 필요하다.
예: `GET /api/posts/easypages?channelId=...`로 해당 채널의 EasyPage 전체 목록과 내부 링크 정보를 내려주는 endpoint.

현재 단계에서는 기존 게시글 state를 활용해 프론트엔드 변경만으로 구현한다.

### 1.13.5 구현 상태

구현 완료.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx](../src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx) | `/` 입력 감지, 상하위 EasyPage 후보 계산, 링크 삽입 | 완료 |
| [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx) | Slash menu 렌더링 및 현재 EasyPage/context 전달 | 완료 |

## 1.14 [보정] `/` 링크 메뉴 위치와 선택 삽입 실패 수정

### 1.14.1 증상

EasyPage에서 `/`를 입력하면 EasyPage 링크 후보는 나타나지만, 메뉴 위치가 `/`를 입력한 커서 위치가 아니라 편집 영역의 처음 고정 위치에 나타난다.

또한 후보를 선택하면 `/`가 입력된 위치에 선택한 EasyPage 링크가 삽입되어야 하지만, 아무 텍스트도 나타나지 않는다.

### 1.14.2 원인

위치 문제:

- `EasyPageSlashLinkMenu`가 `absolute left-8 top-10`으로 고정 렌더링되어 있다.
- TipTap selection의 실제 좌표를 계산하지 않기 때문에 `/` 입력 위치와 무관하게 같은 위치에 표시된다.

삽입 문제:

- 기존 구현은 `editor.chain().deleteRange().insertContent({ type: 'text', marks: [...] })` 방식에 의존한다.
- 현재 selection/blur/메뉴 클릭 타이밍에 따라 저장된 replace range가 정확히 적용되지 않거나, link mark가 붙은 text node 삽입이 실패할 수 있다.

### 1.14.3 구현 방안

메뉴 위치:

1. `/` trigger를 감지할 때 `editor.view.coordsAtPos(to)`로 현재 커서의 viewport 좌표를 얻는다.
2. 메뉴는 `position: fixed`로 렌더링한다.
3. `left = coords.left`, `top = coords.bottom + 8` 기준으로 표시한다.
4. 화면 오른쪽/아래쪽을 벗어나지 않도록 최소한의 clamp를 적용한다.

링크 삽입:

1. 저장된 `/검색어` range를 사용한다.
2. ProseMirror transaction을 직접 만든다.
3. `schema.text(title, [schema.marks.link.create({ href })])`로 link mark가 적용된 text node를 만든다.
4. `tr.replaceWith(from, to, linkedText)`로 `/검색어`를 링크 텍스트로 치환한다.
5. 뒤에 공백 하나를 추가하고 selection을 공백 뒤로 이동한다.

### 1.14.4 구현 상태

구현 완료.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx](../src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx) | `coordsAtPos()` 기반 fixed 위치 렌더링, ProseMirror transaction 기반 링크 치환 삽입 | 완료 |

## 1.15 [보정] EasyPage Link 선택 시 텍스트 링크가 즉시 삽입되도록 수정

### 1.15.1 증상

EasyPage 편집 화면에서 `/`를 입력하면 EasyPage Link 후보 메뉴는 정상적으로 나타난다.

하지만 후보를 선택했을 때 선택된 링크가 `/`를 입력한 위치에 텍스트와 함께 나타나지 않는 경우가 있다.

기대 동작:

1. 사용자가 `/` 또는 `/검색어`를 입력한다.
2. EasyPage Link 메뉴에서 항목을 선택한다.
3. 입력 위치의 `/검색어`가 선택한 EasyPage 제목 텍스트로 치환된다.
4. 치환된 텍스트에는 `/?channelId=...&postId=...` 내부 링크가 적용된다.
5. 링크 뒤에 공백이 추가되어 바로 이어서 입력할 수 있다.

예:

```txt
/
```

`GUNDAM` 선택 후:

```md
[GUNDAM](/?channelId=...&postId=...)
```

### 1.15.2 원인

EasyPage 편집 영역은 링크 클릭 시 내부 EasyPage 이동을 처리하기 위해 pointer/mouse/click capture 단계에서 링크 네비게이션을 감지한다.

`EasyPageSlashLinkMenu`는 편집 영역 내부에 렌더링되므로, 메뉴 항목 클릭 이벤트도 부모 편집 영역의 링크 네비게이션 캡처 대상이 될 수 있다.

이 경우 메뉴 항목의 선택 handler가 실행되기 전에 이벤트가 가로채이거나, 클릭 좌표 아래의 editor link mark 탐지가 먼저 수행되어 삽입이 불안정해질 수 있다.

또한 삽입 로직은 `InternalLinkAutocomplete`와 같은 TipTap command chain 방식으로 통일하는 것이 유지보수에 유리하다.

### 1.15.3 구현 방안

메뉴 이벤트 제외:

1. `EasyPageSlashLinkMenu` 루트 DOM에 `data-easypage-slash-link-menu="true"` 속성을 부여한다.
2. `MDPageViewer.handleEditorLinkNavigation()`에서 이벤트 target이 해당 메뉴 내부이면 즉시 `false`를 반환한다.
3. 이로써 메뉴 클릭은 링크 이동 처리와 분리되고, 메뉴의 선택 handler가 정상 실행된다.

링크 삽입:

1. `/검색어` 감지 시 저장한 `replaceRange`를 사용한다.
2. 선택한 EasyPage의 `channelId`, `postId`로 내부 링크 URL을 만든다.
3. `deleteRange(replaceRange)`로 `/검색어`를 제거한다.
4. `insertContent({ type: 'text', text: title, marks: [{ type: 'link', attrs: { href } }] })`로 링크 텍스트를 삽입한다.
5. `insertContent(' ')`로 링크 뒤 공백을 추가한다.
6. 성공하면 메뉴를 닫고 위치 상태를 초기화한다.

### 1.15.4 구현 상태

구현 완료.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx) | EasyPage Link 메뉴 내부 이벤트를 링크 네비게이션 캡처에서 제외 | 완료 |
| [src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx](../src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx) | 메뉴 루트 식별 속성 추가, 선택 항목을 제목 텍스트 링크로 삽입 | 완료 |

## 1.16 [보정] `/` 메뉴 항목 선택 시 링크가 끝내 삽입되지 않는 문제

### 1.16.1 증상

EasyPage 편집 화면에서 `/`를 입력하면 후보 메뉴는 정상적으로 나타난다.

하지만 후보를 선택(클릭 또는 Enter)해도 `/` 위치에 선택한 EasyPage 링크 텍스트가 삽입되지 않는다.

1.15까지의 보정에도 불구하고 재현된다.

### 1.16.2 원인

기존 삽입은 `editor.chain().focus().deleteRange().insertContent(...).run()` 커맨드 체인에 의존한다.

- 키보드 선택(Enter): 후보 선택 keydown 리스너가 `editor.view.dom`에 bubble 단계로 붙어 있어, ProseMirror의 기본 Enter 처리(줄 분리)가 먼저 실행된다. 이로 인해 문서 위치가 밀려 저장된 `replaceRange`가 어긋나고 삽입이 무의미해지거나 무시된다.
- 마우스 선택(Click): fixed 메뉴 클릭 시 포커스/selection 타이밍에 따라 `chain().focus()`가 기대한 selection을 복원하지 못해 `deleteRange` 이후 `insertContent`가 반영되지 않을 수 있다.

즉 삽입 로직이 에디터 포커스 상태와 이벤트 처리 순서에 민감하게 얽혀 있는 것이 근본 원인이다.

### 1.16.3 구현 방안

포커스/이벤트 순서에 의존하지 않도록 삽입을 ProseMirror 트랜잭션으로 직접 처리한다.

링크 삽입:

1. 저장한 `/검색어` `replaceRange`를 사용한다.
2. `schema.text(title, [linkMark.create({ href })])`로 link mark가 적용된 제목 text node를 만든다.
3. 공백 text node를 함께 만든다.
4. `state.tr.replaceWith(from, to, [linkedTitle, trailingSpace])`로 `/검색어`를 한 번에 치환한다.
5. 커서를 공백 뒤로 이동(`TextSelection.create`)하고 `view.dispatch(tr.scrollIntoView())` 후 `view.focus()`로 마무리한다.

키보드 처리:

- 후보 이동/선택/닫기 keydown 리스너를 **capture 단계**(`addEventListener(..., true)`)로 등록해 ProseMirror 기본 처리보다 먼저 실행되게 하고, 처리한 키는 `preventDefault` + `stopPropagation`한다.

마우스 처리:

- 메뉴 항목 `onMouseDown`에서 `preventDefault` + `stopPropagation`으로 포커스 이동과 상위 전파를 함께 차단한다.

### 1.16.4 구현 상태

구현 완료.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx](../src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx) | 커맨드 체인 대신 `tr.replaceWith` 트랜잭션으로 링크 삽입, keydown capture 단계 가로채기, 항목 클릭 전파 차단 | 완료 |

# 2. EasyPage Navigation Panel: Top/하위 페이지 목차

## 2.1 배경과 목표

EasyPage를 여러 단계로 만들어 가면 현재 화면에서는 선택한 페이지의 본문만 크게 보인다. 사용자는 현재 페이지가 전체 구조에서 어디에 있는지, Top 페이지 아래에 어떤 하위 페이지들이 만들어졌는지 한눈에 확인하기 어렵다.

EasyPage 화면 왼쪽에 접을 수 있는 `Navigation Panel`을 추가한다.

Navigation Panel의 목표는 다음과 같다.

1. 현재 EasyPage가 포함된 구조의 Top 페이지를 표시한다.
2. Top 페이지 아래의 하위 EasyPage 제목을 계층형 목차로 표시한다.
3. 현재 보고 있는 페이지를 강조하고 상위 경로를 펼친다.
4. 목차 항목을 누르면 같은 EasyPage 화면에서 해당 페이지로 이동한다.
5. 페이지를 추가하거나 제목을 변경하면 목차에 반영한다.
6. 페이지 수가 많아져도 전체 구조와 현재 위치를 쉽게 파악할 수 있게 한다.

## 2.2 현재 구조 검토

현재 구현에는 Navigation Panel에 재사용할 수 있는 기반이 이미 있다.

- [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx)
  - 현재 EasyPage 본문과 편집기, `channelId`, `freshPost`, `channelPosts`를 가지고 있다.
  - 내부 EasyPage 링크를 클릭하면 `onOpenPostLink`를 통해 같은 화면에서 다른 페이지를 연다.
  - 선택 텍스트로 하위 페이지를 생성할 때 부모 본문에 자식 페이지 링크를 저장한다.
- [src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx](../src/components/chat/md-page/toolbar/EasyPageSlashLinkMenu.jsx)
  - 현재 채널의 EasyPage 제목과 내부 링크를 읽어 연결 그래프를 만든다.
  - 현재는 연결 관계를 양방향 그래프로 계산하므로 검색 후보에는 적합하지만, Top/하위 방향과 형제 순서를 표현하는 목차에는 그대로 사용할 수 없다.
- [src/components/ChatArea.jsx](../src/components/ChatArea.jsx)
  - `onOpenPostLink`의 실제 페이지 전환을 처리한다.
- [src/templates/formTemplates.js](../src/templates/formTemplates.js)
  - `isMdPage()`와 `getMdPageTitle()`로 EasyPage 여부 및 제목을 판별할 수 있다.

현재의 하위 페이지 관계는 부모 EasyPage 본문 안의 내부 링크로만 표현된다.

```txt
부모 EasyPage 본문 --내부 링크--> 하위 EasyPage
```

이 방식은 기존 페이지를 추가 데이터 없이 찾아낼 수 있다는 장점이 있다. 그러나 일반 참조 링크와 실제 하위 페이지 링크를 구분할 수 없고, 한 페이지가 여러 페이지에서 링크되거나 순환 링크가 생기면 하나의 정확한 트리로 확정하기 어렵다.

## 2.3 권장 UI 구조

데스크톱 화면은 다음과 같이 구성한다.

```txt
┌──────────────────────────────────────────────────────────────────┐
│ 기존 EasyPage 상단 헤더/도구 모음                                │
├──────────────────┬───────────────────────────────────────────────┤
│ Navigation       │ EasyPage 본문                                 │
│                  │                                               │
│ ▼ HEALTH PILOT AI│ # HEALTH PILOT AI                             │
│   ├ 권장 구조    │                                               │
│   │ ├ 데이터     │                                               │
│   │ └ 권한 관리  │                                               │
│   └ 운영 계획    │                                               │
│                  │                                               │
│ [패널 접기]      │                                               │
└──────────────────┴───────────────────────────────────────────────┘
```

Navigation Panel 권장 사양:

- 기본 너비: `260px`
- 사용자가 드래그해 `220px ~ 420px` 범위에서 너비 조절
- 패널 접기/펼치기 버튼 제공
- 접은 상태에서는 작은 목차 아이콘만 표시
- 패널과 본문은 각각 독립적으로 세로 스크롤
- 현재 페이지는 배경색과 굵은 글씨로 강조
- 현재 페이지의 모든 상위 항목은 자동으로 펼침
- 각 페이지 왼쪽의 화살표로 하위 목록을 개별 접기/펼치기
- 긴 제목은 한 줄 말줄임 처리하고 hover 시 전체 제목을 tooltip으로 표시
- 하위 페이지 개수가 있으면 선택적으로 숫자 badge 표시
- 로딩, 빈 구조, 접근 불가 페이지 상태를 각각 구분해 표시

모바일 또는 폭이 좁은 화면에서는 고정 왼쪽 패널 대신 상단의 `목차` 버튼으로 여는 drawer를 사용한다. 목차에서 페이지를 선택하면 drawer를 자동으로 닫는다.

## 2.4 목차 구성 규칙

### 2.4.1 제목

- 각 EasyPage의 첫 번째 H1을 제목으로 사용한다.
- H1이 없으면 기존 `getMdPageTitle(content, 'EasyPage')` 결과를 사용한다.
- 제목 편집 후 저장이 완료되면 Navigation Panel의 제목을 갱신한다.
- 저장하지 않은 제목은 현재 페이지 항목에만 임시로 보여줄 수 있으나, 다른 사용자에게는 저장 후 반영한다.

### 2.4.2 Top 페이지

- `parentPostId`가 없는 페이지를 Top 페이지로 본다.
- 현재 페이지에서 부모를 계속 따라가 가장 위의 페이지를 현재 구조의 Top으로 결정한다.
- 부모가 삭제되었거나 접근 권한이 없으면 현재 확인 가능한 가장 위 페이지를 임시 Top으로 표시한다.
- 순환 관계가 감지되면 탐색을 중단하고 현재 페이지를 임시 Top으로 표시하며 콘솔에 진단 정보를 남긴다.

### 2.4.3 하위 페이지와 순서

- 같은 부모를 가진 페이지는 저장된 `position` 오름차순으로 표시한다.
- `position`이 같거나 없는 기존 데이터는 부모 본문에 링크가 나타나는 순서, 생성일, post id 순으로 안정 정렬한다.
- 새 하위 페이지는 기본적으로 같은 부모의 마지막 위치에 추가한다.
- 추후 drag-and-drop을 제공할 경우 형제 간 순서만 변경하는 것을 기본으로 하고, 다른 부모로 이동하는 동작은 별도 확인 후 수행한다.

### 2.4.4 현재 문서 안의 제목 목차와 구분

Navigation Panel의 1차 목적은 여러 EasyPage 사이의 페이지 목차다. 현재 EasyPage 본문 안의 H2/H3 목차와 혼합하면 계층 의미가 모호해질 수 있다.

초기 구현에서는 EasyPage 제목만 표시한다. 후속 단계에서 현재 선택된 EasyPage 아래에만 H2/H3를 보조 목차로 표시할 수 있다.

## 2.5 관계 데이터 모델 검토

### 2.5.1 1단계: 기존 내부 링크 기반 목차

빠른 초기 구현에서는 기존 EasyPage 본문의 내부 링크를 방향성 있게 분석한다.

1. 현재 채널의 EasyPage만 수집한다.
2. 각 페이지 본문에서 `channelId/postId` 내부 링크를 본문 등장 순서대로 추출한다.
3. A 본문이 B를 링크하면 우선 `A -> B`를 부모/하위 후보 관계로 본다.
4. 역방향 링크를 따라 현재 페이지의 Top 후보를 찾는다.
5. Top부터 깊이 우선 탐색해 트리를 만든다.
6. 방문한 post id를 기록해 순환을 차단한다.
7. 여러 부모가 같은 페이지를 가리키면 최초로 발견된 관계를 기본 경로로 사용하고 다른 위치에는 `참조` 표시를 붙인다.

장점:

- DB 변경 없이 빠르게 제공할 수 있다.
- 이미 만들어진 EasyPage에도 바로 적용할 수 있다.
- 부모 본문에서 링크가 나타나는 순서를 목차 순서로 사용할 수 있다.

제한:

- 일반 참조 링크와 하위 페이지 링크를 완전히 구분하지 못한다.
- 현재 클라이언트에 로드되지 않은 과거 게시글은 목차에서 빠질 수 있다.
- 링크 삭제가 실제 하위 관계 삭제인지 단순 본문 편집인지 판단하기 어렵다.
- 다중 부모와 순환 관계를 UI 규칙으로 보정해야 한다.

따라서 링크 기반 방식은 MVP 및 기존 데이터 마이그레이션 용도로 사용하고, 최종 구조는 명시적 관계 데이터로 전환하는 것을 권장한다.

### 2.5.2 2단계: 명시적 EasyPage 관계 저장

정확한 Top/하위 구조와 목차 순서를 위해 EasyPage 전용 관계를 별도 저장한다.

권장 논리 모델:

```txt
easy_page_relations
- channel_id
- parent_post_id
- child_post_id
- position
- created_at
- updated_at
```

제약 조건:

- `(parent_post_id, child_post_id)`는 유일해야 한다.
- `parent_post_id !== child_post_id`여야 한다.
- 초기 정책은 한 하위 페이지에 하나의 구조상 부모만 허용한다.
- 부모와 하위 페이지는 같은 channel의 EasyPage여야 한다.
- 관계 생성/이동 시 서버에서 순환 여부를 검사한다.
- 일반 본문 링크는 여러 개 허용하며 구조상 부모 관계와 분리한다.

기존 `posts.parent_id`, `child_post_id` 필드는 다른 게시글 기능과 의미가 겹칠 가능성이 있으므로 사용 범위를 확인하지 않고 EasyPage 트리 용도로 재사용하지 않는다. EasyPage 전용 API/테이블 또는 명시적인 metadata 필드를 사용하는 편이 안전하다.

권장 API 예시:

```txt
GET    /api/channels/:channelId/easy-pages/tree?postId=:currentPostId
POST   /api/channels/:channelId/easy-pages/relations
PATCH  /api/channels/:channelId/easy-pages/relations/:childPostId
DELETE /api/channels/:channelId/easy-pages/relations/:childPostId
```

트리 조회 응답은 권한 필터링이 끝난 최소 데이터를 내려준다.

```json
{
  "rootPostId": "top-page-id",
  "items": [
    {
      "postId": "top-page-id",
      "parentPostId": null,
      "title": "HEALTH PILOT AI",
      "position": 0,
      "hasChildren": true
    }
  ]
}
```

## 2.6 주요 동작

### 2.6.1 페이지 이동

1. Navigation Panel의 항목을 선택한다.
2. 저장하지 않은 변경이 있으면 기존 EasyPage 이탈 확인 정책을 적용한다.
3. 같은 채널의 페이지는 기존 `onOpenPostLink({ channelId, postId })`를 호출한다.
4. 페이지가 열리면 선택 항목을 강조하고 필요한 상위 가지를 펼친다.
5. 현재 항목이 스크롤 밖에 있으면 `scrollIntoView({ block: 'nearest' })`로 노출한다.

브라우저 URL의 `channelId/postId`도 기존 방식대로 갱신해 새로고침 및 링크 공유가 가능해야 한다.

### 2.6.2 하위 페이지 생성

기존 `하위 페이지 만들기` 흐름에 관계 저장을 추가한다.

1. 하위 EasyPage post 생성
2. 부모 본문의 선택 텍스트에 내부 링크 삽입
3. `parentPostId`, 마지막 `position`으로 구조 관계 저장
4. 현재 EasyPage 저장
5. Navigation Panel 캐시 갱신

관계 저장이 실패하면 생성된 페이지와 본문 링크는 유지하되, `목차에 연결하지 못했습니다`라는 복구 가능한 오류를 보여주고 재연결 기능을 제공한다.

### 2.6.3 제목 변경

- 현재 페이지 저장 성공 후 트리의 해당 항목 title을 갱신한다.
- optimistic update를 사용한 경우 저장 실패 시 이전 제목으로 되돌린다.
- 다른 사용자의 변경은 트리 재조회 또는 기존 실시간 post 갱신을 통해 반영한다.

### 2.6.4 삭제와 접근 권한

- 하위 페이지가 없는 페이지는 기존 삭제 확인 후 삭제할 수 있다.
- **하위 페이지가 하나라도 있는 페이지는 즉시 삭제하지 않는다.** 서버도 일반 삭제 요청을 `409 Conflict`로 거절하고 하위 페이지 수를 반환한다.
- 사용자에게 `하위 페이지 처리 방법` 대화상자를 열고 다음 두 동작 중 하나를 명시적으로 선택하게 한다.
  1. `하위 페이지 이동 후 현재 페이지만 삭제`
  2. `현재 페이지와 모든 하위 페이지 함께 삭제`
- 아무 항목도 선택하지 않은 상태에서는 확인 버튼을 비활성화한다.
- 대화상자를 닫거나 `취소`를 누르면 페이지와 관계 데이터를 전혀 변경하지 않는다.
- 사용 권한이 없는 페이지의 제목과 존재 여부를 노출하지 않는다.
- 권한 때문에 중간 부모가 숨겨지면 접근 가능한 페이지를 최상위에 배치하고 `일부 경로는 권한으로 숨겨짐` 상태를 표시할 수 있다.

#### 2.6.4.1 하위 페이지 이동 후 현재 페이지만 삭제

이 동작을 선택하면 삭제 대상의 **직접 하위 페이지들**을 다른 부모 아래로 이동한 뒤 현재 페이지만 삭제한다.

대화상자 구성:

- 삭제할 현재 페이지 제목
- 직접 하위 페이지 수와 제목 목록
- 새 부모 페이지 선택 목록
- `하위 페이지 이동 후 삭제` 버튼
- `취소` 버튼

새 부모 선택 규칙:

- 기본 추천 위치는 삭제 대상의 기존 부모다.
- 삭제 대상이 Top 페이지이면 같은 channel에서 새 Top으로 사용할 수 있는 위치를 선택하게 한다.
- 삭제 대상 자신과 삭제 대상의 모든 하위 페이지는 새 부모 후보에서 제외한다.
- 접근 권한이나 편집 권한이 없는 페이지는 후보에 표시하지 않는다.
- 선택한 위치로 이동할 때 순환 구조가 생기지 않는지 서버에서 다시 검사한다.

처리 순서:

1. 삭제 대상과 하위 페이지의 최신 관계 및 사용자 권한 확인
2. 직접 하위 페이지를 선택한 새 부모의 마지막 순서로 이동
3. 새 부모의 기존 항목 뒤에서 하위 페이지들의 상대 순서 유지
4. 삭제 대상의 부모 본문에 있는 구조상 링크 제거 또는 관계 metadata 정리
5. 현재 페이지만 삭제
6. Navigation Panel tree 재조회 및 캐시 무효화
7. 삭제한 페이지를 보고 있었다면 새 부모 페이지로 이동

위 과정은 서버 transaction으로 처리한다. 중간 단계가 하나라도 실패하면 이동과 삭제를 모두 rollback하여 기존 구조를 유지한다.

#### 2.6.4.2 현재 페이지와 모든 하위 페이지 함께 삭제

이 동작은 삭제 대상을 root로 하는 전체 subtree를 삭제한다. 직접 하위뿐 아니라 손자 이하의 모든 EasyPage가 대상이다.

안전장치:

- 삭제되는 전체 페이지 수를 미리 계산해 보여준다.
- 삭제될 페이지 제목을 접을 수 있는 목록으로 표시한다.
- `이 작업은 하위 페이지 전체를 삭제합니다`라는 경고를 표시한다.
- 사용자가 삭제 대상 페이지 제목 또는 `삭제` 확인 문구를 직접 입력해야 최종 버튼을 활성화한다.
- 최종 버튼은 `총 N개 페이지 삭제`처럼 영향 범위를 명확히 표시한다.
- 사용자에게 subtree 안의 모든 페이지 삭제 권한이 있어야 한다. 하나라도 권한이 없으면 전체 삭제를 중단하고 해당 사실만 알리며, 권한 없는 페이지 제목은 노출하지 않는다.

처리 순서:

1. 서버에서 subtree를 다시 계산하고 순환 관계를 방어한다.
2. 삭제 대상 전체에 대한 권한과 참조 무결성을 검사한다.
3. 가장 깊은 하위 페이지부터 관계와 페이지를 삭제한다.
4. subtree 밖의 페이지에 남은 구조 관계와 구조상 링크를 정리한다.
5. Navigation Panel tree 재조회 및 캐시 무효화
6. 삭제 대상의 기존 부모 페이지로 이동한다.
7. 삭제 대상이 Top 페이지이고 남은 부모가 없으면 게시판으로 이동한다.

페이지 및 관계 삭제는 하나의 서버 transaction으로 처리한다. 부분 삭제는 허용하지 않는다.

#### 2.6.4.3 삭제 후 자동 반영

- 삭제 API가 성공하면 클라이언트의 `channelPosts`에서 삭제된 post들을 제거한다.
- `channelId + rootPostId` Navigation tree 캐시를 즉시 무효화하고 다시 조회한다.
- 삭제된 항목, 이동된 하위 페이지, 변경된 형제 순서를 새로고침 없이 Navigation Panel에 반영한다.
- optimistic UI를 사용하더라도 서버 요청 실패 시 삭제 전 tree snapshot으로 복구한다.
- 다른 사용자의 삭제는 기존 실시간 post 갱신을 구독하거나 tree version 변경을 감지해 반영한다.
- 삭제 직후 선택 페이지가 존재하지 않는 짧은 중간 상태가 보이지 않도록 이동 목적지와 새 tree를 함께 반영한다.

#### 2.6.4.4 권장 삭제 API

삭제의 영향 범위를 먼저 확인하는 preview API와 실제 실행 API를 분리한다.

```txt
GET  /api/channels/:channelId/easy-pages/:postId/delete-preview
POST /api/channels/:channelId/easy-pages/:postId/delete
```

실행 요청 예시:

```json
{
  "strategy": "move_children",
  "destinationParentPostId": "new-parent-id",
  "expectedTreeVersion": 12
}
```

```json
{
  "strategy": "delete_subtree",
  "confirmation": "삭제",
  "expectedTreeVersion": 12
}
```

`expectedTreeVersion`이 현재 서버 tree version과 다르면 `409 Conflict`를 반환하고 최신 삭제 대상을 다시 보여준다. 대화상자를 연 뒤 다른 사용자가 하위 페이지를 추가한 상황에서 확인하지 않은 페이지까지 함께 삭제되는 것을 방지하기 위한 장치다.

## 2.7 컴포넌트 및 구현 대상

프론트엔드 권장 구성:

| 파일 | 변경 내용 |
|---|---|
| `src/components/chat/md-page/navigation/EasyPageNavigationPanel.jsx` | 신규. 패널 shell, 접기/펼치기, 로딩/빈 상태, 현재 페이지 표시 |
| `src/components/chat/md-page/navigation/EasyPageTreeItem.jsx` | 신규. 재귀 트리 항목, 하위 가지 토글, 페이지 선택 |
| `src/components/chat/md-page/navigation/easyPageTree.js` | 신규. 링크 추출, Top 탐색, 트리 구성, 순환/다중 부모 방어 로직 |
| [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx) | 본문 왼쪽에 패널 배치, 현재 post/context 전달, 저장·생성 후 갱신 |
| [src/components/ChatArea.jsx](../src/components/ChatArea.jsx) | 기존 `onOpenPostLink` 재사용, 필요 시 트리 조회/갱신 callback 전달 |
| 서버 EasyPage route/repository | 2단계 관계 저장 및 현재 구조 전체 조회 API 추가 |

`EasyPageSlashLinkMenu`와 Navigation Panel이 각각 내부 링크를 따로 파싱하지 않도록 `extractInternalPostLinks`, 제목 수집, EasyPage map 생성 로직을 `easyPageTree.js`의 공통 유틸리티로 분리한다.

레이아웃은 기존 댓글 패널과 충돌하지 않도록 다음 3영역을 고려한다.

```txt
Navigation Panel | EasyPage content | Comments Panel(optional)
```

작은 화면에서는 Navigation과 Comments를 동시에 고정 노출하지 않고 drawer 또는 overlay로 전환한다.

## 2.8 상태와 성능

- 패널 상태: `expandedNodeIds`, `panelCollapsed`, `panelWidth`
- 현재 브라우저에서만 필요한 접기/너비 상태는 `localStorage`에 사용자별로 저장할 수 있다.
- 트리 데이터는 `channelId + rootPostId` 기준으로 캐시한다.
- 제목/관계/삭제 변경 시 해당 트리 캐시를 무효화한다.
- 트리가 크면 닫힌 가지의 하위 DOM을 렌더하지 않는다.
- 링크 기반 MVP는 `channelPosts`가 바뀔 때만 `useMemo`로 트리를 다시 계산한다.
- 서버 방식은 전체 본문 대신 id, title, parent id, position, 권한 정보만 반환한다.

## 2.9 단계별 구현 권장안

### 2.9.1 Phase 1: 읽기 전용 Navigation Panel

- 기존 내부 링크와 `channelPosts`로 트리를 계산한다.
- 왼쪽 패널, 현재 페이지 강조, 펼치기/접기, 항목 이동을 구현한다.
- 순환 링크, 다중 부모, 누락 페이지 방어 처리를 포함한다.
- 패널 접힘과 너비를 로컬에 저장한다.

이 단계만으로 사용자가 요청한 “어디까지 구조가 만들어졌는지 확인”하는 문제를 빠르게 해결할 수 있다.

### 2.9.2 Phase 2: 전체 채널 및 명시적 관계

- 현재 로드된 게시글 범위를 넘어 전체 EasyPage tree를 반환하는 API를 추가한다.
- 하위 페이지 생성 시 관계를 함께 저장한다.
- 기존 내부 링크를 분석해 관계 데이터를 초기 이관한다.
- 일반 참조 링크와 구조상 하위 관계를 분리한다.
- 하위 페이지가 있는 페이지의 일반 삭제를 차단하고 삭제 preview API를 추가한다.
- `하위 페이지 이동 후 삭제`와 `전체 subtree 삭제`를 transaction으로 구현한다.

### 2.9.3 Phase 3: 목차 편집

- drag-and-drop 형제 순서 변경
- 다른 부모로 페이지 이동
- Navigation Panel에서 하위 페이지 바로 만들기
- 삭제/분리/재연결 관리 메뉴
- 현재 페이지의 H2/H3 보조 목차

## 2.10 오류 및 예외 처리

- 링크 대상 post가 없음: `삭제되거나 찾을 수 없는 페이지`로 표시하고 이동 비활성화
- 중복 링크: 목차에는 한 번만 표시
- 자기 자신 링크: 하위 관계에서 제외
- 순환 링크: 최초 방문 경로만 유지하고 반복 항목에 경고 아이콘 표시
- 다중 부모: 기본 부모 아래에만 실제 항목을 표시하고 다른 위치에는 참조 항목 표시
- 현재 post가 `channelPosts`에 없음: 현재 페이지를 임시 단일 Top으로 표시하고 백그라운드 재조회
- 제목 없음: `제목 없는 EasyPage`와 축약 post id 표시
- 저장하지 않은 편집 내용이 있음: 페이지 이동 전 기존 이탈 확인 적용
- 트리 조회 실패: 본문은 정상 표시하고 패널 안에 재시도 버튼 표시
- 삭제 확인 중 tree version 변경: 삭제를 실행하지 않고 최신 하위 페이지 목록을 다시 표시
- 하위 페이지 이동 실패: 삭제도 실행하지 않고 기존 tree 유지
- subtree 일부에 삭제 권한 없음: 전체 삭제 중단, 부분 삭제 금지

## 2.11 접근성

- 패널은 `<nav aria-label="EasyPage 목차">`를 사용한다.
- 트리는 `role="tree"`, 항목은 `role="treeitem"`과 `aria-level`, `aria-expanded`, `aria-current="page"`를 제공한다.
- 키보드 `ArrowUp/Down`으로 항목 이동, `ArrowLeft/Right`로 가지 접기/펼치기, `Enter`로 페이지 열기를 지원한다.
- 접기/펼치기 버튼에는 제목과 동작이 포함된 `aria-label`을 제공한다.
- 색상만으로 현재 페이지를 구분하지 않고 굵기 또는 현재 페이지 아이콘을 함께 사용한다.

## 2.12 수락 기준

1. EasyPage를 열면 왼쪽에 현재 구조의 Top 페이지와 하위 페이지 제목이 계층형으로 보인다.
2. 현재 페이지가 목차에서 명확하게 강조되고 모든 상위 경로가 펼쳐진다.
3. 목차 항목을 선택하면 새 창 없이 해당 EasyPage가 열린다.
4. 브라우저 뒤로가기/앞으로가기와 URL 공유 후 재진입이 정상 동작한다.
5. 하위 페이지를 만든 뒤 새로고침하지 않아도 목차에 추가된다.
6. EasyPage 제목을 변경하고 저장하면 목차 제목도 변경된다.
7. 목차의 형제 페이지 순서는 정의된 `position` 또는 부모 본문의 링크 순서와 일치한다.
8. 패널을 접고 다시 펼칠 수 있으며 본문과 댓글 패널 레이아웃이 깨지지 않는다.
9. 모바일에서는 drawer 형태로 목차를 열고 페이지를 이동할 수 있다.
10. 권한 없는 페이지의 제목이나 존재 여부가 노출되지 않는다.
11. 순환 링크, 삭제된 링크, 다중 부모가 있어도 화면이 멈추거나 무한 재귀하지 않는다.
12. Navigation Panel 조회가 실패해도 현재 EasyPage 본문 편집과 저장은 계속 가능하다.
13. 하위 페이지가 있는 EasyPage의 일반 삭제 요청은 차단되고 처리 방법 선택 대화상자가 열린다.
14. `하위 페이지 이동 후 삭제`를 선택하면 직접 하위 페이지의 순서가 유지된 채 지정한 부모로 이동하고 현재 페이지만 삭제된다.
15. `모든 하위 페이지 함께 삭제`를 선택하면 삭제 대상 전체 목록과 개수를 확인하고 확인 문구를 입력해야 실행할 수 있다.
16. 이동 또는 전체 삭제 중 하나라도 실패하면 부분 반영 없이 삭제 전 구조가 유지된다.
17. 삭제 성공 후 Navigation Panel과 현재 페이지 이동이 새로고침 없이 자동 반영된다.
18. 삭제 확인 대화상자를 연 뒤 tree가 변경되면 기존 확인으로 삭제하지 않고 최신 영향 범위를 다시 확인하게 한다.

## 2.13 검토 결론

Navigation Panel 도입은 EasyPage가 단일 문서 편집기를 넘어 여러 페이지로 구성된 문서 공간으로 확장되기 위해 필요한 기능이다.

우선 기존 내부 링크를 이용한 읽기 전용 패널을 구현하면 DB 변경 없이 빠르게 구조 가시성을 확보할 수 있다. 다만 링크만으로는 일반 참조와 부모/하위 관계를 완전히 구분할 수 없으므로, 순서 변경과 페이지 이동까지 제공하려면 EasyPage 전용 관계 데이터가 필요하다.

따라서 **Phase 1 링크 기반 Navigation Panel → Phase 2 명시적 관계 저장/API → Phase 3 목차 편집** 순서로 구현하는 것을 권장한다.
