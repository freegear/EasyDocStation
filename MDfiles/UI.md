# UI 개선 노트 — EasyStation

프론트엔드 UI/UX 관련 설계 결정과 개선 사항을 기록한다. 각 장은 "증상 → 원인 →
정책(의견) → 구현 → 검증" 순서로 정리한다.

---

# 1. 새 게시글 추가 시 자동 스크롤

## 1.1 증상

채널 게시글 피드(`PostList`)에서 새 글을 작성하면 목록에는 추가되지만, **추가된 글이
화면에 바로 보이지 않는다.** 사용자가 직접 아래로 스크롤해야 새 글이 보인다.

- 내가 작성한 글: 작성 직후 하단에 삽입되지만 뷰포트 밖(아래)이라 안 보인다.
- 다른 사람 글 / 5초 폴링으로 들어온 글: 마찬가지로 하단에 추가되지만 스크롤이 따라가지 않는다.

## 1.2 원인

[src/components/ChatArea.jsx](../src/components/ChatArea.jsx)의 `PostList`는 피드를 **채널당 한 번만**
맨 아래로 스크롤한다.

```jsx
// 최초 진입 시 1회만 바닥으로 스크롤 (initialScrollChannelRef 가드)
useLayoutEffect(() => {
  const channelId = selectedChannel?.id
  if (!channelId || posts.length === 0 || initialScrollChannelRef.current === channelId) return
  bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  initialScrollChannelRef.current = channelId   // ← 이후 이 채널에선 다시 안 내려감
}, [posts.length, selectedChannel?.id])
```

- 위 효과는 `initialScrollChannelRef.current === channelId` 가드 때문에 채널 최초 로드 때만 동작한다.
- 두 번째 `useLayoutEffect`는 **과거 글 로딩(prepend)** 시 스크롤 위치 보정만 담당한다.
- 결과적으로 **하단에 새 글이 append될 때(=`posts.length` 증가) 바닥으로 스크롤하는 경로가 없다.**
  그래서 [ChatContext.addPost](../src/contexts/ChatContext.jsx)가 새 글을 하단에 삽입해도 뷰포트는
  그대로 남는다.

## 1.3 정책 (의견)

무조건 바닥으로 내리는 것도, 전혀 안 내리는 것(현재)도 좋지 않다. 채팅 UI의 표준
**"바닥 고정(stick to bottom)"** 패턴을 따르는 것을 권장한다.

1. **내가 방금 작성한 글**: 항상 바닥으로 스크롤한다. (작성자는 자기 글이 보이길 기대한다.)
2. **새 글이 append될 때 사용자가 이미 바닥 근처(임계값 이내, 예: 120px)**: 바닥으로 스크롤한다.
   (내 글/남의 글/폴링 유입 모두 포함.)
3. **사용자가 위로 올려 과거 글을 읽는 중**: **바닥으로 끌어내리지 않는다.** 대신 (2차 과제로)
   "새 글 ↓" 버튼을 띄워 사용자가 원할 때만 내려가게 한다.

이유:

- 읽는 중에 강제로 내려버리면 흐름이 끊기는 안티패턴이 된다(2번의 near-bottom 판정으로 회피).
- 반대로 지금처럼 전혀 안 내리면 방금 쓴 글조차 안 보이는 혼란이 생긴다(1번으로 회피).
- 부드러움을 위해 append 스크롤은 `behavior: 'smooth'`, 최초 진입 스크롤은 기존대로 `'auto'`.

## 1.4 구현 방향

`PostList` 내부에 append 감지용 상태/효과를 추가한다(기존 최초 스크롤·prepend 보정 로직과 분리).

- `lastPostIdRef`: 가장 최근(맨 아래) 글의 id를 기억한다.
- `isNearBottomRef`: `handleFeedScroll`에서 `scrollHeight - (scrollTop + clientHeight) <= 120`으로
  갱신하고, 초기값은 `true`(최초엔 바닥에 있음).
- 새 `useLayoutEffect`(deps: `posts.length`):
  - **prepend 중이거나(`prependInProgressRef`)·pending restore가 있으면 스킵**한다(과거 글 로딩과 충돌 방지).
  - 맨 아래 글 id가 바뀌었고(새 글 append), 그 글의 작성자가 **현재 사용자 본인**이거나
    `isNearBottomRef.current`가 `true`이면 `bottomRef.current?.scrollIntoView({ behavior: 'smooth' })`.
