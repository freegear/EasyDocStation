# 선택한 게시글·댓글 인쇄 기능 검토 및 구현 설계

## 1. 요청 사항

- 현재 선택된 게시글 또는 댓글을 인쇄할 수 있어야 한다.
- 댓글뿐 아니라 게시글에서도 동일한 사용자 팝업 메뉴가 나타나야 한다.
- 사용자 팝업 메뉴에 `인쇄` 항목을 추가한다.
- `인쇄`를 누르면 선택된 항목만 인쇄 대상으로 삼아 브라우저 인쇄 창을 연다.
- 게시글 본문이 A4 한 페이지보다 길면 내용을 자르지 않고 필요한 페이지 수만큼 자동으로 이어서 인쇄한다.
- A4 인쇄 여백은 상하좌우 약 1cm(`10mm`)로 적용한다.
- 인쇄물의 본문·제목·메타데이터 글꼴은 기존 인쇄 크기보다 20% 작게 적용한다.
- PDF 저장 시 사용되는 파일 제목은 최대 32자로 제한한다.
- 이미지와 SVG 다이어그램은 원본이 한 페이지보다 작으면 원래 크기를 유지하고, 한 페이지보다 클 때만 비율을 유지해 한 페이지 안으로 축소한다.
- 코드 블록과 인용·텍스트 블록은 회색 테두리와 옅은 회색 배경으로 본문과 구분한다.
- 일반 문단에 입력된 명시적 줄바꿈과 연속 공백은 인쇄물에서도 그대로 보존한다.
- 첨부 여부를 나타내는 클립 아이콘과 PDF·문서 등 파일 형식을 나타내는 아이콘은 인쇄에서 제외한다.

이 문서에서 “게시글 클릭 시 팝업 메뉴”는 제공된 Safari 화면을 근거로 **게시글 우클릭(컨텍스트 클릭)** 으로 해석한다. 일반 좌클릭까지 메뉴 열기로 변경하면 현재의 “게시글 상세 열기” 동작과 충돌하므로 좌클릭은 기존 동작을 유지한다. 모바일에서 같은 기능이 필요하면 후속 단계에서 길게 누르기를 연결한다.

## 2. 현재 코드 조사 결과

### 2.1 상세 화면의 사용자 메뉴

관련 파일: `src/components/chat/PostDetailPane.jsx`

- `ActionMenu`가 게시글과 댓글의 공통 메뉴 UI를 담당한다.
- 게시글과 댓글은 `selectedTarget`으로 구분한다.
- `activeTargetType`은 선택된 댓글이 있으면 `comment`, 아니면 `post`가 된다.
- `openContextActionMenu()`가 우클릭 좌표를 보정하고 메뉴를 연다.
- 상세 화면의 게시글 영역과 각 댓글 카드에는 이미 `onContextMenu`가 연결되어 있다.
- 현재 메뉴 항목은 수정, 삭제, 복사, 링크복사, 핀 고정, 채널 복사/이동, AgenticAI 전송, DM 전송이다.
- 현재 `ActionMenu`에는 인쇄 항목과 `print` 액션 처리가 없다.

따라서 상세 화면에서는 공통 메뉴에 `인쇄` 항목과 처리 함수만 추가하면 게시글·댓글 모두 같은 방식으로 인쇄 기능을 사용할 수 있다.

### 2.2 왼쪽 게시글 목록

관련 파일: `src/components/ChatArea.jsx`

- `PostList`가 게시글 목록을 만들고 각 항목을 `PostCard`로 렌더링한다.
- `PostCard`의 좌클릭과 키보드 Enter/Space는 `onSelect(post)`를 호출하여 상세 화면을 연다.
- 텍스트 드래그 선택과 복사 동작을 보호하는 `useSelectionClickGuard`가 적용되어 있다.
- `PostCard`에는 `onContextMenu`가 없다.

이 때문에 목록의 게시글을 우클릭하면 애플리케이션 메뉴가 아니라 Safari/Chrome의 기본 브라우저 메뉴가 나타난다. 제공된 두 번째 화면이 이 경우에 해당한다.

### 2.3 기존 인쇄 구현

