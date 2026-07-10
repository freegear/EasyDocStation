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

---

# 4. 언어 선택 국기 이모지를 이미지 아이콘으로 고정

## 4.1 증상

언어 선택 UI에서 사용자 환경에 따라 표시가 다르게 나타난다.

- 어떤 사용자 화면: `🇰🇷`, `🇺🇸`, `🇯🇵` 국기 모양으로 표시
- 다른 사용자 화면: `KR`, `US`, `JP` 텍스트처럼 표시

즉 같은 UI인데도 접속한 PC, OS, 브라우저, 폰트 환경에 따라 국기 표시가 달라진다.

## 4.2 원인

현재 언어 선택 버튼은 국기 이미지를 쓰는 것이 아니라 Unicode 국기 이모지를 문자열로 렌더한다.

실제 코드 위치:

- [src/components/TitleBar.jsx](../src/components/TitleBar.jsx)
- [src/components/SiteAdminPage.jsx](../src/components/SiteAdminPage.jsx)

현재 구조는 다음과 같은 형태다.

```jsx
const LANGUAGES = [
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
]
```

Unicode 국기 이모지는 내부적으로 국가 코드 조합이다.

예:

```txt
🇰🇷 = Regional Indicator Symbol K + R
🇺🇸 = Regional Indicator Symbol U + S
🇯🇵 = Regional Indicator Symbol J + P
```

OS나 브라우저가 이 조합을 컬러 국기 이모지로 렌더하면 국기로 보이고, 지원하지 못하면 `KR`, `US`, `JP`처럼 보일 수 있다.

특히 다음 환경에서 차이가 날 수 있다.

- Windows의 이모지/폰트 렌더링 차이
- Linux에서 `Noto Color Emoji` 같은 컬러 이모지 폰트 설치 여부
- 브라우저별 emoji fallback 처리 차이
- CSS `font-family`가 강하게 지정되어 emoji fallback이 막히는 경우

## 4.3 정책 (의견)

서비스 UI에서 모든 사용자에게 동일한 모양을 보장하려면 국기 이모지 대신 **이미지 아이콘**을 사용한다.

권장 원칙:

1. 언어 선택 UI에서는 Unicode 국기 이모지를 직접 렌더하지 않는다.
2. `public/flags` 아래에 고정 이미지 자산을 둔다.
3. 언어 목록 데이터에는 `flag` 문자열 대신 `flagSrc` 이미지 경로를 둔다.
4. 접근성 문구는 국가명이 아니라 언어명 기준으로 제공한다.
   - 좋은 예: `alt="한국어"`, `alt="English"`, `alt="日本語"`
   - 피할 예: `alt="한국 국기"`, `alt="미국 국기"`

국기는 국가를 의미하고 언어는 언어를 의미하므로, 화면에는 국기 이미지를 쓰더라도 접근성 라벨과 tooltip은 언어명을 기준으로 잡는 것이 좋다.

## 4.4 이미지 자산 위치

권장 파일 구조:

```txt
public/
  flags/
    kr.svg
    us.svg
    jp.svg
```

Vite/React에서 `public` 아래 파일은 다음처럼 절대 경로로 접근한다.

```jsx
<img src="/flags/kr.svg" alt="한국어" />
```

이미지 형식은 SVG를 우선 권장한다.

이유:

- OS/브라우저 emoji 폰트 영향을 받지 않는다.
- 확대/축소해도 깨지지 않는다.
- 용량이 작다.
- 버튼 크기에 맞추기 쉽다.

SVG 확보가 어렵거나 라이선스 확인이 필요한 경우에는 PNG도 가능하다. 단, PNG를 쓸 때는 최소 2배 해상도 자산을 준비해 고해상도 디스플레이에서 흐릿하지 않게 한다.

## 4.5 구현 방향

### 4.5.1 언어 데이터 변경

기존:

```jsx
const LANGUAGES = [
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
]
```

변경:

```jsx
const LANGUAGES = [
  { code: 'ko', label: '한국어', shortLabel: 'KR', flagSrc: '/flags/kr.svg' },
  { code: 'en', label: 'English', shortLabel: 'US', flagSrc: '/flags/us.svg' },
  { code: 'ja', label: '日本語', shortLabel: 'JP', flagSrc: '/flags/jp.svg' },
]
```

`shortLabel`은 이미지 로딩 실패 시 대체 텍스트나 fallback으로 사용할 수 있다.

