# EmailService.md

메일 서비스의 요약 품질 개선 요구사항을 기록한다.

## 1. 메일 요약에서 발신자 이름 명시

메일 요약은 메일 헤더에 이미 확인된 발신자 정보가 있는 경우, 요약 문장에서 `발신자`처럼 모호한 표현만 사용하면 안 된다.

예를 들어 아래와 같은 메일 메타데이터가 확인된 경우:

- 보낸 사람: `Keisuke Uchida <kuchida@inbis.jp>`
- 본문 서명: `NWC 内田`

요약 결과는 다음처럼 작성하면 안 된다.

```txt
발신자가 자료 수신 및 Wi-Fi 메쉬 기기 제안에 대해 감사 인사를 전함.
```

반드시 확인된 이름 또는 조직/이름을 포함해 작성해야 한다.

권장 표현:

```txt
Keisuke Uchida가 자료 수신 및 Wi-Fi 메쉬 기기 제안에 대해 감사 인사를 전함.
```

또는 본문 서명과 회사명이 함께 확인되는 경우:

```txt
네트워크 코퍼레이션의 내田惠介가 자료 수신 및 Wi-Fi 메쉬 기기 제안에 대해 감사 인사를 전함.
```

## 2. 적용 대상

이 규칙은 메일 요약 결과의 모든 자연어 문장에 적용한다.

- 중요 포인트
- 중요 내용 요약
- 액션 아이템
- 일정 비고
- 복사되는 요약 텍스트

## 3. 작성 원칙

1. 메일 헤더의 `from_name`, `from_email`에 이름이 있으면 그 이름을 우선 사용한다.
2. 본문 서명에 더 명확한 이름/회사명이 있으면 헤더 정보와 함께 사용할 수 있다.
3. 이름을 알 수 있는 경우 `발신자`, `상대방`, `일본 측` 같은 일반 표현만 단독으로 사용하지 않는다.
4. 이름이 불명확한 경우에만 `발신자` 또는 `상대방`을 사용한다.
5. 이름과 역할을 추측하지 않는다. 메일에 확인된 이름, 이메일, 서명, 회사명만 사용한다.

## 4. 프롬프트 반영 기준

메일 요약용 system prompt 또는 fact 추출 prompt에는 아래 지침을 포함해야 한다.

```txt
메일 헤더 또는 본문 서명에서 발신자 이름이 확인되면, 요약 문장에 반드시 그 이름을 포함하세요.
발신자를 알 수 있는데도 "발신자", "상대방", "일본 측"처럼 모호한 표현만 사용하지 마세요.
단, 이름/회사명/역할은 메일에 확인된 정보만 사용하고 추측하지 마세요.
```

## 5. 기대 결과 예시

입력 메일:

- 제목: `Re: Re: THIRD社とのオンラインMTGについて_NWC内田`
- 보낸 사람: `Keisuke Uchida <kuchida@inbis.jp>`
- 본문 주요 내용:
  - 장지영에게 인사
  - 사전에 보낸 자료 수신에 대한 감사
  - Wi-Fi 메쉬 기기 제안에 대한 감사
  - 일본 측에서 필요한 사양과 예상 사용 사례를 내부 확인 후 방향성을 다시 연락하겠다고 안내

개선 전:

```txt
발신자가 자료 수신 및 Wi-Fi 메쉬 기기 제안에 대해 감사 인사를 전함.
```

개선 후:

```txt
Keisuke Uchida가 자료 수신 및 Wi-Fi 메쉬 기기 제안에 대해 감사 인사를 전함.
```

중요 내용 요약 개선 후:

```txt
Keisuke Uchida는 사전에 전달받은 자료와 Wi-Fi 메쉬 기기 제안에 대해 감사 인사를 전했습니다. 일본 측에서 필요한 사양과 예상 사용 사례를 내부적으로 확인한 뒤, 프로젝트 방향성을 다시 연락하겠다고 안내했습니다.
```

## 6. 코드 반영 기준

이 규칙은 `server/mail/mailSummary.js`의 메일 요약 파이프라인에 반영한다.

- 메일 메타데이터에서 확인된 발신자 이름을 요약 입력에 포함한다.
- fact 추출 prompt에 확인된 발신자 이름 사용 규칙을 포함한다.
- JSON 요약 생성 prompt에 확인된 발신자 이름 사용 규칙을 포함한다.
- 규칙 기반 fallback 문장도 `발신자` 대신 확인된 이름을 우선 사용한다.
- 모델 응답에 여전히 `발신자가`, `발신자는`, `The sender`, `差出人は` 같은 일반 표현이 남으면 확인된 이름으로 후처리한다.


## 7. 요약 결과에 Prompt 헤더가 노출되는 문제

### 7.1 증상

메일 요약 결과의 `중요 포인트` 영역에 아래와 같은 문구가 그대로 표시될 수 있다.

```txt
**Role:** Assistant that extracts only explicitly verifiable facts from business emails.
**Language:** Must be in Korean only.
**Constraints:**
```

이 문구는 메일 본문의 사실이 아니라 LLM에게 전달한 지시문 또는 prompt 템플릿의 헤더다. 사용자 화면에는 절대 표시되면 안 된다.

### 7.2 원인 분석

이 문제는 `<think>` 사고 과정 노출과 비슷하지만, 정확히는 **prompt leakage** 또는 **instruction echo** 문제다.

가능한 원인은 다음과 같다.