- `src/components/chat/md-page/hooks/useMDPagePrint.js`에는 EasyPage를 `html2canvas`와 `jsPDF`로 PDF 변환한 뒤 인쇄하는 기능이 있다.
- `src/templates/formTemplates.js`에는 지출결의서 등 양식 문서를 별도 창에서 인쇄하는 기능이 있다.
- `src/components/CalendarView.jsx`와 `src/index.css`에는 캘린더 전용 `window.print()` 및 인쇄 CSS가 있다.

일반 게시글·댓글 인쇄는 EasyPage처럼 화면 전체를 하나의 긴 이미지로 만드는 것보다, **선택 항목의 DOM을 인쇄 전용 창에 복제하고 브라우저 인쇄를 실행하는 방식**이 적합하다. 이 방식은 텍스트 선명도, 여러 페이지 나눔, 표와 링크, 접근성 및 파일 크기 면에서 유리하다.

## 3. 확정할 사용자 동작

### 3.1 선택 기준

| 사용 위치 | 동작 | 인쇄 대상 |
|---|---|---|
| 상세 화면 게시글 | 게시글 영역 우클릭 → 인쇄 | 현재 게시글 1개 |
| 상세 화면 댓글 | 댓글 카드 우클릭 → 인쇄 | 해당 댓글 1개 |
| 왼쪽 게시글 목록 | 게시글 카드 우클릭 → 동일 메뉴 → 인쇄 | 우클릭한 게시글 1개 |
| 일반 좌클릭 | 기존처럼 상세 화면 열기 | 인쇄 메뉴를 자동으로 열지 않음 |

메뉴를 열 때 해당 항목을 먼저 선택해야 한다. 이전에 선택한 댓글이 있더라도 게시글을 우클릭하면 게시글이 인쇄되어야 하며, 다른 댓글을 우클릭하면 그 댓글이 인쇄되어야 한다.

### 3.2 출력 내용

게시글 인쇄물에는 다음을 포함한다.

- 문서 제목: 본문의 첫 유효 행 또는 `게시글`
- 채널명
- 작성자 이름과 사용자명
- 작성 일시
- 학습 상태가 필요하면 보조 정보로 표시
- 게시글 본문
- 본문에 포함된 표, 코드, 인라인 이미지 및 링크
- 첨부파일은 파일명과 크기 목록 표시
- 이미지 첨부는 로드 가능한 경우 미리보기 포함

게시글을 인쇄할 때 댓글 전체를 자동으로 포함하지 않는다. 요청의 핵심이 “현재 선택된 게시글이나 댓글”이므로 선택 단위를 그대로 유지한다.

게시글 전체 본문은 길이와 관계없이 출력한다. 화면의 스크롤 영역 높이까지만 출력하거나 한 페이지에 강제로 축소하지 않으며, A4 영역을 넘는 본문은 2쪽, 3쪽처럼 필요한 수만큼 자동 분할한다.

댓글 인쇄물에는 다음을 포함한다.

- 상단 구분: `댓글`
- 원 게시글을 식별할 수 있는 제목 또는 게시글 링크
- 댓글 작성자 이름과 사용자명
- 작성 일시
- 댓글 본문
- 댓글 첨부파일 목록 및 이미지 미리보기

좋아요 버튼, 수정 입력창, 녹음/STT 조작 버튼, 메뉴, 댓글 작성 영역과 리사이즈 핸들은 출력하지 않는다.

## 4. 권장 구현 구조

### 4.1 공통 인쇄 유틸리티 추가

신규 파일 예시:

`src/lib/printSelectedContent.js`

권장 공개 함수:

```js
printSelectedContent({
  type,          // 'post' | 'comment'
  title,
  channelName,
  author,
  username,
  createdAt,
  contentNode,   // 현재 렌더링된 본문 DOM
  attachments,
  permalink,
})
```

처리 순서:

