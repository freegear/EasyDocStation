# Qrok/GROQ 서비스 연동 작업 기록

작성일: 2026-07-04

## 목표

EasyDocStation의 AgenticAI 지능형 비서와 메일 요약 서비스에서 GROQ LLM 서비스를 선택적으로 사용할 수 있도록 구축한다.

주요 목적은 다음과 같다.

- System 설정 메뉴의 `AgenticAI 설정` 안에 `GROQ 설정` 영역을 추가한다.
- GROQ 사용 여부를 옵션으로 켜고 끌 수 있게 한다.
- 기존 로컬 Ollama 또는 다른 LLM 서비스와 병행하여 비용을 절감할 수 있게 한다.
- GROQ API Key는 프로젝트 루트의 `config.json`에 저장한다.
- 메일 요약 서비스에서 `Enable GROQ` 옵션이 켜져 있을 때 GROQ를 호출할 수 있게 한다.

## 요청 사항 정리

사용자 요청 원문에서는 `Qrok`, `QROK`, `GROQ` 표기가 함께 사용되었다. 실제 연동 대상은 Groq Cloud LLM API로 보고, 구현 명칭은 `GROQ`로 통일한다.

필수 요구사항:

1. System 설정 메뉴의 `AgenticAI 지능형 비서 설정` 페이지에 `GROQ 설정` 영역을 추가한다.
2. `가능한 GROQ를 사용` 옵션을 제공한다.
3. 다른 LLM 서비스와 병행하여 운영 비용을 줄일 수 있게 한다.
4. `GROQ API_KEY`는 프로젝트 루트의 `config.json`에 저장한다.
5. LLM 호출 시 GROQ provider를 선택할 수 있게 한다.
6. 메일 요약 서비스에는 별도의 `Enable GROQ` 옵션을 두고, 해당 옵션이 켜져 있을 때 GROQ를 호출한다.

## 결론: LLM 호출 시 GROQ 호출 가능 여부

가능하다.

GROQ는 OpenAI 호환 Chat Completions API를 제공하므로, 현재 Ollama를 호출하는 서버 측 LLM 호출부에 provider adapter를 추가하면 된다. 메일 요약 서비스에서는 `Enable GROQ`와 `메일 요약에 GROQ 사용` 옵션이 모두 켜져 있고 `api_key`가 존재할 때 GROQ를 우선 호출하도록 구성한다.

권장 호출 정책:

- GROQ 사용 가능: GROQ 우선 호출
- GROQ 비활성화: 기존 Ollama 또는 다른 기본 LLM 호출
- GROQ 장애/API quota 초과/API Key 누락: Ollama fallback
- fallback 발생: 메일 요약 metadata에 provider와 fallback 사유 기록

## 현재 코드 확인

### 설정 화면

- 사이트 관리 화면 파일: `src/components/SiteAdminPage.jsx`
- 좌측 메뉴에는 이미 `AgenticAI 설정` 탭이 존재한다.
- `AgenticAI 지능형 비서 설정` 페이지에서 현재 관리하는 항목:
  - `num_predict`
  - `num_ctx`
  - `history`
  - `language`
  - `operation_mode`
- 설정 저장 함수는 `handleSaveConfig()`이고, `activeTab === 'agenticai'`일 때 `configData.agenticai`와 `agenticai_operation_mode`를 저장한다.

### config.json 저장 구조

- 설정 저장 API: `PUT /api/admin/config`
- 서버 파일: `server/routes/admin.js`
- 현재 방식은 기존 `config.json`을 읽고 요청 body를 merge한 뒤 다시 저장한다.
- `agenticai` 설정은 저장 전 `normalizeAgenticAiConfig()`를 통과한다.
- 따라서 GROQ 설정도 `agenticai.groq` 또는 최상위 `groq` 구조로 추가할 수 있다.

권장 구조:

```json
{
  "agenticai": {
    "num_predict": 2048,
    "num_ctx": 4096,
    "history": 6,
    "language": "ko",
    "groq": {
      "enabled": false,
      "api_key": "",
      "model": "llama-3.1-8b-instant",
      "base_url": "https://api.groq.com/openai/v1",
      "use_for_mail_summary": false
    }
  }
}
```

### AgenticAI 패널

- 기존 패널 파일: `src/components/GroqPanel.jsx`
- 현재 이름은 `GroqPanel`이지만 실제 모델 목록은 `src/data/mockData.js`의 `GROQ_MODELS`를 사용하고, API Key는 `GROQ_API_KEY = 'ollama'`로 되어 있다.
- 실제 호출 흐름은 로컬 Ollama/RAG API와 더 강하게 연결된 상태로 보인다.
- 명칭상 GROQ 패널이 이미 있으므로, 신규 컴포넌트를 만들기보다 설정값을 이 패널의 LLM 호출 경로에서 참조하도록 확장하는 방향이 적합하다.

