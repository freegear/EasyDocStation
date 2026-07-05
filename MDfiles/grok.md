# Groq/내부 LLM 공통 Query Rewrite 정책

## 목적

Groq Cloud LLM과 내부 LLM(Ollama/local mode)이 서로 다른 모델이어도, 위치 찾기류 질문은 같은 검색 입력을 사용해야 한다.

따라서 모델 호출 전에 공통 Query Rewrite 레이어를 둔다.

## 문제

아래 두 질문은 사용자의 의도는 같지만 기존 처리에서는 다르게 동작할 수 있었다.

```txt
연세대 교직원식당 한경관 어울샘 은 어디에 있어 ?
연세대 교직원식당 한경관 어울샘 자료는 어디에 있어 ?
```

두 번째 질문은 `자료`라는 target hint가 있어 `/api/questions` locate 경로로 안정적으로 들어간다.
첫 번째 질문은 `어디`라는 locate 신호는 있지만 자료 유형어가 없어 일반 RAG 질의로 흐를 수 있다.

## 결정

Groq/내부 LLM을 분기하기 전에 질문을 먼저 정규화한다.

1. 입력 한글은 NFC로 정규화한다.
2. `"X 은 어디에 있어?"`처럼 대상은 있지만 자료 유형어가 없는 질문은 `"X 자료는 어디에 있어?"`로 내부 재작성한다.
3. `"어디에 있어?"`, `"찾아줘"`, `"링크 줘"`처럼 명령만 있는 질문은 직전 사용자 발화에서 대상어를 추출해 `"대상 자료는 어디에 있어?"`로 재작성한다.
4. 사용자 말풍선에는 원문을 유지하고, 검색/RAG/LLM 호출에는 `resolvedQuestion`을 사용한다.

## 적용 경로

- `/api/questions` locate/summary 분기
- `/posts/search` 키워드 검색
- `/rag/search` LanceDB 검색
- Groq Chat Completions 호출
- 내부 LLM/Ollama 호출

즉, provider가 Groq이든 내부 LLM이든 같은 `resolvedQuestion`을 받기 때문에 같은 검색 근거를 기반으로 답변한다.

## Locate 실패 시 RAG fallback

위치 찾기 질문은 먼저 `/api/questions`의 PostgreSQL locate 인덱스에서 찾는다.
결과가 0건이면 서버가 동일 `keywords`로 RAG/LanceDB fallback 검색을 수행한다.

흐름:

```txt
resolvedQuestion
-> /api/questions
-> PostgreSQL locate 검색
-> 결과 0건
-> RAG fallback 검색
-> channel_id/post_id/attachment_id reference를 frontend deeplink로 변환
```

이 단계는 Groq/내부 LLM 호출 전에 끝난다.
따라서 Groq provider와 내부 LLM provider는 모두 같은 reference 목록을 받는다.

## 구현 파일

- [src/components/GroqPanel.jsx](../src/components/GroqPanel.jsx)
  - `normalizeUserQuestionText`
  - `extractLocateSubject`
  - `isShortLocateFollowup`
  - `resolveQuestionForRetrieval`
- [server/application/usecase/HandleUserQuestionUseCase.js](../server/application/usecase/HandleUserQuestionUseCase.js)
  - locate 결과 0건일 때 RAG fallback 호출
- [server/services/ragLocateFallback.js](../server/services/ragLocateFallback.js)
  - RAG 검색 결과 metadata를 링크 가능한 reference로 정규화
- [server/intent/parser/RuleBasedIntentParser.js](../server/intent/parser/RuleBasedIntentParser.js)
  - 서버 직접 호출 대비 NFC 정규화

## 검증 기준

다음 두 질문은 `/api/questions` locate 경로에서 유사한 reference를 반환해야 한다.

```txt
연세대 교직원식당 한경관 어울샘 은 어디에 있어 ?
연세대 교직원식당 한경관 어울샘 자료는 어디에 있어 ?
```