1. 메뉴 클릭 이벤트 안에서 즉시 `window.open('', '_blank')`를 실행한다. 비동기 이미지 준비 후 창을 열면 팝업 차단기에 막힐 수 있다.
2. 게시글 제목의 앞뒤 공백을 제거하고 Unicode 문자 기준 최대 32자로 잘라 인쇄 창의 `<title>`과 출력 제목에 사용한다.
3. 새 창에 `인쇄 준비 중...`을 먼저 표시한다.
4. 선택 항목의 본문 DOM을 `cloneNode(true)`로 복제한다.
5. 복제 DOM에서 버튼, 입력 요소, 동영상·오디오 조작부 및 `data-print-exclude` 요소를 제거한다.
6. 현재 페이지에서 필요한 게시글 본문 스타일을 인쇄 문서에 주입한다.
7. 이미지의 `load/error`를 기다리되 전체 대기는 약 3초로 제한한다.
8. `document.fonts.ready`를 기다린다.
9. 새 창의 `focus()`와 `print()`를 호출한다.
10. `afterprint`에서 인쇄 창을 닫는다. 사용자가 PDF 저장을 선택할 수도 있으므로 인쇄 호출 직후 강제로 닫지 않는다.

제목 제한은 JavaScript 문자열 인덱스가 아니라 `Array.from()`을 사용하여 계산한다. 따라서 한글은 물론 서로게이트 페어를 사용하는 이모지도 중간에서 깨지지 않는다. 32자 이하 제목은 원문을 유지하고 앞뒤 공백만 제거한다.

팝업이 차단된 경우에는 사용자에게 `인쇄 창을 열 수 없습니다. 이 사이트의 팝업을 허용해 주세요.`라고 안내한다.

### 4.2 인쇄 대상 DOM 참조

`PostDetailPane.jsx`에 다음 참조를 둔다.

```js
const postPrintRef = useRef(null)
const commentPrintRefs = useRef(new Map())
```

- 게시글의 메타데이터와 본문·첨부 영역을 감싸는 요소에 `postPrintRef`를 연결한다.
- 각 댓글 카드의 기존 `commentItemRefs`를 인쇄에도 재사용하거나 별도 `commentPrintRefs`에 저장한다.
- 댓글 입력 영역과 댓글 목록 전체가 게시글 인쇄 참조 안에 들어가지 않도록 범위를 분리한다.
- 대화형 요소에는 `data-print-exclude="true"`를 적용한다.

화면에 렌더링된 `ContentRenderer`, `MailSummaryCard`, `TemplateRenderer` 결과를 복제하면 Markdown을 별도로 다시 파싱할 필요가 없고 현재 사용자에게 보이는 결과와 출력 결과가 일치한다.

### 4.3 공통 메뉴에 인쇄 추가

`PostDetailPane.jsx`의 `ActionMenu`에서 복사/링크복사 다음에 다음 항목을 추가한다.

```jsx
{item('print', `🖨 ${labels.print || '인쇄'}`)}
```

그리고 메뉴 액션 분기에 다음 처리를 추가한다.

```js
else if (action === 'print') handlePrintSelected()
```

`handlePrintSelected()`는 `activeTargetType`과 `selectedComment`를 확인하여 게시글 또는 댓글의 정확한 DOM 참조와 메타데이터를 공통 인쇄 유틸리티에 전달한다.

보관된 채널에서도 인쇄는 읽기 작업이므로 사용할 수 있어야 한다. 현재 메뉴 전체가 `!selectedChannel?.is_archived` 조건으로 숨겨지므로, 구현 시 메뉴 표시 조건을 조정해야 한다. 수정·삭제·이동 항목만 권한에 따라 숨기고 복사·링크복사·인쇄 같은 읽기 작업은 보관 채널에서도 제공하는 것이 자연스럽다.

### 4.4 목록 게시글의 브라우저 기본 메뉴 대체

`PostCard`에 `onOpenActionMenu` 콜백을 추가하고 카드에 `onContextMenu`를 연결한다.

```jsx
onContextMenu={(event) => {
  if (event.target.closest('a, button, input, textarea, [data-attachment]')) return
  event.preventDefault()
  event.stopPropagation()
  onOpenActionMenu(event, post)
}}
```

목록에서 동일 메뉴와 기존 상세 화면 액션을 중복 구현하지 않도록 다음 흐름을 권장한다.

