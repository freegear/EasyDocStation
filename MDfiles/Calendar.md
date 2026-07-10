# Calendar.md

## 증상

- 이벤트 모달에서는 `"불루탑 소장님 미팅"`의 시간이 `2026년 7월 8일 오후 05:30 ~ 오후 06:00`으로 저장/표시된다.
- 하지만 주간 캘린더 시간 그리드에서는 해당 이벤트가 오후가 아니라 오전 `05:30 ~ 06:00` 위치에 표시된다.
- 사용자가 Drag & Drop으로 오후 시간대로 강제로 옮기려고 해도, 화면상으로는 오전 시간대에만 남아 있는 것처럼 보인다.

## 확인한 원인

핵심 원인은 캘린더 화면의 12시간제 -> 24시간제 변환 함수가 서로 다른 `ampm` 값 형식을 섞어 쓰고 있기 때문이다.

### 1. 이벤트 데이터는 한국어 `오전` / `오후`를 사용한다

`EventAddModal.jsx`의 시간 선택 UI는 `ampm` 값을 다음처럼 저장한다.

- `오전`
- `오후`

관련 위치:

- `src/components/EventAddModal.jsx:150`
- `src/components/EventAddModal.jsx:151`
- `src/components/EventAddModal.jsx:152`

서버의 시간 변환 로직도 한국어 `오후`를 기준으로 처리한다.

- `server/routes/events.js:11`
- `server/routes/events.js:13`
- `server/routes/events.js:26`

즉, 현재 앱의 실제 이벤트 시간 데이터 형식은 `AM/PM`이 아니라 `오전/오후`이다.

### 2. 캘린더 렌더링 함수는 영문 `AM` / `PM`만 처리한다

`CalendarView.jsx`의 `dtTo24h()` 함수는 다음 조건만 검사한다.

- `dt.ampm === 'PM'`
- `dt.ampm === 'AM'`

관련 위치:

- `src/components/CalendarView.jsx:21`
- `src/components/CalendarView.jsx:22`
- `src/components/CalendarView.jsx:25`
- `src/components/CalendarView.jsx:26`

따라서 이벤트 데이터가 `{ ampm: '오후', hour: 5, minute: 30 }`인 경우, `dtTo24h()`는 오후 5시 30분을 `17:30`으로 바꾸지 못하고 그대로 `05:30`으로 해석한다.

그 결과 `오후 05:30 ~ 오후 06:00` 이벤트가 캘린더 그리드에서는 `오전 05:30 ~ 오전 06:00` 위치에 배치된다.

### 3. Drag & Drop도 같은 변환 함수를 사용한다

Drag & Drop으로 이벤트를 이동할 때도 기존 이벤트의 시작/종료 시간을 읽기 위해 `dtTo24h()`를 사용한다.

관련 위치:

- `src/components/CalendarView.jsx:887`
- `src/components/CalendarView.jsx:911`
- `src/components/CalendarView.jsx:912`
- `src/components/CalendarView.jsx:913`
- `src/components/CalendarView.jsx:914`
- `src/components/CalendarView.jsx:915`

그래서 화면 표시뿐 아니라 드래그 이동/리사이즈 계산에서도 오후 이벤트가 오전 시간으로 해석될 수 있다.

특히 현재 증상처럼 사용자가 오후로 드롭해도 화면이 다시 오전처럼 보이는 이유는, 저장/상태 업데이트 이후에도 렌더링 단계에서 `오후`를 24시간제로 변환하지 못하기 때문이다.

## 영향 범위

- 주간 보기와 일간 보기의 시간 그리드 배치가 잘못된다.
- 이벤트 카드 내부에 표시되는 시간 문자열도 잘못될 수 있다.
- 월간 보기의 시간 prefix도 `dtTo24h()`를 사용하므로 오후 일정이 오전 시간처럼 표시될 수 있다.
- Drag & Drop 이동, 시작 시간 리사이즈, 종료 시간 리사이즈 계산도 영향을 받는다.
- 서버 저장 데이터 자체가 반드시 잘못된 것은 아니다. 모달과 서버는 한국어 `오전/오후`를 기준으로 동작하므로, 주된 문제는 프론트 캘린더 렌더링/계산 함수의 변환 불일치다.

## 해결 방법

### 1. `dtTo24h()`가 한국어와 영문 형식을 모두 처리하게 수정

`src/components/CalendarView.jsx`의 `dtTo24h()`를 다음 기준으로 보정해야 한다.

