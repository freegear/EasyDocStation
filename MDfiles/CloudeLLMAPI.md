# Cloud LLM API 연동

## 1. 목적

EasyDocStation의 기존 로컬 Gemma(Ollama) 호출을 유지하면서 사이트 관리자가 다음 AI/LLM 중 하나를 선택하도록 구현한다.

1. **Gemma AI (Local Install)** — 기존 Ollama `/api/chat`
2. **DeepSeek API** — DeepSeek OpenAI 호환 Chat Completions API
3. **Meta Muse Code** — Meta Model API의 OpenAI 호환 Responses API

사이트 관리의 **AI/LLM 설정** 메뉴는 **RAG 학습 설정** 바로 위에 표시된다. 저장된 공급자는 일반 AI 대화뿐 아니라 `requestChatCompletion` 공통 경로를 사용하는 요약 기능에도 적용된다.

## 2. 구현 파일

- `src/components/SiteAdminPage.jsx`
  - 공급자 3종 선택
  - DeepSeek API Key/Model/Base URL 입력
  - Meta Muse Code API Key/Model/Base URL 입력
  - 공급자별 연결 테스트
- `server/llmClient.js`
  - Ollama, DeepSeek, Meta 호출 어댑터
  - 선택 공급자 분기와 Ollama 폴백
- `server/routes/admin.js`
  - 설정 정규화
  - `POST /api/admin/deepseek/test`
  - `POST /api/admin/meta/test`
- `server/routes/ai.js`
  - `POST /api/ai/chat`에서 공통 LLM 클라이언트 사용
- `config.json.example`
  - 배포용 기본 설정 예시

## 3. 설정 구조

```json
{
  "agenticai": {
    "provider": "ollama",
    "fallback_to_ollama": true,
    "deepseek": {
      "enabled": false,
      "api_key": "",
      "model": "deepseek-v4-flash",
      "base_url": "https://api.deepseek.com"
    },
    "meta": {
      "enabled": false,
      "api_key": "",
      "model": "muse-spark-1.2",
      "base_url": "https://api.meta.ai/v1"
    }
  }
}
```

`provider` 값은 `ollama`, `deepseek`, `meta` 중 하나다. 기존 설치와의 호환을 위해 기본값은 `ollama`다. 화면에서 DeepSeek 또는 Meta를 선택해 저장하면 해당 설정의 `enabled`도 함께 활성화된다.

Meta 모델은 `muse-spark-1.2`(Standard)와 `muse-spark-1.2-contributor`(Contributor) 중에서 선택할 수 있다. Contributor 서비스에는 공급자의 별도 데이터 처리 조건이 적용될 수 있으므로 민감정보 전송 전에 계정 약관을 확인한다. Base URL은 운영 환경에 맞게 편집할 수 있다.

## 4. 호출 흐름

```text
사용자 AI 요청
  -> POST /api/ai/chat
  -> requestChatCompletion()
  -> config.json의 agenticai.provider 확인
     ├─ ollama   -> 로컬 Gemma /api/chat
     ├─ deepseek -> {base_url}/chat/completions
     └─ meta     -> {base_url}/responses
```

DeepSeek 호출은 기존 Ollama payload를 Chat Completions의 `messages` 형식으로 변환한다. Meta 호출은 `messages`를 Responses API의 `input` 배열과 `input_text` 콘텐츠로 변환해 `POST {base_url}/responses`로 전송한다. 두 공급자의 응답은 공통 구조인 `content`, `provider`, `model`로 정규화한다.

`fallback_to_ollama=true`이면 DeepSeek/Meta의 인증 오류, 타임아웃, 네트워크 오류, 비정상 HTTP 응답 때 로컬 Gemma로 재시도한다. 폴백 결과에는 서버 내부적으로 `fallbackFrom`과 `fallbackReason`이 남는다. 폴백을 원하지 않으면 이 옵션을 끈다.

## 5. 관리자 사용 방법