1. `ChatArea`가 `{ postId, x, y, requestId }` 형태의 `pendingPostActionMenu` 상태를 가진다.
2. `PostCard` 우클릭 시 해당 게시글을 선택하고 우클릭 좌표를 상태에 저장한다.
3. 선택된 게시글의 `PostDetailPane`이 마운트되면 이 요청을 받아 `selectedTarget`을 게시글로 설정하고 `ActionMenu`를 연다.
4. 메뉴가 열린 뒤 `requestId`를 소비하여 재렌더링 때 다시 열리지 않게 한다.

`setTimeout`이나 전역 DOM 탐색으로 상세 화면이 열릴 때까지 기다리는 방식은 렌더링 속도에 따라 실패할 수 있으므로 사용하지 않는다.

메뉴 위치는 `position: fixed`이므로 저장된 화면 좌표를 그대로 사용할 수 있지만, 기존 `openContextActionMenu()`의 화면 경계 보정 로직을 공통 함수로 추출하여 반드시 다시 적용한다.

### 4.5 다국어 문구

`src/i18n/index.js`의 `chat` 영역에 최소 다음 키를 추가한다.

```js
print: '인쇄',
printing: '인쇄 준비 중...',
printPopupBlocked: '인쇄 창을 열 수 없습니다. 이 사이트의 팝업을 허용해 주세요.',
printFailed: '인쇄 준비 중 오류가 발생했습니다.',
```

현재 `mdPage.print`를 재사용할 수는 있지만 게시글 메뉴가 MDPage에 종속되지 않도록 `chat.print`를 별도로 두는 것이 좋다. 지원 중인 다른 언어에도 같은 키를 추가해야 한다.

## 5. 인쇄 전용 스타일

인쇄 창에는 앱 전체 CSS를 그대로 복사하지 않고 작은 전용 스타일을 사용한다. 외부 Tailwind 런타임에 의존하지 않아야 한다.

특히 화면용 Tailwind 번들 또는 현재 문서의 전체 `<style>`을 인쇄 창에 복제하지 않는다. 화면 레이아웃의 `h-full`, `overflow-*`, flex/panel 규칙이 다시 적용되면 전용 CSS로 일부 값을 덮어써도 Chrome/Safari 인쇄 엔진이 게시글을 하나의 스크롤 박스로 판단할 수 있기 때문이다. 복제 DOM의 인라인 `height`, `min-height`, `max-height`, `overflow`, `position`도 인쇄 전에 제거한다.

```css
@page { size: A4; margin: 0; }
html { color-scheme: light; }
body {
  margin: 0;
  padding: 10mm;
  box-sizing: border-box;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  color: #111827;
  background: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo",
    "Noto Sans KR", "Segoe UI", sans-serif;
  font-size: 8.8pt; /* 기존 11pt 대비 20% 축소 */
  line-height: 1.65;
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}
.easy-print-content,
.easy-print-content > *,
.easy-print-content .eds-markdown,
.easy-print-content .overflow-hidden,
.easy-print-content .overflow-auto,
.easy-print-content .overflow-y-auto,
.easy-print-content .overflow-x-auto {
  height: auto !important;
  max-height: none !important;
  overflow: visible !important;
}
img, svg {
  width: auto !important;
  height: auto !important;
  max-width: 100% !important;
  max-height: 267mm !important;
  object-fit: contain;
  break-inside: avoid;
  page-break-inside: avoid;
}
table { width: 100%; border-collapse: collapse; break-inside: auto; }
thead { display: table-header-group; }
tr, blockquote { break-inside: avoid; }
th, td { border: 1px solid #d1d5db; padding: 6px 8px; }
pre, blockquote {
  padding: 0.8em 1em;
  border: 1px solid #cbd5e1;
  border-radius: 5px;
  background: #f3f4f6 !important;
  color: #1f2937;
  box-decoration-break: clone;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  break-inside: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
:not(pre) > code {
  padding: 0.12em 0.35em;
  border: 1px solid #d1d5db;
  border-radius: 3px;
  background: #f3f4f6 !important;
}
a { color: inherit; text-decoration: underline; overflow-wrap: anywhere; }
[data-print-exclude="true"], button, input, textarea, select, audio, video {
  display: none !important;
}
```