### 4.5.2 버튼 렌더링 변경

기존:

```jsx
<span className="inline-block align-middle">{lang.flag}</span>
```

변경:

```jsx
<img
  src={lang.flagSrc}
  alt={lang.label}
  title={lang.label}
  className="h-5 w-5 object-contain"
  draggable={false}
/>
```

이미지 로딩 실패 fallback까지 고려하면 다음처럼 처리할 수 있다.

```jsx
<img
  src={lang.flagSrc}
  alt={lang.label}
  title={lang.label}
  className="h-5 w-5 object-contain"
  draggable={false}
  onError={(event) => {
    event.currentTarget.style.display = 'none'
  }}
/>
```

다만 `onError`만으로는 버튼 안이 비어 보일 수 있으므로, 더 안정적으로 하려면 공통 `LanguageFlag` 컴포넌트를 두는 것이 좋다.

권장 컴포넌트:

```jsx
function LanguageFlag({ lang }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <span className="text-xs font-bold">{lang.shortLabel}</span>
  }
  return (
    <img
      src={lang.flagSrc}
      alt={lang.label}
      title={lang.label}
      className="h-5 w-5 object-contain"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
```

## 4.6 공통화 의견

현재 `LANGUAGES` 정의가 [TitleBar.jsx](../src/components/TitleBar.jsx)와 [SiteAdminPage.jsx](../src/components/SiteAdminPage.jsx)에 중복되어 있다.

이미지 아이콘으로 전환할 때는 언어 목록과 렌더링을 공통화하는 것이 좋다.

권장 신규 파일:

```txt
src/constants/languages.js
src/components/LanguageFlag.jsx
```

역할:

- `src/constants/languages.js`
  - `SUPPORTED_LANGUAGES` 배열 관리
  - 언어 코드, 언어명, 짧은 라벨, 이미지 경로를 한 곳에서 관리
- `src/components/LanguageFlag.jsx`
  - 이미지 렌더링
  - 이미지 로딩 실패 시 `KR/US/JP` fallback
  - 공통 크기와 접근성 속성 관리

이렇게 하면 타이틀바와 관리자 페이지가 같은 이미지, 같은 크기, 같은 fallback 정책을 사용한다.

## 4.7 구현 결과

| 파일 | 변경 | 상태 |
|---|---|---|
| `public/flags/kr.svg` | 한국어 선택용 고정 SVG 국기 이미지 추가 | 완료 |
| `public/flags/us.svg` | English 선택용 고정 SVG 국기 이미지 추가 | 완료 |
| `public/flags/jp.svg` | 日本語 선택용 고정 SVG 국기 이미지 추가 | 완료 |
| [src/constants/languages.js](../src/constants/languages.js) | `SUPPORTED_LANGUAGES` 공통 언어 목록 추가 (`code`, `label`, `shortLabel`, `flagSrc`) | 완료 |
| [src/components/LanguageFlag.jsx](../src/components/LanguageFlag.jsx) | 국기 이미지 렌더링 및 이미지 로딩 실패 시 `KR/US/JP` fallback 처리 | 완료 |
| [src/components/TitleBar.jsx](../src/components/TitleBar.jsx) | 기존 이모지 기반 `LANGUAGES` 제거, `SUPPORTED_LANGUAGES`와 `LanguageFlag` 사용 | 완료 |
| [src/components/SiteAdminPage.jsx](../src/components/SiteAdminPage.jsx) | 기존 이모지 기반 `LANGUAGES` 제거, `SUPPORTED_LANGUAGES`와 `LanguageFlag` 사용 | 완료 |

## 4.8 검증

```txt
npm run build
```

실제 확인:

1. 타이틀바 언어 선택 버튼이 모든 환경에서 이미지 국기로 표시된다.
2. 사이트 관리자 페이지의 언어 선택 버튼도 같은 이미지 국기로 표시된다.
3. Windows, macOS, Linux, Chrome, Edge, Safari 등에서 `KR/US/JP` 텍스트로 깨지지 않는다.
4. 이미지 로딩에 실패하면 버튼이 비어 보이지 않고 `KR`, `US`, `JP` fallback이 표시된다.
5. `alt`, `title`, `aria-label`은 국기명이 아니라 `한국어`, `English`, `日本語`처럼 언어명으로 제공된다.

---

# 5. `@` 멘션 후보를 현재 채널 멤버 기준으로 제한

## 5.1 증상

