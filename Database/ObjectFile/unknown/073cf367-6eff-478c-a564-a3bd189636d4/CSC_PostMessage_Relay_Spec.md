# CSC-AI postMessage 통신 규격서

## 통신 방식

iframe(AI) ↔ parent(CSC) 간 `window.postMessage` 사용

---

## 요청 (AI → CSC)

```json
{
  "type": "CSC_DATA_REQUEST",
  "requestId": "(자동 생성되는 고유 ID)",
  "endpoints": [
    {
      "id": "devices",
      "endpoint": "/api/nm-res/dev-group/v1/getPageDevInfoView",
      "payload": {
        "devPageReqDto": {
          "key": "", "devStatus": -1, "devSubType": -1,
          "devCharacter": 0, "sortField": "name", "sortType": "asc",
          "pageNum": 1, "pageSize": 100, "orgId": 1
        }
      },
      "paginate": true
    }
  ]
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | string | `"CSC_DATA_REQUEST"` 고정 |
| `requestId` | string | 요청/응답 매칭용 고유 ID (AI 측에서 자동 생성, CSC는 응답 시 그대로 반환) |
| `endpoints[].id` | string | 데이터 식별 키 (응답 시 동일 키 사용) |
| `endpoints[].endpoint` | string | CSC API 경로 |
| `endpoints[].payload` | object | API 요청 body |
| `endpoints[].paginate` | boolean | `true`: 전체 페이지 수집 필요 |
| `endpoints[].depends_on` | string | 선행 endpoint id (해당 결과 기반으로 호출) |

---

## 응답 (CSC → AI)

### 성공

```json
{
  "type": "CSC_DATA_RESPONSE",
  "requestId": "(요청 시 전달된 값 그대로 반환)",
  "success": true,
  "data": {
    "devices": [ ... ],
    "monitor": [ ... ]
  }
}
```

### 실패

```json
{
  "type": "CSC_DATA_RESPONSE",
  "requestId": "(요청 시 전달된 값 그대로 반환)",
  "success": false,
  "error": "에러 메시지"
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | string | `"CSC_DATA_RESPONSE"` 고정 |
| `requestId` | string | 요청의 requestId와 동일 |
| `success` | boolean | 성공 여부 |
| `data` | object | endpoint id를 키로 한 응답 데이터 |
| `error` | string | 실패 시 에러 메시지 |

---

## 요청되는 endpoint 조합

| 질의 유형 | endpoints |
|-----------|-----------|
| 자산/보안인증서/장비분류 | `devices` |
| 모니터링 | `devices`, `monitor` |
| 취약점 점검/Running Config | `devices`, `config_files`, `config_content` |
| 취약점 체크리스트 | 없음 |

---

## endpoint 상세

### devices

```
POST /api/nm-res/dev-group/v1/getPageDevInfoView
paginate: true
```

### monitor

```
POST /api/nm-monitor/monitor/v1/queryMonitorDataList
paginate: true
```

### config_files

```
POST /api/nm-ops/config/file/v1/queryConfigFileInPage
paginate: true
```

### config_content

```
POST /api/nm-ops/config/file/v1/getConfigFileContent
depends_on: config_files
```

`config_files` 결과의 각 항목에 대해 `{ "aId": item.id, "aEncoding": "GBK" }`로 개별 호출

---

## 제약사항

- 타임아웃: **30초**
- `paginate: true`인 endpoint는 `data.list` / `data.total` 기준으로 전체 페이지 수집
- `depends_on`이 있는 endpoint는 선행 endpoint 완료 후 처리
- API 호출 프로토콜은 기존 CSC 방식 동일 (Base64 인코딩, `X-Access-Token` 헤더)
