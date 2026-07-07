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