채널 설정 화면의 `채널 멤버` 목록에는 `yoo`가 보이지만, 게시글 또는 댓글 입력창에서 `@yoo`를 입력하면 멘션 후보에 나타나지 않는다.

## 5.2 원인

채널 멤버 UI와 `@` 멘션 자동완성이 서로 다른 데이터 기준을 사용하고 있었다.

- 채널 멤버 UI:
  - [src/components/ChannelManageModal.jsx](../src/components/ChannelManageModal.jsx)
  - `GET /api/channels/:id/members` 사용
  - 현재 채널에 등록된 멤버를 표시한다.

- 기존 `@` 멘션 자동완성:
  - [src/hooks/useMentionAutocomplete.js](../src/hooks/useMentionAutocomplete.js)
  - `GET /api/teams/:teamId/members` 사용
  - 현재 채널 멤버가 아니라 현재 팀 멤버를 기준으로 후보를 만들었다.

따라서 어떤 사용자가 채널 멤버 목록에는 보이더라도, 멘션 자동완성이 읽는 팀 멤버 목록에 없거나 검색 결과 상위 10명 밖으로 밀리면 `@` 후보에 나타나지 않을 수 있었다.

## 5.3 정책 (의견)

게시글과 댓글의 `@` 멘션은 사용자가 **현재 채널 안에서 대화 상대를 부르는 기능**이다.

따라서 멘션 후보는 팀 전체 멤버가 아니라 **현재 채널 멤버만** 대상으로 하는 것이 자연스럽다.

정책:

1. 게시글 작성창의 `@` 후보는 현재 선택된 채널의 멤버만 표시한다.
2. 댓글 작성창의 `@` 후보도 해당 게시글이 속한 채널의 멤버만 표시한다.
3. 채널 멤버가 아닌 팀 멤버는 `@` 후보에 표시하지 않는다.
4. 후보 검색 조건은 기존처럼 `name`, `display_name`, `username` prefix 매칭을 유지한다.

이렇게 하면 채널 설정에서 보이는 `채널 멤버`와 실제 `@` 멘션 후보의 기준이 일치한다.

## 5.4 구현 결과

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/hooks/useMentionAutocomplete.js](../src/hooks/useMentionAutocomplete.js) | 인자를 `teamId` 기준에서 `channelId` 기준으로 변경, `/teams/:id/members` 대신 `/channels/:id/members` 호출 | 완료 |
| [src/components/ChatArea.jsx](../src/components/ChatArea.jsx) | 게시글 작성창 `ComposeBar`에서 `selectedTeam.id` 대신 `selectedChannel.id`를 멘션 훅에 전달 | 완료 |
| [src/components/chat/PostDetailPane.jsx](../src/components/chat/PostDetailPane.jsx) | 댓글 작성창에서 `selectedTeam.id` 대신 게시글의 `channelId`를 멘션 훅에 전달 | 완료 |
| [MDfiles/UI.md](./UI.md) | 원인, 정책, 구현 결과 기록 | 완료 |

## 5.5 검증

```txt
npm run build
```

실제 확인:

1. 채널 멤버 목록에 `yoo`가 있는 채널에서 게시글 입력창에 `@yoo`를 입력하면 후보에 나타난다.
2. 같은 채널의 댓글 입력창에서도 `@yoo`가 후보에 나타난다.
3. 현재 채널 멤버가 아닌 팀 멤버는 `@` 후보에 나타나지 않는다.
4. `@`만 입력했을 때 후보 목록은 현재 채널 멤버 기준으로 표시된다.
5. 후보 선택 시 기존처럼 `@표시이름` 형태로 입력된다.

---

# 6. 붙여넣기에서 텍스트는 되지만 이미지는 안 되는 문제

## 6.1 증상

입력창에 텍스트를 복사해서 붙여넣으면 정상적으로 들어간다. 하지만 스크린샷이나 이미지 파일을 클립보드에 복사한 뒤 붙여넣으면 첨부 또는 본문 이미지로 들어가지 않는다.

예상 사용 시나리오:

- OS 스크린샷 도구로 캡처 후 `Ctrl+V`
- 브라우저/메신저/이미지 뷰어에서 이미지 복사 후 `Ctrl+V`
- 파일 탐색기에서 이미지 파일 복사 후 입력창에 `Ctrl+V`

## 6.2 원인

현재 구현은 텍스트 붙여넣기와 파일 드래그앤드롭은 처리하지만, 클립보드 이미지 파일을 처리하는 `paste` 경로가 빠져 있다.