- 작성자 판정: append된 최신 글의 author(id/email)를 `useAuth().currentUser`와 비교한다. `addPost`가
  낙관적 삽입하는 글은 본인 글이므로 이 조건으로 자연히 잡힌다.

주의:

- 최초 진입 스크롤(1.2의 첫 효과)과 **중복 실행되지 않도록** append 효과는
  `initialScrollChannelRef.current === channelId`(=이미 최초 스크롤 완료)일 때만 동작하게 한다.
- 채널 전환 시 `lastPostIdRef`/`isNearBottomRef`를 초기화한다(다른 채널 기준점 잔존 방지).

## 1.5 범위 밖 (2차 과제)

- 위로 스크롤해 과거 글을 읽는 중 새 글이 오면 띄우는 **"새 글 ↓" 플로팅 버튼**.
- 새 글 도착 시 미묘한 하이라이트/애니메이션 등 시각적 강조.

## 1.6 변경 예정 파일

- [src/components/ChatArea.jsx](../src/components/ChatArea.jsx) — `PostList`에 append 자동 스크롤 효과 추가.

## 1.7 검증

```txt
npm run build
```

이후 실제 확인:

1. 내가 글을 작성하면 작성 직후 새 글이 화면 하단에 **자동으로 보인다.**
2. 바닥 근처에서 다른 사람 글/폴링 글이 들어오면 자동으로 따라 내려간다.
3. 위로 올려 과거 글을 읽는 중에는 새 글이 와도 **화면이 강제로 내려가지 않는다.**
4. 과거 글 로딩(위로 스크롤) 시 스크롤 위치 보정이 기존대로 동작한다(회귀 없음).

---

# 2. 메일/캘린더 버튼 타이틀바 이동

## 2.1 증상

왼쪽 사이드 패널 하단에 `메일`, `캘린더` 텍스트 버튼이 있어 주요 서비스 진입점이 채널/DM 목록과 섞여 보인다.
사용자는 같은 성격의 상단 전역 버튼인 `Welcome Board`와 `Side Panel` 토글 사이로 두 버튼을 이동하길 원한다.

## 2.2 원인

- 기존 메일/캘린더 버튼은 [src/components/Sidebar.jsx](../src/components/Sidebar.jsx)에 배치되어 사이드 패널이 닫히면 접근성이 떨어진다.
- [src/components/TitleBar.jsx](../src/components/TitleBar.jsx)는 이미 `Welcome Board` 버튼과 `Side Panel` 토글을 가진 전역 도구 영역을 제공하므로, 메일/캘린더 진입점의 위치로 더 적합하다.
- 요청 이미지 자산 `public/img/mail_logo.jpeg`, `public/img/calendar_logo.jpeg`가 있으므로 텍스트/라인 아이콘보다 이미지 버튼으로 구현하는 것이 요구사항에 맞다.

## 2.3 정책 (의견)

메일/캘린더는 채널 목록에 속한 항목이 아니라 앱 전역 화면 전환 버튼이다. 따라서 사이드바 하단에서 제거하고, 데스크톱 타이틀바의 전역 액션 그룹에 배치한다.

배치 순서:

1. `Welcome Board`
2. `메일`
3. `캘린더`
4. `Side Panel` 토글

활성 상태:

- 메일 화면이 열려 있으면 메일 버튼에 인디고 링/배경을 준다.
- 캘린더 화면이 열려 있으면 캘린더 버튼에 인디고 링/배경을 준다.
- 각 버튼은 `aria-label`, `title`을 유지해 이미지 버튼의 의미를 보완한다.

## 2.4 구현 방향

- [src/components/TitleBar.jsx](../src/components/TitleBar.jsx)
  - `showMail`, `showCalendar`, `onOpenMail`, `onToggleCalendar` props를 추가한다.
  - `Welcome Board` 버튼과 `Side Panel` 토글 사이에 이미지 버튼 2개를 추가한다.