### 메일 요약 서비스

- 메일 요약 라우트: `server/routes/mail.js`
- 요약 API: `POST /api/mail/messages/:id/summary`
- 실제 요약 함수: `server/mail/mailSummary.js`의 `summarizeMail()`
- 현재 LLM 호출 함수는 `requestOllama()`이며 `/api/chat` 형식으로 Ollama에 요청한다.
- 메일 요약 과정에서 LLM을 호출하는 위치:
  - 언어 감지
  - 번역
  - fact 추출
  - 최종 JSON 요약 생성
  - 재시도 요약 생성

## 구현 방향

### 1. AgenticAI 설정 화면에 GROQ 설정 추가

`src/components/SiteAdminPage.jsx`의 `activeTab === 'agenticai'` 화면에 다음 UI를 추가한다.

- `가능한 GROQ를 사용` 토글
- `Enable GROQ` 토글
- `메일 요약에 GROQ 사용` 토글
- `GROQ API Key` 비밀번호 입력
- `GROQ Model` 입력 또는 선택
- `Base URL` 입력
- `GROQ 연결 테스트` 버튼

저장 시 `handleSaveConfig()`에서 다음 값을 포함한다.

```js
configData.agenticai = {
  num_predict: parseInt(agenticaiForm.num_predict),
  num_ctx: parseInt(agenticaiForm.num_ctx),
  history: parseInt(agenticaiForm.history),
  language: agenticaiForm.language || 'ko',
  groq: {
    enabled: !!agenticaiForm.groq_enabled,
    prefer_when_available: !!agenticaiForm.groq_prefer_when_available,
    api_key: agenticaiForm.groq_api_key || '',
    model: agenticaiForm.groq_model || 'llama-3.1-8b-instant',
    base_url: agenticaiForm.groq_base_url || 'https://api.groq.com/openai/v1',
    use_for_mail_summary: !!agenticaiForm.groq_use_for_mail_summary
  }
}
```

### 2. 서버 설정 정규화 추가

`server/routes/admin.js`의 `normalizeAgenticAiConfig()`에 GROQ 기본값을 추가한다.

필요 필드:

- `enabled`
- `prefer_when_available`
- `api_key`
- `model`
- `base_url`
- `use_for_mail_summary`

API Key는 `config.json` 저장 요구사항에 따라 저장하되, 추후 보안 강화를 위해 환경변수 우선순위를 둘 수 있다.

### 3. 공통 LLM 클라이언트 도입

현재 `server/mail/mailSummary.js`는 `requestOllama()`에 직접 의존한다.

GROQ를 붙이려면 다음 중 하나가 필요하다.

- `requestOllama()`와 `requestGroq()`를 같은 파일에 함께 두고 조건 분기한다.
- 더 좋은 방향은 `server/llmClient.js` 같은 공통 모듈을 만들고 provider별 호출을 위임한다.

권장 인터페이스:

```js
async function requestChatCompletion(payload, options = {}) {
  const provider = resolveProvider(options.task)
  if (provider === 'groq') return requestGroq(payload, options)
  return requestOllama(payload, options)
}
```

GROQ 호출은 OpenAI 호환 Chat Completions API를 사용한다.

- URL: `${base_url}/chat/completions`
- Header:
  - `Authorization: Bearer ${api_key}`
  - `Content-Type: application/json`
- Body:
  - `model`
  - `messages`
  - `temperature`
  - `max_tokens`

Ollama payload의 `options.num_predict`는 GROQ에서는 `max_tokens`로 변환한다.

### 4. 메일 요약에서 Enable GROQ 적용

`server/mail/mailSummary.js`의 모든 `requestOllama()` 호출을 공통 호출로 교체한다.

조건:

```js
const groqEnabled =
  config?.agenticai?.groq?.enabled &&
  config?.agenticai?.groq?.use_for_mail_summary &&
  config?.agenticai?.groq?.api_key
```

`groqEnabled === true`이면 메일 요약의 언어 감지, 번역, fact 추출, 최종 요약 모두 GROQ로 처리한다.

운영 안정성을 위해 GROQ 호출 실패 시 정책을 선택해야 한다.

- 권장 기본값: GROQ 실패 시 Ollama fallback
- fallback 발생 시 `summary_meta.pipeline_version` 또는 `quality_flags`에 `groq_fallback_ollama` 기록

### 5. 비용 절감 운영 방식