긴 표나 이미지가 페이지 폭을 넘지 않는지 Safari와 Chrome 양쪽에서 확인해야 한다. 배경색이 의미 있는 양식 문서는 `print-color-adjust: exact`를 사용해도 사용자의 브라우저 인쇄 설정에 따라 배경 그래픽이 생략될 수 있다.

브라우저 인쇄 설정에서 “여백 없음”을 선택하면 `@page` 여백이 무시될 수 있으므로, 여백은 인쇄 문서 `body`의 `padding: 10mm`로 포함한다. `box-decoration-break: clone`을 함께 적용해 페이지가 나뉘어도 내부 여백이 유지되도록 한다. `@page` 자체 여백은 `0`으로 두어 브라우저 기본 여백과 본문 여백이 중복되지 않게 한다. 본문은 기존 `11pt`에서 20% 줄인 `8.8pt`, 인쇄 제목과 내부 제목도 각각 기존 값의 80%를 적용한다.

화면용 `h-full`, `max-h-*`, `overflow-hidden`, `overflow-y-auto`가 인쇄 DOM에 남으면 브라우저는 스크롤 영역 밖의 내용을 없는 것으로 판단하여 미리보기를 1쪽으로 만들 수 있다. 따라서 인쇄 범위에서는 높이 제한을 `height: auto`, `max-height: none`, `overflow: visible`로 반드시 해제한다. 게시글 전체에 고정 높이를 지정하거나 전체 게시글을 `break-inside: avoid`로 묶지 않는다.

표는 여러 페이지로 이어질 수 있게 하고 `thead`는 다음 페이지에서도 반복한다. 일반 행과 이미지는 가능하면 중간에서 잘리지 않게 하되, 긴 코드 블록과 문단은 다음 페이지로 정상 분할될 수 있어야 한다.

A4 높이 `297mm`에서 문서 내부 여백 상하 `10mm`씩과 인쇄 엔진의 반올림 여유를 제외하여 이미지·SVG의 최대 높이는 `267mm`로 제한한다. `width`와 `height`는 `auto`, 최대 너비는 `100%`, `object-fit`은 `contain`으로 설정하므로 가로 또는 세로 중 먼저 한계에 도달하는 방향을 기준으로 종횡비를 유지해 축소된다. 최대값만 지정하므로 이보다 작은 이미지는 확대하지 않는다. `break-inside: avoid`로 이미지가 페이지 경계에서 두 장으로 나뉘는 것도 방지한다.

코드 블록(`pre`)과 인용·텍스트 블록(`blockquote`)에는 `#cbd5e1` 테두리와 `#f3f4f6` 배경을 적용한다. 인라인 코드에도 더 작은 테두리와 같은 계열의 배경을 적용한다. `pre` 내부의 `code`에는 배경과 테두리를 중복 적용하지 않는다. 긴 코드 블록은 `break-inside: auto`를 유지하여 내용이 잘리지 않고 다음 페이지로 이어지며, `box-decoration-break: clone`으로 분할된 블록의 박스 표현을 유지한다.

일반 Markdown 문단은 실제 `<br>` 대신 하나의 `<p>` 내부 줄바꿈 문자로 여러 줄을 표현할 수 있다. 화면의 Tailwind `whitespace-pre-wrap`에 의존하지 않도록 인쇄 CSS의 `.easy-print-content p`에도 `white-space: pre-wrap`을 직접 지정한다. `overflow-wrap: anywhere`를 함께 적용해 긴 URL이나 공백 없는 문자열이 인쇄 폭을 벗어나지 않게 한다.

첨부파일 제목 옆의 클립 SVG와 `FileTypeIcon`은 본문 데이터가 아니라 화면용 상태·형식 표시 장식이다. 두 SVG에 `data-print-exclude="true"`를 지정하여 인쇄 DOM 복제 과정에서 제거한다. 실제 첨부 이미지, PDF 썸네일과 본문 Mermaid SVG에는 이 속성을 지정하지 않으므로 기존 인쇄 대상에 그대로 포함된다.

## 6. 특수 콘텐츠 처리

### Markdown 및 일반 텍스트

현재 `ContentRenderer` 결과를 복제한다. 원문 문자열만 새 창에 넣으면 Markdown 표, 코드, 수식, 멘션 스타일이 사라질 수 있다.

### 양식 템플릿

