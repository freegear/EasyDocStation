# WelcomeBoard.md

`template/WelcomeBoard_whiteThema.html` 을 **"Welcome 보드"** 서비스로 구축하는 방안을 **설계/검토**한다.
(실제 코드는 별도 작업으로 진행한다.)

## 1. 요구사항

1. `WelcomeBoard_whiteThema.html` 을 "Welcome 보드" 서비스로 만든다.
2. 사이드바 **SERVICE(버튼) 패널의 제일 위**에 배치하고, 이름은 **"Welcome 보드"**.
3. **모든 사용자는 자신만의 Welcome 보드**를 가진다.
4. 이 페이지는 **서버 실행 시 `--showWelcomeBoard` 옵션이 있을 때만** 보인다.

## 2. 현재 구조 조사 결과

### 2.1 SERVICE 버튼 패널 (Sidebar)

- [src/components/Sidebar.jsx](../src/components/Sidebar.jsx) 상단 `SERVICE` 섹션이 `topServices` 배열을 버튼으로 렌더한다.
  - `topServices`(약 54행)는 플래그로 구성: `건설 안전 칸반 보드`(`CONSTRUCT_SAFE_KANBAN_TEMPLATE`),
    `Easy Code 생성 플랫폼`(`EASY_CODE_GENERATION_TEMPLATE`).
  - 각 버튼 클릭 → `onOpenServicePage?.(template)` 호출.
  - 배열 순서 = 표시 순서. **맨 앞에 넣으면 패널 최상단**에 온다.
- 각 서비스 템플릿은 `{ id, label, icon, content }` 구조([src/templates/formTemplates.js](../src/templates/formTemplates.js) 5~17행).
  `content`는 `template/*.html?raw`로 import한 **정적 HTML 문자열**.

### 2.2 서비스 페이지 렌더 방식

- 클릭 시 `onOpenServicePage` → App의 `setFullscreenService(template)`.
- [src/App.jsx](../src/App.jsx) `FullscreenServicePage`(20행)가 `service.content`(HTML)를
  **전체화면 `<iframe srcDoc>`** 로 렌더한다. Esc 2번으로 닫힘.
- 즉 Welcome 보드도 **동일 메커니즘으로 그대로 렌더**된다(추가 렌더러 불필요).

### 2.3 현재 플래그 방식의 한계 (중요)

- 기존 서비스 노출 플래그는 **빌드타임 Vite 환경변수**다:
  `import.meta.env.VITE_CONSTRUCT_SAFE_KANBAN_TEMPLATE === '1'`([Sidebar.jsx](../src/components/Sidebar.jsx) 52~53행).
- 그러나 요구사항 4는 **서버 실행 옵션(`--showWelcomeBoard`)** 이다 → 빌드타임 env로는 충족 불가.
  프론트가 **런타임에 서버로부터** 플래그를 받아야 한다.

### 2.4 서버 런타임 설정 노출 패턴

- 서버는 `config.json`/환경변수 값을 `GET /api/config/*` 로 노출한다
  ([server/index.js](../server/index.js) `/api/config/version|display|agenticai|limits|company` 등).
- 프론트는 시작 시 이 엔드포인트를 조회한다(예: [src/contexts/AuthContext.jsx](../src/contexts/AuthContext.jsx) 217행 `fetch('/api/config/limits')`).
- 서버 기동: `node index.js`(운영) / `nodemon index.js`(개발). 서버 스크립트에서 `process.argv` 파싱 선례 존재
  (`server/scripts/*` 에서 `process.argv.includes('--dry-run')` 등).

### 2.5 템플릿 성격

- [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html)은 **완전 정적**(탭 전환용
  인라인 `<script>`만 존재, `localStorage`/`fetch` 없음). 카드(오늘의 일정 / 중요 메일 / 중요 사항들 등)에는
  **데모용 하드코딩 데이터**가 들어 있다(홍길동, 이수연 등 목업).

## 3. 설계

### 3.1 템플릿 등록

- [src/templates/formTemplates.js](../src/templates/formTemplates.js)에 상수 추가:

  ```
  import welcomeBoardTemplate from '../../template/WelcomeBoard_whiteThema.html?raw'
  export const WELCOME_BOARD_TEMPLATE = {
    id: 'welcome-board',
    label: 'Welcome 보드',
    icon: '👋',            // 또는 🏠
    content: welcomeBoardTemplate,
  }
  ```

### 3.2 버튼 패널 최상단 배치 + 이름

- [src/components/Sidebar.jsx](../src/components/Sidebar.jsx) `topServices` 구성 시 **맨 앞에** 추가:

  ```
  const topServices = [
    ...(showWelcomeBoard ? [WELCOME_BOARD_TEMPLATE] : []),   // 최상단
    ...(showConstructSafeKanbanTemplate ? [CONSTRUCT_SAFE_KANBAN_TEMPLATE] : []),
    ...(showEasyCodeGenerationTemplate ? [EASY_CODE_GENERATION_TEMPLATE] : []),
  ]
  ```
- 라벨 "Welcome 보드"는 템플릿 `label`로 표시된다. 기존 버튼 렌더/클릭(→ `onOpenServicePage`) 로직을 그대로 재사용.

### 3.3 실행 옵션 `--showWelcomeBoard` (구현됨 — 기존 플래그와 동일 패턴)

기존 두 서비스 플래그(`--Construct_safe_kanban_template`, `--EasyCodeGeneration`)는 실행 스크립트
[scripts/run-dgx-spark.sh](../scripts/run-dgx-spark.sh)가 옵션을 받아 **Vite env**(`VITE_*`)로 프론트에 전달하는
방식이다(프론트는 `import.meta.env.VITE_*`로 읽음). Welcome 보드도 **동일 패턴**으로 맞춰 구현했다
(별도 서버 config 엔드포인트 불필요, 일관성 확보).

1. **실행 스크립트 옵션 파싱** — [scripts/run-dgx-spark.sh](../scripts/run-dgx-spark.sh):
   - 기본값 `SHOW_WELCOME_BOARD="${VITE_SHOW_WELCOME_BOARD:-0}"`.
   - 옵션 케이스 `--showWelcomeBoard|--show-welcome-board|showWelcomeBoard` → `SHOW_WELCOME_BOARD="1"`.
   - `--help` 목록·활성화 로그 추가.
   - 프론트 기동 env에 `VITE_SHOW_WELCOME_BOARD="$SHOW_WELCOME_BOARD"` 전달.
   - 실행 예: `bash scripts/run-dgx-spark.sh --showWelcomeBoard`.

2. **프론트 노출** — [src/components/Sidebar.jsx](../src/components/Sidebar.jsx):
   - `const showWelcomeBoard = import.meta.env.VITE_SHOW_WELCOME_BOARD === '1'`.
   - `topServices` **맨 앞**에 `WELCOME_BOARD_TEMPLATE` 추가(3.2).

> 참고: 이 프로젝트는 `run-dgx-spark.sh`가 `npm run dev:frontend`(vite)를 `VITE_*` env와 함께 기동하므로
> Vite env가 곧 "실행 옵션"으로 동작한다. 따라서 서버 런타임 config 엔드포인트 방식(초기 검토안)은 채택하지 않고
> 기존 두 플래그와 동일한 방식으로 통일했다.

### 3.4 "모든 사용자는 자신만의 Welcome 보드"

현재 서비스 템플릿은 **정적 HTML을 사용자마다 각자 iframe으로 여는** 구조라, "각 사용자가 자기 인스턴스를 본다"는
의미는 이미 성립한다(공유 상태 없음). 다만 "자신만의"를 어디까지 보느냐에 따라 범위가 갈린다.

- **(A) 정적 개인 보드 (1차 권장)**: 모든 사용자에게 **동일한 정적 템플릿**을 각자 화면에 렌더.
  서버 저장/상태 없음. 가장 단순하고 회귀 위험 0. 단, 카드 내용은 현재 **데모 데이터**(개인화 아님).
- **(B) 개인 데이터 채움**: 카드(오늘의 일정/중요 메일/중요 사항)를 **로그인 사용자 실제 데이터**로 채움.
  캘린더/메일/별표 등 기존 API를 iframe↔부모 `postMessage` 또는 서버 렌더로 주입해야 함(중간 규모 작업).
- **(C) 개인 편집·저장**: 사용자가 보드를 커스터마이즈하고 **per-user로 영속화**. 사용자별 저장소(예: `user_id`
  스코프 테이블/문서)가 필요. 현재 코드에 딱 맞는 "사용자별 보드 콘텐츠" 저장소는 없음 → 신설 필요(후속).

→ **권장: 1차 (A)로 출시**(요구사항 1·2·4를 즉시 충족, "자신만의"=개인 인스턴스). (B)/(C)는 후속 단계로 명시.
   데모 데이터는 실서비스 전 **빈 상태/플레이스홀더**로 교체 검토(현재 목업 이름 노출 방지).

## 4. 렌더 · 보안

- Welcome 보드는 기존 `FullscreenServicePage`의 **`<iframe srcDoc>`** 로 렌더(칸반/EasyCode와 동일).
  자체 완결 정적 HTML이라 추가 보안 이슈 없음(외부 폰트 `fonts.googleapis.com` 링크만 존재 — 사내망 정책에 따라
  폰트 로드 실패 시 시스템 폰트로 폴백되며 기능엔 지장 없음).
- 향후 (B)에서 사용자 데이터를 넣을 때는 iframe ↔ 부모 통신(`postMessage`) 신뢰 경계·오리진 검증을 둔다.

## 5. 구현 위치 요약 (파일별)

| 파일 | 변경 | 상태 |
|---|---|---|
| [scripts/run-dgx-spark.sh](../scripts/run-dgx-spark.sh) | `--showWelcomeBoard` 옵션 파싱 → `VITE_SHOW_WELCOME_BOARD` env 전달, help/로그 | 완료 |
| [src/templates/formTemplates.js](../src/templates/formTemplates.js) | `WELCOME_BOARD_TEMPLATE` 상수 + `?raw` import 추가 (현재 `WelcomeBoard_whiteThema.html`(흰 테마)을 import — blue/white 두 테마는 팔레트만 다르고 마크업 동일) | 완료 |
| [src/components/Sidebar.jsx](../src/components/Sidebar.jsx) | `import.meta.env.VITE_SHOW_WELCOME_BOARD` → `topServices` **맨 앞**에 추가 | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) | 상단바 `.actions`(＋새 문서/▦/🔔) 제거 | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [template/WelcomeBoard_blueThema.html](../template/WelcomeBoard_blueThema.html) | 보드 본문 인사말(`.topbar`/`.greeting`) 블록 **제거** → 인패널 헤더 한 줄로 통합(아래 참고) | 완료 |
| [src/templates/formTemplates.js](../src/templates/formTemplates.js) · [src/App.jsx](../src/App.jsx) | 인사말을 인패널 헤더 한 줄로 표시: `WELCOME_BOARD_TEMPLATE.headerLabel` 문구를 헤더(`PanelServicePage`)에서 `service.headerLabel \|\| service.label` 로 렌더, 폰트 50%↑(`text-[21px]`). **문구: `EasyStation에 오신 것을 환영합니다.`** (구 `안녕하세요, 👋 Welcome 보드에 오신 것을 환영합니다.` 에서 교체) | 완료 |

## 6. 결정 필요 사항

1. **개인화 범위**: 3.4의 (A) 정적 / (B) 개인 데이터 / (C) 개인 편집·저장 중 1차 범위. (권장: A)
2. **플래그 전달 수단**: argv `--showWelcomeBoard` 단독 / env 병행 여부. (권장: argv + env 병행)
3. **데모 데이터 처리**: 목업 이름 그대로 노출 vs 빈/플레이스홀더로 교체. (권장: 교체)
4. **모바일 노출 여부**: 데스크톱만 / 모바일 포함.

## 7. 범위 밖(향후 확장)

- (B) 카드에 로그인 사용자 실제 데이터(일정/메일/별표) 주입.
- (C) per-user 보드 커스터마이즈·영속화(사용자별 저장소 신설).
- 서비스 노출 플래그 방식 통일(빌드타임 env ↔ 런타임 서버 플래그).
- Welcome 보드를 로그인 직후 **기본 첫 화면**으로 띄우는 옵션.

---

## 8. [신규 요구] Welcome 보드를 **가운데 메인 패널**에 렌더

> 요구: "Welcome 보드는 가운데 메인 패널에 나타나도록 해줘."
> (현재는 전체화면 오버레이로 열림 → 가운데 컬럼에 인패널로 렌더하도록 전환)

### 8.1 현재 렌더 방식 검토 결과 (실제 코드 확인)