- [src/App.jsx](../src/App.jsx)
  - 타이틀바에 기존 메일/캘린더 상태와 열기 핸들러를 전달한다.
  - 메일 열기 로직은 기존 사이드바 버튼 동작과 동일하게 메일 딥링크/초기 폴더를 초기화하고 캘린더/DM/Welcome 화면을 닫는다.
  - 캘린더 토글 로직은 기존 사이드바 버튼 동작과 동일하게 캘린더를 토글하고 DM/메일/Welcome 화면을 닫는다.
- [src/components/Sidebar.jsx](../src/components/Sidebar.jsx)
  - 하단 `메일`, `캘린더` 버튼을 제거한다.
  - 사이드바 prop 목록에서 더 이상 쓰지 않는 메일/캘린더 관련 props를 정리한다.

## 2.5 검증

```txt
npm run build
```

실제 확인:

1. 타이틀바에서 `Welcome Board`와 `Side Panel` 토글 사이에 메일/캘린더 이미지 버튼이 보인다.
2. 메일 버튼은 `/img/mail_logo.jpeg`, 캘린더 버튼은 `/img/calendar_logo.jpeg`를 사용한다.
3. 사이드바 하단에는 기존 `메일`, `캘린더` 텍스트 버튼이 더 이상 보이지 않는다.
4. 메일/캘린더 버튼 클릭 시 기존 화면 전환 동작이 유지된다.

---

# 3. EasyPage 하위 페이지 이동 스택

## 3.1 증상

EasyPage에서 하위 페이지 링크를 클릭해 들어간 뒤 `이전 페이지로 가기` 동작이나 버튼을 누르면,
항상 게시판 또는 브라우저 이전 페이지 기준으로 이동한다.

사용자가 기대하는 흐름은 다음과 같다.

1. 상위 EasyPage에서 하위 EasyPage 링크를 클릭한다.
2. 하위 페이지에서 `이전 페이지로 가기`를 누르면 바로 직전 EasyPage, 즉 상위 페이지로 돌아간다.
3. 하위 페이지가 여러 단계라면 `A -> B -> C -> D` 이동 후 뒤로가기 시 `D -> C -> B -> A` 순서로 돌아간다.
4. 더 이상 EasyPage 내부 이동 이력이 없으면 브라우저 기본 뒤로가기를 수행한다.

## 3.2 원인

현재 EasyPage 링크 이동은 선택된 게시글을 바꾸거나 URL의 `channelId/postId`를 갱신하는 방식으로 처리된다.
하지만 "어떤 EasyPage에서 어떤 하위 EasyPage로 들어왔는지"를 별도 구조로 저장하지 않는다.

따라서 하위 페이지를 열었을 때 다음 정보가 남지 않는다.

- 직전 EasyPage의 `channelId`
- 직전 EasyPage의 `postId`
- 직전 EasyPage 제목
- 여러 단계 하위 이동 순서

결과적으로 앱은 하위 페이지 내부 이동과 브라우저 전체 히스토리 이동을 구분하지 못한다.

추가로 macOS 트랙패드의 **두 손가락 오른쪽 스와이프**는 버튼 클릭 이벤트가 아니다.
브라우저가 뒤로가기 제스처로 해석해 `history.back()` 또는 `popstate` 흐름으로 처리한다.
따라서 화면의 `이전 페이지로 가기` 버튼 handler만 구현하면 트랙패드 스와이프는 EasyPage stack을 거치지 못한다.

## 3.3 정책 (의견)

EasyPage 내부 링크 이동에는 전용 Navigation Stack을 둔다.

원칙:

- EasyPage 내부 링크를 클릭해 다른 EasyPage로 이동할 때 현재 페이지 정보를 `push`한다.
- `이전 페이지로 가기` 버튼 또는 동일한 뒤로가기 동작이 호출되면 스택에서 `pop`한다.
- `pop` 결과가 있으면 해당 EasyPage를 같은 화면에서 연다.
- 스택이 비어 있으면 앱 내부에서 더 돌아갈 EasyPage가 없으므로 브라우저 기본 `history.back()`을 수행한다.
- macOS 트랙패드 두 손가락 오른쪽 스와이프도 동일한 뒤로가기 동작으로 본다.
  즉, 버튼 클릭과 브라우저 `popstate` 이벤트가 같은 stack pop 정책을 사용해야 한다.