GROQ는 빠른 응답이 필요한 요약 작업에 우선 적용하고, 로컬 Ollama는 비용이 들지 않는 fallback으로 유지한다.

권장 옵션:

- 기본 AgenticAI 질의: 기존 로컬 또는 서버 LLM 유지
- 메일 요약: `Enable GROQ` + `메일 요약에 GROQ 사용` 옵션이 켜진 경우 GROQ 사용
- 장애 또는 quota 초과: Ollama fallback

### 6. GROQ 연결 테스트 버튼

AgenticAI 설정 화면의 `GROQ 설정` 카드에 `GROQ 연결 테스트` 버튼을 추가한다.

동작 방식:

- 저장 전 입력된 `GROQ API_KEY`, `GROQ Model`, `Base URL` 값으로 즉시 테스트한다.
- 서버 전용 API `POST /api/admin/groq/test`를 호출한다.
- 서버는 Groq Chat Completions API에 짧은 health check 프롬프트를 전송한다.
- 성공 시 모델명과 응답 시간을 화면에 표시한다.
- 실패 시 HTTP 상태/API Key 오류/quota 오류/네트워크 오류 메시지를 화면에 표시한다.
- API Key는 테스트 응답에 포함하지 않는다.

## 작업 체크리스트

- [x] Qrok/GROQ 연동 요구사항 기록 파일 생성
- [x] 기존 AgenticAI 설정 화면 위치 확인
- [x] 기존 config 저장 API 확인
- [x] 기존 메일 요약 LLM 호출 위치 확인
- [x] LLM 호출 시 GROQ 사용 가능 여부 정리
- [x] 메일 요약 서비스의 `Enable GROQ` 운영 정책 기록
- [x] `config.json.example`에 `agenticai.groq` 기본값 추가
- [x] `config.json`에 `agenticai.groq` 기본값 추가
- [x] `SiteAdminPage.jsx`에 GROQ 설정 UI 추가
- [x] `server/routes/admin.js`에 GROQ 설정 정규화 추가
- [x] `server/index.js`의 AgenticAI 공용 설정 API에 GROQ 설정 포함
- [x] 서버 공통 LLM 클라이언트 추가
- [x] `server/mail/mailSummary.js`에서 GROQ provider 분기 적용
- [x] 메일 요약 metadata에 사용 provider/fallback 기록
- [x] `POST /api/admin/groq/test` GROQ 연결 테스트 API 추가
- [x] AgenticAI 설정 화면의 GROQ 카드에 연결 테스트 버튼 추가
- [ ] GROQ 실패 시 Ollama fallback 테스트

## 구현 시 주의사항

- 실제 서비스명은 `GROQ`로 통일한다. 요청 원문의 `Qrok`, `QROK`는 작업 기록 제목에만 남긴다.
- `config.json`은 실제 API Key를 포함할 수 있으므로 git에 커밋하지 않는 운영이 안전하다.
- 브라우저로 API Key를 직접 노출하지 않도록, GROQ 호출은 반드시 서버에서 수행한다.
- 설정 화면에서 API Key를 읽어올 때는 전체 값을 그대로 보여주기보다 마스킹 표시를 고려한다.
- GROQ는 OpenAI 호환 API지만 Ollama와 응답 JSON 구조가 다르므로 provider adapter가 필요하다.

## 작업 로그

### 2026-07-04

- `./MDfies/qrok.md` 파일에 Qrok/GROQ 서비스 연동 요구사항을 기록했다.
- System 설정 메뉴의 `AgenticAI 지능형 비서 설정` 페이지에 `GROQ 설정` 영역을 추가하는 방향으로 정리했다.
- `config.json` 저장 구조는 `agenticai.groq` 하위에 두는 방식으로 제안했다.
- 메일 요약 서비스에서 `Enable GROQ` 옵션을 통해 GROQ를 호출할 수 있음을 확인하고, 실패 시 Ollama fallback 정책을 기록했다.
- `server/llmClient.js`를 추가하여 Ollama와 GROQ 호출을 공통 adapter로 분리했다.
- `server/mail/mailSummary.js`의 LLM 호출을 `requestChatCompletion()` 기반으로 교체했다.
- `src/components/SiteAdminPage.jsx`의 AgenticAI 설정 페이지에 GROQ 설정 UI를 추가했다.
- `server/routes/admin.js`, `server/index.js`, `config.json.example`, `config.json`에 GROQ 기본 설정 구조를 반영했다.
- `POST /api/admin/groq/test` API를 추가하여 저장 전 GROQ 연결 상태를 확인할 수 있게 했다.
- `GROQ 연결 테스트` 버튼과 테스트 결과 메시지를 GROQ 설정 카드에 추가했다.