### 6.2.1 게시글 작성창

[src/components/ChatArea.jsx](../src/components/ChatArea.jsx)의 `ComposeBar`는 다음 경로만 처리한다.

- 파일 선택: `<input type="file">` → `handleFileSelect()` → `addFiles()`
- 드래그앤드롭: `onDrop` / `onDragOver` → `handleDrop()` → `addFiles()`

하지만 `<textarea>`에는 `onPaste`가 없다.

현재 구조:

```jsx
<textarea
  onChange={...}
  onDragOver={handleTextareaDragOver}
  onDrop={handleTextareaDrop}
/>
```

따라서 텍스트는 브라우저 기본 동작으로 붙지만, 클립보드에 들어 있는 이미지 파일은 애플리케이션이 읽지 않으므로 첨부 목록에 추가되지 않는다.

### 6.2.2 댓글 작성창

[src/components/chat/PostDetailPane.jsx](../src/components/chat/PostDetailPane.jsx)의 댓글 입력창도 게시글 작성창과 동일하다.

- 파일 선택 지원
- 드래그앤드롭 지원
- `onPaste` 없음

즉 댓글에서도 텍스트는 붙지만 이미지는 첨부되지 않는다.

### 6.2.3 EasyPage / MD 편집기

[src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx)는 TipTap 편집기에서 copy/cut/paste를 별도로 처리한다.

현재 paste 흐름:

- `pasteEasyDocClipboardData(editor.view, event)` 호출
- [clipboardExtension.js](../src/components/chat/md-page/extensions/clipboardExtension.js)에서 `application/x-easydocstation-md-slice` 전용 payload만 읽음
- EasyDoc 내부에서 복사한 문서 slice가 있으면 붙여넣고, 없으면 `false` 반환

이 로직은 EasyDoc 내부 문서 조각 복사/붙여넣기에는 유효하지만, 외부 클립보드 이미지(`clipboardData.items`, `clipboardData.files`)를 업로드해서 이미지 노드로 삽입하는 기능은 없다.

반면 MD 편집기에는 이미 이미지 업로드 함수가 있다.

- `uploadAndInsertImage(file)`
- `uploadAndInsertFile(file)`
- 드래그앤드롭 이미지 삽입

즉 이미지 삽입 능력은 있지만, paste 이벤트에서 이미지 파일을 꺼내 이 함수로 연결하는 경로가 빠져 있다.

## 6.3 정책 (의견)

붙여넣기는 드래그앤드롭, 파일 선택과 같은 파일 첨부 경로로 취급한다.

정책:

1. 텍스트만 있는 paste는 브라우저 기본 동작을 유지한다.
2. 클립보드에 이미지 파일이 있으면 기본 paste를 막고 이미지 첨부 또는 이미지 삽입으로 처리한다.
3. 게시글/댓글 작성창에서는 붙여넣은 이미지를 첨부 파일 목록에 추가한다.
4. EasyPage/MD 편집기에서는 붙여넣은 이미지를 업로드 후 현재 커서 위치에 이미지 노드로 삽입한다.
5. 이미지 외 파일이 클립보드에 들어오면 정책을 선택한다.
   - 1차 권장: 이미지 파일만 paste 지원
   - 후속 확장: PDF/문서 파일도 첨부로 paste 지원
6. 이미지 파일명은 클립보드에서 이름이 없을 수 있으므로 안전한 기본 이름을 만든다.
   - 예: `pasted-image-20260709-143012.png`

## 6.4 구현 방향

### 6.4.1 공통 클립보드 파일 추출 helper

중복을 줄이기 위해 클립보드에서 파일을 추출하는 helper를 둔다.

권장 위치:

```txt
src/lib/clipboardFiles.js
```

역할:

- `event.clipboardData.files`에서 파일 추출
- `event.clipboardData.items`에서 `kind === 'file'` 항목을 `getAsFile()`로 추출
- `image/*` 타입만 필터링
- 파일 이름이 없거나 `image.png`처럼 너무 일반적이면 `pasted-image-...` 이름으로 보정

예상 함수:

```js
export function getPastedImageFiles(event) {
  const data = event.clipboardData
  if (!data) return []

  const files = []
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file?.type?.startsWith('image/')) files.push(file)
  }

  for (const file of Array.from(data.files || [])) {
    if (file?.type?.startsWith('image/')) files.push(file)
  }

  return dedupeAndNormalize(files)
}
```