`TemplateRenderer` 결과를 복제하되 저장·추가·삭제·업로드 버튼은 제외한다. 지출결의서에 이미 있는 전용 인쇄 함수와 충돌하지 않도록 팝업 메뉴 인쇄는 공통 선택 인쇄 흐름만 호출한다. 향후 양식별 전용 출력이 필요하면 콘텐츠 종류에 따라 기존 `printExpense()`로 분기할 수 있다.

### EasyPage와 EasySheet

EasyPage는 별도 `MDPageViewer`를 사용하고 이미 인쇄 버튼과 PDF 생성 기능이 있다. 게시글 목록 메뉴에서 EasyPage를 인쇄할 때는 가능하면 기존 `useMDPagePrint` 경로를 호출하고, 일반 게시글 DOM 인쇄와 이중 구현하지 않는 것이 좋다. EasySheet는 화면 전체 스프레드시트의 인쇄 범위·배율 정책이 별도로 필요하므로 이번 “일반 게시글/댓글 인쇄” 범위에서 명확히 제외하거나 후속 작업으로 분리한다.

### 이미지와 인증 첨부파일

현재 화면에 이미 로드된 이미지를 복제하는 방식을 우선한다. 인증이 필요한 이미지 URL을 새 창에서 다시 요청할 때 쿠키와 CORS 정책에 따라 실패할 수 있다. 출력 전에 `img.complete`를 검사하고 실패한 이미지는 파일명 링크로 대체해야 한다. PDF·동영상·오피스 파일의 내용 전체를 자동 출력하지 않고 첨부 목록만 표시한다.

## 7. 접근성 및 상호작용

- 메뉴는 기존처럼 `role="menu"`, 각 항목은 `role="menuitem"`을 유지한다.
- 인쇄 항목도 위/아래 방향키 탐색과 Escape 닫기를 지원한다.
- 게시글 카드는 우클릭 외에도 키보드 접근 경로가 필요하다. 권장 방식은 `Shift+F10` 또는 Context Menu 키에서 동일 메뉴를 여는 것이다.
- 좌클릭/Enter/Space의 상세 열기 동작은 변경하지 않는다.
- 텍스트를 드래그 선택한 뒤 발생하는 클릭으로 메뉴가 열리지 않도록 기존 선택 가드를 유지한다.
- 링크, 첨부파일, 입력 요소에서 우클릭할 때는 기존 브라우저 기능이 필요할 수 있으므로 사용자 메뉴를 강제로 열지 않는다.
- 인쇄 중임을 메뉴 닫힌 뒤에도 알 수 있도록 짧은 `인쇄 준비 중...` 상태 또는 새 창의 준비 화면을 제공한다.

## 8. 오류 처리

- 선택 항목 DOM을 찾지 못하면 인쇄를 시작하지 않고 오류 안내를 표시한다.
- 인쇄 창 차단, 이미지 로드 실패, 폰트 준비 실패는 각각 로그를 남긴다.
- 일부 이미지가 실패해도 텍스트 인쇄는 계속 진행한다.
- `window.print()` 호출 실패 시 새 창을 닫고 사용자에게 오류를 알린다.
- 메뉴에서 인쇄를 여러 번 빠르게 누르는 것을 막기 위해 인쇄 준비 중에는 해당 항목을 비활성화한다.
- 서버 API나 데이터 변경은 필요하지 않으며 인쇄 작업은 전부 클라이언트에서 수행한다.

## 9. 테스트 계획

### 단위 테스트

- 선택 대상이 게시글이면 게시글 메타데이터와 `postPrintRef`를 전달한다.
- 선택 대상이 댓글이면 정확한 댓글 ID의 DOM 참조를 전달한다.
- 게시글을 우클릭했을 때 이전 댓글 선택이 게시글 선택으로 교체된다.
- 댓글을 우클릭했을 때 해당 댓글이 선택된다.
- `ActionMenu`의 인쇄 항목이 `print` 액션을 한 번만 발생시킨다.
- 팝업 차단 시 안내 문구가 표시된다.
- 대화형 요소 제거 후 본문, 표, 링크와 첨부파일명이 남는다.
- 32자를 넘는 한글·영문·이모지 제목이 Unicode 문자 기준 정확히 32자로 제한된다.
- 작은 이미지가 확대되지 않고, 용지보다 큰 이미지 및 Mermaid SVG가 비율을 유지한 채 한 페이지 범위로 축소된다.
- 코드 블록, 인라인 코드 및 인용·텍스트 블록에 회색 테두리와 옅은 회색 배경이 적용된다.
- 일반 문단의 줄바꿈 문자가 공백으로 합쳐지지 않고 원본과 같은 줄 구성을 유지한다.
- 첨부 클립과 파일 형식 아이콘은 제거되지만 실제 이미지·문서 썸네일과 Mermaid SVG는 유지된다.