1. Qwen/GROQ 모델이 fact 추출 prompt의 구조화된 헤더를 응답에 그대로 복사한다.
2. `Role`, `Language`, `Constraints` 같은 영어 섹션명이 모델에게 "출력해야 할 목록"처럼 오인될 수 있다.
3. fact 추출 단계에서 이 문구가 bullet 목록으로 들어오면, 다음 JSON 요약 단계는 이를 `[확인된 사실 목록]`의 일부로 믿고 `keyPoints`에 반영한다.
4. 현재 `<think>` 제거 로직은 reasoning trace에는 대응하지만, `**Role:**`, `**Language:**`, `**Constraints:**` 같은 prompt 헤더 문구는 별도 패턴으로 잡지 않으면 남을 수 있다.
5. JSON 구조 자체는 유효하므로 parse 오류가 발생하지 않고, 화면에는 정상 요약처럼 표시된다.

즉, 이 문제는 메일 내용 분석 오류가 아니라 **LLM 지시문이 요약 데이터로 역류한 문제**다.

### 7.3 `<think>` 문제와의 차이

`<think>` 문제는 모델의 내부 사고 과정이 노출되는 것이다.

반면 `**Role:**`, `**Language:**`, `**Constraints:**` 문제는 모델이 system prompt 또는 fact prompt의 지시문을 출력물로 복사하는 것이다.

둘 다 사용자에게 보여서는 안 되지만, 제거 패턴은 다르게 잡아야 한다.

### 7.4 해결 방향

코딩 시에는 다음 방향으로 처리한다.

1. fact 추출 prompt에서 `Role/Language/Constraints` 형태의 마크다운 헤더를 사용하지 않는다.
2. prompt를 자연어 지시문 중심으로 바꾸고, 출력 형식은 "메일 사실 bullet만"으로 제한한다.
3. fact 추출 결과에서 prompt 헤더 패턴을 제거한다.
4. JSON 요약 결과의 모든 문자열 필드에서도 prompt 헤더 패턴을 제거한다.
5. prompt 헤더가 감지되면 해당 요약은 품질 실패로 기록한다.
6. 제거 후 핵심 포인트가 부족하면 재시도 또는 fallback을 수행한다.

### 7.5 제거해야 할 Prompt Leakage 패턴

후처리에서는 최소한 아래 패턴을 제거해야 한다.

```txt
**Role:**
Role:
**Language:**
Language:
**Constraints:**
Constraints:
**Output:**
Output:
**Task:**
Task:
Assistant that extracts
Must be in Korean only
Only explicitly verifiable facts
```

이 패턴은 원본 메일 본문이 아니라 **LLM 응답 결과**에만 적용한다. 원본 메일 본문은 수정하지 않는다.

### 7.6 Prompt 작성 개선안

fact 추출 prompt는 아래처럼 간단한 자연어 지시문으로 작성하는 편이 안전하다.

```txt
업무 이메일에서 메일 본문에 명시적으로 확인되는 사실만 한국어 bullet 목록으로 작성하세요.
메일에 없는 내용은 추측하지 마세요.
역할, 언어, 제약 조건 같은 prompt 지시문은 출력하지 마세요.
출력에는 메일에서 확인된 업무 사실만 포함하세요.
```

피해야 할 형식:

```txt
**Role:** Assistant that extracts only explicitly verifiable facts from business emails.
**Language:** Must be in Korean only.
**Constraints:**
```

Qwen 계열 모델은 이런 헤더를 출력 형식으로 오해하거나 그대로 echo할 수 있다.

### 7.7 검증 기준

1. `중요 포인트`에 `**Role:**`이 표시되지 않는다.
2. `중요 포인트`에 `**Language:**`가 표시되지 않는다.
3. `중요 포인트`에 `**Constraints:**`가 표시되지 않는다.
4. `summary`, `actionItems.task`, `schedule.notes`에도 prompt 헤더가 표시되지 않는다.
5. raw 응답에 prompt leakage가 있어도 저장되는 `summary_json`에는 들어가지 않는다.
6. prompt leakage 감지 시 quality flag에 기록한다.

### 7.8 권장 Quality Flag

```txt
prompt_leakage_detected
prompt_leakage_removed
prompt_leakage_retry
prompt_leakage_fallback
```

### 7.9 운영 판단

GROQ/Qwen 모델을 계속 사용할 경우, reasoning trace 제거만으로는 충분하지 않다.

Qwen 계열은 prompt 구조를 답변으로 따라 쓰는 경향이 있을 수 있으므로, 메일 요약 파이프라인에는 다음 두 가지 정제가 모두 필요하다.

1. reasoning trace 정제
2. prompt leakage 정제

특히 fact 추출 단계의 결과는 다음 JSON 요약 단계의 근거가 되므로, prompt leakage는 fact 단계에서 먼저 제거하는 것이 가장 중요하다.

### 7.10 코드 반영 내용

`server/mail/mailSummary.js`에 prompt leakage 방어 로직을 반영한다.

적용 내용:

1. LLM 응답에서 `Role`, `Language`, `Constraints`, `Output`, `Task` 형태의 prompt 헤더를 감지한다.
2. `Assistant that extracts`, `Must be in Korean only`, `Only explicitly verifiable facts` 같은 prompt 본문 문구도 감지한다.
3. fact 추출 결과를 `parseFactLines()`에서 정제하여, 다음 JSON 요약 단계로 prompt 문구가 넘어가지 않도록 한다.
4. JSON 요약 응답의 `keyPoints`, `summary`, `actionItems.task`, `schedule.notes` 등 사용자에게 표시되는 모든 문자열 필드에서 prompt leakage를 한 번 더 제거한다.
5. prompt leakage가 발견되면 `quality_flags`에 `prompt_leakage_detected`, `prompt_leakage_removed`, `prompt_leakage_retry`를 기록한다.
6. 같은 정제 경로에서 기존 `<think>` reasoning trace 제거도 함께 처리하여, 모델 내부 사고 과정과 prompt echo를 모두 차단한다.

검증:

```txt
node -c server/mail/mailSummary.js
npm run build
```

위 검증을 통과해야 한다.