1. 사이트 관리자 권한으로 **사이트 관리**를 연다.
2. **RAG 학습 설정** 위의 **AI/LLM 설정**을 연다.
3. Gemma AI, DeepSeek API, Meta Muse Code 중 하나를 선택한다.
4. 클라우드 공급자를 선택한 경우 API Key와 계정에서 허용된 Model을 입력한다.
5. 해당 공급자의 **연결 테스트**를 실행한다.
6. **설정 저장**을 누른다.

설정은 요청마다 서버의 `config.json`에서 읽기 때문에 일반적인 공급자 전환에는 서버 재시작이 필요 없다.

## 6. API 및 오류

### DeepSeek 연결 테스트

`POST /api/admin/deepseek/test`

사이트 관리자만 호출할 수 있다. API Key가 없으면 HTTP 400, 외부 호출 실패는 HTTP 502를 반환한다.

### Meta 연결 테스트

`POST /api/admin/meta/test`

사이트 관리자만 호출할 수 있다. API Key가 없으면 HTTP 400, 외부 호출 실패는 HTTP 502를 반환한다.

### 실제 AI 호출

`POST /api/ai/chat`

로그인 사용자가 호출하며 응답은 기존 프론트엔드 호환을 위해 NDJSON 한 줄로 반환한다.

## 7. 보안 및 운영 검토

- API Key 입력은 `type=password`로 화면에서 가린다.
- 키는 브라우저에서 공급자 API로 직접 보내지 않고 EasyDocStation 백엔드를 통해서만 사용한다.
- 현재 프로젝트의 기존 설정 방식에 맞춰 키는 서버의 `config.json`에 저장된다. 따라서 운영 서버에서는 파일 권한을 서비스 계정으로 제한하고 `config.json`을 Git에 커밋하거나 백업 로그에 노출하지 않아야 한다.
- 환경 변수 `DEEPSEEK_API_KEY`, `MODEL_API_KEY` 또는 `META_API_KEY`도 런타임 대체 값으로 사용할 수 있다.
- 외부 LLM을 선택하면 질문, RAG 컨텍스트, 요약 대상 데이터가 해당 공급자 서버로 전송될 수 있다. 조직의 개인정보·기밀정보 정책과 공급자의 데이터 처리 조건을 확인해야 한다.
- 로그에는 API Key나 Authorization 헤더를 기록하지 않는다. 외부 오류 본문은 진단을 위해 최대 300자로 제한한다.
- Meta Muse Code는 `MODEL_API_KEY`와 OpenAI 호환 Responses API를 사용한다. 본 구현은 의존성 추가 없이 `POST /v1/responses`를 호출한다.

## 8. RAG 문서 처리의 공급자 선택

PDF/문서의 일반 텍스트 및 Markdown 변환은 Docling, MarkItDown, Unstructured, pypdf 같은 문서 파서를 사용하며 LLM을 호출하지 않는다. 이미지 설명과 텍스트 추출 실패 후 최종 Vision OCR 단계는 `config.json`의 `agenticai.provider`를 실행 시점에 읽어 다음과 같이 분기한다.

- `ollama`: 로컬 Gemma Vision 호출
- `deepseek`: DeepSeek OpenAI 호환 이미지 메시지 호출
- `meta`: Meta Responses API의 `input_image` 호출

Meta/DeepSeek 호출 실패 시 `fallback_to_ollama=true`인 경우에만 Gemma로 폴백한다. `false`이면 Gemma를 호출하지 않고 해당 이미지 설명 또는 OCR 결과를 비워 기존 비LLM 파싱 결과만 사용한다. DeepSeek 모델이 이미지 입력을 지원하지 않으면 공급자 오류가 발생할 수 있으므로 Vision 지원 모델을 설정해야 한다. API 키는 학습 작업 payload에 복사하지 않고 Python 트레이너가 서버의 `config.json`에서 직접 읽는다.

## 9. 검증

- `node --check server/llmClient.js`
- `node --check server/routes/admin.js`
- `node --check server/index.js`
- `npm run build`

실제 외부 연결 테스트는 유효한 DeepSeek/Meta API Key와 해당 계정의 모델 접근 권한이 있어야 완료된다.