- 사이드바에서 Welcome 보드 클릭 → `onOpenServicePage?.(template)` → App의 **`setFullscreenService(template)`**
  ([Sidebar.jsx:391](../src/App.jsx#L391)에서 prop 주입).
- [App.jsx:20](../src/App.jsx#L20) `FullscreenServicePage`가 `service.content`(HTML)를
  **`<div className="fixed inset-0 z-[10000]">` + `<iframe srcDoc>`** 로 렌더한다.
  → 화면 전체를 덮어 **좌측 Sidebar·우측 GroqPanel(AgenticAI)까지 가린다.** (Esc 2번/× 버튼으로 닫힘)
- 반면 "가운데 메인 패널"은 [App.jsx:404-416](../src/App.jsx#L404-L416)의 **조건부 체인**이 담당한다.
  좌측 `Sidebar`와 우측 `GroqPanel` **사이의 컬럼**이며, 현재 우선순위:
  `showCalendar → CalendarView` / `showDM → DirectMessageView` / `isSearchMode → SearchResultsArea` / else `ChatArea`.
- 우측 GroqPanel(AgenticAI)은 [App.jsx:419](../src/App.jsx#L419)에서 `display: (showCalendar || showDM || !showAgenticPanel) ? 'none'`
  으로 캘린더/DM일 때만 숨긴다(언마운트 아님, state 유지).

**결론:** 전체화면(`fixed inset-0`)이 원인이다. 캘린더/DM과 **동일한 인패널 브랜치**로 만들면,
사이드바·AgenticAI 패널은 그대로 두고 **가운데 컬럼만** Welcome 보드로 바뀐다(스크린샷 레이아웃과 일치).

### 8.2 구현 방안 (권장: 캘린더/DM과 동일 패턴의 인패널 뷰)

1. **인패널 렌더러 신설** — [src/App.jsx](../src/App.jsx):
   `FullscreenServicePage`를 재사용하지 말고, 가운데 컬럼용 컴포넌트 `PanelServicePage`를 추가한다.
   - 래퍼를 `fixed inset-0 z-[10000]` 대신 **`flex-1 min-h-0` (형제 flex 컬럼)** 로 둔다
     (형제인 Sidebar/GroqPanel과 같은 flex row에 들어가 가운데를 채움).
   - 내부 `<iframe srcDoc={service.content} className="h-full w-full border-0">` 로 렌더.
   - 닫기 UX: 전체화면 × 대신 **상단 "← 채널로" 버튼**(또는 Esc)로 `onClose` → ChatArea 복귀.

   ```jsx
   function PanelServicePage({ service, onClose }) {
     if (!service) return null
     return (
       <div className="flex flex-1 min-h-0 flex-col bg-slate-950">
         <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
           <button type="button" onClick={onClose}
             className="text-sm text-white/80 hover:text-white">← 채널로</button>
           <span className="text-sm text-white/60">{service.label}</span>
         </div>
         <iframe title={service.label} srcDoc={service.content}
           className="flex-1 w-full border-0" />
       </div>
     )
   }
   ```

2. **뷰 state 추가 + 상호배타 처리** — [src/App.jsx](../src/App.jsx):
   캘린더/DM처럼 별도 state를 둔다. `const [welcomeService, setWelcomeService] = useState(null)`.
   - 가운데 컬럼 조건부 체인([App.jsx:404-416](../src/App.jsx#L404-L416))에 **ChatArea 앞** 브랜치 삽입:
     ```jsx
     {showCalendar ? <CalendarView .../>
       : showDM && activeDMConv ? <DirectMessageView .../>
       : welcomeService ? <PanelServicePage service={welcomeService} onClose={() => setWelcomeService(null)} />
       : isSearchMode ? <SearchResultsArea .../>
       : <ChatArea .../>}
     ```
   - **상호배타:** Welcome 열 때 `setShowCalendar(false); setShowDM(false); setShowMail(false); setActiveDMConv(null)`.
     반대로 캘린더/DM/메일/채널 선택 시 `setWelcomeService(null)` 도 함께 호출(다른 뷰로 나가면 보드 닫힘).

3. **사이드바 클릭 라우팅 분기** — [src/components/Sidebar.jsx](../src/components/Sidebar.jsx):
   Welcome 보드만 인패널로 보내고, 칸반/EasyCode는 기존 전체화면 유지(변경 최소화).
   - 새 prop `onOpenServiceInPanel(template)` 를 받고, 버튼 클릭 시 **템플릿 id로 분기**:
     `template.id === 'welcome-board' ? onOpenServiceInPanel(template) : onOpenServicePage(template)`.
   - App에서 `onOpenServiceInPanel={(tpl) => { setWelcomeService(tpl); setShowCalendar(false); setShowDM(false); setShowMail(false); setActiveDMConv(null) }}` 주입.

4. **AgenticAI(GroqPanel) 노출 유지** — [App.jsx:419](../src/App.jsx#L419):
   Welcome 보드는 스크린샷대로 **우측 AI 패널을 함께 노출**해야 하므로,
   해당 `display:none` 숨김 조건(`showCalendar || showDM ...`)에 **welcomeService를 추가하지 않는다.**
   (가운데 컬럼만 보드로 바뀌고 우측 패널은 그대로 유지됨.)

### 8.3 파일별 변경 요약 (신규 요구)

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/App.jsx](../src/App.jsx) | `PanelServicePage` 추가 · `welcomeService` state · 조건부 체인에 인패널 브랜치 · 상호배타 리셋 | 예정 |
| [src/components/Sidebar.jsx](../src/components/Sidebar.jsx) | Welcome 보드 클릭을 `onOpenServiceInPanel`로 분기(id `welcome-board`) | 예정 |
| (선택) [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) | 좁아진 가운데 컬럼 폭 기준 반응형 확인(현재 iframe 내부 스크롤로 대응 가능) | 검토 |

### 8.4 대안 및 트레이드오프

- **(대안1) 기존 `FullscreenServicePage` 재사용 + 위치만 변경:** 래퍼를 `fixed`에서 컬럼용으로 바꾸면
  Esc 2번 닫기 로직 등이 그대로 딸려 와 인패널 UX와 안 맞는다 → **별도 `PanelServicePage` 신설 권장.**
- **(대안2) 모든 서비스(칸반/EasyCode 포함) 인패널화:** 일관성은 좋으나 회귀 범위 커짐.
  → 이번 요구는 Welcome 보드 한정이므로 **분기 방식**으로 최소 변경.
- **모바일:** [MobileLayout](../src/components/MobileLayout.jsx)은 `onOpenServicePage=setFullscreenService`(전체화면) 사용.
  모바일은 좁아서 인패널 의미가 약함 → **모바일은 전체화면 유지**(데스크톱만 인패널). 필요 시 후속.

### 8.5 결정 필요

1. **닫기/복귀 방식:** 상단 "← 채널로" 버튼 / Esc / 둘 다. (권장: 버튼 + Esc)
2. **다른 서비스도 인패널화 여부:** Welcome만 / 전체(칸반·EasyCode 포함). (권장: Welcome만)
3. **모바일 동작:** 전체화면 유지 / 모바일도 인패널. (권장: 전체화면 유지)

---

## 9. [신규 요구] "오늘의 일정" **전체 보기 → 캘린더 페이지 이동**

> 요구: "Welcome 보드의 '오늘의 일정'에서 '전체 보기' 버튼을 누르면 캘린더 페이지로 이동한다."

### 9.1 현재 구조 검토 결과 (실제 코드 확인)

- 앱이 실제로 import하는 템플릿은 [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html)이다
  ([formTemplates.js](../src/templates/formTemplates.js) `WELCOME_BOARD_TEMPLATE.content`). *(blue/white 테마는 팔레트만 다르고 마크업 동일.)*
- "오늘의 일정" 카드의 버튼은 `<button class="view-all">전체 보기</button>` 이며,
  **세 카드(일정/메일/사항들)가 모두 같은 `.view-all` 클래스**를 쓴다 → 일정 카드 버튼만 구분할 **식별자(hook)** 가 필요하다.
- Welcome 보드는 [App.jsx:79](../src/App.jsx#L79) `PanelServicePage`의 **`<iframe srcDoc={service.content}>`** 안에서 렌더된다.
  따라서 버튼 클릭은 **iframe 내부 이벤트**이고, 캘린더 전환 state(`setShowCalendar`)는 **부모(App)** 에 있다
  → iframe → 부모 통신(`postMessage`)이 필요하다.
- 캘린더 전환은 부모에서 `setShowCalendar(true)` + 상호배타 리셋으로 이뤄진다
  (예: [App.jsx:420](../src/App.jsx#L420) `onToggleCalendar`, [App.jsx:397](../src/App.jsx#L397)). 가운데 컬럼 조건부 체인에서
  `showCalendar`가 참이면 `<CalendarView>` 가 뜬다([App.jsx:448](../src/App.jsx#L448)).

**결론:** iframe 안 버튼 → `window.parent.postMessage`로 신호 → 부모의 message 리스너가
`setShowCalendar(true)` + `setWelcomeService(null)`(보드 닫기) + 상호배타 리셋을 실행하면 캘린더 페이지로 이동한다.

### 9.2 구현 방안 (권장: iframe → 부모 postMessage 라우팅)

1. **템플릿 버튼에 신호 전송** — [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html):
   - "오늘의 일정" 카드의 `전체 보기` 버튼만 식별되도록 `onclick` 부여:
     ```html
     <button class="view-all"
       onclick="parent.postMessage({ type: 'welcome-board:navigate', target: 'calendar' }, '*')">
       전체 보기
     </button>
     ```
   - (다른 두 카드의 `전체 보기`는 후속에서 각각 `target: 'mail'` 등으로 확장 가능.)

2. **부모 message 리스너 + 라우팅** — [src/App.jsx](../src/App.jsx):
   `PanelServicePage`(또는 `MainLayout`)에 `message` 리스너를 추가한다.
   - `event.source === iframe.contentWindow` 로 **발신 iframe을 검증**하고, `event.data.type === 'welcome-board:navigate'` 인
     메시지만 처리한다. *(srcDoc iframe은 `event.origin`이 `"null"`로 올 수 있어 origin 단독 검증 대신 source/타입 검증을 쓴다.)*
   - `target === 'calendar'` 이면 부모의 콜백(예: `onNavigate('calendar')`)을 호출 →
     App에서 `setShowCalendar(true); setWelcomeService(null); setShowDM(false); setShowMail(false); setActiveDMConv(null)` 실행.
   - 리스너는 mount 시 등록, unmount 시 해제.

     ```jsx
     // PanelServicePage
     const iframeRef = useRef(null)
     useEffect(() => {
       const onMessage = (e) => {
         if (e.source !== iframeRef.current?.contentWindow) return
         if (e.data?.type !== 'welcome-board:navigate') return
         onNavigate?.(e.data.target)   // 'calendar'
       }
       window.addEventListener('message', onMessage)
       return () => window.removeEventListener('message', onMessage)
     }, [onNavigate])
     // <iframe ref={iframeRef} ... />
     ```
     ```jsx
     // 사용처: <PanelServicePage service={welcomeService}
     //   onClose={() => setWelcomeService(null)}
     //   onNavigate={(target) => {
     //     if (target === 'calendar') {
     //       setShowCalendar(true); setWelcomeService(null)
     //       setShowDM(false); setShowMail(false); setActiveDMConv(null)
     //     }
     //   }} />
     ```

3. **상호배타/복귀:** 캘린더로 이동하면 보드는 닫히므로(`setWelcomeService(null)`),
   캘린더에서 "← 채널로/닫기"를 누르면 기존대로 `ChatArea`로 복귀한다(보드로 자동 복귀는 하지 않음 — 8절 상호배타 원칙과 동일).

### 9.3 파일별 변경 요약 (신규 요구)

| 파일 | 변경 | 상태 |
|---|---|---|
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) | "오늘의 일정" 카드 `전체 보기` 버튼에 `onclick`→`parent.postMessage('welcome-board:navigate', calendar)` 추가 | 완료 |
| [src/App.jsx](../src/App.jsx) | `PanelServicePage`에 iframe `ref` + `message` 리스너(source/type 검증) · `onNavigate` prop · 사용처에서 `target==='calendar'` 시 `setShowCalendar(true)`+`setWelcomeService(null)`+상호배타 리셋 | 완료 |

### 9.4 대안 및 트레이드오프

- **(대안1) `srcDoc` 대신 직접 `parent.location`/직접 함수 호출:** srcDoc은 부모와 동일 오리진이라 기술적으로 가능하나
  iframe↔부모 결합도가 높아지고 오리진 검증 경계가 흐려진다 → **postMessage 방식 권장.**
- **(대안2) 버튼을 iframe 밖(부모 오버레이)으로 빼기:** 레이아웃/스크롤 정합이 깨져 부적합.
- **확장성:** `type: 'welcome-board:navigate'` + `target` 스킴을 두면 "중요 메일 전체 보기 → 메일 페이지",
  "중요 사항 전체 보기 → …" 등도 **동일 채널로 확장** 가능(9.2-1의 target만 추가).

### 9.5 결정 필요

1. **다른 카드 `전체 보기`도 이번에 연결할지:** 일정만 / 메일·사항 포함. (권장: 이번엔 일정만, 나머지는 스킴만 열어둠)
2. **캘린더 이동 시 특정 날짜 포커스 여부:** 단순 캘린더 오픈 / 오늘 날짜 포커스(`calendarFocusEvent` 유사). (권장: 우선 단순 오픈)

---

## 10. [신규 요구] "중요 메일" **전체 보기 → 메일 "중요 편지함"으로 이동**

> 요구: "Welcome 보드의 '중요 메일'에서 '전체 보기'를 누르면 메일의 '중요 편지함'으로 이동한다."

### 10.1 현재 구조 검토 결과 (실제 코드 확인)

- 9절에서 만든 **`welcome-board:navigate` postMessage 스킴을 그대로 재사용**한다(`target` 값만 추가).
- 메일 페이지는 [App.jsx](../src/App.jsx)에서 `showMail` 이 참일 때 `<MailPage>` 로 렌더된다.
- "중요 편지함"은 **`starred` 통합(unified) 폴더**이다([MailPage.jsx](../src/features/mail/MailPage.jsx) `UNIFIED_SYSTEM_FOLDERS` 의 `{ key: 'starred', icon: 'star' }`).
  선택 상태는 `activeKey === 'unified:starred'` (`UNIFIED_KEY_PREFIX + 'starred'`)로 표현된다.
- MailPage는 기존에 특정 **메일 메시지** 진입용 `initialMailLink` prop만 있었고(폴더 진입용 prop은 없음),
  기본 `activeKey` 는 `unified:all` 로 시작한다 → **초기 폴더 지정 수단이 필요**하다.

### 10.2 구현 방안 (9절 스킴 + MailPage `initialFolder` prop)

1. **템플릿 버튼 신호** — [WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) / [WelcomeBoard_blueThema.html](../template/WelcomeBoard_blueThema.html):
   "중요 메일" 카드 `전체 보기` 버튼에
   `onclick="parent.postMessage({ type: 'welcome-board:navigate', target: 'mail-important' }, '*')"` 부여.

2. **MailPage 초기 폴더 prop 신설** — [src/features/mail/MailPage.jsx](../src/features/mail/MailPage.jsx):
   `initialFolder = null` prop 추가. `{ key, openedAt }` 형태를 받아 `key`(예: `unified:starred`)로 `updateActiveKey` 한다.
   `initialMailLink` 와 동일하게 **signature(`key:openedAt`) dedup** 으로 1회만 적용(`handledInitialFolderRef`).

3. **App 라우팅** — [src/App.jsx](../src/App.jsx):
   - `mailInitialFolder` state 추가, `<MailPage initialFolder={mailInitialFolder} />` 로 전달.
   - `PanelServicePage.onNavigate` 에 `target === 'mail-important'` 분기:
     `setShowMail(true); setMailDeepLink(null); setMailInitialFolder({ key: 'unified:starred', openedAt: Date.now() }); setWelcomeService(null)` + 상호배타 리셋.
   - 사이드바에서 메일을 **일반 진입**할 때는 `setMailInitialFolder(null)` 로 리셋(중요 편지함 강제 방지).

### 10.3 파일별 변경 요약 (신규 요구)

| 파일 | 변경 | 상태 |
|---|---|---|
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [template/WelcomeBoard_blueThema.html](../template/WelcomeBoard_blueThema.html) | "중요 메일" 카드 `전체 보기` 버튼에 `onclick`→`postMessage(target:'mail-important')` 추가(양 테마) | 완료 |
| [src/features/mail/MailPage.jsx](../src/features/mail/MailPage.jsx) | `initialFolder` prop + `handledInitialFolderRef` dedup + `updateActiveKey(key)` 진입 effect | 완료 |
| [src/App.jsx](../src/App.jsx) | `mailInitialFolder` state · `MailPage`에 전달 · `onNavigate` `mail-important` 분기(`unified:starred`) · 일반 메일 진입 시 리셋 | 완료 |

### 10.4 확장성

- `target` 스킴이 `calendar` / `mail-important` 로 확장됨. 이후 "중요 사항 전체 보기" 등도
  같은 방식으로 `target` 만 추가하면 된다(리스너/구조 변경 불필요).
- `initialFolder.key` 에 다른 통합/계정 폴더 키(`unified:inbox`, `<accountId>:<folderId>` 등)를 넘기면
  다른 폴더로도 재사용 가능.

---

## 11. [신규 요구] `--showWelcomeBoard` 시 **Welcome 보드를 기본 랜딩 화면으로 자동 오픈**

> 요구: `--showWelcomeBoard` 로 실행한 경우 다음 시점에 Welcome 페이지로 이동한다.
> ① 최초 로그인할 때 ② 화면을 Refresh 할 때 ③ 다시 메인 페이지로 진입할 때.
> (7절 "향후 확장"의 "로그인 직후 기본 첫 화면" 항목을 구현으로 승격.)

### 11.1 현재 구조 검토 결과 (실제 코드 확인)

- 노출 플래그는 빌드타임 Vite env `VITE_SHOW_WELCOME_BOARD`(`--showWelcomeBoard` → 3.3절 스크립트가 전달)이며,
  기존엔 [Sidebar.jsx](../src/components/Sidebar.jsx) 에서만 읽어 버튼 노출에 사용했다.
- 인패널 Welcome 보드는 [App.jsx](../src/App.jsx) 의 `welcomeService` state로 열린다(8절). 기본값 `null`(닫힘).
- [App.jsx](../src/App.jsx) 에는 이미 **`currentUser?.id` 변경 감지 effect**가 있어 로그인/새로고침/재로그인 시
  뷰 state(캘린더/메일/DM/검색 등)를 리셋한다(`lastUserIdRef` 로 1회 처리). → **자동 오픈의 정확한 훅 지점.**
  - 로그인: `id` `null`→값
  - 새로고침: 마운트 후 `currentUser` 비동기 로드로 `id` `null`→값
  - 재로그인: `id` 값 변경
  - ⇒ 세 시나리오 모두 이 effect 1곳에서 커버된다.

> **"메인 페이지 재진입" 해석:** 로그인/새로고침 등 **세션 진입(마운트) 시점**으로 해석했다.
> 이미 로그인된 상태에서 메일/캘린더 → 채널로 단순 복귀할 때마다 매번 보드를 강제로 다시 띄우면
> 정상 사용을 방해하므로 그 경우는 제외한다(사용자가 채널 클릭 시 보드 닫힘, 8절 상호배타).

### 11.2 구현 방안

1. **플래그/가드 헬퍼** — [src/App.jsx](../src/App.jsx):
   - 모듈 상수 `SHOW_WELCOME_BOARD = import.meta.env.VITE_SHOW_WELCOME_BOARD === '1'`.
   - `hasDeepLinkParams()`: URL에 `channelId|postId|mailMessageId|mailTenantId` 가 있으면 `true`.
     **딥링크로 진입한 경우 해당 대상(포스트/메일)이 우선**하므로 자동 오픈을 건너뛴다.

2. **자동 오픈** — `currentUser?.id` 변경 effect 말미에:
   ```js
   if (SHOW_WELCOME_BOARD && !hasDeepLinkParams()) setWelcomeService(WELCOME_BOARD_TEMPLATE)
   else setWelcomeService(null)
   ```
   - 렌더 우선순위상 메일(`showMail`)이 보드보다 먼저이고, 채널/포스트 딥링크는 가드로 제외되므로
     기존 딥링크 동작과 충돌하지 않는다.

### 11.3 파일별 변경 요약 (신규 요구)

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/App.jsx](../src/App.jsx) | `WELCOME_BOARD_TEMPLATE` import · 모듈 상수 `SHOW_WELCOME_BOARD` · `hasDeepLinkParams()` 헬퍼 · `currentUser.id` 변경 effect에서 플래그+딥링크 가드로 `setWelcomeService(WELCOME_BOARD_TEMPLATE)` 자동 오픈(+`mailInitialFolder` 리셋 추가) | 완료 |

### 11.4 대안 및 결정

- **(대안) "메인 재진입"을 매 채널 복귀로 해석:** 매번 보드가 떠 사용성 저해 → 채택하지 않음(11.1 해석 주 참고).
- **딥링크 우선순위:** URL 딥링크가 있으면 자동 오픈 생략(가드). 이견 시 우선순위 재조정 가능.
- **닫기 후 재오픈:** 자동 오픈은 세션 진입 시점 1회. 사용자가 "← 채널로"로 닫으면 같은 세션에선 다시 뜨지 않는다.

---

## 12. [신규 요구] "중요 메일" 카드에 **실제 중요 편지함 메일 목록 주입** (3.4-(B) 부분 구현)

> 요구: 메일 "중요 편지함"의 메일 목록을 Welcome 보드 "중요 메일" 카드 **크기에 맞추어** 표시한다.
> (현재 카드는 데모 하드코딩 데이터 → 로그인 사용자 실제 별표 메일로 교체.)

### 12.1 현재 구조 검토 결과 (실제 코드 확인)

- 보드는 `<iframe srcDoc>`(정적 HTML)로 렌더되므로, 부모(React)가 데이터를 **`postMessage` 로 주입**하고
  iframe 내부 스크립트가 카드 DOM을 다시 그리는 방식이 적합하다(9절 스킴의 반대 방향: 부모→iframe).
- "중요 편지함" = `starred` 통합 폴더. 목록 조회는
  `GET /mail/messages?tenantId=<t>&scope=unified&unifiedKey=starred&folderType=&folderName=&limit=<n>&offset=0`
  ([MailPage.jsx](../src/features/mail/MailPage.jsx) `buildActiveRequest` `kind:'unified'` 분기, 서버 [repository.js](../server/mail/repository.js) `cleanKey==='starred' → mm.is_starred = true`).
- `tenantId` 는 `GET /mail/accounts` 응답에서 `account.tenant_id` 로 얻는다([MailPage.jsx](../src/features/mail/MailPage.jsx) `currentTenantId`).
- 메시지 행 필드: `id, from_name, from_email, subject, snippet, received_at, is_read, is_starred`
  ([repository.js](../server/mail/repository.js) SELECT, [MailMessageList.jsx](../src/features/mail/MailMessageList.jsx) 표시부: `from_name||from_email`, `received_at`, `subject`, `snippet`).
- "크기에 맞추어서": 카드 높이는 약 **3행** 기준으로 유지하되(`max-height` + `overflow-y:auto`),
  별표 메일은 여러 건(`limit=30`)을 주입하고 초과분은 카드 내부 스크롤로 본다(12.5-1 결정).

### 12.2 구현 방안 (부모 fetch → iframe postMessage 주입)

1. **부모 데이터 로드** — [src/App.jsx](../src/App.jsx):
   - state `welcomeBoardData`(`null | { importantMail: [...] }`).
   - `welcomeService?.id === 'welcome-board'` 일 때 effect에서:
     `apiFetch('/mail/accounts')` → `tenantId` → `apiFetch('/mail/messages?…unifiedKey=starred&limit=3')`.
     행을 `{ name, subject, snippet, received_at }` 로 최소 매핑 후 `setWelcomeBoardData`. (cancel 플래그로 경쟁 방지)
   - 보드가 닫히면(`welcomeService` null) `welcomeBoardData` 도 `null`.

2. **부모→iframe 주입** — [src/App.jsx](../src/App.jsx) `PanelServicePage`:
   - `injectType`(예: `'welcome-board:data'`) · `injectData` prop 추가.
   - iframe `onLoad` 로 `iframeReady` 표시, `iframeReady && injectData` 이면
     `iframeRef.current.contentWindow.postMessage({ type: injectType, payload: injectData }, '*')` 전송.
     (데이터가 나중에 도착해도 `injectData` 변경 시 재전송.)

3. **iframe 내부 렌더** — [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html):
   - "중요 메일" 카드의 3개 `.mail-item` 을 `<div id="importantMailList">…</div>` 로 감싼다(데모는 로드 전 폴백).
   - `<script>` 에 `message` 리스너 추가: `type === 'welcome-board:data'` 이면 `payload.importantMail` 로
     `#importantMailList` 를 다시 그린다.
     - **XSS 방지:** 제목/미리보기/발신자는 신뢰 불가 → `createElement`+`textContent` 로만 구성(`innerHTML` 금지).
     - 아바타: 발신자명 이니셜(최대 2자) + 기존 `av-1/av-2/av-3` 순환 색.
     - 시간: `received_at` → **메일 목록과 동일하게 `toLocaleDateString()`** 표기(예: `2026. 7. 3.`).
     - 빈 배열이면 "중요 메일이 없습니다" 플레이스홀더.
   - **메일 목록처럼 "짧게" 표시(12.6):** 이름/제목을 **한 줄 말줄임(truncate)** 처리해 항목 높이를 목록 행처럼 컴팩트하게 유지한다.
     CSS 스코프 `.mail-item .mail-name`(flex+truncate) · `.mail-item .mail-time`(flex-shrink:0) · `.mail-subject`(nowrap+ellipsis).
     미리보기(`.mail-preview`)는 기존에 이미 한 줄 말줄임.

### 12.3 파일별 변경 요약 (신규 요구)

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/App.jsx](../src/App.jsx) | `apiFetch` import · `welcomeBoardData` state · 보드 오픈(`welcomeService.id==='welcome-board'`) 시 accounts→tenant→starred(limit3) fetch(cancel 가드) · `PanelServicePage` 에 `injectType`/`injectData` 전달 | 완료 |
| [src/App.jsx](../src/App.jsx) `PanelServicePage` | `iframeReady`(onLoad) + `injectType`/`injectData` prop · `injectData` 변경 시 iframe으로 `postMessage` 주입 · `service.id` 변경 시 로드상태 리셋 | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | 중요 메일 리스트 `#importantMailList` 컨테이너화(+스크롤) + `message`(`welcome-board:data`) 수신 스크립트(`createElement`+`textContent` 안전 렌더, 이니셜, `toLocaleDateString`, 빈 목록 플레이스홀더) + **메일 목록처럼 이름/제목 한 줄 말줄임 CSS**(`.mail-item .mail-name`/`.mail-time`, `.mail-subject`) | 완료 |

### 12.4 대안 및 트레이드오프

- **(대안1) `service.content` HTML 문자열을 부모에서 치환 후 srcDoc 주입:** 매 데이터 변경마다 iframe 리로드 →
  깜빡임·스크롤 리셋. postMessage 주입이 부드러움 → **채택.**
- **(대안2) 카드를 iframe 밖 React 컴포넌트로 이전:** 개인화 확장엔 유리하나 보드 전체 구조 변경(회귀 큼).
  이번엔 "중요 메일 1개 카드"만 대상이므로 postMessage 주입으로 최소 변경.
- **확장:** 같은 채널로 "오늘의 일정"(캘린더 이벤트) 등 다른 카드도 `payload` 확장해 개인화 가능(3.4-(B) 전면화의 발판).

### 12.5 결정 (확정)

1. **표시 건수:** **스크롤 허용**으로 결정. fetch `limit=30`, 렌더는 전체 표시하되
   `#importantMailList` 에 `max-height:230px; overflow-y:auto` 적용해 카드 크기(약 3행)는 유지하고 나머지는 스크롤. (렌더 시 `slice(0,3)` 제거)
2. **항목 클릭 시:** **무동작**으로 결정(현행 유지). 후속으로 해당 메일 딥링크(10절 `mail-important` 연계) 확장 여지.

### 12.6 그리드 무너짐 방지 + 컴팩트 렌더 (버그 수정)

- **증상:** 실제 별표 메일(제목/미리보기가 김)을 주입하니 "중요 메일" 카드 열만 과도하게 넓어지고
  좌/우 카드(오늘의 일정·중요 사항)가 한 글자씩 줄바꿈될 만큼 좁아짐.
- **원인:** `.grid-top` 이 `grid-template-columns:repeat(3,1fr)` 였는데, `1fr = minmax(auto,1fr)` 라
  긴 텍스트의 **min-content** 가 트랙 최소폭을 밀어올려 3등분이 깨졌다(그리드 아이템 기본 `min-width:auto`).
- **수정:**
  - `.grid-top` → `grid-template-columns:repeat(3,minmax(0,1fr))` (트랙 최소폭 0 → 3열 균등 고정).
  - `.card` 에 `min-width:0` 추가(그리드 아이템이 콘텐츠 min-content로 팽창하지 않도록).
  - 효과: 열 폭이 1/3로 고정되며, 12.2/12.6의 이름·제목 한 줄 말줄임(truncate)과 `#importantMailList` 세로 스크롤이 정상 작동해
    항목이 **메일 목록처럼 작고 균일**하게 표시된다.
- 적용: [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) 양 테마.

---

## 13. [신규 요구] "중요 메일" 카드는 **안 읽은 중요(별표) 메일만** 표시

> 요구: "중요 메일에서 보이는 것은 중요 편지함에서 **안 읽은 중요 메일만** 보여준다."
> (12절에서 별표 메일 전체를 주입하던 것 → **미열람(`is_read=false`) 별표 메일**로 좁힌다.)

### 13.1 현재 구조 검토 결과 (실제 코드 확인)

- 12절 구현으로 [src/App.jsx](../src/App.jsx) 의 `welcomeService.id==='welcome-board'` effect가
  `GET /mail/messages?scope=unified&unifiedKey=starred&limit=30` 으로 **별표 메일 전체**(읽음+안읽음)를 가져와
  `{ name, subject, snippet, received_at }` 로 매핑해 iframe에 주입했다.
- 응답 행에는 `is_read` 필드가 이미 포함된다([repository.js](../server/mail/repository.js) `listUnifiedMessages` SELECT `mm.is_read`).
  → **서버/메일 DB 계층을 건드리지 않고**, 부모(App)에서 `is_read=false` 로 거르면 요구를 충족한다.
- "중요 편지함(`unified:starred`)" 자체는 그대로 읽음/안읽음을 모두 보여준다(전체 보기 이동 대상 불변).
  이번 변경은 **Welcome 보드 "중요 메일" 카드 표시**에만 국한된다(메일 서비스 5원칙 불침범).

### 13.2 구현 방안 (부모에서 미열람 필터)

1. **미열람 필터** — [src/App.jsx](../src/App.jsx) `welcomeBoardData` 로드 effect:
   - starred 응답 rows 를 `.filter(m => !m.is_read)` 후 매핑한다(기존 `.map(...)` 앞에 삽입).
   - 정렬은 서버가 `received_at DESC` 로 반환하므로 최신 미열람 별표 메일이 위로 온다.
2. **빈 목록 문구** — [WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html):
   - `wbRenderImportantMail` 빈 배열 플레이스홀더를 `중요 메일이 없습니다.` → `안 읽은 중요 메일이 없습니다.` 로 교체
     (모두 읽은 경우에도 카드가 비어 보이는 이유를 명확히).

### 13.3 파일별 변경 요약 (신규 요구)

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/App.jsx](../src/App.jsx) | `welcomeBoardData` 로드 시 starred 응답을 `is_read=false` 로 필터한 뒤 매핑(안 읽은 별표 메일만 주입) | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | 빈 목록 플레이스홀더 문구 `안 읽은 중요 메일이 없습니다.` 로 교체 | 완료 |

### 13.4 대안 및 트레이드오프

- **(대안) 서버 쿼리에 `unreadOnly` 파라미터 추가:** `listUnifiedMessages` + 라우트에 미열람 필터를 넣으면
  `limit` 소진 위험이 없어 더 견고하나, 메일 DB 계층/라우트를 손대는 변경이라 회귀 범위가 커진다
  (Welcome 보드 카드 1개 표시 목적엔 과함). → **부모 클라이언트 필터 채택.**
- **`limit=30` 절단 주의:** 별표 메일이 30건을 넘고 상위 30건이 모두 읽음이면 그 아래 미열람 별표가 누락될 수 있다.
  별표는 보통 소수의 큐레이션 집합이라 실무상 영향 미미. 문제가 되면 위 (대안)의 서버 필터로 승격한다.

---

## 14. [신규 요구] "오늘의 일정" 카드에 **실제 오늘 캘린더 이벤트 주입** (3.4-(B) 부분 구현)

> 요구: "오늘의 일정 카드는 캘린더에서 **오늘의 캘린더 이벤트**를 보여주는 것으로 한다."
> (현재 카드는 데모 하드코딩 일정 → 로그인 사용자의 실제 오늘 이벤트로 교체. 12절 "중요 메일" 주입과 동일 패턴.)

### 14.1 현재 구조 검토 결과 (실제 코드 확인)

- 캘린더 이벤트는 `GET /api/events`(=`apiFetch('/events')`)로 로드한다([events.js](../server/routes/events.js) `router.get('/')`, [CalendarView.jsx](../src/components/CalendarView.jsx) `apiFetch('/events')`).
- **반복 이벤트는 서버가 생성 시점에 개별 행(occurrence)으로 저장**한다([events.js](../server/routes/events.js) `generateOccurrences`) →
  클라이언트는 확장 없이 각 이벤트의 `startDt`(년/월/일)만 오늘과 비교하면 "오늘 발생" 판정이 된다.
  (CalendarView의 `eventOnDay` 도 동일하게 `startDt` 일치만 검사.)
- 이벤트 `toClient` 형태([events.js](../server/routes/events.js) 82행): `{ id, title, color, allDay, startDt, endDt, memo, ... }`.
  - `startDt` 는 dt 객체 `{ year, month, day, ampm:'오전'|'오후', hour(12h), minute }`.
    24시간제 변환은 서버 `dtToDate` 와 동일하게 `h = hour%12; if(ampm==='오후') h+=12`.
    (주의: CalendarView의 `dtTo24h` 는 `ampm==='PM'/'AM'` 을 검사하는 상이 구현이 있어 재사용하지 않고, 저장 포맷('오전/오후')에 맞춘 헬퍼를 App.jsx에 신설.)
  - **위치(location) 필드는 없음** → 데모의 `.sched-loc`("회의실 A" 등)에 대응하는 실데이터가 없으므로 위치 표기는 제거한다(오해 방지).
- 보드는 `<iframe srcDoc>` 정적 HTML → 12절과 동일하게 부모(App)가 `postMessage(welcome-board:data)` 로 주입하고
  iframe 스크립트가 카드 DOM을 다시 그린다.

### 14.2 구현 방안 (부모 fetch → iframe postMessage 주입, 12절 채널 재사용)

1. **부모 데이터 로드** — [src/App.jsx](../src/App.jsx) `welcomeBoardData` effect:
   - 기존 "중요 메일" 로드 effect를 확장해 **오늘의 일정과 병렬 로드**(`Promise.all`) 후 한 번에 `setWelcomeBoardData`.
   - `apiFetch('/events')` → `startDt` 가 **오늘(년/월/일 일치)** 인 이벤트만 필터.
   - 매핑 `{ time, title, color, allDay }`:
     - `time` = `allDay ? '종일' : 'HH:MM'`(신설 헬퍼 `welcomeEventHHMM`, 저장 포맷 '오전/오후' 기준 24시간제).
     - `color` = 이벤트 hex 색만 허용(`/^#[0-9a-f]{3,8}$/i`), 그 외 기본색 — **style 주입이므로 CSS 인젝션 방지**.
     - **정렬:** 종일 이벤트 먼저(`_min=-1`), 그다음 시작 시각 오름차순.
   - payload에 `todayLabel`(예: `7월 5일 토요일`)도 실어 날짜 헤더를 실제 오늘로 갱신.
2. **부모→iframe 주입** — `PanelServicePage` 는 12절에서 만든 `injectType='welcome-board:data'` / `injectData` 를 그대로 사용(구조 변경 없음, payload에 `todaySchedule`/`todayLabel` 만 추가).
3. **iframe 내부 렌더** — [white](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html):
   - "오늘의 일정" 카드의 데모 항목을 `<div id="todayScheduleList">`(로드 전 "일정을 불러오는 중…" 폴백)로 교체, 날짜 라벨에 `id="todayDateLabel"` 부여.
   - `message` 리스너에서 `payload.todaySchedule` 로 `wbRenderTodaySchedule(list, label)` 호출.
     - **XSS 방지:** 시간/제목은 `createElement`+`textContent` 로만 구성(`innerHTML` 금지). 색상만 검증된 hex를 `style.background` 로.
     - 빈 배열이면 "오늘 일정이 없습니다." 플레이스홀더.
   - **컴팩트 렌더:** `.sched-title` 한 줄 말줄임(`min-width:0`+ellipsis), `.sched-time`/`.sched-item` `min-width:0`·`flex-shrink:0` 로 긴 제목에도 그리드가 안 무너지게(12.6과 동일 원칙).

### 14.3 파일별 변경 요약 (신규 요구)

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/App.jsx](../src/App.jsx) | 모듈 헬퍼 `welcomeEventStartMinutes`/`welcomeEventHHMM`·`WELCOME_WEEKDAYS` · `welcomeBoardData` effect를 오늘의 일정+중요 메일 **병렬 로드**로 확장(`/events` 오늘 필터·정렬·매핑, `todayLabel` 포함) | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | "오늘의 일정" 카드 `#todayScheduleList` 컨테이너화 + 날짜 라벨 `#todayDateLabel` · `wbRenderTodaySchedule`(안전 렌더/빈 상태) · `message` 핸들러에서 `todaySchedule`/`todayLabel` 수신 · `.sched-title` 말줄임 CSS · 위치(`.sched-loc`) 표기 제거 | 완료 |

### 14.4 대안 및 트레이드오프

- **(대안) "오늘 걸쳐 있는" 이벤트(어제 시작~오늘 종료 등)도 포함:** `startDt~endDt` 범위 교차로 판정하면 더 정확하나,
  캘린더 자체가 `eventOnDay`(startDt 일치)로 동작하므로 **일관성**을 위해 시작일 기준으로 맞춤. 필요 시 후속 확장.
- **위치/장소:** 이벤트 스키마에 location이 없어 표기 생략. 추후 필드 추가 시 payload에 실어 우측 표기 복원 가능.
- **확장:** 12절(중요 메일)과 동일한 `welcome-board:data` 단일 채널로 주입 → 이후 "중요 사항들" 카드도 payload만 추가하면 개인화 가능(3.4-(B) 전면화의 발판).

---

## 15. [신규 요구] "최근에 본 문서" 탭에 **실제 최근 열람 게시글 주입**

> 요구: "최근에 본 문서" 탭을 누르면 **최근에 본 게시글을 시간 역순(가장 최근이 위)** 으로 보여준다.
> 각 항목은 **게시판의 글과 파일**, **등록일 / 업데이트일 / 작성자(또는 업데이트한 사람)** 를 표시한다.

### 15.1 현재 구조 검토 결과 (실제 코드 확인)

- 게시글 조회 시점은 [PostDetailPane.jsx](../src/components/chat/PostDetailPane.jsx) 의
  `incrementViews(channelId, post.id)` effect(뷰 카운트 증가)와 같은 위치에서 잡을 수 있다.
  → 이 지점이 "열람" 훅이다. 열람 순간에 **표시용 메타 스냅샷을 서버 DB에 upsert**하면,
  Welcome 보드 오픈 시 원본 게시글/첨부를 다시 순회하지 않고 최근 본 목록만 즉시 조회할 수 있다.
- 기존 구현은 localStorage(`welcome-recent-posts-v1:<userId>`)에 사용자별 스냅샷을 저장했다.
  이 방식은 빠르지만 브라우저/기기 간 동기화가 안 되고, 사용자 요청 기준의 "별도 DB 선등록" 요구를 충족하지 않는다.
  → localStorage는 **서버 저장 실패 시 보조 캐시/fallback** 으로만 유지한다.
- **게시글 직렬화에 `updatedAt` 부재:** [posts.js](../server/routes/posts.js) `GET /` 응답이 `createdAt` 만 주고 `updatedAt` 을 누락했다(DB엔 `updated_at` 존재).
  → 요구의 "업데이트일" 을 위해 **양 경로(Cassandra/PG) 직렬화에 `updatedAt: row.updated_at || row.created_at` 추가**(순수 가산, 저위험).
- **게시글엔 별도 title이 없다**(일반 글은 `content` 만; PG엔 title 컬럼 존재). 표시 제목은
  [ChatArea.jsx](../src/components/ChatArea.jsx) 문서 목록과 동일 규칙으로 파생:
  템플릿→`{label} 양식`, MD→`getMdPageTitle`, EasySheet→`getEasySheetTitle`, 일반→본문 첫 줄.
  ([formTemplates.js](../src/templates/formTemplates.js) `isTemplateContent/isMdPage/isEasySheet/getMdPageTitle/getEasySheetTitle/FORM_TEMPLATES` 재사용.)
- **"글과 파일":** 각 게시글의 첨부(`post.attachments[].name`)를 항목에 함께 표기한다.
- **작성자/업데이트한 사람:** 게시글은 별도 updater를 저장하지 않고 편집은 작성자 권한이므로 **작성자(`author.name`)** 로 표기(요구의 "또는" 충족).
- 보드는 `<iframe srcDoc>` → 12·14절과 동일하게 부모가 `welcome-board:data` payload로 주입, iframe이 `#panel-docs` 를 다시 그린다.

**결론:** 열람 순간에 **표시 메타 스냅샷을 `recent_post_views` DB 테이블에 upsert**한다.
Welcome 보드 오픈 시에는 `GET /recent-post-views?limit=20` 한 번만 호출해 최신순 목록을 바로 주입한다.
스냅샷은 "그때 본 정보"라 "최근에 본" 의미에 부합하며, 이후 원문이 바뀌어도 클릭 시 실제 게시글 최신본으로 이동한다.

### 15.2 구현 방안

1. **게시글 응답에 `updatedAt` 추가** — [server/routes/posts.js](../server/routes/posts.js) `GET /` (Cassandra·PG 두 직렬화 블록):
   `updatedAt: row.updated_at || row.created_at`.
2. **DB 스냅샷 테이블** — [server/schema.sql](../server/schema.sql) · [server/db.js](../server/db.js):
   - `recent_post_views` 테이블을 생성한다.
   - 기본키는 `(user_id, post_id)` 로 둔다. 같은 글을 다시 열면 `viewed_at` 과 표시 스냅샷을 갱신해 최신순 맨 위로 올린다.
   - 스냅샷 필드:
     `{ user_id, post_id, channel_id, team_id, kind, icon, title, tag, summary, created_at, updated_at, author_id, author_name, author_image_url, comment_count, attachments, viewed_at }`.
     단, **최근에 본 문서 화면에서는 본문 요약을 기본 표시하지 않으므로 `summary` 는 빈 문자열로 저장/반환**한다.
     예외적으로 제목이 `(제목 없음)` 인 항목은 화면 식별성을 위해 본문 평문 첫 줄을 `summary` 로 저장/반환한다.
   - 인덱스: `(user_id, viewed_at DESC)` 로 Welcome 보드 조회를 빠르게 한다.
3. **최근 본 문서 API** — [server/routes/recentPostViews.js](../server/routes/recentPostViews.js):
   - `POST /api/recent-post-views`: 열람 스냅샷을 upsert한다. 기록 전 `canAccessChannel` 로 현재 사용자의 채널 접근권한을 확인한다.
   - `GET /api/recent-post-views?limit=20`: 현재 사용자 최근 본 문서를 `viewed_at DESC` 로 반환한다.
     조회 시에도 `canAccessChannel` 로 권한이 사라진 채널의 항목을 숨긴다.
4. **추적 유틸** — [src/lib/recentPosts.js](../src/lib/recentPosts.js):
   - `makeWelcomePostSnapshot({ post, channel, team, viewedAt })`: 제목/첨부/작성자/작성자 프로필 이미지/댓글 수 스냅샷을 만든다.
     최근에 본 문서에는 본문을 기본 노출하지 않기 위해 `summary:''` 로 두되, 제목 후보가 없으면 본문 평문 첫 줄을 표시용 제목으로 승격한다.
   - `recordRecentPostView(...)`: 기존 localStorage 캐시를 갱신하고, 서버 POST에 넘길 스냅샷 객체를 반환한다.
     localStorage는 서버 기록 실패나 오프라인 상황의 fallback 용도로 유지한다.
5. **열람 시 서버 기록** — [src/components/chat/PostDetailPane.jsx](../src/components/chat/PostDetailPane.jsx):
   기존 뷰 effect 옆에 `recordedRecentRef` 가드로 **게시글 오픈당 1회** `recordRecentPostView(...)` 호출 후
   `POST /api/recent-post-views` 로 서버 DB에 upsert한다.
6. **부모 주입** — [src/App.jsx](../src/App.jsx) `welcomeBoardData` effect:
   `GET /recent-post-views?limit=20` 을 호출해 payload(`welcome-board:data`)의 `recentPosts` 로 주입한다.
   서버 조회 실패 시에만 `getRecentPosts(currentUser?.id)` localStorage 캐시로 폴백한다.
5. **iframe 렌더** — [white](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html):
   `#panel-docs` 데모 행 → `#recentDocsList` 컨테이너(로드 전 "…불러오는 중" 폴백)로 교체.
   `wbRenderRecentDocs(list)` 가 `.doc-row-lg`(작성자 아바타·제목·태그·상대시각·첨부·`등록일/업데이트일/작성자` 메타·**댓글 수 `💬 N`**)를 다시 그린다.
   - **본문 기본 미표시:** `recentPosts` 는 저장/조회/렌더 단계에서 제목이 있는 항목의 `summary` 를 비워 제목과 첨부, 메타만 보여준다.
     제목이 `(제목 없음)` 인 항목만 예외로 본문 평문 첫 줄을 한 줄 요약으로 보여준다.
   - **왼쪽 작성자 표시:** `authorImageUrl` 이 있으면 프로필 이미지로 표시하고, 없거나 이미지 로딩에 실패하면 `authorName` 의 첫 글자 이니셜을 표시한다.
   - **프로필 이미지 보정:** 스냅샷의 `author_image_url` 이 비어 있어도 `author_id` 로 `users.image_url` 을 조회해 응답에 채우고, 가능하면 `recent_post_views.author_image_url` 도 갱신한다.
     이 분기는 `wbRenderRecentDocs` 에서만 `leadAuthor:true` 로 켜며, "최근에 업데이트 된 글" 탭은 기존 문서 아이콘을 유지한다.
   - **XSS 방지:** 모든 텍스트 `createElement`+`textContent`(아이콘 이모지도 textContent). 빈 목록이면 "최근에 본 문서가 없습니다.".
   - **클릭 시 이동:** 행 클릭 → `postMessage({ type:'welcome-board:navigate', target:'post', channelId, postId })`.
6. **부모 라우팅** — [src/App.jsx](../src/App.jsx):
   `PanelServicePage` message 핸들러가 `onNavigate(target, data)` 로 **전체 데이터**를 넘기고,
   `onNavigate` 의 `target === 'post'` 분기가 상호배타 리셋 후 `navigateToPost(channelId, postId)`(기존 딥링크 로직 재사용) 호출.

### 15.3 파일별 변경 요약 (신규 요구)

| 파일 | 변경 | 상태 |
|---|---|---|
| [server/routes/posts.js](../server/routes/posts.js) | `GET /` 게시글 직렬화(Cassandra·PG)에 `updatedAt: row.updated_at \|\| row.created_at` 가산 | 완료 |
| [server/schema.sql](../server/schema.sql) · [server/db.js](../server/db.js) | `recent_post_views` 테이블과 `(user_id, viewed_at DESC)` 인덱스 추가, `author_id`/`author_image_url` 컬럼 추가/마이그레이션, 기존 row의 `author_id` 를 `posts.author_id` 로 backfill | 완료 |
| [server/routes/recentPostViews.js](../server/routes/recentPostViews.js) · [server/index.js](../server/index.js) | `GET/POST /api/recent-post-views` 라우트 추가, 조회/기록 시 채널 접근권한 검증, `authorId`/`authorImageUrl` 직렬화, `users.image_url` fallback 보정, `(제목 없음)` row의 본문 한 줄 보강 | 완료 |
| [src/lib/recentPosts.js](../src/lib/recentPosts.js) | `makeWelcomePostSnapshot` 공용 함수 + `recordRecentPostView` 가 서버 POST용 스냅샷 반환, 명시 제목/첨부명 없으면 본문 첫 줄을 표시용 제목으로 승격, `summary:''`, `authorId`/`authorImageUrl` 포함, localStorage fallback 유지 | 완료 |
| [src/components/chat/PostDetailPane.jsx](../src/components/chat/PostDetailPane.jsx) | 게시글 오픈당 1회 스냅샷 생성 후 `POST /recent-post-views` 로 DB upsert | 완료 |
| [src/App.jsx](../src/App.jsx) | `GET /recent-post-views?limit=20` 로 최근 본 문서 로드, 실패 시 localStorage fallback, payload에 `recentPosts` 주입 · `target==='post'` → `navigateToPost` 분기 | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | `#panel-docs` → `#recentDocsList` 컨테이너 · `wbRenderRecentDocs`(+`wbRelTime`/`wbFmtDate`/메타 헬퍼, 안전 렌더, 왼쪽 작성자 프로필/이니셜, 제목 있는 항목 본문 제거, `(제목 없음)` 항목 본문 한 줄 표시, 첨부 표기, **댓글 수 `💬 N`**, 클릭 이동) · `message` 핸들러에서 `recentPosts` 수신 | 완료 |

### 15.4 대안 및 트레이드오프

- **(기존안) localStorage 스냅샷:** 서버 변경 없이 빠르지만 브라우저/기기 간 동기화가 안 되고,
  사용자가 요청한 "문서를 볼 때마다 별도 DB에 등록" 구조가 아니다. → 서버 DB 스냅샷을 채택하고 localStorage는 fallback으로 격하.
- **스냅샷 신선도:** 열람 후 원문이 수정돼도 스냅샷은 그대로("그때 본" 정보). "최근에 본" 의미상 허용. 필요 시 클릭 진입 시점에 최신본으로 갱신 가능.
- **권한 변경:** 조회 시 `canAccessChannel` 로 필터링하므로, 사용자가 더 이상 접근할 수 없는 채널의 최근 본 기록은 화면에 표시하지 않는다.
- **첨부 없는 일반 글:** ChatArea 문서 목록은 일반 텍스트 글을 "문서"에서 제외하지만, 본 요구는 "최근에 본 **게시글**" 이므로 일반 글도 포함(제목=본문 첫 줄).
- **확장:** 하단 "최근에 업데이트 된 글" 탭은 15.7절에서 미열람 게시글 모음으로 구현했다.
  "최근에 수신한 메일" 탭도 동일 payload 채널로 확장 가능(후속).

### 15.5 [보정] 10개 표시 + 스크롤 · 최근 본 문서 본문 기본 미표시

> 요구: ① "최근에 본 문서"는 **10개까지만 보이고 그 이상은 스크롤**. ② **최근에 본 문서는 제목은 보여주되 본문은 기본적으로 보여주지 않는다**.
> 추가 보정: 제목이 `(제목 없음)` 으로 나올 경우에는 식별을 위해 본문 평문 첫 줄을 한 줄 보여준다.

- **① 10개 뷰포트 + 스크롤** — [white](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html):
  `wbRenderRecentDocs` 렌더 후 `#recentDocsList` 자식이 10개 초과면 **앞 10행의 실제 높이 합**(`offsetHeight`)을
  `max-height` 로 설정하고 `overflow-y:auto` 를 준다. 행 높이가 가변(요약·첨부 유무)이라 고정 px 대신 **실측 합**으로
  정확히 10행 뷰포트를 만든다. 10개 이하이면 스타일 해제(스크롤 없음). 스냅샷 저장 상한은 20건이라 최대 10건이 스크롤 대상.
- **② 최근 본 문서 본문 기본 미표시 + 무제목 예외** — [src/lib/recentPosts.js](../src/lib/recentPosts.js) · [server/routes/recentPostViews.js](../server/routes/recentPostViews.js) · [white](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html):
  `makeWelcomePostSnapshot` 은 제목이 있는 항목의 `summary` 를 빈 문자열로 만들고, 제목이 `(제목 없음)` 인 항목만 본문에서 마크다운/HTML을 걷어낸 평문 첫 줄을 `summary` 로 만든다.
  서버 `POST /api/recent-post-views` 도 같은 규칙으로 저장하고, `GET /api/recent-post-views` 는 기존에 저장된 무제목 row의 `summary` 가 비어 있으면 `posts.content` 를 조인해 본문 첫 줄을 보강한다.
  iframe의 `wbRenderRecentDocs` 는 제목이 있는 항목은 `summary:''` 로 덮어써 본문을 숨긴다. `(제목 없음)` 항목은 서버/스냅샷 단계에서 가능한 경우 첫 번째 의미 있는 본문 줄 또는 링크를 제목으로 승격한다.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/lib/recentPosts.js](../src/lib/recentPosts.js) | 최근 본 문서 스냅샷 제목 후보를 명시 제목 → 첨부 파일명 → 본문 첫 줄 → 링크 순으로 생성, `summary` 는 빈 문자열 유지 | 완료 |
| [server/routes/recentPostViews.js](../server/routes/recentPostViews.js) | 최근 본 문서 저장/조회 API에서 기존/신규 `(제목 없음)` 항목의 표시용 제목을 본문 첫 줄/summary로 보강 | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | `#recentDocsList` 10행 초과 시 앞 10행 실측 높이로 `max-height`+`overflow-y:auto`, `wbRenderRecentDocs` 에서 제목 있는 항목 요약 제거 | 완료 |

### 15.6 [보정] 최근 본 문서 왼쪽 작성자 표시

> 요구: 최근에 본 문서의 왼쪽 끝에는 문서 아이콘 대신 올린 사람 정보가 정확히 표현되어야 한다. 프로필 이미지가 있으면 이미지로, 없으면 사용자 이니셜 한 글자로 표시한다.

- **스냅샷 확장** — [src/lib/recentPosts.js](../src/lib/recentPosts.js):
  게시글 열람 시 `post.author.id` 를 `authorId` 로, `post.author.image_url` 값을 `authorImageUrl` 로 스냅샷에 포함한다.
  이미지가 없으면 빈 문자열로 둔다.
- **DB/API 확장** — [server/schema.sql](../server/schema.sql) · [server/db.js](../server/db.js) · [server/routes/recentPostViews.js](../server/routes/recentPostViews.js):
  `recent_post_views.author_id`, `recent_post_views.author_image_url` 컬럼을 추가하고, `POST /api/recent-post-views` upsert와 `GET /api/recent-post-views` 응답에 연결한다.
  기존 row는 가능한 경우 `post_id` 로 `posts.author_id` 를 찾아 `author_id` 를 backfill한다.
- **프로필 이미지 보정** — [server/routes/recentPostViews.js](../server/routes/recentPostViews.js):
  `POST` 저장 시 `authorImageUrl` 이 비어 있고 `authorId` 가 있으면 `users.image_url` 을 조회해 `author_image_url` 로 저장한다.
  `GET` 조회 시에도 `recent_post_views.author_image_url` 이 비어 있으면 `author_id` 로 `users.image_url` 을 조인해 응답의 `authorImageUrl` 로 내려주고,
  동시에 해당 row의 `author_image_url` 을 비동기 업데이트한다.
- **iframe 렌더** — [white](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html):
  `wbRenderRecentDocs` 가 항목에 `leadAuthor:true` 를 부여한다. `wbRenderDocCards` 는 이 값이 있을 때 왼쪽 영역을 작성자 아바타로 렌더한다.
  `authorImageUrl` 이 있으면 `<img>` 로 보여주고, 이미지 로딩 실패 또는 이미지 없음 상태에서는 `authorName` 의 첫 글자 이니셜을 표시한다.
  이 동작은 최근 본 문서 탭에만 적용하며, 최근 업데이트 탭은 기존 문서 아이콘을 유지한다.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/lib/recentPosts.js](../src/lib/recentPosts.js) | 최근 본 문서 스냅샷에 `authorId`, `authorImageUrl` 추가 | 완료 |
| [server/schema.sql](../server/schema.sql) · [server/db.js](../server/db.js) | `recent_post_views.author_id`, `author_image_url` 컬럼 추가, 기존 row `author_id` backfill 마이그레이션 | 완료 |
| [server/routes/recentPostViews.js](../server/routes/recentPostViews.js) | `authorId`/`authorImageUrl` 저장·조회 직렬화, 빈 이미지 URL은 `users.image_url` 로 저장/조회 시 보정 | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | 최근 본 문서 왼쪽 영역을 프로필 이미지 우선, 실패 시 이니셜 한 글자로 렌더 | 완료 |

### 15.7 [신규 요구] "최근에 업데이트 된 글" = 가입 채널의 미열람 원글 최신순 모음

> 요구: 사용자가 가입된 채널들에 아직 읽지 않은 글이 있을 경우, 여러 채널의 미열람 원글을 채널 구분 없이 모아서 시간 순서대로 나열한다.
> 이 탭에서는 제목은 보여주되 본문 요약은 보여주지 않는다.

> ⚠️ **[15.8절에서 확장됨]** 아래 초기 설계는 `unreadPost`(새 원글)만 모았다. 이후 "새 댓글·수정된 글·수정된 댓글도 포함"
> 요구에 따라 **판정 기준을 `isUnread`(새 원글 OR 새 댓글 OR 수정된 원글 OR 수정된 댓글)로 확장**하고 정렬을
> `unreadActivityAt`(가장 최근 미열람 활동) 기준으로 바꿨다. 최신 로직은 **15.8절**을 따른다.
>
> ⚠️ **[18절에서 성능 보정 예정]** 현재 구현은 Welcome 보드 초기 데이터 로드 중 대상 채널마다
> `GET /posts?channelId=<id>&limit=100` 을 병렬 호출한다. 채널 수가 많으면 대시보드 전체 표시가 늦어지므로,
> 후속 구현은 **대시보드 1차 데이터 먼저 표시 → 최근 업데이트는 후순위 지연 로드 → 중기적으로 전용 API로 대체**한다.

#### 현재 구조 검토 결과

- 채널별 읽지 않은 글 수는 이미 `channel_last_read` 기반으로 계산된다.
  - [server/routes/channels.js](../server/routes/channels.js) `GET /channels/unread` 가 채널별 unread count를 반환한다.
  - [src/contexts/ChatContext.jsx](../src/contexts/ChatContext.jsx) 는 이 값을 `teams[].channels[].unread` 에 반영한다.
- 게시글 목록 API [server/routes/posts.js](../server/routes/posts.js) `GET /posts?channelId=...` 는 각 게시글에
  `isUnread`, `unreadPost`, `unreadCommentCount`, `unreadActivityAt` 메타를 포함한다.
  - `unreadActivityAt` 은 안 읽은 원글 또는 안 읽은 댓글 중 가장 최신 활동 시각이다.
  - 이번 탭은 "글" 기준이므로 댓글 unread까지 포함하는 `isUnread` 대신 **원글 unread인 `unreadPost`** 만 사용한다.
  - 채널을 실제로 선택할 때는 `POST /channels/:id/read` 로 읽음 처리하지만, Welcome 보드의 배경 조회는
    `/posts` 조회만 수행하므로 읽음 상태를 바꾸지 않는다.
- 하단 탭 `#panel-updates` 는 기존에 목업 `.doc-row` 들만 렌더하고 있었다.
  따라서 15절에서 만든 `welcome-board:data` 주입 채널과 게시글 카드 렌더러를 재사용해 실데이터로 교체한다.

#### 구현 방안

1. **공용 게시글 스냅샷 함수화** — [src/lib/recentPosts.js](../src/lib/recentPosts.js):
   - 기존 `recordRecentPostView` 내부의 제목/요약/첨부/작성자/댓글 수 스냅샷 생성 로직을
     `makeWelcomePostSnapshot({ post, channel, team, viewedAt })` 로 분리한다.
   - "최근에 본 문서"와 "최근에 업데이트 된 글"이 같은 표시 규칙을 공유한다.

2. **부모 데이터 로드** — [src/App.jsx](../src/App.jsx) `welcomeBoardData` effect:
   - `teams` 에서 사용자가 가입/접근 가능한 채널 목록을 읽고, `!channel.is_archived` 인 채널을 대상으로 한다.
   - 대상 채널마다 `GET /posts?channelId=<id>&limit=100` 을 병렬 호출한다.
   - 응답에서 `post.unreadPost === true` 인 게시글만 모은다(댓글만 미열람인 글은 제외).
   - 각 항목을 `makeWelcomePostSnapshot` 으로 변환하되, 정렬/상대시간 기준은 `post.createdAt` 으로 둔다.
   - 본문 요약을 표시하지 않도록 `summary: ''` 로 비운다.
   - 모든 채널 결과를 합쳐 `viewedAt` 기준 최신순으로 정렬하고 상위 30건을
     `recentUpdates` payload에 넣는다.

3. **iframe 렌더** — [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html):
   - `#panel-updates` 의 목업 목록을 `#recentUpdatesList` 컨테이너로 교체한다.
   - 기존 `wbRenderRecentDocs` 로직을 `wbRenderDocCards(list, boxId, emptyText)` 로 일반화한다.
   - `payload.recentUpdates` 수신 시 `wbRenderRecentUpdates` 를 호출한다.
   - 항목 클릭은 기존 `target:'post'` postMessage 스킴을 그대로 사용하므로 해당 게시글로 이동한다.
   - 빈 목록 문구는 `읽지 않은 업데이트 글이 없습니다.` 로 표시한다.

#### 파일별 변경 요약

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/lib/recentPosts.js](../src/lib/recentPosts.js) | `makeWelcomePostSnapshot` 공용 함수 추가, `recordRecentPostView` 가 해당 함수 재사용 | 완료 |
| [src/App.jsx](../src/App.jsx) | `teams` 기반 가입 채널 조회 → `/posts` 병렬 로드 → `unreadPost` 필터 → `createdAt` 최신순 정렬 → 본문 요약 제거(`summary:''`) → `recentUpdates` payload 주입 | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | `#panel-updates` 목업 제거, `#recentUpdatesList` 컨테이너화, `wbRenderDocCards` 공용 렌더러와 `wbRenderRecentUpdates` 추가, `payload.recentUpdates` 수신 처리 | 완료 |

#### 대안 및 트레이드오프

- **서버 전용 집계 API 신설:** `/welcome/unread-posts` 같은 API를 만들면 한 번의 요청으로 더 효율적이나,
  권한·댓글 unread·첨부 enrich 로직을 새로 묶어야 해 변경 범위가 커진다. 이번에는 기존 `/posts` 응답의 unread 메타를 재사용한다.
- **조회 한계:** 채널당 최신 100개 안에서 미열람 글을 찾는다. 일반적인 채널 unread 용도에는 충분하지만,
  오래 누적된 미열람 글이 100개를 넘으면 더 오래된 글은 빠질 수 있다. 필요 시 서버 집계 API로 승격한다.
- **읽음 처리:** Welcome 보드에서 목록을 보는 것만으로는 채널을 읽음 처리하지 않는다. 항목을 클릭해 실제 게시글로 이동하면 기존 채널/게시글 흐름에 따른 읽음 처리 정책을 따른다.
- **본문 미표시:** 이 탭은 제목 중심 큐이므로 본문 요약은 렌더하지 않는다. 채널 태그, 시각, 작성자, 첨부/댓글 메타는 탐색 보조 정보로 유지한다.

### 15.8 [신규 요구] "최근에 업데이트 된 글" = 새 글뿐 아니라 **새 댓글·수정된 글·수정된 댓글**까지 반영

> 요구: "원글뿐 아니라 댓글이 새로 추가되거나, 글/댓글이 **수정**되어도 '최근에 업데이트 된 글'에 나타나야 한다."
> (15.7의 `unreadPost`(새 원글)만 모으던 기준을 확장. 팀/채널 배지와의 불일치도 함께 해소.)

#### 배경 (불일치의 원인)

- 팀/채널 배지 숫자([Sidebar.jsx](../src/components/Sidebar.jsx) `teamUnread` = `Σ channel.unread`)는
  [channels.js](../server/routes/channels.js) `GET /channels/unread` 가 계산하며 **`last_read_at` 이후의 새 글 + 새 댓글**을 센다.
- 그러나 15.7의 "최근에 업데이트 된 글"은 [App.jsx](../src/App.jsx) `loadRecentUpdates` 가 `post.unreadPost`(**새 원글만**)로 필터해서,
  **댓글만 미열람인 글**은 목록에서 누락됐다 → "배지엔 숫자가 뜨는데 목록은 비어 있음"의 원인.
- 또한 글/댓글 **수정**은 어디에서도 미열람으로 잡히지 않았다(안 읽음 판정이 `created_at` 단일 기준: [posts.js](../server/routes/posts.js) `isAfterLastRead`).

#### 현재 구조 검토 결과 (실제 코드 확인)

- `GET /posts` 응답의 각 글은 이미 `isUnread`/`unreadPost`/`unreadCommentCount`/`unreadActivityAt` 메타를 포함한다
  ([posts.js](../server/routes/posts.js) `buildUnreadMetaLight`, 응답에 `...unreadMeta` 스프레드). → **목록 필터만 바꾸면 새 댓글이 즉시 반영**된다.
- **댓글 unread는 PG 미러에서 계산**된다([posts.js](../server/routes/posts.js) `getCommentMetaMap` 이 `db.query` 로 `comments` 조회, [channels.js](../server/routes/channels.js) 배지 댓글 카운트도 PG).
  PG `comments.updated_at` 은 **댓글 수정 시 이미 `NOW()` 로 갱신**된다([posts.js](../server/routes/posts.js) `PUT /:postId/comments/:commentId`). → 댓글 수정은 **스키마 변경 없이** 반영 가능.
- **게시글은 Cassandra가 원본**이며 `posts` 테이블에 `updated_at`·`is_edited` 컬럼이 **이미 존재**하지만
  ([cassandra.js](../server/cassandra.js)), 수정 엔드포인트가 이를 갱신하지 않았다. → 수정 시각을 기록하도록 쓰기 경로만 보완하면 됨.

#### 구현 방안

1. **게시글 수정 시각 기록** — [posts.js](../server/routes/posts.js) `PUT /:id`:
   Cassandra `UPDATE posts SET ... updated_at = <now>, is_edited = true`(양 분기), PG 미러도 `is_edited = true, updated_at = NOW()`.
   (INSERT 시 `updated_at = created_at` 이라, 미수정 글은 `max(created,updated)=created` 로 기존과 동일하게 동작.)
2. **댓글 수정 반영(판정)** — [posts.js](../server/routes/posts.js) `getCommentMetaMap`:
   SELECT에 `updated_at` 추가, 미열람 판정 기준을 `max(created_at, updated_at)` 로. → 읽은 뒤 수정된 댓글도 `lastUnreadCommentAt` 에 잡힌다.
3. **게시글 수정 반영(판정)** — [posts.js](../server/routes/posts.js) `buildUnreadMetaLight`:
   `postUpdatedAt` 파라미터 추가. `unreadPostEdited = 본인 글 아님 && 새 글 아님 && (updated_at > lastRead)` 를 계산해
   `isUnread` 와 `unreadActivityAt` 에 포함(양 호출부에서 `postUpdatedAt: row.updated_at` 전달). `unreadPost`(새 원글) 의미는 그대로 보존.
4. **목록 필터·정렬 변경** — [App.jsx](../src/App.jsx) `loadRecentUpdates`:
   `filter(post => post.unreadPost)` → `filter(post => post.isUnread)`, 정렬/상대시각 기준을 `post.unreadActivityAt || createdAt` 로
   (방금 댓글 달리거나 수정된 글이 위로 올라옴). 제목만 표시(`summary:''`)는 15.7 그대로 유지.
5. **배지 일치(댓글 수정)** — [channels.js](../server/routes/channels.js) `GET /channels/unread`:
   댓글 카운트 조건을 `created_at > lastRead` → `(created_at > lastRead OR updated_at > lastRead)` 로.
   **게시글 수정은 배지에 넣지 않는다**(아래 결정 참조).

#### 결정 — 배지 범위 (사용자 확인됨: "목록 완전반영 + 배지 효율유지")

- **목록**은 4가지(새 글·새 댓글·수정 글·수정 댓글)를 **모두** 반영한다.
- **배지**는 새 글·새 댓글·**수정 댓글**까지 반영하고, **"이미 읽은 옛 글이 나중에 수정된" 경우는 배지 숫자에 세지 않는다.**
  - 이유: 배지 게시글 카운트는 Cassandra 클러스터링 키(`created_at > lastRead`) **범위 조회**로 효율을 얻는데, 게시글 수정(`updated_at`)까지
    세려면 채널 파티션을 넓게 읽어야 해 **앱 로드 성능이 저하**된다. 게시글 수정(특히 옛 글)은 드물어 트레이드오프가 유리.
  - 결과: 수정된 옛 원글은 **목록에는 뜨지만 배지 숫자에는 반영되지 않는** 경미한 비대칭이 있다(문서화된 의도).

#### 파일별 변경 요약

| 파일 | 변경 | 상태 |
|---|---|---|
| [server/routes/posts.js](../server/routes/posts.js) | `PUT /:id` 수정 시 Cassandra/PG `updated_at`·`is_edited` 갱신 · `getCommentMetaMap` SELECT에 `updated_at` 추가 + `max(created,updated)` 로 미열람 판정 · `buildUnreadMetaLight` 에 `postUpdatedAt`/`unreadPostEdited` 반영(양 호출부에 `postUpdatedAt` 전달) | 완료 |
| [server/routes/channels.js](../server/routes/channels.js) | 배지 댓글 카운트를 `(created_at > lastRead OR updated_at > lastRead)` 로 확장(수정 댓글 포함, 게시글 수정 제외) | 완료 |
| [src/App.jsx](../src/App.jsx) | `loadRecentUpdates` 필터 `unreadPost` → `isUnread`, 정렬/상대시각 기준 `unreadActivityAt` 우선 | 완료 |

#### 대안 및 트레이드오프

- **게시글 수정을 배지까지 완전 일치:** 채널 파티션 전체를 읽어 `max(created,updated) > lastRead` 로 세면 100% 일치하나
  앱 로드 성능 부담이 커져 이번엔 채택하지 않음(위 결정). 필요 시 `edited_at` 버킷 테이블/보조 인덱스로 승격 가능.
- **댓글 미러 의존:** 댓글 unread는 PG 미러 기준이라 미러 쓰기 실패 시 누락될 수 있으나, 이는 기존 댓글 수 표시도 동일하게 의존하던 전제로 신규 위험 아님.
- **수정 소음:** 사소한 재저장도 `updated_at` 을 올려 목록에 재부상할 수 있다. 필요 시 "실질 내용 변경 시에만 갱신"으로 후속 보정.
- **`buildUnreadMeta`(비-Light):** 현재 호출부가 없어(정의만 존재) 이번 변경에서 제외. 추후 사용 시 동일 원칙(`postUpdatedAt`)으로 확장.

### 15.9 [신규 요구] "최근에 본 문서" — **문서명 우선 + 첫 줄/링크 제목 승격 + 팀·채널 함께 표기**

> 요구: "최근에 본 문서"에서 ① **본문이 제목처럼 보이지 않도록** 하고, ② **문서가 속한 팀과 채널이 함께 보이도록** 한다.  
> 추가 보정: 명시 제목과 첨부 파일명이 모두 없어 `(제목 없음)` 으로 나올 경우에는
> **첫 번째 의미 있는 본문 줄 → 링크** 순으로 표시용 제목을 승격한다.

#### 현재 구조 검토 결과 (실제 코드 확인)

- 본문 요약(`summary`)은 저장/조회/렌더 전 구간에서 기본적으로 `''` 로 고정되어 **본문 요약 줄이 렌더되지 않는다**.
- 일반 텍스트 글은 명시 `title` 이 없을 수 있다. 이 경우 목록 식별성을 위해 제목 후보 순서를
  **명시 제목 → 첨부 파일명 → 첫 번째 의미 있는 본문 줄 → 링크 → `(제목 없음)`** 으로 둔다.
  ([recentPosts.js](../src/lib/recentPosts.js) `derivePostDisplay`, [recentPostViews.js](../server/routes/recentPostViews.js) `rowToClient`)
- 태그는 `tag: channel?.name || team?.name` 로 **채널 하나만** 표기했다([recentPosts.js](../src/lib/recentPosts.js) `makeWelcomePostSnapshot`).
- 열람 기록부 [PostDetailPane.jsx](../src/components/chat/PostDetailPane.jsx) 는 `channel`(selectedChannel)·`team`(selectedTeam)을 모두 넘긴다 → 팀·채널 정보 확보 가능.

#### 구현 방안 (결정: **문서명 우선**)

1. **문서명 우선 + 첫 줄/링크 제목 승격** — [recentPosts.js](../src/lib/recentPosts.js) `derivePostDisplay` / `makeWelcomePostSnapshot`:
   `preferAttachmentTitle` 옵션에서 일반 글 제목을 **명시 제목 → 첨부 파일명 → 첫 번째 의미 있는 본문 줄 → 링크** 순으로 뽑는다.
   `recordRecentPostView`("최근에 본 문서" 기록)에서만 `preferAttachmentTitle: true` 로 호출 → **이 탭에만 적용**(양식/MD/시트 글은 원래 문서 제목이라 영향 없음).
   첫 줄이나 링크를 제목으로 승격한 경우 `summary` 는 비워 제목과 중복 표시하지 않는다.
   - "최근에 업데이트 된 글"(15.7/15.8)은 글 중심이므로 **기존대로 본문 첫 줄 제목 유지**(옵션 false).
2. **기존 저장 row 보정** — [server/routes/recentPostViews.js](../server/routes/recentPostViews.js):
   이미 `recent_post_views.title='(제목 없음)'` 으로 저장된 row도 조회 시 `posts.content` 또는 기존 `summary` 의 첫 번째 의미 있는 줄/링크를 `title` 로 승격해 응답한다.
   따라서 사용자가 같은 글을 다시 열람하지 않아도 Welcome 보드 목록에서 제목이 개선된다.
3. **팀·채널 함께 표기** — [recentPosts.js](../src/lib/recentPosts.js) `makeWelcomePostSnapshot`:
   `tag` 를 `팀 · 채널` 형태로 구성(`[team.name, channel.name]` 중복 제거 후 `' · '` 조인, 한쪽만 있으면 그것만).
   태그는 스냅샷 문자열에 실려 서버·템플릿 변경 없이 그대로 표시된다(템플릿 `.doc-tag` 재사용). 업데이트 글 탭도 동일하게 팀·채널을 함께 보게 된다(문맥 보강, 무해).

#### 파일별 변경 요약

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/lib/recentPosts.js](../src/lib/recentPosts.js) | `derivePostDisplay(post, {preferAttachmentTitle})` — 명시 제목 → 첨부 파일명 → 첫 번째 의미 있는 본문 줄 → 링크 순 제목 · `summary:''` · `makeWelcomePostSnapshot` `tag`=`팀 · 채널` · `recordRecentPostView` 는 `preferAttachmentTitle:true` | 완료 |
| [server/routes/recentPostViews.js](../server/routes/recentPostViews.js) | 기존 `(제목 없음)` 저장 row를 조회 시 첫 번째 의미 있는 본문 줄/링크/summary로 표시용 제목 보정, summary 중복 노출 제거 | 완료 |

#### 대안 및 트레이드오프

- **적용 범위:** 문서명 우선은 "최근에 본 문서"에만 적용(업데이트 글 탭은 본문 첫 줄 제목이 탐색에 유용하므로 유지). 팀·채널 태그는 양 탭 공통.
- **기존 스냅샷:** 이미 DB(`recent_post_views`)에 저장된 `(제목 없음)` 행은 서버 조회 응답에서 표시용 제목을 보정한다. 태그 등 다른 스냅샷 값은 다시 열람하면 새 규칙으로 갱신된다.
- **팀·채널 분리 칩:** 하나의 칩에 `팀 · 채널` 문자열로 표기(템플릿 변경 최소화). 필요 시 후속으로 팀/채널 별도 칩 렌더로 확장 가능.

---

## 16. [신규 요구] "중요 메일" 항목 클릭 → **해당 메일로 바로 이동**

> 요구: "중요 메일" 카드의 메일 목록 중 하나를 클릭하면 그 메일로 바로 이동한다.

### 16.1 현재 구조 검토 결과 (실제 코드 확인)

- 특정 메일로 이동하는 **딥링크 메커니즘이 이미 있다**: [App.jsx](../src/App.jsx) `openMailDeepLink({ messageId, tenantId })` →
  `setMailDeepLink({...})` + `setShowMail(true)` + 상호배타 리셋. [MailPage](../src/features/mail/MailPage.jsx) 는 `initialMailLink={mailDeepLink}`
  를 받아 해당 메시지를 연다(`initialMailLink.messageId`).
- 그러나 12절에서 "중요 메일" 카드에 주입하던 데이터는 `{ name, subject, snippet, received_at }` 만 있어
  **메시지 `id`·`tenantId` 가 빠져** 클릭 이동에 필요한 식별자가 없었다.
- 9·10·15절에서 만든 `welcome-board:navigate` postMessage 스킴을 그대로 재사용한다(`target:'mail'` 추가).

### 16.2 구현 방안

1. **주입 데이터에 식별자 추가** — [App.jsx](../src/App.jsx) `loadImportantMail`:
   각 항목에 `id`(메시지 id)와 `tenantId`(이미 조회에 사용) 포함.
2. **항목 클릭 신호** — [white](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html):
   `wbRenderImportantMail` 의 각 `.mail-item` 에 `id`·`tenantId` 가 있으면 `cursor:pointer` + 클릭 시
   `postMessage({ type:'welcome-board:navigate', target:'mail', messageId, tenantId })`.
3. **부모 라우팅** — [App.jsx](../src/App.jsx) `PanelServicePage.onNavigate`:
   `target === 'mail'` 분기 → `setWelcomeService(null)` + `setMailInitialFolder(null)` 후
   `openMailDeepLink({ messageId, tenantId })`(기존 딥링크 로직 재사용 → 메일 열기 + 상호배타 리셋).

### 16.3 파일별 변경 요약

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/App.jsx](../src/App.jsx) | `loadImportantMail` 매핑에 `id`·`tenantId` 추가 · `onNavigate` `target==='mail'` → `openMailDeepLink` 분기 | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | `wbRenderImportantMail` 각 항목 클릭 시 `welcome-board:navigate`(`target:'mail'`, `messageId`, `tenantId`) 전송 | 완료 |

### 16.4 확장

- 동일 스킴으로 15절의 "최근 수신 메일" 탭 항목 클릭 이동도 재사용 가능(payload에 `id`/`tenantId`만 실으면 됨).
- 딥링크는 `messageId`+`tenantId` 필수. 둘 중 하나라도 없으면 클릭 비활성(안전 가드).

---

## 17. [신규 요구] Welcome 보드 로고를 이미지로 교체

> 요구: 사이드바 SERVICE 섹션의 `Welcome 보드` 로고와 인패널 헤더
> `EasyStation에 오신 것을 환영합니다.` 앞 로고를
> [public/img/Welcome-logo_2nd.png](../public/img/Welcome-logo_2nd.png) 이미지로 표시한다.

### 17.1 현재 구조 검토 결과

- Welcome 보드 버튼은 [src/components/Sidebar.jsx](../src/components/Sidebar.jsx)의 `topServices.map(template => ...)` 에서 렌더한다.
- 기존 아이콘은 [src/templates/formTemplates.js](../src/templates/formTemplates.js)의 `WELCOME_BOARD_TEMPLATE.icon` 문자열(`👋`)을
  `<span>` 으로 출력하는 구조다.
- 인패널 헤더 문구는 [src/App.jsx](../src/App.jsx)의 `PanelServicePage`에서
  `service.headerLabel || service.label` 을 렌더한다.
- `public/img/Welcome-logo_2nd.png` 는 Vite 정적 public 자산이므로 앱에서는 `/img/Welcome-logo_2nd.png` 경로로 직접 참조할 수 있다.

### 17.2 구현 방안

1. **템플릿 메타 확장** — `WELCOME_BOARD_TEMPLATE`에 `iconImg: '/img/Welcome-logo_2nd.png'` 를 추가한다.
   - 기존 `icon` 값은 fallback 용도로 유지한다.
   - 다른 서비스 템플릿 구조에는 영향을 주지 않는다.
2. **사이드바 렌더 확장** — `Sidebar` 서비스 버튼에서 `template.iconImg` 가 있으면 `<img>` 로 표시하고,
   없으면 기존처럼 `template.icon` 텍스트를 표시한다.
   - 크기: `w-5 h-5`.
   - 비율 유지: `object-contain`.
   - 장식용 아이콘이므로 `alt=""` 로 둔다.
3. **인패널 헤더 렌더 확장** — `PanelServicePage` 헤더에서 `service.iconImg` 가 있으면
   `EasyStation에 오신 것을 환영합니다.` 문구 앞에 같은 이미지를 표시한다.
   - 크기: `w-7 h-7`.
   - 비율 유지: `object-contain`.
   - 헤더 문구가 좁은 폭에서 말줄임될 수 있도록 기존 `truncate` 는 유지한다.

### 17.3 파일별 변경 요약

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/templates/formTemplates.js](../src/templates/formTemplates.js) | `WELCOME_BOARD_TEMPLATE.iconImg = '/img/Welcome-logo_2nd.png'` 추가, 기존 `icon` fallback 유지 | 완료 |
| [src/components/Sidebar.jsx](../src/components/Sidebar.jsx) | SERVICE 버튼 아이콘 렌더를 `iconImg` 우선 `<img>` / 없으면 기존 텍스트 아이콘으로 분기 | 완료 |
| [src/App.jsx](../src/App.jsx) | `PanelServicePage` 인패널 헤더에서 `service.iconImg` 를 문구 앞 `<img>` 로 렌더 | 완료 |

### 17.4 검증 기준

- `--showWelcomeBoard` 활성화 상태에서 사이드바 SERVICE 섹션 최상단 `Welcome 보드` 버튼 왼쪽에
  [public/img/Welcome-logo_2nd.png](../public/img/Welcome-logo_2nd.png)가 표시되어야 한다.
- Welcome 보드 인패널 헤더의 `EasyStation에 오신 것을 환영합니다.` 문구 앞에도
  [public/img/Welcome-logo_2nd.png](../public/img/Welcome-logo_2nd.png)가 표시되어야 한다.
- 건설 안전 칸반 보드, Easy Code 생성 플랫폼 등 `iconImg` 가 없는 기존 서비스는 기존 이모지 아이콘 렌더를 유지해야 한다.

---

## 18. [성능 보정 완료] Welcome 보드 초기 표시 우선 + 최근 업데이트 지연 로드 + 전용 API 전환

> 요구/결정: 현재 Welcome 보드는 초기 로딩 중 "최근에 업데이트 된 글"을 만들기 위해 모든 가입 채널에
> `GET /posts?channelId=<id>&limit=100` 을 병렬 호출한다. 이는 대시보드 첫 화면용으로 과하다.  
> 구현 결정: **"대시보드 먼저, 최근 업데이트는 후순위"** 로 로딩 순서를 분리하고,
> **"Welcome 전용 recent-updates API"** 로 `/posts?limit=100` 다중 호출을 제거한다.

### 18.1 문제 정의

- [src/App.jsx](../src/App.jsx) `welcomeBoardData` effect는 현재 `Promise.all` 로
  `todaySchedule`, `importantMail`, `recentUnreadMail`, `recentUpdates`, `recentPosts` 를 모두 기다린 뒤
  한 번에 `setWelcomeBoardData` 한다.
- 이 중 `recentUpdates` 는 `teams[].channels[]` 전체를 순회하며 채널마다
  `GET /posts?channelId=<id>&limit=100` 을 병렬 호출한다.
- `/posts` 는 채널 화면용 API라 게시글 본문뿐 아니라 권한, 고정글, 삭제글, 댓글 메타, 좋아요, 첨부, 작성자,
  미열람 상태 등을 조립한다. Welcome 보드 하단 탭 하나를 위해 모든 채널에서 이 무거운 API를 호출하는 구조다.
- 결과적으로 가장 느린 `recentUpdates` 작업이 끝날 때까지 대시보드 카드 데이터까지 같이 늦게 보일 수 있다.
- 로그상 다수의 `/api/posts?...limit=100` 요청이 같은 시각에 몰리면서 `socket hang up`/`ECONNREFUSED` 가 연쇄 발생한 흔적도 있다.

### 18.2 목표

1. **첫 화면 우선 표시:** 오늘 일정, 중요 메일, 최근 미확인 메일, 최근 본 문서는 가능한 한 빨리 표시한다.
2. **무거운 업데이트 탭 분리:** 최근 업데이트 글 조회 실패나 지연이 대시보드 전체 표시를 막지 않게 한다.
3. **점진 갱신:** "최근에 업데이트 된 글" 탭은 별도 로딩 상태를 유지하다가 결과가 오면 해당 탭만 갱신한다.
4. **중기 최적화:** `/posts?limit=100` 다중 호출을 Welcome 전용 요약 API 한 번으로 대체한다.
5. **읽음 상태 보존:** Welcome 보드에서 조회만 하는 행위는 기존처럼 채널/게시글 읽음 처리로 간주하지 않는다.

### 18.3 단기 구현 방안 — 대시보드 먼저, 최근 업데이트는 후순위

#### 18.3.1 데이터 주입을 2단계로 분리

현재:

```js
const [todaySchedule, importantMail, recentUnreadMail, recentUpdates, recentPosts] = await Promise.all([...])
setWelcomeBoardData({ todaySchedule, importantMail, recentUnreadMail, recentUpdates, recentPosts })
```

변경 방향:

1. **1차 payload:** `todaySchedule`, `importantMail`, `recentUnreadMail`, `recentPosts` 만 먼저 병렬 조회한다.
2. 1차 조회가 끝나면 즉시 `setWelcomeBoardData` 로 iframe에 주입한다.
3. `recentUpdates` 는 별도 async 작업으로 뒤에서 시작한다.
4. `recentUpdates` 결과가 오면 기존 `welcomeBoardData` 에 `recentUpdates` 만 병합해 다시 주입한다.

주의:

- `setWelcomeBoardData(prev => ({ ...prev, recentUpdates }))` 형태로 병합해야 1차 데이터가 사라지지 않는다.
- `cancelled` 가 true인 경우 1차/2차 모두 state update를 하지 않는다.
- `welcomeService?.id` 가 바뀌면 기존처럼 `setWelcomeBoardData(null)` 로 초기화한다.

#### 18.3.2 iframe 렌더링 계약

- 템플릿의 `window.addEventListener('message')` 는 이미 payload 일부만 있어도 해당 필드만 렌더한다.
  예: `payload.recentPosts !== undefined` 이면 최근 본 문서만 렌더한다.
- 따라서 1차 payload에는 `recentUpdates` 를 생략하거나 `recentUpdatesLoading:true` 같은 상태 필드를 넣을 수 있다.
- 단기 구현은 템플릿 변경을 최소화하기 위해:
  - 초기 HTML의 `#recentUpdatesList` 는 기존 "최근에 업데이트 된 글을 불러오는 중…" 문구를 유지한다.
  - 2차 payload 도착 시 `payload.recentUpdates` 만 렌더한다.
- 실패 시에는 `recentUpdates: []` 를 주입해 `읽지 않은 업데이트 글이 없습니다.` 로 표시할지,
  별도 에러 문구를 표시할지 결정해야 한다. 기본안은 **빈 목록 처리**로 둔다.

#### 18.3.3 `recentUpdates` 조회량 축소

단기에서도 `/posts?limit=100` 은 부담이 크다. 최소 보정은 아래 중 하나다.

- 1안: `limit=30` 으로 낮춘다. 채널 수가 많아도 최대 조회량이 크게 줄어든다.
- 2안: `channel.unread > 0` 인 채널만 조회한다. 사이드바 unread count가 이미 있으므로 불필요한 채널 호출을 줄일 수 있다.
- 3안: `channel.unread > 0` 채널 중 최근 활동순/팀 표시순으로 상위 N개만 먼저 조회하고, 필요 시 추가 조회한다.

권장 단기안:

1. `channel.unread > 0` 이고 `!channel.is_archived` 인 채널만 대상으로 한다.
2. 채널당 `limit=30` 으로 시작한다.
3. 결과는 기존처럼 `post.isUnread` 로 필터하고 `unreadActivityAt` 기준 최신순 30건만 유지한다.

#### 18.3.4 동시성 제한

현재 `Promise.all(channels.map(...))` 는 채널 수만큼 동시에 `/posts` 를 호출한다.
단기 구현에서 전용 API를 만들기 전까지는 동시성을 제한한다.

- 권장 동시성: 3~5개.
- 구현은 별도 라이브러리 없이 작은 queue helper로 충분하다.
- 실패한 채널은 빈 배열로 처리하고 전체 로딩을 실패시키지 않는다.

예상 효과:

- 첫 화면은 `recentUpdates` 와 무관하게 빠르게 뜬다.
- 서버에 `/posts` 요청이 한꺼번에 30개씩 몰리지 않는다.
- 메일/최근 본 문서/일정 API가 `/posts` 폭주에 같이 밀릴 가능성이 줄어든다.

### 18.4 중기 구현 방안 — Welcome 전용 recent-updates API

단기 보정 후에도 근본적으로는 `/posts` 채널 목록 API를 Welcome 집계용으로 재사용하지 않는 것이 좋다.
중기에는 서버에 Welcome 전용 API를 만든다.

#### 18.4.1 API 형태

권장 endpoint:

```http
GET /api/welcome/recent-updates?limit=30
```

응답 항목:

```json
{
  "postId": "...",
  "channelId": "...",
  "kind": "post",
  "icon": "📄",
  "title": "...",
  "tag": "팀 · 채널",
  "summary": "",
  "createdAt": "...",
  "updatedAt": "...",
  "authorId": 1,
  "authorName": "KevinIm",
  "authorImageUrl": "...",
  "commentCount": 2,
  "attachments": ["file.pdf"],
  "viewedAt": 1770000000000,
  "unreadPost": true,
  "unreadPostEdited": false,
  "unreadCommentCount": 1,
  "unreadActivityAt": "..."
}
```

프론트는 이 응답을 기존 `wbRenderRecentUpdates` 에 그대로 넣을 수 있어야 한다.
가능하면 [src/lib/recentPosts.js](../src/lib/recentPosts.js)의 `makeWelcomePostSnapshot` 출력 형태와 맞춘다.

#### 18.4.2 서버 책임

서버 API는 아래를 한 번에 수행한다.

1. 현재 사용자가 접근 가능한 채널 목록을 구한다.
2. 읽음 기준(`channel_last_read`)을 가져온다.
3. 새 원글, 새 댓글, 수정된 원글, 수정된 댓글 조건을 반영해 후보를 만든다.
4. `unreadActivityAt` 기준 최신순으로 정렬한다.
5. `limit` 만큼만 반환한다.
6. Welcome 보드에 필요한 최소 필드만 직렬화한다.

중요:

- `/posts` 처럼 댓글 목록, 상세 권한 필드, 전체 첨부 객체, 좋아요 상태, training status 등을 모두 만들 필요가 없다.
- 첨부는 표시용 파일명 최대 5개만 있으면 된다.
- 본문 요약은 최근 업데이트 탭에서는 표시하지 않으므로 `summary:''` 로 둔다.
- 조회만으로 읽음 처리하지 않는다.

#### 18.4.3 데이터 소스 선택

현 구조상 후보:

- **PostgreSQL 중심:** `posts`, `comments`, `channel_last_read`, `channels`, `teams`, `users`, `attachments` 를 조인/조회한다.
  - 장점: 한 API 안에서 집계하기 쉽고 `updated_at` 조건을 쓰기 쉽다.
  - 단점: Cassandra가 원본인 환경에서는 PG 미러 최신성이 중요하다.
- **기존 `/posts` 재사용:** 구현은 빠르지만 병목 원인을 유지한다.
- **별도 materialized table:** 장기적으로 가장 빠르지만 쓰기 경로마다 갱신해야 해서 범위가 크다.

권장 중기안:

- 우선 PostgreSQL 기반 전용 API로 구현한다.
- PG 미러 누락 가능성이 확인되면 이후 materialized table 또는 Cassandra 보조 테이블을 검토한다.

#### 18.4.4 권한/보안

- 반드시 `requireAuth` 를 적용한다.
- 채널 접근권한은 기존 `canAccessChannel` 또는 같은 기준의 set 기반 필터를 적용한다.
- 채널 수가 많은 사용자에게 `canAccessChannel` 을 row마다 순차 호출하면 느려질 수 있으므로,
  가능하면 "사용자가 접근 가능한 채널 id set" 을 먼저 만들고 SQL 후보를 그 set으로 제한한다.
- 응답에는 사용자가 접근할 수 없는 채널의 post/comment 정보가 섞이면 안 된다.

#### 18.4.5 프론트 전환

중기 전환 시 [src/App.jsx](../src/App.jsx) `loadRecentUpdates` 는 아래처럼 바뀐다.

1. `apiFetch('/welcome/recent-updates?limit=30')` 호출.
2. 응답 배열 검증.
3. 실패 시 빈 배열 반환.
4. 기존 `teams` 순회와 `/posts?limit=100` 병렬 호출 제거.

이때 18.3의 "후순위 지연 로드" 구조는 유지한다. 전용 API가 빨라져도 최근 업데이트가 첫 화면 필수 데이터가 될 필요는 없다.

### 18.5 단계별 구현 순서

#### 1단계 — 로딩 순서 분리

- [src/App.jsx](../src/App.jsx) `welcomeBoardData` effect에서 1차 데이터와 `recentUpdates` 를 분리한다.
- 1차 데이터:
  - `loadTodaySchedule()`
  - `loadImportantMail()`
  - `loadRecentUnreadMail()`
  - `loadRecentPosts()`
- 2차 데이터:
  - `loadRecentUpdates()`
- 1차 완료 즉시 `setWelcomeBoardData`.
- 2차 완료 시 `recentUpdates` 만 병합.

#### 2단계 — 기존 `/posts` 방식의 피해 줄이기

- `loadRecentUpdates` 대상 채널을 `channel.unread > 0` 인 채널로 제한한다.
- 채널당 `limit=100` 을 `limit=30` 으로 낮춘다.
- 동시 호출 개수를 3~5개로 제한한다.
- 실패 채널은 전체 실패로 올리지 않고 빈 결과로 처리한다.

#### 3단계 — 전용 API 추가

- 서버에 `server/routes/welcome.js` 또는 `server/routes/welcomeRecentUpdates.js` 를 추가한다.
- `GET /api/welcome/recent-updates?limit=30` 를 구현한다.
- [server/index.js](../server/index.js)에 라우터를 연결한다.
- 기존 `isUnread`/`unreadActivityAt` 의미와 15.8의 배지 범위 결정을 유지한다.

#### 4단계 — 프론트 API 전환

- [src/App.jsx](../src/App.jsx) `loadRecentUpdates` 를 새 API 호출로 교체한다.
- 18.3의 지연 로드 구조는 그대로 유지한다.
- `/posts?channelId=...&limit=...` 다중 호출은 제거한다.

#### 5단계 — 관측/검증

- 개발 로그 또는 브라우저 Network 기준으로 Welcome 보드 진입 시 `/posts?limit=100` 다중 호출이 없어졌는지 확인한다.
- 첫 화면 카드/최근 본 문서가 최근 업데이트 결과를 기다리지 않고 표시되는지 확인한다.
- 최근 업데이트 탭은 처음에는 로딩 문구, 이후 결과 또는 빈 목록으로 바뀌는지 확인한다.
- unread가 있는 채널의 새 글/새 댓글/수정 글/수정 댓글이 15.8 기준대로 목록에 나타나는지 확인한다.
- 항목 클릭 시 기존 `target:'post'` 라우팅이 유지되는지 확인한다.

### 18.6 파일별 변경 계획

| 단계 | 파일 | 변경 | 상태 |
|---|---|---|---|
| 1 | [src/App.jsx](../src/App.jsx) | Welcome 보드 데이터 로드를 1차 필수 데이터와 2차 `recentUpdates` 로 분리, 2차 결과는 병합 업데이트 | 완료 |
| 2 | [src/App.jsx](../src/App.jsx) | `/posts` 방식의 임시 피해 축소 대신 전용 API로 바로 전환해 채널별 다중 호출 자체를 제거 | 완료 |
| 3 | [server/routes/welcomeRecentUpdates.js](../server/routes/welcomeRecentUpdates.js) | `GET /api/welcome/recent-updates?limit=30` 신규 라우트 구현 | 완료 |
| 3 | [server/index.js](../server/index.js) | Welcome recent updates 라우터 등록 | 완료 |
| 4 | [src/App.jsx](../src/App.jsx) | `loadRecentUpdates` 를 전용 API 호출로 전환하고 `/posts` 다중 호출 제거 | 완료 |
| 5 | [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | 기존 로딩 문구와 부분 payload 렌더링 계약을 그대로 사용해 변경 불필요 | 완료 |

### 18.7 구현 시 주의사항

- 단기 1단계와 2단계는 사용자 체감 개선이 크므로 먼저 한다.
- 전용 API는 기존 `/posts` 응답과 동일한 모든 필드를 만들 필요가 없다. Welcome 보드 렌더에 필요한 최소 필드만 반환한다.
- `recentUpdates` 조회 실패가 Welcome 보드 전체 실패가 되면 안 된다.
- 메일/캘린더/최근 본 문서 조회와 `recentUpdates` 조회는 서로 독립적으로 실패·성공해야 한다.
- 대시보드 첫 렌더 이후 iframe에 payload를 여러 번 보내도 템플릿이 부분 갱신 가능하도록 payload 필드 단위를 유지한다.
- 장기적으로는 Welcome 보드에 필요한 데이터를 `/api/welcome/summary` 하나로 묶는 것도 가능하지만,
  이번 보정의 핵심은 `recentUpdates` 병목을 첫 화면에서 분리하는 것이다.

---

## 19. [신규 요구] 제목 바 Welcome Board 이미지 버튼

> 요구: 서버를 `--showWelcomeBoard` 옵션으로 시작한 경우, 제목 바에 **Welcome Board 버튼**을 표시한다.  
> 버튼 위치는 **좌측 사이드바 숨기기/보이기 버튼의 왼쪽**이며, 텍스트가 아니라
> [public/img/Welcome-logo_2nd.png](../public/img/Welcome-logo_2nd.png) 이미지를 사용한다.

### 19.1 동작 목표

1. `--showWelcomeBoard` 옵션이 켜진 경우에만 제목 바 버튼을 보여준다.
2. 버튼은 `Welcome Board` 글자 대신 `public/img/Welcome-logo_2nd.png` 이미지만 표시한다.
3. 위치는 제목 바 우측 컨트롤 영역에서 **좌측 사이드바 토글 버튼 바로 왼쪽**이다.
4. 버튼 클릭 시 기존 Welcome 보드 인패널 화면으로 이동한다.
5. Welcome 보드로 이동할 때 캘린더, DM, 메일 화면은 닫아 기존 상호배타 규칙을 유지한다.
6. URL 딥링크 자동 처리 정책은 유지한다. 이 버튼은 사용자가 명시적으로 누르는 진입점이므로 딥링크 가드와 별개로 동작한다.

### 19.2 구현 지침

1. **TitleBar props 확장** — [src/components/TitleBar.jsx](../src/components/TitleBar.jsx):
   - `showWelcomeBoardButton` boolean prop 추가.
   - `onOpenWelcomeBoard` callback prop 추가.
   - 데스크톱 컨트롤 영역에서 `showWelcomeBoardButton` 이 true일 때만 이미지 버튼 렌더.
   - 버튼은 `aria-label`/`title` 을 `Welcome Board` 로 둔다.
   - 이미지 `src="/img/Welcome-logo_2nd.png"` 를 사용하고, `alt=""` 로 두어 버튼의 accessible name은 `aria-label` 이 담당하게 한다.

2. **버튼 위치** — [src/components/TitleBar.jsx](../src/components/TitleBar.jsx):
   - 기존 사이드바 토글 버튼 주석/블록 바로 앞에 배치한다.
   - AgenticAI 패널 토글, 사용자 메뉴, 언어 토글의 위치는 유지한다.

3. **App 연결** — [src/App.jsx](../src/App.jsx):
   - `TitleBar` 에 `showWelcomeBoardButton={SHOW_WELCOME_BOARD}` 전달.
   - `onOpenWelcomeBoard` 에서:
     - `setWelcomeService(WELCOME_BOARD_TEMPLATE)`
     - `setShowCalendar(false)`
     - `setShowDM(false)`
     - `setShowMail(false)`
     - `setActiveDMConv(null)`
   - 필요 시 `setMailDeepLink(null)`/`setMailInitialFolder(null)` 도 함께 정리해 메일 딥링크 잔상을 남기지 않는다.

### 19.3 파일별 변경 계획

| 파일 | 변경 | 상태 |
|---|---|---|
| [MDfiles/WelcomeBoard.md](./WelcomeBoard.md) | 제목 바 Welcome Board 이미지 버튼 요구사항과 구현 지침 추가 | 완료 |
| [src/components/TitleBar.jsx](../src/components/TitleBar.jsx) | `showWelcomeBoardButton`/`onOpenWelcomeBoard` props 추가, 사이드바 토글 왼쪽에 이미지 버튼 렌더 | 완료 |
| [src/App.jsx](../src/App.jsx) | `TitleBar` props 연결, 클릭 시 Welcome 보드 인패널 오픈 및 다른 화면 닫기 | 완료 |

### 19.4 검증 항목

- `--showWelcomeBoard` 로 시작하면 제목 바에 Welcome 로고 이미지 버튼이 보인다.
- 버튼은 좌측 사이드바 토글 버튼의 왼쪽에 있다.
- 버튼 클릭 시 Welcome 보드가 가운데 메인 패널에 열린다.
- 캘린더/DM/메일 화면에서 버튼을 눌러도 Welcome 보드로 전환된다.
- `--showWelcomeBoard` 옵션이 꺼져 있으면 제목 바 버튼이 보이지 않는다.

---

## 20. [신규 요구] 오늘의 일정 `새 일정 추가` → 캘린더 이벤트 추가 창

> 요구: Welcome Board의 **오늘의 일정** 카드에서 **새 일정 추가** 버튼을 누르면 캘린더의 이벤트 추가 창이 나타난다.

### 20.1 검토 결과

- Welcome 보드는 `PanelServicePage`의 `iframe srcDoc` 안에서 렌더되며, 이미 `welcome-board:navigate` `postMessage`로 부모 App에 라우팅 요청을 보낸다.
- 오늘의 일정 `전체 보기`는 `target:'calendar'` 로 캘린더 화면을 열고 있다.
- 캘린더의 추가 창은 [CalendarView.jsx](../src/components/CalendarView.jsx) 내부 `showEventModal` + `EventAddModal` 조합으로 열린다.
- 기존 `calendarFocusEvent`는 특정 이벤트를 찾아 편집 모달을 여는 용도이므로, 새 일정 추가 요청은 별도 신호(`calendarAddEventRequest`)로 분리하는 것이 안전하다.

### 20.2 구현 방안

1. [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html)
   - 오늘의 일정 카드 `새 일정 추가` 행에 클릭/키보드 핸들러를 추가한다.
   - 메시지 스킴: `{ type:'welcome-board:navigate', target:'calendar-add-event' }`.

2. [src/App.jsx](../src/App.jsx)
   - `calendarAddEventRequest` state를 추가한다.
   - `target === 'calendar-add-event'` 수신 시:
     - `setCalendarFocusEvent(null)`
     - `setCalendarAddEventRequest({ openedAt: Date.now() })`
     - `setShowCalendar(true)`
     - `setWelcomeService(null)`
     - DM/메일 상태를 닫아 기존 상호배타 규칙을 유지한다.
   - `CalendarView`에 `addEventRequest={calendarAddEventRequest}` 를 전달한다.
   - CalendarView가 요청을 처리한 뒤 `onAddEventRequestHandled` 로 state를 비워, 이후 캘린더 재진입 때 모달이 다시 열리지 않게 한다.

3. [src/components/CalendarView.jsx](../src/components/CalendarView.jsx)
   - `addEventRequest` prop을 받고 `openedAt` 변경을 1회성 신호로 처리한다.
   - 요청 수신 시 오늘 날짜의 `day` 뷰로 이동하고, `editingEvent`/`presetDts`를 비운 뒤 `showEventModal`을 `true`로 설정한다.
   - 처리 후 부모 콜백을 호출해 1회성 요청을 소진한다.
   - 실제 시간 기본값은 기존 `EventAddModal`의 `makeDefaultDt(0/1)` 로 유지한다.

### 20.3 파일별 변경 계획

| 파일 | 변경 | 상태 |
|---|---|---|
| [MDfiles/WelcomeBoard.md](./WelcomeBoard.md) | 요구사항 검토 및 구현 지침 추가 | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | `새 일정 추가` 클릭/키보드 입력 시 `calendar-add-event` 메시지 전송 | 완료 |
| [src/App.jsx](../src/App.jsx) | `calendarAddEventRequest` state 추가, Welcome 라우팅에서 캘린더 추가 요청 처리, `CalendarView` prop 전달 및 처리 후 요청 초기화 | 완료 |
| [src/components/CalendarView.jsx](../src/components/CalendarView.jsx) | `addEventRequest` 신호 수신 시 이벤트 추가 모달 열기, 처리 완료 콜백 호출 | 완료 |

### 20.4 검증 항목

- Welcome 보드 오늘의 일정 카드에서 `새 일정 추가` 클릭 시 Welcome 보드가 닫히고 캘린더가 열린다.
- 캘린더가 열린 직후 `EventAddModal`이 추가 모드로 나타난다.
- `Enter`/`Space` 키로도 `새 일정 추가`가 동작한다.
- 기존 `전체 보기` 버튼은 캘린더 화면 이동만 수행하며 모달을 열지 않는다.

### 20.5 [보정] 캘린더로만 이동하고 이벤트 추가 창이 열리지 않는 문제

#### 원인

- `CalendarView`의 `addEventRequest` 처리 effect에서 `handledAddEventRequestRef.current = signature` 를 타이머 실행 전에 먼저 기록했다.
- React 개발 환경의 StrictMode는 effect를 검증하기 위해 mount 시 effect를 한 번 정리했다가 다시 실행할 수 있다.
- 첫 번째 effect에서 처리 완료 ref가 먼저 기록되고, 그 타이머는 StrictMode 정리 단계에서 취소된다.
- 두 번째 effect는 같은 `openedAt` 값을 이미 처리한 요청으로 판단해 바로 반환한다.
- 결과적으로 `showCalendar(true)` 는 적용되어 캘린더 화면으로 이동하지만, `setShowEventModal(true)` 가 실행되지 않아 이벤트 추가 창이 나타나지 않았다.

#### 수정

- 처리 완료 ref 기록을 타이머 예약 시점이 아니라 **타이머 콜백 내부**, 즉 실제로 모달을 여는 시점으로 옮겼다.
- StrictMode가 첫 번째 타이머를 취소해도 ref가 아직 기록되지 않으므로, 두 번째 effect 실행에서 다시 타이머를 예약하고 모달을 정상적으로 연다.

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/components/CalendarView.jsx](../src/components/CalendarView.jsx) | `addEventRequest` 처리 완료 ref 기록을 실제 모달 오픈 타이머 내부로 이동 | 완료 |

---

## 21. [신규 요구] `최근 미확인 메일` 탭 제목 옆 미확인 메일 수 표시

> 요구: Welcome Board 하단 탭의 `최근 미확인 메일` 제목 오른쪽 옆에 미확인 메일 개수를 표시한다.

### 21.1 구현 방안

1. **카운트 기준**
   - 목록은 기존처럼 `/mail/messages?scope=unified&unifiedKey=inbox&unreadOnly=1&limit=30` 응답으로 최근 미확인 메일을 렌더한다.
   - 탭 옆 숫자는 가능한 한 “현재 통합 받은편지함의 전체 미확인 수”에 가깝게 표시한다.
   - 이를 위해 Welcome 보드 데이터 로딩 시 이미 호출하는 `/mail/accounts` 응답의 각 account `folders` 중 `type === 'inbox'` 인 폴더의 `unread_count`를 합산한다.
   - 계정 메타데이터를 얻지 못하거나 unread_count가 없으면 `recentUnreadMail.length`를 fallback으로 사용한다.

2. **부모 → iframe payload**
   - [src/App.jsx](../src/App.jsx)는 기존 `recentUnreadMail` 배열과 함께 `recentUnreadMailCount` 숫자를 payload에 포함한다.
   - 기존 payload 구조와 호환되도록 `recentUnreadMailCount`가 없어도 iframe은 배열 길이로 카운트를 표시한다.

3. **iframe 렌더링**
   - [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html)의 `최근 미확인 메일` 탭 텍스트 오른쪽에 `<span id="recentUnreadMailCount" class="tab-count">`를 둔다.
   - 데이터가 들어오기 전에는 빈 span으로 숨긴다.
   - 데이터 수신 후 `wbUpdateRecentUnreadMailCount(count)`로 숫자를 표시한다.
   - 숫자는 작은 pill/badge 형태로 표시하고, active 탭 색상과 어울리도록 `var(--accent-soft)`, `var(--accent)`를 사용한다.

### 21.2 파일별 변경 계획

| 파일 | 변경 | 상태 |
|---|---|---|
| [src/App.jsx](../src/App.jsx) | `/mail/accounts` 응답에서 inbox unread_count 합산, `recentUnreadMailCount` payload 추가 | 완료 |
| [template/WelcomeBoard_whiteThema.html](../template/WelcomeBoard_whiteThema.html) · [blue](../template/WelcomeBoard_blueThema.html) | 탭 제목 옆 count badge 마크업/CSS/렌더 함수 추가 | 완료 |
| [MDfiles/WelcomeBoard.md](./WelcomeBoard.md) | 요구사항과 구현 방안 기록 | 완료 |

### 21.3 검증 항목

- Welcome 보드 로딩 후 `최근 미확인 메일` 탭 제목 오른쪽에 숫자 badge가 보인다.
- 미확인 메일이 0개이면 `0`이 표시된다.
- 목록 데이터만 있고 별도 count가 없는 구버전 payload에서도 배열 길이를 표시한다.
- 기존 탭 전환, 7개 행 높이 고정, 8번째 이후 스크롤 동작은 유지된다.