- `PM` 또는 `오후`이면 12가 아닌 hour에 12를 더한다.
- `AM` 또는 `오전`이고 hour가 12이면 0으로 바꾼다.
- `hour`, `minute` 값이 숫자가 아닐 가능성도 방어하면 더 안전하다.

예시 방향:

```js
function dtTo24h(dt) {
  let h = Number(dt.hour)
  const m = Number(dt.minute) || 0
  const ampm = dt.ampm
  if ((ampm === 'PM' || ampm === '오후') && h !== 12) h += 12
  if ((ampm === 'AM' || ampm === '오전') && h === 12) h = 0
  return { hour: h, minute: m }
}
```

### 2. 시간 데이터 형식을 하나로 통일

장기적으로는 `ampm` 저장 형식을 앱 전체에서 하나로 통일하는 것이 좋다.

권장안:

- UI 표시: `오전` / `오후`
- 내부 데이터: 가능하면 24시간제 숫자 또는 ISO datetime
- 기존 구조 유지 시: `ampm`은 `오전` / `오후`로 통일하고, 변환 함수도 이 형식을 기준으로 작성

현재 코드 기준으로는 이미 모달과 서버가 `오전/오후`를 쓰고 있으므로, 단기 수정은 `CalendarView.jsx`의 `dtTo24h()`를 한국어 기준에 맞추는 것이 가장 작고 안전하다.

### 3. 회귀 테스트 포인트

수정 후 아래 케이스를 확인해야 한다.

- `오후 05:30 ~ 오후 06:00` 이벤트가 주간/일간 보기에서 `17:30 ~ 18:00` 위치에 표시되는지
- 이벤트 카드 내부 시간이 `17:30 – 18:00`으로 표시되는지
- 해당 이벤트를 오전에서 오후로, 오후에서 오전으로 Drag & Drop 했을 때 위치가 정상 반영되는지
- 시작/종료 리사이즈가 오전/오후 경계를 넘을 때 정상 동작하는지
- `오전 12:00`은 `00:00`, `오후 12:00`은 `12:00`으로 처리되는지

## 결론

이번 문제의 직접 원인은 이벤트 데이터의 `ampm` 값은 한국어 `오후`인데, 캘린더 배치 계산 함수 `dtTo24h()`가 영문 `PM`만 인식하는 형식 불일치다.

따라서 코드 수정 시에는 우선 `src/components/CalendarView.jsx`의 `dtTo24h()`를 `오전/오후`도 처리하도록 고치면, `"불루탑 소장님 미팅"`이 오전이 아니라 실제 시간인 오후 5:30 ~ 6:00 위치에 표시되고 Drag & Drop 동작도 함께 정상화될 가능성이 높다.

---

## 주간 보기 날짜 열과 하루종일 이벤트 열 불일치

### 증상

- 주 단위 화면에서 상단 날짜 헤더의 각 날짜 열 위치와, 바로 아래 `하루종일` 이벤트 행의 날짜 열 위치가 서로 맞지 않는다.
- 긴 하루종일 이벤트 제목이 있는 날짜의 열이 더 넓게 보이고, 그 뒤 날짜들의 시작 위치가 날짜 헤더와 어긋난다.

### 원인

`src/components/CalendarView.jsx`의 `WeekView`에서 날짜 헤더, 하루종일 이벤트 행, 시간 그리드가 모두 `gridTemplateColumns: '56px repeat(7, 1fr)'`를 사용한다.

관련 위치:

- `src/components/CalendarView.jsx:264`
- `src/components/CalendarView.jsx:284`
- `src/components/CalendarView.jsx:317`

CSS Grid에서 `1fr` 트랙은 기본적으로 `minmax(auto, 1fr)`처럼 동작한다. 그래서 셀 내부에 긴 텍스트가 있으면 해당 열이 텍스트의 최소 콘텐츠 폭만큼 늘어날 수 있다.

날짜 헤더는 짧은 요일/날짜만 있으므로 균등하게 보이지만, 하루종일 이벤트 행은 긴 제목을 가진 이벤트가 들어오면서 특정 날짜 열이 넓어지고, 결과적으로 날짜 헤더와 하루종일 행의 열 너비가 서로 달라진다.

### 해결 방법

주간 보기에서 사용하는 7개 날짜 열을 `repeat(7, minmax(0, 1fr))`로 고정한다.

