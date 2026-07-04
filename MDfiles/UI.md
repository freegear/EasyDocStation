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