이 방식은 브라우저 히스토리와 EasyPage 문서 계층 이동을 섞지 않는다. 사용자는 EasyPage 안에서는 문서 계층을 따라 돌아가고,
문서 계층 이력이 끝난 뒤에는 일반 웹 페이지처럼 이전 위치로 돌아간다.

## 3.4 Stack 구조

권장 구조:

```ts
type EasyPageNavigationEntry = {
  channelId: string
  postId: string
  title?: string
  openedAt: number
}

type EasyPageNavigationStack = EasyPageNavigationEntry[]
```

예시:

```txt
EasyPage A -> GUNDAM -> Gundam-Mk2 -> Z-GUNDAM

stack:
[
  { channelId: '...', postId: 'A', title: 'EasyPage' },
  { channelId: '...', postId: 'GUNDAM', title: 'GUNDAM' },
  { channelId: '...', postId: 'Gundam-Mk2', title: 'Gundam-Mk2' }
]

현재 페이지: Z-GUNDAM
```

뒤로가기:

1. `pop()` => `Gundam-Mk2` 열기
2. `pop()` => `GUNDAM` 열기
3. `pop()` => `EasyPage A` 열기
4. stack empty => `window.history.back()`

## 3.5 구현 방향

[src/components/ChatArea.jsx](../src/components/ChatArea.jsx)에 EasyPage 내부 이동 스택 상태를 둔다.

- `const easyPageNavigationStackRef = useRef([])`
- `pushEasyPageNavigation(entry)` helper 추가
- `popEasyPageNavigation()` helper 추가
- `clearEasyPageNavigationStack()` helper 추가

EasyPage 내부 링크 클릭 처리:

- [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx)의 내부 링크 클릭은 기존처럼
  `onOpenPostLink(targetChannelId, targetPostId)`를 호출한다.
- [src/components/ChatArea.jsx](../src/components/ChatArea.jsx)의 `handleOpenPostLink()`에서 실제 이동 전에 현재 선택 게시글을 stack에 `push`한다.
- 단, 현재 페이지와 target 페이지가 같으면 push하지 않는다.
- 게시판 목록에서 게시글을 직접 선택하거나 채널을 바꾸는 경우에는 EasyPage 내부 계층 이동이 아니므로 stack을 비운다.

뒤로가기 처리:

- 상단의 `게시판으로` 버튼과 EasyPage toolbar의 `이전 페이지로 가기` 버튼이 같은 handler를 사용하게 한다.
- handler 동작:
  1. `const previous = popEasyPageNavigation()`
  2. `previous`가 있으면 `fetchPost(previous.channelId, previous.postId)` 후 `setSelectedPost(previousPost)`
  3. `previous`가 없으면 `window.history.back()` 실행

macOS 트랙패드 스와이프 처리:

- EasyPage 내부 링크 이동 시 브라우저 히스토리에도 현재 앱 상태를 `pushState` 또는 `replaceState`로 기록한다.
- `window.addEventListener('popstate', handler)`를 등록한다.
- `popstate`가 발생했을 때 EasyPage navigation stack이 비어 있지 않으면:
  1. 브라우저 기본 이동 결과를 그대로 두지 않고 앱 내부에서 `popEasyPageNavigation()`을 수행한다.
  2. pop된 EasyPage를 `fetchPost()`로 열고 URL을 해당 `channelId/postId`에 맞게 동기화한다.
  3. 필요하면 현재 위치를 다시 `pushState`로 보정해, 다음 스와이프도 앱 stack이 먼저 처리하게 한다.
- stack이 비어 있으면 별도 가로채기를 하지 않고 브라우저의 원래 뒤로가기를 허용한다.

주의:

- 브라우저 뒤로가기 제스처는 `preventDefault()`로 직접 막을 수 있는 일반 wheel/touch 이벤트가 아니다.
  안정적인 구현은 `popstate`와 `history.pushState/replaceState`를 함께 사용하는 방식이다.
- EasyPage 내부 링크 이동을 할 때마다 브라우저 히스토리 엔트리를 남기지 않으면 트랙패드 스와이프가 발생해도 앱이 감지할 기회가 부족하다.
  따라서 내부 stack과 브라우저 history를 함께 갱신해야 한다.