### 브라우저/E2E 테스트

1. 왼쪽 게시글 카드를 우클릭하면 브라우저 기본 메뉴 대신 앱 메뉴가 표시된다.
2. 게시글 상세 본문을 우클릭해도 같은 메뉴가 표시된다.
3. 댓글을 우클릭하면 같은 메뉴가 표시되고 인쇄 대상은 그 댓글이다.
4. 일반 좌클릭은 기존처럼 게시글 상세를 연다.
5. 인쇄 메뉴를 누르면 새 인쇄 창이 열리고 게시글 또는 댓글 하나만 표시된다.
6. 댓글 입력창, 다른 댓글, 앱 사이드바와 ActionMenu는 인쇄물에 포함되지 않는다.
7. 긴 Markdown, 표, 코드 블록, 한글, 멘션, 링크가 A4 여러 페이지에 정상 출력된다.
8. 화면에서 스크롤이 필요한 긴 게시글도 마지막 문장까지 출력되고 인쇄 미리보기의 페이지 수가 자동 증가한다.
9. 이미지 첨부, 이미지 로드 실패, PDF 및 동영상 첨부를 각각 확인한다.
10. 작성 권한이 없는 사용자와 보관 채널에서도 읽을 수 있는 콘텐츠는 인쇄할 수 있다.
11. Chrome과 macOS Safari에서 실제 인쇄 미리보기 및 PDF 저장을 확인한다.
12. 세로로 긴 이미지와 Mermaid 흐름도가 두 페이지로 잘리지 않고 한 페이지 안에 축소되는지 확인한다.
13. 코드 블록과 텍스트 블록이 인쇄물에서 테두리·옅은 회색 배경으로 구분되고 긴 코드가 다음 페이지까지 출력되는지 확인한다.
14. 하나의 Markdown 문단 안에 여러 줄이 입력된 경우 인쇄물에서도 같은 위치에서 줄바꿈되는지 확인한다.
15. 첨부 영역의 클립·파일 형식 아이콘은 인쇄되지 않고 첨부파일 이름과 실제 미리보기만 남는지 확인한다.

## 10. 구현 순서

1. `printSelectedContent` 공통 유틸리티와 인쇄 CSS를 작성한다.
2. `PostDetailPane`에 게시글·댓글 인쇄 DOM 참조를 연결한다.
3. `ActionMenu`에 인쇄 항목과 `handlePrintSelected()`를 연결한다.
4. `PostCard`의 우클릭을 `ChatArea`의 pending menu 요청으로 전달한다.
5. 상세 화면에서 pending 요청을 소비해 동일 `ActionMenu`를 연다.
6. 보관 채널의 읽기 전용 메뉴 표시 조건을 정리한다.
7. 번역 문구와 오류 안내를 추가한다.
8. 단위 테스트와 Chrome/Safari E2E 검증을 수행한다.

## 11. 예상 변경 파일

- `src/components/chat/PostDetailPane.jsx`
- `src/components/ChatArea.jsx`
- `src/lib/printSelectedContent.js` (신규)
- `src/i18n/index.js`
- 필요 시 `src/index.css` 또는 인쇄 유틸리티 내부 전용 CSS
- 관련 단위/E2E 테스트 파일

백엔드와 데이터베이스 스키마 변경은 필요하지 않다.

## 12. 완료 기준