이렇게 하면 각 날짜 열이 콘텐츠의 최소 폭에 끌려가지 않고 동일한 비율로 나뉜다. 긴 하루종일 이벤트 제목은 셀 안에서 `truncate` 처리되어야 하며, 셀 자체는 `min-w-0`과 `overflow-hidden`을 가져야 한다.

구현 방향:

- 주간 보기 전용 그리드 컬럼 상수를 둔다.
- 날짜 헤더, 하루종일 이벤트 행, 시간 그리드가 같은 컬럼 정의를 공유하게 한다.
- 날짜 헤더 셀, 하루종일 셀, 시간 그리드 날짜 셀에 `min-w-0`을 적용한다.
- 하루종일 이벤트 카드에 `w-full`을 적용해 셀 너비 안에서만 말줄임되게 한다.

### 회귀 테스트 포인트

- 긴 하루종일 이벤트 제목이 있어도 날짜 헤더의 `일~토` 열과 하루종일 이벤트 행의 열 시작/끝 위치가 일치하는지 확인한다.
- 하루종일 이벤트 제목은 옆 날짜 열을 밀지 않고 해당 날짜 셀 안에서 말줄임되는지 확인한다.
- 시간 그리드의 날짜 열도 상단 날짜 헤더와 같은 x 좌표에 정렬되는지 확인한다.

---

## 반복 이벤트 이동 시 "이벤트를 찾을 수 없습니다" 오류

### 증상

- `"7월 7일 저녁에 이성환 법인장과 만나 베트남 시장 진출 방향에 대해 논의할 것."` 이벤트를 Drag & Drop으로 이동하면 반복 이벤트 수정 확인 팝업이 뜬다.
- 이후 수정 요청이 실패하며 `이벤트 수정 실패 / 이벤트를 찾을 수 없습니다.` 오류가 표시된다.

### 원인

드래그 이동 로직은 이벤트가 반복 이벤트인지 판단할 때 `repeat !== 'none'`만 확인한다.

관련 위치:

- `src/components/CalendarView.jsx:865`
- `src/components/CalendarView.jsx:893`
- `src/components/CalendarView.jsx:957`
- `src/components/CalendarView.jsx:983`

하지만 서버에서 반복 이벤트 전체 수정은 `series_id`로 시리즈 전체를 찾는다.

관련 위치:

- `server/routes/events.js:174`
- `server/routes/events.js:179`
- `server/routes/events.js:180`
- `server/routes/events.js:183`

즉, 프론트는 `repeat` 값만 보고 반복 이벤트 팝업을 띄우지만, 서버는 `seriesId`가 있어야 전체 수정할 수 있다. 기존 데이터, 메일/AI 액션에서 생성된 데이터, 마이그레이션 데이터처럼 `repeat` 값은 있지만 `seriesId`가 비어 있거나 올바르지 않은 경우에는 `/events/series/:seriesId` 요청이 서버에서 해당 시리즈를 찾지 못해 404가 된다.

또한 드래그 단건 저장 경로는 실패를 `.catch(() => {})`로 조용히 무시하고 있어서, 실패 시 화면 상태를 되돌리거나 사용자가 이해할 수 있는 메시지를 일관되게 보여주지 못한다.

### 해결 방법

반복 이벤트 전체 수정은 `repeat !== 'none'`뿐 아니라 `seriesId`가 실제로 있을 때만 허용해야 한다.

구현 방향:

- `repeat` 값과 `seriesId`를 함께 확인하는 헬퍼를 둔다.
- Drag & Drop 저장 시 `repeat`만 있고 `seriesId`가 없는 이벤트는 일반 단건 이벤트처럼 `/events/:id`로 저장한다.
- 드래그 저장 실패 시 기존 `prevEvents`로 화면 상태를 되돌리고 `openCalendarError('이벤트 수정 실패', err)`를 호출한다.
- 이벤트 모달의 저장/삭제 확인 팝업도 `seriesId`가 있는 반복 이벤트일 때만 띄운다.

### 회귀 테스트 포인트

- `repeat` 값은 있지만 `seriesId`가 없는 이벤트를 이동해도 `/events/series/null` 또는 `/events/series/undefined`로 요청하지 않는지 확인한다.
- `seriesId`가 있는 정상 반복 이벤트는 기존처럼 해당 날짜만/전체 선택 팝업이 뜨는지 확인한다.
- 드래그 저장 실패 시 이벤트가 이전 위치로 되돌아가고 오류 메시지가 표시되는지 확인한다.