URL 처리:

- `pop`으로 이전 EasyPage를 열 때도 URL의 `channelId/postId`는 현재 열린 EasyPage와 동기화한다.
- 새 브라우저 탭 또는 새로고침으로 직접 들어온 EasyPage는 stack이 비어 있는 상태로 시작한다.
- 이 상태에서 뒤로가기를 누르면 브라우저 기본 이전 페이지로 이동한다.

## 3.6 예외 처리

- stack에 있는 `postId`가 삭제되었거나 접근 권한이 없으면 해당 entry를 버리고 한 번 더 `pop`을 시도한다.
- 더 이상 유효한 entry가 없으면 `window.history.back()`을 수행한다.
- 내부 링크 클릭 중 대상 게시글 fetch에 실패하면 stack에 push한 값을 되돌려서, 실패한 이동이 뒤로가기 이력에 남지 않게 한다.
- 같은 페이지를 반복 클릭하는 경우 중복 push를 막는다.
- 채널 이동, 게시판 목록 복귀, 검색 결과에서 게시글 직접 열기 등 EasyPage 계층과 무관한 이동은 stack을 초기화한다.

## 3.7 변경 예정 파일

- [src/components/ChatArea.jsx](../src/components/ChatArea.jsx)
  - EasyPage navigation stack 상태와 push/pop helper 추가
  - 내부 링크 이동 시 현재 EasyPage push
  - 뒤로가기 handler에서 pop 우선, stack empty 시 `window.history.back()` fallback
  - `popstate` listener 추가로 macOS 트랙패드 두 손가락 오른쪽 스와이프 처리
  - EasyPage 내부 이동 시 `history.pushState/replaceState`로 브라우저 히스토리와 stack 동기화
- [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx)
  - 필요 시 `onBack` 또는 `onNavigateBack` prop 추가
  - toolbar의 이전 페이지 버튼을 ChatArea의 stack 기반 handler와 연결
- [src/contexts/ChatContext.jsx](../src/contexts/ChatContext.jsx)
  - 필요 시 URL 동기화 또는 post fetch helper 재사용 범위 확인

## 3.8 구현 결과

- [src/components/ChatArea.jsx](../src/components/ChatArea.jsx)에 EasyPage navigation stack을 추가했다.
- EasyPage 내부 링크 이동 시 현재 EasyPage를 stack에 저장하고, 대상 EasyPage URL을 `history.pushState()`로 기록한다.
- `MDPageViewer`의 `onClose`는 stack-aware 뒤로가기 handler로 연결했다.
- macOS 트랙패드 두 손가락 오른쪽 스와이프는 브라우저 `popstate`에서 감지하고, stack이 있으면 이전 EasyPage를 연다.
- 게시판에서 게시글을 직접 선택하거나 게시글 상세를 닫는 일반 흐름은 EasyPage stack을 초기화한다.

## 3.9 검증

```txt
npm run build
```

실제 확인:

1. `EasyPage A -> GUNDAM -> Gundam-Mk2 -> Z-GUNDAM` 순서로 이동한다.
2. `이전 페이지로 가기`를 누르면 `Z-GUNDAM -> Gundam-Mk2`로 돌아간다.
3. 다시 누르면 `Gundam-Mk2 -> GUNDAM`, 다시 누르면 `GUNDAM -> EasyPage A`로 돌아간다.
4. `EasyPage A`에서 다시 이전 페이지를 누르면 stack이 비어 있으므로 브라우저 기본 뒤로가기가 실행된다.
5. 게시판 목록에서 EasyPage를 직접 열면 stack은 비어 있고, 뒤로가기는 브라우저 기본 동작을 수행한다.
6. 존재하지 않거나 삭제된 하위 페이지 entry가 stack에 있으면 건너뛰고 다음 유효한 entry로 이동한다.
7. macOS에서 트랙패드에 두 손가락을 대고 오른쪽으로 스와이프하면 버튼 클릭과 동일하게
   `Z-GUNDAM -> Gundam-Mk2 -> GUNDAM -> EasyPage A` 순서로 이동한다.
8. EasyPage stack이 비어 있는 상태에서 같은 스와이프를 하면 브라우저의 기존 이전 페이지로 이동한다.