### 6.4.2 게시글 작성창 적용

[src/components/ChatArea.jsx](../src/components/ChatArea.jsx)의 `ComposeBar`에 paste handler를 추가한다.

동작:

1. `getPastedImageFiles(event)` 호출
2. 이미지가 없으면 아무것도 하지 않음 → 텍스트 paste 기본 동작 유지
3. 이미지가 있으면 `event.preventDefault()`
4. 기존 `addFiles(files)` 호출

적용 위치:

```jsx
<textarea
  ...
  onPaste={handleTextareaPaste}
/>
```

`handleTextareaPaste`는 `handleTextareaDrop`과 유사하게 `addFiles()`로 연결한다.

### 6.4.3 댓글 작성창 적용

[src/components/chat/PostDetailPane.jsx](../src/components/chat/PostDetailPane.jsx)의 댓글 textarea에도 같은 paste handler를 추가한다.

동작은 게시글 작성창과 동일하다.

- 텍스트 paste는 기본 동작
- 이미지 paste는 첨부 파일 목록에 추가

### 6.4.4 EasyPage / MD 편집기 적용

[src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx)의 paste 처리 순서를 조정한다.

권장 순서:

1. `pasteEasyDocClipboardData(editor.view, event)`를 먼저 시도한다.
2. EasyDoc 내부 slice paste가 처리되면 종료한다.
3. 처리되지 않았고 클립보드에 이미지 파일이 있으면:
   - `event.preventDefault()`
   - 이미지 파일을 순서대로 `uploadAndInsertImage(file)`에 전달
4. 이미지가 없으면 기본 TipTap paste를 허용한다.

이렇게 하면 기존 EasyDoc 내부 문서 복사/붙여넣기 기능은 유지하면서 외부 이미지 paste만 추가할 수 있다.

주의:

- `pasteEasyDocClipboardData()`가 `false`를 반환한 경우에만 이미지 paste를 검사한다.
- `onPasteCapture`와 ProseMirror plugin `handleDOMEvents.paste`가 중복으로 실행될 수 있으므로, 한 곳으로 통합하거나 중복 처리 방지 플래그를 둔다.

## 6.5 파일별 변경 계획

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/lib/clipboardFiles.js](../src/lib/clipboardFiles.js) | 클립보드 이미지 파일 추출 및 파일명 보정 helper 추가 | 완료 |
| [src/components/ChatArea.jsx](../src/components/ChatArea.jsx) | 게시글 작성 textarea에 `onPaste` 추가, 이미지 paste 시 `addFiles()` 연결 | 완료 |
| [src/components/chat/PostDetailPane.jsx](../src/components/chat/PostDetailPane.jsx) | 댓글 textarea에 `onPaste` 추가, 이미지 paste 시 `addFiles()` 연결 | 완료 |
| [src/components/chat/MDPageViewer.jsx](../src/components/chat/MDPageViewer.jsx) | EasyDoc slice paste 실패 시 클립보드 이미지 파일을 `uploadAndInsertImage()`로 삽입 | 완료 |
| [src/components/chat/md-page/extensions/clipboardExtension.js](../src/components/chat/md-page/extensions/clipboardExtension.js) | EasyDoc 전용 paste는 유지하고, 외부 이미지 paste는 MDPageViewer에서 후속 처리 | 완료 |
| [MDfiles/UI.md](./UI.md) | 원인 분석과 해결 방안 기록 | 완료 |

## 6.6 검증 항목

```txt
npm run build
```

실제 확인:

1. 게시글 작성창에 텍스트를 붙여넣으면 기존처럼 텍스트가 들어간다.
2. 게시글 작성창에 스크린샷 이미지를 붙여넣으면 첨부 파일 목록에 이미지가 추가된다.
3. 댓글 작성창에 스크린샷 이미지를 붙여넣으면 첨부 파일 목록에 이미지가 추가된다.
4. 이미지가 첨부된 상태로 게시글/댓글을 등록하면 기존 파일 업로드 경로로 정상 저장된다.
5. EasyPage 편집기에서 이미지를 붙여넣으면 현재 커서 위치에 이미지가 삽입된다.
6. EasyPage 내부에서 복사한 문서 조각 붙여넣기는 기존처럼 유지된다.
7. 이미지가 아닌 일반 텍스트/HTML paste는 기존 편집기 기본 동작을 해치지 않는다.