- 목록 게시글, 상세 게시글, 댓글에서 브라우저 기본 메뉴가 아닌 동일한 앱 작업 메뉴를 사용할 수 있다.
- 메뉴의 인쇄 항목이 현재 선택 대상을 정확히 구분한다.
- 게시글 인쇄에 댓글 목록이나 댓글 입력창이 섞이지 않는다.
- 댓글 인쇄에 다른 댓글이나 게시글 전체가 섞이지 않는다.
- 한글, Markdown, 표, 코드, 링크 및 지원되는 이미지가 A4 인쇄 미리보기에서 읽을 수 있게 출력된다.
- 게시글이 한 페이지보다 길면 마지막 내용까지 필요한 페이지 수만큼 자동으로 나뉘어 출력된다.
- 모든 페이지에 약 1cm 여백이 적용되고 인쇄 글꼴이 이전 크기보다 20% 작게 출력된다.
- 32자를 넘는 게시글 제목은 인쇄 제목과 PDF 기본 파일명에서 32자로 제한된다.
- 한 페이지보다 큰 이미지와 SVG 다이어그램은 종횡비를 유지해 한 페이지 안으로 축소되고 작은 이미지는 원래 크기를 유지한다.
- 코드와 텍스트 블록은 회색 테두리와 옅은 회색 배경으로 일반 본문과 명확히 구분된다.
- 일반 Markdown 문단의 명시적 줄바꿈은 인쇄에서도 원본과 동일하게 보존된다.
- 화면 장식용 첨부·문서 형식 아이콘은 인쇄에서 제외된다.
- 인쇄는 콘텐츠를 수정하지 않으며 추가 서버 권한이나 API를 요구하지 않는다.

## 13. 구현 결과

2026년 8월 2일 구현 완료.

- 게시글 목록 `PostCard`의 우클릭에서 브라우저 기본 메뉴를 막고 상세 화면의 동일한 `ActionMenu` 요청을 전달한다.
- 상세 게시글과 댓글의 공통 메뉴에 `인쇄` 항목을 추가했다.
- 현재 선택 대상에 따라 게시글 또는 댓글 DOM을 정확히 선택한다.
- 게시글 출력에서는 댓글 목록을 제외하고, 댓글 출력에서는 선택된 댓글 카드만 사용한다.
- 인쇄 전용 창에서 앱 스타일, 한글 폰트, 이미지 로딩을 준비한 뒤 브라우저 인쇄 창을 연다.
- 화면용 스크롤 컨테이너의 높이와 overflow 제한을 인쇄 시 해제하여 긴 게시글 전체를 여러 페이지로 출력한다.
- 앱의 화면용 스타일시트를 인쇄 창에 복사하지 않고 인쇄 전용 문서 CSS만 적용하여 페이지 분할을 방해하는 레이아웃 규칙을 차단한다.
- 브라우저의 여백 설정과 관계없이 보이도록 인쇄 문서 본문에 `10mm` 내부 여백을 적용하고, 본문과 제목의 인쇄 글꼴을 기존 대비 80%로 축소했다.
- 인쇄 창의 문서 제목과 PDF 기본 파일명은 Unicode 문자 기준 최대 32자로 제한했다.
- 큰 이미지와 Mermaid SVG에 `267mm` 최대 높이와 `100%` 최대 너비를 적용하여 한 페이지 안에 비율대로 축소되도록 했다.
- 코드 블록, 인라인 코드와 인용·텍스트 블록에 인쇄 전용 테두리·회색 배경 스타일을 추가했다.
- 인쇄 문단에 `white-space: pre-wrap`을 적용하여 원본 화면의 여러 줄 구성을 보존하도록 수정했다.
- 첨부 클립 SVG와 공통 `FileTypeIcon`에 인쇄 제외 표식을 추가하여 대형 아이콘이 출력되지 않도록 했다.
- 버튼, 입력창, 메뉴, 오디오·비디오 조작부는 출력에서 제외한다.
- 팝업 차단과 인쇄 준비 실패 안내를 한국어·영어·일본어 번역에 추가했다.
- 보관 채널에서도 복사, 링크복사, 인쇄 등 읽기 작업 메뉴를 사용할 수 있고 변경 작업은 숨긴다.
- 공통 인쇄 유틸리티 메타데이터 이스케이프 단위 테스트와 Vite 프로덕션 빌드를 통과했다.
