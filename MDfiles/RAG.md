RAG.md

# 사업 문서 정확 검색 및 오분류 방지

사업자등록증, 통장 사본, 주주명부, 정관처럼 문서 종류 자체를 찾는 질문은 벡터 유사도만으로 처리하지 않는다. PDF 학습 단계에서 문서 종류를 분류하고, 검색 단계에서 파일명·문서 종류·본문 표제를 결합해 재순위화한다.

## 학습 기준

- 원본 OCR은 보존한다.
- 검색용 텍스트에는 `사 업 자 등 록 증 → 사업자등록증`, `사업자 등록 번호 → 사업자등록번호`, `법인 등록 번호 → 법인등록번호`, `사업장 소재지` 등의 표준어를 추가한다.
- 파일명과 본문 표식을 이용해 `metadata.document_kind`를 설정한다.
- 지원 종류는 `business_registration`, `bankbook_copy`, `shareholder_registry`, `articles_of_incorporation`, `quotation`, `tax_invoice`, `invoice`, `transaction_statement`이다.
- 회사명의 `주식회사`, `㈜`, 영문 표기 차이는 문서 검색용 확장 문맥에서 함께 고려한다.

## 금액 오분류 방지

- 숫자 후보가 존재한다는 이유만으로 `amount_summary`를 생성하지 않는다.
- `합계`, `총액`, `견적금액`, `청구금액`, `소계`, `공급가액`, `부가세`, `VAT` 등 명시적 금액 표식이 있거나 금액 문서로 분류된 경우에만 금액 요약을 생성한다.
- `business_registration`, `bankbook_copy`, `shareholder_registry`, `articles_of_incorporation`은 금액 요약 생성 대상에서 제외한다.
- 사업자등록번호, 법인등록번호, 계좌번호, 전화번호를 문서 합계로 간주하지 않는다.

## 검색 기준

- `사업자등록증 찾아줘`, `통장 사본 보여줘`, `주주명부 찾아줘` 같은 문서 찾기 질의를 별도로 감지한다.
- 문서 찾기 질의는 최초 후보를 최소 24개까지 확대하고 표준 문서명으로 2차 검색한다.
- 재순위화 우선순위는 `document_kind 정확 일치 → 파일명 일치 → 본문 표제 일치 → 벡터 거리` 순서로 적용한다.
- 기존 채널 ACL, 보안등급, 명시적 검색 범위 및 거리 컷오프는 그대로 유지한다.
- 검색 캐시는 문서 질의 종류를 키에 포함하며 TTL은 기존 600초 정책을 따른다.

## 기존 데이터 반영

코드 배포만으로 기존 LanceDB 레코드는 교정되지 않는다. 오분류된 게시물은 기존 `post_id` 벡터를 삭제하고 게시물 단위로 재학습한다. 재학습 후 캐시를 비우거나 TTL 경과 뒤 다음 질문을 검증한다.

- `실리콘큐브 사업자등록증 찾아줘`
- `실리콘큐브 사업자 번호가 뭐야?`
- `124-87-38462 관련 문서 찾아줘`
- `임종윤 대표 회사의 사업자등록증 보여줘`
- `실리콘큐브 사업장 소재지는?`

사업자등록증에는 `document_kind=business_registration`이 저장되고 `amount_summary`가 없어야 하며, 위 질문에서 해당 게시물이 최우선 근거로 선택되어야 한다.

# 0. RAG 검색 거리 컷오프

LanceDB 벡터 검색의 `score`는 유사도가 아니라 `_distance` 값이다. 값이 작을수록 질문과 가까운 결과이고, 값이 커질수록 관련성이 낮다.

운영 검색에서는 `_distance >= 1.0` 결과를 제외한다.

적용 위치:

- `server/rag_server.py`: 상시 실행 RAG 검색 서버에서 `_distance >= 1.0` 결과를 응답에서 제외한다.
- `server/rag_search.py`: subprocess fallback 검색에서도 같은 기준을 적용한다.
- `server/routes/rag.js`: `/api/rag/search`의 후처리 단계에서 `score >= 1.0` 결과를 다시 제외한다.
- `server/services/ragLocateFallback.js`: `/api/questions` locate 실패 후 RAG fallback reference 생성 전에도 같은 기준을 적용한다.

이 기준은 위치 찾기 질문에도 동일하게 적용한다. 예를 들어 아래 질문으로 RAG fallback이 실행되더라도 `score`가 `1.0` 이상인 reference는 사용자에게 보여주지 않는다.

```txt
연세대 교직원식당 한경관 어울샘 은 어디에 있어 ?
```

주의: `score_threshold` 옵션은 relevance threshold이고, `score`는 distance이므로 둘을 혼동하지 않는다. distance 컷오프는 항상 적용하고, `similarity_score_threshold`는 추가 필터로만 사용한다.

# 1. MarkItDown에서 Docling으로 전환

## 1.1 목적과 현재 상태

현재 운영 코드는 `server/rag_train.py`의 `load_markitdown_text()`와
`ingest_markitdown_document()`를 통해 Word, Excel, PPT/PPTX, XML, HTML, CSV를
Markdown으로 변환한다. Word는 MarkItDown 실패 시 `docx2txt`, PPT/PPTX는 실패 시
`LibreOffice -> PDF -> 기존 PDF 파서`를 fallback으로 사용한다.

Docling 전환의 목적은 단순히 Markdown 변환 라이브러리를 바꾸는 것이 아니다.
Docling의 통합 문서 모델(`DoclingDocument`)을 이용해 제목 계층, 페이지/슬라이드,
표의 행·열 관계, 그림과 provenance를 더 구조적으로 보존하고 이를 RAG 청킹과
메타데이터에 반영하는 것이 목표다.

이 장의 1차 전환 구현은 `server/document_conversion.py`와
`server/rag_train.py`에 반영되어 있다. 기본 변환기는 Docling이며, 설정으로
MarkItDown을 선택하거나 Docling 실패 시 MarkItDown으로 fallback할 수 있다. 다만
기존 LanceDB 레코드는 자동으로 바뀌지 않으므로 3장의 버전드 재학습과 active table
전환은 별도 운영 작업으로 수행해야 한다. 2장에 남아 있는 MarkItDown 설명은 전환 전
운영 기준선과 fallback/rollback 기준으로 본다.

## 1.2 지원 형식 차이와 전환 범위

Docling 공식 지원 형식을 기준으로 다음과 같이 적용한다.

| 파일 유형 | Docling 전환 방안 | 주의사항 |
| --- | --- | --- |
| DOCX | Docling 기본 변환 | 기존 `docx2txt`를 최종 fallback으로 유지 |
| DOC | Docling 변환 | 구형 Office 형식이므로 LibreOffice 설치 필요 |
| XLSX | Docling 기본 변환 | 시트명, 병합 셀, 수식 결과, 숨김 행/열 회귀 검증 필요 |
| XLS | Docling 변환 | 구형 Office 형식이므로 LibreOffice 설치 필요 |
| PPTX | Docling 기본 변환 | 슬라이드 순서, 표, 노트, 도형 내 텍스트 검증 필요 |
| PPT | Docling 변환 | 구형 Office 형식이므로 LibreOffice 설치 필요 |
| HTML/HTM | Docling 기본 변환 | 메뉴·스크립트·스타일 제거 품질 비교 필요 |
| CSV | Docling 기본 변환 | 인코딩, delimiter, 큰 행 수에 대한 별도 제한 필요 |
| XML | 선별 적용 | 일반 XML 전체가 아니라 DocLang, USPTO, JATS, XBRL 등 지원 스키마 중심 |
| PDF/이미지 | 2차 전환 후보 | 현재 PDF/OCR 파이프라인과 GPU 스케줄링 영향 검증 후 결정 |
| ZIP | 직접 변환하지 않음 | 기존처럼 안전하게 해제한 뒤 내부 파일별로 분기 |

초기 전환 범위는 `DOC/DOCX`, `XLS/XLSX`, `PPT/PPTX`, `HTML/HTM`, `CSV`로
제한한다. 일반 XML은 Docling이 임의의 XML 스키마를 범용 Markdown으로 바꾸는
도구라고 가정하면 안 된다. 지원 스키마를 판별할 수 없는 XML은 기존 MarkItDown
또는 안전한 XML 구조 텍스트 추출기를 fallback으로 사용한다.

PDF와 이미지도 Docling이 지원하지만 1차 전환에 포함하지 않는다. 기존 PDF
파이프라인에는 OCR, 문서 종류 분류, 페이지 단위 메타데이터, 이미지 처리와 금액
오분류 방지 로직이 연결되어 있으므로 동일 품질이 검증되기 전에 함께 교체하면
회귀 범위가 지나치게 커진다.

## 1.3 설치와 실행 환경

1. `server/requirements.txt`에 버전을 고정한 `docling` 의존성을 추가한다.
2. 전환 기간에는 `markitdown[all]`을 제거하지 않는다. Docling 운영 검증과
   rollback 기간이 끝난 뒤 제거한다.
3. 실제 서버가 사용하는 Python은 `server/pythonRuntime.js`의
   `getPythonExecutable()`로 결정되므로, 일반 셸의 `python3`가 아니라 **그 실행
   환경**에 Docling을 설치하고 import 테스트를 수행한다.
4. DOC/XLS/PPT를 계속 지원하려면 LibreOffice 설치 여부와 실행 권한을 점검한다.
5. 폐쇄망 또는 재시작 지연을 피해야 하는 환경에서는 필요한 모델 artifact를
   설치 단계에서 미리 다운로드하고 로컬 `artifacts_path`를 지정한다.
6. 운영 시작 전에 Docling 버전, 모델 artifact 버전/해시, Python 버전을 기록한다.

개발 예시는 다음과 같다. 실제 배포에서는 무버전 설치가 아니라 검증된 버전을
고정한다.

```bash
python -m pip install docling
python -c "from docling.document_converter import DocumentConverter; print('docling ok')"
```

Docling은 설정에 따라 OCR, layout, table 모델을 초기화하거나 artifact를 내려받을
수 있다. 따라서 애플리케이션 요청 중 최초 다운로드가 발생하지 않게 하고,
외부 서비스 호출과 외부 plugin은 명시적으로 필요한 경우가 아니면 비활성화한다.

## 1.4 코드 변경 방법

### 1.4.1 변환 adapter 추가

`server/rag_train.py`에 Docling 전용 adapter를 추가한다.

```python
from docling.document_converter import DocumentConverter

_docling_converter = None

def get_docling_converter():
    global _docling_converter
    if _docling_converter is None:
        _docling_converter = DocumentConverter()
    return _docling_converter

def load_docling_document(file_path):
    result = get_docling_converter().convert(file_path)
    document = result.document
    return {
        "markdown": document.export_to_markdown().strip(),
        "json": document.export_to_dict(),
        "status": str(result.status),
    }
```

위 코드는 방향을 보여 주는 예시다. 실제 구현에서는 다음을 추가한다.

- 파일 크기, 페이지 수, 처리 시간 제한
- 변환 status의 성공, 부분 성공, 실패 구분
- 예외와 빈 Markdown 처리
- 지원 확장자 allowlist와 실제 파일 형식 검증
- 프로세스 재사용 시 converter와 pipeline 초기화 비용 측정
- 동시 변환 수 제한
- 필요 시 형식별 `format_options`와 OCR/table 옵션 분리

### 1.4.2 인제스트 함수 일반화

MarkItDown 이름이 박힌 `ingest_markitdown_document()`를 즉시 삭제하지 말고 다음
순서로 일반화한다.

1. 공통 저장·메타데이터·청킹 부분을 `ingest_converted_document()`로 분리한다.
2. 변환기 adapter는 `load_docling_document()`와 `load_markitdown_text()`로 나눈다.
3. 기능 플래그로 변환기 우선순위를 선택한다.
4. Docling 성공 시 공통 인제스트 함수에 Markdown과 구조화 JSON을 전달한다.
5. 실패 시 파일 유형별 fallback을 실행한다.

권장 기능 플래그 예:

```json
{
  "rag": {
    "document_converter": "docling",
    "docling_shadow_compare": true,
    "docling_fallback_to_markitdown": true
  }
}
```

환경변수를 사용할 경우에도 동일한 세 값을 지원하되, 설정 파일과 환경변수의
우선순위를 한 곳에서 결정한다. 요청마다 임의로 변환기를 바꾸지 않는다.

### 1.4.3 산출물 저장

Docling 변환 결과는 기존 파일을 덮어쓰지 않고 다음처럼 별도로 저장한다.

```txt
FileTrainingData/.../converted_docling.md
FileTrainingData/.../converted_docling.json
FileTrainingData/.../conversion_report.json
```

`converted_docling.md`는 검색/검토용이고, `converted_docling.json`은 표 구조,
provenance와 계층 정보를 잃지 않는 재청킹용 원본이다. Markdown만 저장하면
Docling으로 교체하는 핵심 이점의 상당 부분을 잃는다. JSON 산출물은 크기가 클 수
있으므로 보존 기간, 압축, 최대 크기 정책을 둔다.

`conversion_report.json`에는 최소한 아래 항목을 남긴다.

- 원본 파일 해시와 크기
- 변환기와 버전
- 변환 status와 처리 시간
- Markdown/JSON 산출물 경로와 크기
- 추출된 페이지, 표, 그림, 텍스트 항목 수
- warning과 실패 사유
- fallback 사용 여부와 사용한 파이프라인

### 1.4.4 메타데이터 변경

신규 청크에는 다음 값을 사용한다.

- `converted_by`: `docling`
- `converted_format`: 기본 `markdown`, 구조 청크는 `docling_json`
- `parser_version`: 설치된 Docling 버전
- `conversion_status`: `success`, `partial_success`, `failure`
- `fallback_used`: fallback 사용 여부
- `fallback_pipeline`: `markitdown`, `docx2txt`, `libreoffice_pdf`,
  `xml_structured_text` 등
- `page_number`, `sheet_name`, `slide_number`, `row_range`, `heading_path`:
  Docling document의 provenance에서 얻을 수 있는 범위만 저장

필드가 없을 때 추측한 페이지/슬라이드/행 번호를 만들지 않는다. 기존
`converted_by=markitdown` 레코드를 값만 `docling`으로 갱신해서도 안 된다. 원본을
Docling으로 다시 변환하고 재청킹·재임베딩해야 한다.

### 1.4.5 호출부와 관리 기능 변경

다음 위치를 함께 변경한다.

- `server/rag_train.py`
  - `load_docling_document()`와 공통 인제스트 함수 추가
  - 게시글, 댓글, 폴더, ZIP 내부 파일의 Docling 분기 적용
  - 파일별 timeout, 부분 성공, fallback 처리
- `server/requirements.txt`
  - 검증된 Docling 버전 고정
- `server/routes/rag.js`
  - 기존 PPT 비교 API를 `Docling / MarkItDown / LibreOffice-PDF` 비교로 확장
  - 업로드 파일의 MIME/확장자/실제 형식 검증
- `server/rag.js`, `server/scripts/rebuild-rag-all.js`
  - 기존 `markitdown_files` payload 명칭은 호환을 위해 당분간 유지하거나
    `convertible_files`로 버전드 전환
- `src/components/SiteAdminPage.jsx`
  - Docling 변환 시간, 추출량, 오류, fallback과 품질 비교 표시
- 설치 스크립트
  - Docling 및 모델 artifact 사전 설치, LibreOffice 점검 추가

내부 payload의 `markitdown_files`를 한 번에 이름 변경하면 구버전 API나 재학습
스크립트가 깨질 수 있다. 먼저 `convertible_files`를 추가하고 두 키를 읽는 호환
기간을 둔 뒤 제거한다.

## 1.5 파일 유형별 fallback 정책

권장 우선순위는 다음과 같다.

| 파일 유형 | 기본 | 1차 fallback | 최종 fallback |
| --- | --- | --- | --- |
| DOCX | Docling | MarkItDown | docx2txt |
| DOC | Docling + LibreOffice | MarkItDown | 파일 메타데이터만 학습 |
| XLSX | Docling | MarkItDown | CSV/스프레드시트 직접 추출 또는 메타데이터 |
| XLS | Docling + LibreOffice | MarkItDown | 메타데이터만 학습 |
| PPTX | Docling | MarkItDown | LibreOffice -> PDF -> PDF 파서 |
| PPT | Docling + LibreOffice | MarkItDown | LibreOffice -> PDF -> PDF 파서 |
| HTML/HTM | Docling | MarkItDown | BeautifulSoup 본문 추출 |
| CSV | Docling | MarkItDown | CSV parser 행 단위 추출 |
| 지원 XML | Docling | MarkItDown | XML 구조 텍스트 추출 |
| 일반 XML | XML 구조 텍스트 추출 | MarkItDown | 메타데이터만 학습 |

fallback 결과가 성공하더라도 `converted_by=docling`으로 기록하지 않는다. 실제로
성공한 변환기를 기록하고 `fallback_used=true`로 남긴다.

## 1.6 예상 문제점

### 1.6.1 설치 용량과 의존성 충돌

Docling은 MarkItDown보다 문서 구조 분석 기능이 많고 선택한 pipeline에 따라 ML,
OCR 및 문서 처리 의존성이 추가된다. 설치 이미지와 빌드 시간이 커질 수 있고,
PyTorch/NumPy/Pydantic 등 기존 RAG 환경과 버전 충돌이 발생할 수 있다. 기존 서버
환경에 바로 설치하지 말고 동일 lock file로 재현 가능한 별도 검증 환경에서 먼저
설치한다.

### 1.6.2 최초 실행과 오프라인 배포

필요한 모델 artifact가 없으면 최초 변환 때 다운로드 또는 초기화 지연이 발생할 수
있다. 폐쇄망에서는 변환 자체가 실패할 수 있다. 배포 단계에서 artifact를 미리
준비하고 자동 다운로드를 금지한 상태로 cold-start 테스트를 수행한다.

### 1.6.3 CPU/GPU와 메모리 사용량

OCR, layout, table structure 또는 VLM 기능을 켜면 변환 시간이 늘고 RAM/VRAM을
추가로 사용한다. 현재 검색용 bge-m3와 Ollama가 GPU를 사용하는 구조에서는 Docling
GPU 처리가 5장의 GPU 스케줄링 정책을 우회하면 검색 지연 또는 OOM을 일으킬 수
있다. 1차 Office/HTML/CSV 변환은 CPU 기준으로 측정하고, GPU 기능이 필요하면 GPU
브로커의 low-priority training 작업으로 편입한다.

### 1.6.4 처리 속도와 동시성

문서마다 `DocumentConverter`와 pipeline을 새로 초기화하면 대량 재학습이 느려질 수
있다. 반대로 하나의 converter를 무제한 동시 공유하는 것도 thread/process 안전성과
메모리 사용량을 검증하지 않으면 위험하다. 프로세스당 converter 재사용, 제한된
worker 수, 파일별 timeout과 큐 backpressure를 적용한다.

### 1.6.5 Markdown만 사용할 때의 정보 손실

Docling 내부 모델에 표 셀 병합, 위치와 provenance가 있어도
`export_to_markdown()` 결과만 기존 문자 수 기준 청커에 넣으면 해당 정보가
평탄화된다. 품질 향상을 얻으려면 Docling JSON을 보존하고 제목/표/페이지 경계를
인식하는 청커를 추가해야 한다. 초기에는 기존 청커와 구조 청커를 비교하고 같은
문서를 이중으로 운영 테이블에 넣지 않는다.

### 1.6.6 형식별 추출 품질 회귀

- Excel: 수식 자체와 계산 결과, 병합 셀, 다중 시트, 숨김 데이터가 달라질 수 있다.
- PPT/PPTX: 읽기 순서, 도형 그룹, SmartArt, 차트, 발표자 노트가 누락되거나 순서가
  달라질 수 있다.
- Word: 머리말/꼬리말, 각주, 텍스트 상자, 추적 변경 내용 처리 결과가 달라질 수 있다.
- HTML: navigation과 본문의 구분 및 동적 JavaScript 렌더링은 별도 문제다.
- CSV: 인코딩과 delimiter 자동 판별 오류로 열이 합쳐질 수 있다.
- XML: 지원 스키마가 아닌 일반 업무 XML은 변환 대상에서 빠질 수 있다.

따라서 “Docling이 더 구조적이다”라는 이유만으로 모든 파일에서 검색 품질이 자동으로
좋아진다고 판단하지 않는다.

### 1.6.7 보안과 리소스 고갈

업로드 문서는 신뢰할 수 없는 입력이다. 최대 파일 크기, 페이지/행 수, 변환 시간,
압축 해제 크기, 동시 작업 수를 제한한다. 외부 URL을 변환 입력으로 허용하지 않고,
remote service와 외부 plugin은 기본 비활성화한다. LibreOffice 변환과 Docling
변환은 권한을 제한한 worker/container에서 실행하는 것이 바람직하다.

### 1.6.8 기존 데이터와 캐시 불일치

코드만 바꾸면 기존 LanceDB에는 MarkItDown 청크가 남는다. Docling 전환 후에는
원본 파일 해시와 변환기 버전을 기준으로 전체 대상 파일을 재학습하고, 새 테이블을
검증한 뒤 active table을 전환해야 한다. 검색 캐시도 전환 시점에 무효화한다.

## 1.7 단계별 전환 절차

1. **기준선 수집**: 대표 DOCX/XLSX/PPTX/HTML/CSV/XML과 실패 파일 세트를 고정하고
   현재 MarkItDown 결과, 청크, 검색 질문, 처리 시간과 메모리를 저장한다.
2. **Docling shadow 변환**: 운영 벡터에는 쓰지 않고 `converted_docling.*`와 비교
   리포트만 생성한다.
3. **형식별 판정**: 텍스트 누락률, 표 구조, 읽기 순서, 메타데이터, 처리 시간,
   실패율과 RAG 검색 정확도를 비교한다.
4. **canary 적용**: 기능 플래그로 DOCX 또는 PPTX 한 형식부터 Docling을 기본으로
   적용하고 MarkItDown fallback을 유지한다.
5. **새 테이블 재학습**: 기존 active table을 덮어쓰지 않고 새 버전 테이블에 전체
   대상 문서를 재학습한다.
6. **검색 A/B 검증**: 문서 찾기, 표 값, 금액, 날짜, 슬라이드 제목과 출처 이동을
   포함한 질문 세트로 기존/신규 테이블을 비교한다.
7. **운영 전환**: 품질과 처리 용량 기준을 통과하면 active table을 전환한다.
8. **안정화 후 정리**: 관찰 기간이 끝난 후에만 MarkItDown 의존성, 호환 payload와
   비교용 코드를 제거한다.

## 1.8 검증 및 승인 기준

- 대표 파일의 본문 누락률과 핵심 검색 정확도가 MarkItDown 기준보다 낮지 않다.
- Excel/CSV의 헤더와 값 관계, PPT의 슬라이드 순서, Word의 제목 계층이 보존된다.
- `post_id`, `comment_id`, `attachment_id`, `channel_id`, 원본 파일명이 유지된다.
- 페이지/시트/슬라이드 provenance가 실제 원본과 일치한다.
- 부분 성공과 실패가 성공으로 오인되지 않고 fallback 경로가 기록된다.
- 손상 파일 하나가 전체 배치 재학습을 중단시키지 않는다.
- cold-start, 평균 및 P95 변환 시간과 peak RAM/VRAM이 운영 한도 안에 있다.
- 네트워크가 차단된 운영 환경에서도 필요한 형식이 변환된다.
- 새 테이블 장애 시 기존 MarkItDown 테이블과 설정으로 즉시 rollback할 수 있다.

Docling 전환은 위 조건을 파일 유형별로 통과한 경우에만 완료로 판단한다. 모든 형식을
한 번에 전환하지 않으며, MarkItDown 제거는 마지막 단계다.

## 1.9 공식 참고자료

- [Docling 설치](https://docling-project.github.io/docling/getting_started/installation/)
- [지원 입력·출력 형식](https://docling-project.github.io/docling/usage/supported_formats/)
- [DocumentConverter API](https://docling-project.github.io/docling/reference/document_converter/)
- [Pipeline options](https://docling-project.github.io/docling/reference/pipeline_options/)
- [문서 직렬화와 Markdown/JSON 출력](https://docling-project.github.io/docling/concepts/serialization/)

# 2. 기존 MarkItDown 기반 RAG 학습 기준 및 fallback

# 2.1 excel을 학습

Excel 파일은 MarkItDown을 이용해서 Markdown 텍스트로 변환한 뒤 RAG 학습 파이프라인에 넣는다.

목표는 `.xls`, `.xlsx` 파일의 원문 내용을 파일 메타데이터만 학습하는 것이 아니라, 시트명, 표 구조, 행/열 값, 금액/날짜/품목 정보를 검색 가능한 텍스트로 학습하는 것이다.

## 2.1.1 대상 파일

- `.xlsx`
- `.xls`

RAG 학습 페이지의 "학습 데이터 추가", 게시글 첨부 파일 학습, 댓글 첨부 파일 학습에서 Excel 파일을 감지하면 MarkItDown 변환 대상으로 분류한다.

## 2.1.2 처리 흐름

1. 사용자가 Excel 파일을 업로드한다.
2. 서버는 파일 확장자와 content type을 확인해서 Excel 파일인지 판별한다.
3. Excel 파일을 원본 학습 데이터 저장소에 보관한다.
4. MarkItDown으로 Excel 파일을 Markdown으로 변환한다.
5. 변환된 Markdown을 `FileTrainingData` 하위에 `converted.md` 형태로 저장한다.
6. Markdown 텍스트를 기존 TXT/Markdown 학습 로직과 동일하게 청킹한다.
7. 각 청크에 원본 파일명, 확장자, 변환 도구, 시트 정보, 행/열 단서 등 메타데이터를 붙인다.
8. 임베딩을 생성하고 LanceDB에 저장한다.
9. 학습 완료 후 RAG 검색에서 Excel 원문 내용이 검색되는지 확인한다.

## 2.1.2.1 게시글 첨부 Excel 학습

게시글에 첨부 파일이 올라올 때 Excel 파일이 포함되어 있으면 해당 파일도 MarkItDown 기반 Excel 학습 파이프라인에 추가한다.

처리 기준은 다음과 같다.

1. 게시글 등록 또는 수정 시 첨부 파일 목록을 조회한다.
2. 첨부 파일의 확장자 또는 content type이 Excel이면 `excels` 학습 대상으로 분류한다.
3. 게시글 본문 학습 payload에 `excels` 배열을 포함한다.
4. `rag_train.py`는 `post.excels`를 순회하면서 MarkItDown 변환을 수행한다.
5. 변환된 Markdown은 게시글 ID와 첨부 ID 기준으로 `FileTrainingData`에 저장한다.
6. 청크 메타데이터에는 `post_id`, `channel_id`, `attachment_id`, `source`, `file_name`, `type=excel`을 반드시 포함한다.
7. 게시글 수정으로 재학습할 때는 기존 `post_id` 기준 벡터 삭제 후 Excel 첨부도 함께 재학습한다.

게시글 첨부 Excel은 RAG 학습 페이지에 별도로 추가하지 않아도, 게시글 학습 조건에 따라 자동으로 학습되어야 한다.

## 2.1.2.2 댓글 첨부 Excel 학습

댓글에 첨부 파일이 올라올 때 Excel 파일이 포함되어 있으면 댓글 학습 payload에도 `excels` 배열을 포함한다.

댓글 첨부 Excel 청크는 `comment_id`, `post_id`, `channel_id`, `attachment_id`를 함께 저장해서 검색 결과의 출처를 댓글 단위로 추적할 수 있어야 한다.

## 2.1.3 메타데이터

Excel에서 추출된 청크는 최소한 아래 메타데이터를 가진다.

- `source`: 원본 Excel 파일명
- `file_name`: 원본 Excel 파일명
- `source_ext`: `xls` 또는 `xlsx`
- `converted_by`: `markitdown`
- `converted_format`: `markdown`
- `type`: `excel`
- `sheet_name`: 가능하면 시트명
- `original_content`: 변환된 Markdown 원문 또는 해당 청크의 원문 일부
- `file_hash`: 원본 Excel 파일 해시

금액, 날짜, 품목처럼 업무 질의에 자주 쓰이는 값은 기존 RAG 금액 추출 로직과 연결해서 `amount_total`, `amount_candidates`, `currency` 등의 메타데이터를 함께 채운다.

## 2.1.4 실패 처리

MarkItDown 변환이 실패해도 전체 RAG 학습이 중단되면 안 된다.

- 변환 성공: Markdown 본문을 청킹해서 학습한다.
- 변환 실패: 파일명, 확장자, 크기, 업로드 위치 등 메타데이터만 학습하고 실패 사유를 로그에 남긴다.
- 빈 결과: "변환 결과가 비어 있음" 상태로 기록하고 메타데이터 학습으로 fallback 한다.

## 2.1.5 구현 위치

우선 적용 위치는 RAG 학습 페이지의 수동 학습 데이터셋이다.

- `server/routes/rag.js`
  - Excel 파일을 `markitdown_files` 또는 Excel 전용 입력으로 분류한다.
  - 기존 미지원 형식 메타데이터 학습 처리 전에 MarkItDown 변환 대상으로 넘긴다.
  - `getDocumentPathsForPost()`에서 게시글 첨부 Excel을 `excels` 배열로 분류한다.
  - `getDocumentPathsByIds()`에서 댓글 첨부 Excel을 `excels` 배열로 분류한다.
  - `runTraining()`과 `runCommentTraining()` payload에 `excels`를 포함한다.

- `server/rag_train.py`
  - `MarkItDown`을 import한다.
  - `load_markitdown_document(file_path)` 함수를 만든다.
  - Excel 변환 결과를 Markdown 텍스트로 받아 `append_text_chunks()`에 전달한다.
  - 변환된 Markdown 파일을 `FileTrainingData`에 저장한다.
  - 게시글의 `post.excels`와 댓글의 `comment.excels`를 순회하며 `ingest_excel()`을 실행한다.

## 2.1.6 검증 기준

Excel 학습 기능은 아래 기준을 만족해야 한다.

- `.xlsx`, `.xls` 파일이 업로드된다.
- 학습 시작 시 MarkItDown 변환 로그가 남는다.
- 변환된 Markdown 파일이 저장된다.
- 시트의 주요 텍스트, 표 값, 금액, 날짜가 RAG 질의로 검색된다.
- 변환 실패 파일이 있어도 다른 파일 학습은 계속 진행된다.

## 2.1.7 권장 적용 순서

1. RAG 학습 페이지의 수동 데이터셋 Excel 학습부터 적용한다.
2. 결과가 안정적이면 게시글 첨부 Excel 학습으로 확장한다.
3. 마지막으로 댓글 첨부 Excel 학습까지 확장한다.

현재 목표 범위에는 게시글 첨부 Excel 학습을 포함한다. 즉, RAG 학습 페이지의 수동 데이터셋뿐 아니라 게시글에 첨부된 `.xls`, `.xlsx` 파일도 같은 파이프라인으로 학습한다.

PDF 학습은 기존 EasyStation PDF 파이프라인을 유지한다. MarkItDown은 Excel, PPT, Office 문서를 Markdown으로 변환해 RAG 학습 범위를 넓히는 보강 도구로 사용한다.

# 2.2 PPT , PPTX 학습

PPT/PPTX 학습은 비교 검증 결과 MarkItDown 방식이 더 좋은 결과를 보였으므로, 운영 학습 파이프라인의 기본 구조를 `LibreOffice -> PDF -> PDF 파서` 방식에서 `MarkItDown -> Markdown -> 청킹` 방식으로 변경한다.

기존 LibreOffice 기반 파이프라인은 삭제하지 않고 fallback 및 비교 검증 용도로 유지한다. 즉, 실제 학습의 기본값은 MarkItDown이고, MarkItDown 변환이 실패하거나 결과가 비어 있을 때만 기존 PDF 변환 파이프라인으로 fallback 한다.

## 2.2.1 대상 파일

- `.ppt`
- `.pptx`

RAG 학습 페이지의 "학습 데이터 추가", 게시글 첨부 파일 학습, 댓글 첨부 파일 학습에서 PPT/PPTX 파일을 감지하면 MarkItDown 변환 대상으로 분류한다.

## 2.2.2 기본 학습 파이프라인

1. PPT/PPTX 파일을 업로드한다.
2. 서버는 파일 확장자와 content type을 확인해서 PPT/PPTX 파일인지 판별한다.
3. PPT/PPTX 파일을 원본 학습 데이터 저장소에 보관한다.
4. MarkItDown으로 PPT/PPTX를 Markdown 텍스트로 변환한다.
5. 변환된 Markdown을 `FileTrainingData` 하위에 `converted_markitdown.md`로 저장한다.
6. Markdown 텍스트를 기존 TXT/Markdown 학습 로직과 동일하게 청킹한다.
7. 각 청크에 원본 파일명, 확장자, 변환 도구, 슬라이드 번호 단서, 첨부 ID를 메타데이터로 붙인다.
8. 임베딩을 생성하고 LanceDB에 저장한다.
9. 학습 완료 후 RAG 검색에서 PPT/PPTX 원문 내용이 검색되는지 확인한다.

## 2.2.3 fallback 파이프라인

MarkItDown 변환이 실패하거나 변환 결과가 비어 있으면 기존 파이프라인을 fallback으로 실행한다.

1. LibreOffice를 이용해서 PPT/PPTX를 PDF로 변환한다.
2. 변환된 PDF를 기존 PDF 학습 파이프라인에 전달한다.
3. 기존 PDF 파서가 텍스트, 표, 이미지, 페이지 번호를 추출한다.
4. 추출 결과를 청킹하고 임베딩한 뒤 LanceDB에 저장한다.
5. fallback 사용 여부와 실패 사유를 `FileTrainingData`의 리포트에 기록한다.

fallback은 운영 안정성을 위한 보조 경로이며, 정상 상황의 기본 경로는 MarkItDown이다.

## 2.2.4 게시글 첨부 PPT/PPTX 학습

게시글에 첨부 파일이 올라올 때 PPT/PPTX 파일이 포함되어 있으면 해당 파일도 MarkItDown 기반 PPT 학습 파이프라인에 추가한다.

처리 기준은 다음과 같다.

1. 게시글 등록 또는 수정 시 첨부 파일 목록을 조회한다.
2. 첨부 파일의 확장자 또는 content type이 PPT/PPTX이면 `presentations` 학습 대상으로 분류한다.
3. 게시글 본문 학습 payload에 `presentations` 배열을 포함한다.
4. `rag_train.py`는 `post.presentations`를 순회하면서 MarkItDown 변환을 수행한다.
5. 변환된 Markdown은 게시글 ID와 첨부 ID 기준으로 `FileTrainingData`에 저장한다.
6. 청크 메타데이터에는 `post_id`, `channel_id`, `attachment_id`, `source`, `file_name`, `type=presentation`을 반드시 포함한다.
7. 게시글 수정으로 재학습할 때는 기존 `post_id` 기준 벡터 삭제 후 PPT/PPTX 첨부도 함께 재학습한다.

## 2.2.5 댓글 첨부 PPT/PPTX 학습

댓글에 첨부 파일이 올라올 때 PPT/PPTX 파일이 포함되어 있으면 댓글 학습 payload에도 `presentations` 배열을 포함한다.

댓글 첨부 PPT/PPTX 청크는 `comment_id`, `post_id`, `channel_id`, `attachment_id`를 함께 저장해서 검색 결과의 출처를 댓글 단위로 추적할 수 있어야 한다.

## 2.2.6 스키마 변경 판단

단기 구현만 고려하면 기존 LanceDB 메타데이터 스키마 안에서 `type=presentation`, `file_name`, `attachment_id`, `original_content`, `file_hash` 중심으로 저장할 수 있다.

하지만 상용화를 고려하면 PPT/PPTX는 다음과 같은 추가 메타데이터가 필요하다.

- `source_ext`: `ppt` 또는 `pptx`
- `document_kind`: `presentation`
- `converted_by`: `markitdown`
- `converted_format`: `markdown`
- `parser_version`: MarkItDown 버전
- `slide_number`: 추출 가능한 경우 슬라이드 번호
- `slide_title`: 추출 가능한 경우 슬라이드 제목
- `fallback_used`: fallback 사용 여부
- `fallback_pipeline`: fallback 파이프라인 이름

따라서 PPT/PPTX 학습을 상용화 기준으로 반영하려면 스키마 변경이 필요하다. 기존 테이블을 즉시 overwrite하지 않고 `# 3. 버전드 마이그레이션 방식`에 따라 `my_rag_table_v2`를 생성하고 백그라운드 재학습 후 전환한다.

## 2.2.7 비교 검증 기능의 역할

사이트 관리 페이지의 "PPT 파이프라인 비교" 기능은 운영 학습 경로를 선택하기 위한 검증 도구로 유지한다.

비교 검증 결과 MarkItDown이 우수하므로 기본 운영 전략은 다음과 같다.

- 기본 학습: `markitdown`
- 실패 fallback: `libreoffice_pdf`
- 관리자 검증: `ppt_compare`

비교 검증 기능은 실제 RAG 벡터를 바로 오염시키지 않고, `ppt_compare.json`, `converted_markitdown.md`, `converted_pdf_text.json`을 생성해서 관리자가 결과를 확인할 수 있게 한다.



# 2.3 xml

XML 파일은 MarkItDown을 이용해서 Markdown 또는 구조화 텍스트로 변환한 뒤 RAG 학습 파이프라인에 넣는다.

목표는 XML 태그와 값을 단순 문자열로 학습하는 것이 아니라, 태그 경로와 값의 관계를 검색 가능한 문맥으로 보존하는 것이다.

## 2.3.1 대상 파일

- `.xml`

## 2.3.2 학습 파이프라인

1. XML 파일을 업로드한다.
2. 서버는 파일 확장자와 content type을 확인해서 XML 파일인지 판별한다.
3. XML 파일을 원본 학습 데이터 저장소에 보관한다.
4. MarkItDown으로 XML을 Markdown 또는 텍스트로 변환한다.
5. 변환 결과를 `converted_markitdown.md`로 저장한다.
6. XML 태그 경로, 속성, 값을 문맥 단위로 청킹한다.
7. 임베딩을 생성하고 LanceDB에 저장한다.

## 2.3.3 메타데이터

- `source_ext`: `xml`
- `document_kind`: `structured_xml`
- `converted_by`: `markitdown`
- `converted_format`: `markdown`
- `xml_path`: 가능한 경우 태그 경로
- `parser_version`: MarkItDown 버전

XML은 구조형 문서이므로 상용화 기준에서는 `xml_path` 같은 경로 메타데이터가 필요하다. 따라서 v2 스키마에서 정식 필드로 반영한다.

# 2.4 HTML

HTML 파일은 MarkItDown을 이용해서 본문 중심 Markdown으로 변환한 뒤 RAG 학습 파이프라인에 넣는다.

목표는 HTML 태그, 메뉴, 스크립트, 스타일 잡음을 제거하고 실제 문서 본문, 제목, 표, 링크 텍스트를 검색 가능한 형태로 학습하는 것이다.

## 2.4.1 대상 파일

- `.html`
- `.htm`

## 2.4.2 학습 파이프라인

1. HTML 파일을 업로드한다.
2. 서버는 파일 확장자와 content type을 확인해서 HTML 파일인지 판별한다.
3. HTML 파일을 원본 학습 데이터 저장소에 보관한다.
4. MarkItDown으로 HTML을 Markdown으로 변환한다.
5. 변환 결과를 `converted_markitdown.md`로 저장한다.
6. 제목, heading, paragraph, table, link 중심으로 청킹한다.
7. 임베딩을 생성하고 LanceDB에 저장한다.

## 2.4.3 메타데이터

- `source_ext`: `html` 또는 `htm`
- `document_kind`: `html`
- `converted_by`: `markitdown`
- `converted_format`: `markdown`
- `html_title`: 가능한 경우 HTML title
- `heading_path`: 가능한 경우 heading 계층
- `parser_version`: MarkItDown 버전

HTML은 제목과 heading 계층이 검색 품질에 중요하므로 v2 스키마에서 `html_title`, `heading_path`를 정식 메타데이터로 반영한다.

# 2.5 CSV

CSV 파일은 MarkItDown을 이용해서 Markdown 표 또는 행 단위 텍스트로 변환한 뒤 RAG 학습 파이프라인에 넣는다.

목표는 CSV의 헤더와 각 행의 값을 함께 보존해서, 특정 품목/금액/날짜/고객사/상태 값을 정확히 검색할 수 있게 하는 것이다.

## 2.5.1 대상 파일

- `.csv`

## 2.5.2 학습 파이프라인

1. CSV 파일을 업로드한다.
2. 서버는 파일 확장자와 content type을 확인해서 CSV 파일인지 판별한다.
3. CSV 파일을 원본 학습 데이터 저장소에 보관한다.
4. MarkItDown으로 CSV를 Markdown 표 또는 텍스트로 변환한다.
5. 변환 결과를 `converted_markitdown.md`로 저장한다.
6. 헤더와 행 값을 함께 묶어서 청킹한다.
7. 금액, 날짜, 품목 등의 업무 핵심 값을 추출한다.
8. 임베딩을 생성하고 LanceDB에 저장한다.

## 2.5.3 메타데이터

- `source_ext`: `csv`
- `document_kind`: `table`
- `converted_by`: `markitdown`
- `converted_format`: `markdown`
- `column_headers`: CSV 헤더 목록
- `row_range`: 청크에 포함된 행 범위
- `parser_version`: MarkItDown 버전

CSV는 행/열 기반 질의가 많으므로 상용화 기준에서는 `column_headers`, `row_range`가 필요하다. Excel과 같은 테이블 문서 계열로 보고 v2 스키마에 반영한다.

# 2.6 ZIP

ZIP 파일은 단일 문서가 아니라 여러 문서를 담는 컨테이너로 취급한다.

목표는 ZIP 자체를 하나의 텍스트로 학습하는 것이 아니라, 압축을 안전하게 해제한 뒤 내부 파일을 확장자별 파이프라인으로 분기하여 학습하는 것이다.

## 2.6.1 대상 파일

- `.zip`

## 2.6.2 학습 파이프라인

1. ZIP 파일을 업로드한다.
2. 서버는 파일 확장자와 content type을 확인해서 ZIP 파일인지 판별한다.
3. ZIP 파일을 원본 학습 데이터 저장소에 보관한다.
4. 안전한 임시 디렉터리에 압축을 해제한다.
5. 내부 파일 목록을 검사한다.
6. 내부 파일을 확장자별 파이프라인으로 분기한다.
   - PDF: 기존 PDF 파이프라인
   - Excel: MarkItDown Excel 파이프라인
   - PPT/PPTX: MarkItDown PPT 파이프라인
   - XML: MarkItDown XML 파이프라인
   - HTML: MarkItDown HTML 파이프라인
   - CSV: MarkItDown CSV 파이프라인
   - TXT/MD/JSON/LOG: 텍스트 파이프라인
7. 내부 파일별 변환 결과를 `FileTrainingData`에 저장한다.
8. ZIP 파일과 내부 파일의 관계를 메타데이터로 저장한다.
9. 임베딩을 생성하고 LanceDB에 저장한다.

## 2.6.3 보안 제한

ZIP은 반드시 보안 제한을 둔다.

- 최대 압축 해제 크기 제한
- 최대 내부 파일 개수 제한
- 디렉터리 traversal 차단
- 중첩 ZIP 제한
- 실행 파일, 스크립트 파일 기본 제외
- 손상된 ZIP은 메타데이터만 학습하고 실패 로그 기록

## 2.6.4 메타데이터

- `source_ext`: `zip`
- `document_kind`: `archive`
- `archive_id`: ZIP 원본 파일 ID
- `archive_file_path`: ZIP 내부 상대 경로
- `inner_source_ext`: 내부 파일 확장자
- `converted_by`: 내부 파일 처리 파이프라인 이름
- `parser_version`: 처리 도구 버전

ZIP은 컨테이너와 내부 파일 관계가 중요하므로 v2 스키마에서 `archive_id`, `archive_file_path`, `inner_source_ext`를 정식 필드로 반영한다.


# 3. 버전드 마이그레이션 방식

상용화를 고려하면 Docling을 포함한 문서 변환 기반 학습은 기존 LanceDB 메타데이터
스키마에 임시로 끼워 넣는 방식보다 버전드 마이그레이션 방식으로 진행한다.

기존 `my_rag_table`을 바로 overwrite하면 기존 게시글, 댓글, 첨부 파일 학습 데이터가 사라지고 재학습 중 RAG 검색 품질이 떨어질 수 있다. 따라서 새 테이블을 만들고 백그라운드에서 전체 재학습을 완료한 뒤 전환한다.

## 3.1 기본 원칙

1. 기존 `my_rag_table`은 유지한다.
2. 새 스키마를 가진 `my_rag_table_v2`를 생성한다.
3. Docling 기반 Office, HTML, CSV 파이프라인은 새 테이블을 대상으로 먼저 구현하고,
   MarkItDown은 검증 기간의 fallback으로 유지한다. XML과 ZIP은 1장의 분기 정책을
   따른다.
4. 전체 게시글, 댓글, 첨부 파일을 백그라운드로 재학습한다.
5. v2 검색 품질을 검증한다.
6. 검증이 끝나면 RAG 검색 테이블 포인터를 v2로 전환한다.
7. 문제가 있으면 즉시 v1으로 rollback 한다.

## 3.2 v2 메타데이터 필드

v2 스키마에는 기존 필드에 더해 아래 필드를 추가한다.

- `schema_version`: RAG 스키마 버전
- `document_kind`: `pdf`, `excel`, `presentation`, `xml`, `html`, `table`, `archive`, `text`
- `source_ext`: 원본 확장자
- `converted_by`: `docling`, `markitdown`, `pdfplumber`, `unstructured`, `docx2txt`, `manual_text` 등
- `converted_format`: `markdown`, `text`, `json`, `pdf`
- `parser_version`: 변환 도구 버전
- `fallback_used`: fallback 사용 여부
- `fallback_pipeline`: fallback 파이프라인 이름
- `sheet_name`: Excel 시트명
- `row_range`: Excel/CSV 행 범위
- `column_headers`: Excel/CSV 컬럼 헤더
- `slide_number`: PPT/PPTX 슬라이드 번호
- `slide_title`: PPT/PPTX 슬라이드 제목
- `xml_path`: XML 태그 경로
- `html_title`: HTML title
- `heading_path`: HTML/Markdown heading 계층
- `archive_id`: ZIP 원본 파일 ID
- `archive_file_path`: ZIP 내부 상대 경로
- `inner_source_ext`: ZIP 내부 파일 확장자

## 3.3 테이블 전환 방식

테이블 전환은 설정 기반으로 처리한다.

예:

```json
{
  "rag": {
    "active_table": "my_rag_table",
    "next_table": "my_rag_table_v2",
    "schema_version": 1
  }
}
```

v2 재학습과 검증이 끝나면 아래와 같이 전환한다.

```json
{
  "rag": {
    "active_table": "my_rag_table_v2",
    "previous_table": "my_rag_table",
    "schema_version": 2
  }
}
```

## 3.4 재학습 과정

1. `my_rag_table_v2`를 생성한다.
2. 기존 게시글 264개, 댓글 354개, 첨부 파일 1,088개를 대상으로 재학습한다.
3. 파일 유형별로 새 파이프라인을 적용한다.
4. 변환 산출물은 `FileTrainingData`에 보존한다.
5. 학습 완료 후 샘플 질문으로 검색 품질을 검증한다.
6. 관리자 페이지에서 v1/v2 검색 결과를 비교한다.
7. v2 결과가 안정적이면 active table을 전환한다.

## 3.5 파일 유형별 적용 전략

| 파일 유형 | v2 기본 파이프라인 | fallback |
| --- | --- | --- |
| PDF | 기존 PDF 파이프라인 | 기존 OCR fallback; Docling은 별도 비교 후 결정 |
| Excel | Docling | MarkItDown -> 직접 추출 또는 메타데이터 학습 |
| PPT/PPTX | Docling | MarkItDown -> LibreOffice -> PDF -> PDF 파서 |
| Word | Docling | MarkItDown -> docx2txt |
| 지원 XML 스키마 | Docling | MarkItDown -> XML 구조 텍스트 직접 추출 |
| 일반 XML | XML 구조 텍스트 직접 추출 | MarkItDown -> 메타데이터 학습 |
| HTML | Docling | MarkItDown -> BeautifulSoup 본문 추출 |
| CSV | Docling | MarkItDown -> CSV 파서 기반 행 단위 추출 |
| ZIP | 내부 파일별 분기 | ZIP 메타데이터만 학습 |

## 3.6 검증 기준

v2 전환 전에 아래 항목을 검증한다.

- 기존 RAG 질문에 대한 검색 품질이 v1보다 낮아지지 않는다.
- Excel/PPT/PPTX/XML/HTML/CSV/ZIP의 원문 내용이 검색된다.
- 검색 결과의 출처가 `post_id`, `comment_id`, `attachment_id`, 내부 파일 경로까지 추적된다.
- 변환 실패 파일이 있어도 전체 재학습이 중단되지 않는다.
- v2 전환 후 문제가 생기면 v1으로 rollback 할 수 있다.

## 3.7 운영 전환 원칙

개발 단계에서는 기존 스키마에 `type`, `file_name`, `attachment_id`, `original_content` 중심으로 최소 반영할 수 있다.

상용화 단계에서는 반드시 v2 스키마를 사용한다.

즉, 최종 방향은 다음과 같다.

```txt
개발/검증: 기존 active table 유지 + Docling shadow 산출물/비교 리포트 저장
상용화 준비: 새 버전 테이블 생성 + Docling 확장 메타데이터 반영
운영 전환: 새 테이블 백그라운드 재학습 완료 후 active_table 전환
장애 대응: previous_table로 즉시 rollback
```


# 4. RAG 답변 제어

RAG 답변 제어의 목표는 "근거가 없는데도 AI가 답변을 확장하는 현상"을 구조적으로 차단하는 것이다.

프롬프트에 "추정하지 말라"고 지시하는 것만으로는 충분하지 않다. RAG 검색 결과가 없거나, 현재 질문 대상과 다른 자료가 검색되었을 때는 LLM 호출 자체를 막아야 한다.

따라서 RAG 답변은 아래 순서로만 생성한다.

```txt
질문 범위 결정
-> RAG 검색 필터 생성
-> RAG 검색 실행
-> Evidence Gate 검증
-> 검증된 근거만 context 구성
-> LLM 호출
-> 참고자료 표시
```

## 4.1 질문 범위 결정

AI 질문을 처리하기 전에 사용자의 질문 범위를 먼저 결정한다.

지원 범위는 다음과 같다.

| scope | 의미 | 기본 사용 상황 |
| --- | --- | --- |
| `image_scope` | 현재 이미지 질문 | 게시글 첨부 이미지 또는 이미지 참조 버튼에서 질문 |
| `post_scope` | 현재 게시글 질문 | 특정 게시글 상세 화면에서 질문 |
| `comment_scope` | 현재 댓글 질문 | 특정 댓글을 AgenticAI로 보낸 경우 |
| `channel_scope` | 현재 채널 질문 | 현재 채널 범위 요약/검색 |
| `global_scope` | 전체 RAG 검색 | 사용자가 명시적으로 전체 검색을 요청 |

기본 정책은 가장 좁은 범위를 선택하는 것이다.

```txt
현재 이미지가 명확하면 image_scope
현재 게시글이 명확하면 post_scope
현재 채널만 명확하면 channel_scope
사용자가 "전체에서 찾아줘"라고 명시하면 global_scope
```

`global_scope`는 기본값으로 사용하지 않는다. 전체 검색은 다른 게시글/문서가 섞여 답변이 확대되는 주요 원인이므로 사용자가 명시적으로 요청한 경우에만 허용한다.

## 4.2 RAG 검색 필터 생성

scope에 따라 RAG 검색 필터를 반드시 생성한다.

### 4.2.1 image_scope

이미지 질문은 반드시 현재 이미지 첨부 파일로 제한한다.

필수 필터:

```json
{
  "post_id": "현재 게시글 ID",
  "attachment_id": "현재 이미지 첨부 ID",
  "type": "image_attachment"
}
```

이미지 질문에서 `post_id`만 사용하는 것은 충분하지 않다. 같은 게시글에 여러 첨부 파일이나 본문 텍스트가 있을 수 있으므로 `attachment_id`와 `type=image_attachment`까지 함께 제한한다.

### 4.2.2 post_scope

현재 게시글 질문은 현재 게시글 ID로 제한한다.

```json
{
  "post_id": "현재 게시글 ID"
}
```

기본적으로 다른 `post_id`의 검색 결과는 제외한다.

### 4.2.3 comment_scope

댓글 질문은 댓글 ID와 원 게시글 ID를 함께 제한한다.

```json
{
  "post_id": "댓글이 속한 게시글 ID",
  "comment_id": "현재 댓글 ID"
}
```

### 4.2.4 channel_scope

현재 채널 질문은 현재 채널 ID로 제한한다.

```json
{
  "channel_id": "현재 채널 ID"
}
```

### 4.2.5 global_scope

전체 검색은 권한이 허용된 전체 RAG 데이터에서 검색한다.

단, `global_scope`는 사용자가 전체 검색을 명시한 경우에만 사용한다.

## 4.3 Evidence Gate

RAG 검색 결과는 LLM에 전달하기 전에 반드시 Evidence Gate를 통과해야 한다.

Evidence Gate는 아래 조건을 검사한다.

1. 검색 결과가 존재하는가
2. 검색 결과가 질문 범위와 일치하는가
3. 검색 결과의 source type이 질문 유형과 맞는가
4. 검색 점수가 최소 기준을 넘는가
5. 참고자료가 사용자에게 표시 가능한 출처를 가지고 있는가

하나라도 실패하면 LLM을 호출하지 않는다.

## 4.4 No Evidence Gate

검색 결과가 없으면 LLM을 호출하지 않는다.

처리 기준:

```txt
references.length === 0
또는 context가 비어 있음
-> LLM 호출 금지
-> "현재 학습 데이터에서 답변 근거를 찾지 못했습니다." 반환
```

이때 fallback으로 일반 지식 답변을 생성하면 안 된다.

반환 메시지 예:

```txt
현재 학습 데이터에서 이 질문에 답할 근거를 찾지 못했습니다.
참고자료를 추가하거나 질문 범위를 좁혀 주세요.
```

## 4.5 Wrong Evidence Gate

검색 결과가 있어도 현재 질문 대상과 맞지 않으면 LLM을 호출하지 않는다.

### 4.5.1 image_scope 검증

이미지 질문은 아래 조건을 모두 만족해야 한다.

- 최소 1개 이상의 reference가 존재한다.
- 최소 1개 이상의 reference가 `type=image_attachment`이다.
- 주요 reference의 `attachment_id`가 현재 이미지 첨부 ID와 일치한다.
- 주요 reference의 `post_id`가 현재 게시글 ID와 일치한다.
- 참고자료에 이미지 썸네일 또는 `img_path`를 표시할 수 있다.

실패 시:

```txt
현재 이미지에 해당하는 학습 근거를 찾지 못했습니다.
다른 게시글이나 다른 문서를 근거로 답변하지 않습니다.
```

### 4.5.2 post_scope 검증

게시글 질문은 아래 조건을 만족해야 한다.

- 최소 1개 이상의 reference가 현재 `post_id`와 일치한다.
- 다른 `post_id`의 reference는 기본적으로 제외한다.
- 제외 후 reference가 0개가 되면 LLM을 호출하지 않는다.

### 4.5.3 comment_scope 검증

댓글 질문은 아래 조건을 만족해야 한다.

- 최소 1개 이상의 reference가 현재 `comment_id`와 일치한다.
- 댓글 첨부 파일 질문이면 `attachment_id`도 일치해야 한다.

### 4.5.4 channel_scope 검증

채널 질문은 아래 조건을 만족해야 한다.

- reference의 `channel_id`가 현재 채널 ID와 일치한다.
- 권한이 없는 채널의 reference는 제외한다.

## 4.6 Score Gate

검색 결과가 있더라도 유사도 점수가 너무 낮으면 답변하지 않는다.

구현 기준:

```txt
상위 결과가 score_threshold 미달
또는 상위 N개 결과가 모두 기준 미달
-> LLM 호출 금지
```

score 기준은 LanceDB 검색 방식에 맞춰 실험적으로 정한다.

권장 초기 정책:

- similarity distance 방식이면 낮을수록 좋은 값인지 확인한다.
- 현재 검색 결과의 score 분포를 로그로 남긴다.
- 운영 초기에는 보수적으로 적용하고, 오탐이 많으면 threshold를 조정한다.

## 4.7 Context 구성 규칙

LLM에 전달하는 context는 Evidence Gate를 통과한 reference만 사용한다.

금지:

- 검색된 모든 chunk를 그대로 넣기
- 현재 질문 범위 밖의 reference를 섞기
- 이전 assistant 답변을 근거처럼 넣기
- 이미지 질문에서 일반 게시글 검색 결과를 우선 사용하기

필수:

- 중복 chunk 제거
- source별 최대 chunk 수 제한
- image_scope에서는 `image_attachment`를 최우선 사용
- post_scope에서는 현재 `post_id`의 chunk만 사용
- context마다 `source_type`, `post_id`, `attachment_id`, `score`를 보존

LLM 전달 형식 예:

```txt
[답변 규칙]
- 아래 [검증된 근거]에 있는 내용만 사용하세요.
- 근거에 없는 내용은 답하지 마세요.
- 추정, 일반 지식, 이전 답변의 내용을 보충하지 마세요.
- 답변할 근거가 부족하면 "근거가 부족합니다"라고 답하세요.

[질문 범위]
scope: image_scope
post_id: ...
attachment_id: ...

[검증된 근거]
1. source_type: image_attachment
   post_id: ...
   attachment_id: ...
   file_name: ...
   score: ...
   excerpt: ...

[질문]
...
```

## 4.8 히스토리 정책

RAG 사실 질문에서는 대화 히스토리를 일반 대화와 다르게 처리한다.

권장 정책:

| scope | history 정책 |
| --- | --- |
| `image_scope` | history 0 |
| `post_scope` | history 0 또는 최근 user 질문 1개 |
| `comment_scope` | history 0 또는 최근 user 질문 1개 |
| `channel_scope` | history 1~2 |
| `global_scope` | 관리자 설정값 사용 가능 |

특히 이전 assistant 답변은 RAG 사실 질문의 근거로 사용하지 않는다.

이전 답변이 한 번 확대되면 다음 답변이 그 내용을 다시 이어받아 더 확대될 수 있으므로, RAG 사실 질문에서는 assistant history를 제외하는 것이 기본이다.

### 4.8.1 후속 위치 질문 Query Rewrite

사용자가 특정 대상을 먼저 말한 뒤 `"어디에 있어?"`, `"찾아줘"`, `"링크 줘"`처럼 짧은 후속 명령을 입력하면, RAG/검색/LLM 호출 전에 내부 처리용 질문을 명시적인 locate 질문으로 재작성한다.

예:

```txt
사용자 표시 입력:
어디에 있어?

직전 사용자 대상:
연세대 교직원식당 한경관 어울샘

내부 검색 질문:
연세대 교직원식당 한경관 어울샘 자료는 어디에 있어?
```

정책:

- 말풍선에는 사용자가 입력한 원문을 유지한다.
- `/api/questions`, 키워드 검색, `/rag/search`, Groq/내부 LLM 프롬프트에는 `resolvedQuestion`을 사용한다.
- `"X 은 어디에 있어?"`처럼 현재 문장에 대상은 있지만 `자료/문서/파일` 같은 자료 유형어가 없으면 `"X 자료는 어디에 있어?"`로 보강한다.
- `"X 자료는 어디에 있어?"`처럼 이미 명시적인 locate 질문은 의미를 바꾸지 않고 NFC 정규화만 적용한다.
- `"어디에 있어?"`, `"찾아줘"`처럼 명령만 있는 경우에는 직전 사용자 발화에서 대상어를 추출해 붙인다.
- 한글 입력은 검색/정규식 안정성을 위해 NFC로 정규화한다. 분해형 자모로 입력된 `"연세대"`도 `"연세대"`와 같은 검색어로 처리한다.

구현 위치:

- [src/components/GroqPanel.jsx](../src/components/GroqPanel.jsx)
  - `normalizeUserQuestionText`
  - `extractLocateSubject`
  - `isShortLocateFollowup`
  - `resolveQuestionForRetrieval`
- [server/intent/parser/RuleBasedIntentParser.js](../server/intent/parser/RuleBasedIntentParser.js)
  - 서버 직접 호출 대비 NFC 정규화

검증 기준:

```txt
연세대 교직원식당 한경관 어울샘 은 어디에 있어 ?
연세대 교직원식당 한경관 어울샘 자료는 어디에 있어 ?
```

두 질문은 내부적으로 같은 locate 검색 의도와 유사한 검색어로 처리되어야 한다.

## 4.9 키워드 검색 병합 제한

이미지 질문과 현재 게시글 질문에서는 키워드 검색 결과를 무조건 RAG context에 병합하지 않는다.

정책:

- `image_scope`: 키워드 검색 결과 병합 금지
- `post_scope`: 현재 `post_id`와 일치하는 키워드 결과만 병합
- `comment_scope`: 현재 `comment_id` 또는 `post_id`와 일치하는 결과만 병합
- `global_scope`: 키워드 검색 병합 허용

키워드 검색 결과가 현재 범위 밖의 게시글을 가져오면 답변 확대의 원인이 된다.

## 4.10 Locate 실패 시 RAG fallback

`/api/questions`의 locate 경로는 우선 PostgreSQL 검색 인덱스(`search_documents`, `attachments`, `posts`, `comments`)에서 자료 링크를 찾는다.
하지만 일부 자료는 LanceDB/RAG 학습 데이터에는 존재하지만 PostgreSQL locate 인덱스에는 없을 수 있다.

이 경우 locate intent 자체는 성공했지만 결과가 0건이므로, 다음 순서로 fallback한다.

1. `RuleBasedIntentParser`가 `action=locate`, `target=resources`, `keywords=[...]`를 만든다.
2. [PostRepository.locateReferences](../server/query/repository/PostRepository.js)가 PostgreSQL locate 인덱스를 검색한다.
3. 결과가 0건이면 [ragLocateFallback](../server/services/ragLocateFallback.js)이 RAG 서버(5001)에 동일 keyword query를 보낸다.
4. RAG 검색 결과 metadata의 `channel_id`, `post_id`, `attachment_id`, `comment_id`, `file_name`, `page_number`를 link reference로 정규화한다.
5. `channel_id/post_id`가 있고 현재 사용자 권한으로 접근 가능한 reference만 응답한다.
6. [HandleUserQuestionUseCase](../server/application/usecase/HandleUserQuestionUseCase.js)는 기존 locate 응답과 동일하게 `frontend_deeplink` 링크를 만든다.

정책:

- fallback은 locate 결과가 0건일 때만 수행한다.
- RAG fallback은 답변 요약을 만들지 않고 **링크 가능한 reference**만 만든다.
- `post_id`가 없거나 `channel_id`를 복원할 수 없는 RAG 결과는 링크로 만들지 않는다.
- 현재 채널 결과를 우선 정렬하고, 없으면 접근 가능한 다른 채널 결과를 뒤에 둔다.
- 보안 레벨과 채널 접근 권한을 다시 확인한다.

검증 기준:

```txt
연세대 교직원식당 한경관 어울샘 은 어디에 있어 ?
연세대 교직원식당 한경관 어울샘 자료는 어디에 있어 ?
```

두 질문 모두 PostgreSQL locate 인덱스에서 0건이어도 RAG fallback을 통해 동일하거나 유사한 `post_id/channel_id` reference를 반환해야 한다.

## 4.11 참고자료 표시 정책

답변 아래 참고자료에는 검증된 reference만 표시한다.

표시 필드:

- `scope`
- `source_type`
- `post_id`
- `comment_id`
- `attachment_id`
- `channel_id`
- `file_name`
- `img_path`
- `score`

이미지 reference는 반드시 썸네일 또는 이미지 미리보기를 표시한다.

참고자료가 현재 질문 범위와 일치하지 않으면 답변을 표시하지 않는다.

차단 UI 예:

```txt
근거 상태: 차단
사유: 현재 이미지와 일치하는 참고자료 없음
```

통과 UI 예:

```txt
근거 상태: 통과
범위: 현재 이미지
참고자료: image_attachment / attachment_id=... / score=...
```

## 4.11 응답 차단 조건

아래 조건 중 하나라도 해당하면 LLM을 호출하지 않는다.

1. RAG context가 비어 있다.
2. references가 비어 있다.
3. 현재 scope와 reference 메타데이터가 일치하지 않는다.
4. 이미지 질문인데 `image_attachment` reference가 없다.
5. 현재 이미지 질문인데 `attachment_id`가 다르다.
6. 현재 게시글 질문인데 다른 `post_id`만 검색되었다.
7. 검색 score가 기준 미달이다.
8. 사용자가 전체 검색을 요청하지 않았는데 `global_scope`로 검색되었다.

차단 메시지는 실패 사유를 명확히 알려야 한다.

예:

```txt
현재 이미지에 대한 학습 근거를 찾지 못했습니다.
다른 자료를 근거로 추정 답변을 생성하지 않았습니다.
```

## 4.12 구현 대상 파일

우선 구현 대상은 다음과 같다.

- `src/components/GroqPanel.jsx`
  - 현재 화면의 `postId`, `channelId`, 선택된 `attachmentId`를 RAG 요청에 전달한다.
  - 질문 scope를 결정한다.
  - RAG 사실 질문에서는 history를 축소하거나 assistant history를 제외한다.
  - 이미지 질문에서는 키워드 검색 결과 병합을 제한한다.

- `server/routes/rag.js`
  - `retrieval.filter`에 `post_id`, `comment_id`, `attachment_id`, `channel_id`, `type`을 지원한다.
  - Evidence Gate를 서버에서 수행한다.
  - Gate 실패 시 context 없이 명확한 차단 응답을 반환한다.
  - reference enrichment 단계에서 `source_type`, `attachment_id`, `score`, `img_path`를 유지한다.

- `server/rag_train.py`
  - 이미지 학습 chunk의 `type`을 `image_attachment`로 일관되게 저장한다.
  - `post_id`, `channel_id`, `attachment_id`, `file_name`, `img_path`, `file_hash`를 필수 메타데이터로 저장한다.
  - 이미지 caption은 보이는 사실 중심으로 작성되도록 한다.

- `src/components/chat/PostDetailPane.jsx`
  - 게시글 이미지별로 "이 이미지로 질문" 액션을 제공한다.
  - 해당 액션은 `attachment_id`를 AgenticAI target으로 전달한다.

## 4.13 검증 기준

아래 시나리오를 통과해야 한다.

1. 현재 이미지 질문에서 참고자료에 해당 이미지 1개 이상이 표시된다.
2. 현재 이미지 질문에서 다른 게시글 링크가 참고자료로 표시되지 않는다.
3. 해당 이미지 학습 근거가 없으면 답변하지 않고 차단 메시지를 표시한다.
4. 현재 게시글 질문에서 다른 게시글만 검색되면 답변하지 않는다.
5. 새 채팅과 기존 채팅에서 동일 이미지 질문의 답변 범위가 크게 달라지지 않는다.
6. 이전 assistant 답변이 다음 RAG 사실 답변의 근거로 사용되지 않는다.
7. 사용자가 명시적으로 전체 검색을 요청한 경우에만 전체 RAG 검색을 수행한다.
8. 참고자료 UI에서 `source_type`, `post_id`, `attachment_id`, `score`를 확인할 수 있다.

## 4.14 최종 운영 정책

최종 운영 정책은 다음과 같다.

```txt
기본 검색 범위는 현재 화면 기준으로 자동 제한한다.
이미지 질문은 attachment_id + type=image_attachment로 제한한다.
검색 결과가 없으면 LLM을 호출하지 않는다.
검색 결과가 질문 대상과 다르면 LLM을 호출하지 않는다.
RAG 사실 질문에서는 이전 assistant 답변을 근거로 쓰지 않는다.
전체 검색은 사용자가 명시적으로 선택한 경우에만 허용한다.
참고자료에 실제 근거가 표시되지 않으면 답변을 보여주지 않는다.
```

# 5. GPU 학습 스케줄링

> 이 장을 실제 코드 기준으로 구체화한 설계·단계별 구현 계획서: [GpuScheduling.md](./GpuScheduling.md). 착수 순서·리스크·롤백·플래그·검증 기준은 그 문서를 따른다.
>
> 구현은 가치/위험 기준 **5단계**로 나눈다(GpuScheduling.md §0). 아래 5.5의 원안(브로커 우선)과 달리, **임베딩 단일화와 관측성을 브로커 앞으로 당겼다**: ① 1단계 경량 협조 게이트(양보, 저위험) → ② 2단계 임베딩 단일화(`/embed` 재사용, 큐 없이 OOM 근본 해결) → ③ 3단계 관측성(게이트 검증) → ④ 4단계 정식 브로커 큐(유실 방지, 위험 최고) → ⑤ 5단계 운영 성숙(기아 방지·청크 양보·Ollama 조율).

## 5.1 목적

파일이 많은 학습(특히 폴더 업로드, [UploadFolder.md](./UploadFolder.md))은 GPU를 오래 점유한다. 이때 실시간 검색·답변 생성이 함께 GPU를 치면 응답 지연이나 VRAM 부족(OOM)이 발생한다.

따라서 학습은 다음 원칙으로 스케줄링한다.

- 학습은 **GPU가 비어 있을 때만** 실행한다.
- 다른 GPU 요청(검색·답변 생성 등 대화형 작업)이 있으면 **그쪽을 우선**한다.
- 이를 위해 **우선순위를 가진 GPU 요청 큐**와, 그 큐를 소비하는 **단일 GPU 브로커**를 둔다.

## 5.2 현재 구조와 문제

현재 GPU를 사용하는 작업은 서로를 모른 채 동작한다.

| 작업 | 실행 방식 | GPU 점유 | 조정 |
|---|---|---|---|
| 검색 임베딩 | 영구 서버 `server/rag_server.py`(5001포트), bge-m3 상주 | GPU 상주 | 프로세스 **내부**만 `_embed_lock`으로 직렬화 |
| 학습(RAG 임베딩) | 요청마다 `server/rag_train.py` 서브프로세스 spawn | bge-m3 **재로드** + 캡션용 Ollama 호출 | 없음(fire-and-forget) |
| 답변 생성 / 이미지 캡션 | Ollama(dgx-spark) | 별도 GPU 소비 | 없음 |

핵심 문제는 **검색 서버(상주 프로세스)와 학습(별도 서브프로세스)이 같은 GPU를 서로 모른 채 동시에 친다**는 점이다. bge-m3가 두 번 로드되어 VRAM이 이중으로 들고, 대량 학습이 돌면 실시간 검색·답변이 지연되거나 OOM이 난다. 이를 막는 장치가 현재 없다.

기존 자산:

- `server/aiQueue.js`에 **Redis Stream 기반 큐 + `priority` 필드**가 이미 있다.
- `server/aiOptimization.js`에 `queue_enabled`, `worker_heartbeat_sec` 등 **워커 설정 플래그**가 있다.

즉 뼈대는 있으나, **`enqueueTask`를 소비하는 worker(consumer)가 없어** 현재는 producer-only 껍데기다.

## 5.3 설계 원칙

**단일 GPU 브로커 + 우선순위 레인 + 협조적 양보**를 기본 구조로 한다.

1. **단일 GPU 브로커(워커):** GPU 작업을 실제로 디스패치하는 유일한 주체. `ai:queue:*` 스트림을 소비한다.
2. **우선순위 레인:**
   - `interactive`(검색·답변 생성) = high
   - `training`(학습) = low / batch
   - high 레인이 비어 있을 때만 학습 작업을 admit한다.
3. **GPU 유휴 판정(2층):**
   - **논리 게이트(주):** 브로커가 high 레인 처리 상태를 보고 "대화형 작업이 없을 때만" 학습 실행.
   - **물리 게이트(보조):** `nvidia-smi` VRAM/utilization 임계치. 브로커가 모르는 외부 GPU 사용(Ollama 포함)까지 커버.
4. **협조적 양보(선점 대체):** 실행 중인 CUDA 커널을 강제로 뺏는 hard preemption은 불가하다. 대신 학습을 **파일/청크 단위로 쪼개** 실행하고, **매 단위 종료 시 high 레인을 확인**해 대기 요청이 있으면 다음 단위 시작 전에 양보(yield)한다. 폴더 업로드는 파일이 많아 이 방식이 잘 맞는다.

## 5.4 기존 구현과의 충돌 (선결 과제)

**충돌 1 — 검색은 큐를 우회해야 한다(지연 민감).**
검색은 `server/routes/rag.js`에서 rag_server로 직접 HTTP 호출하며 답변 지연에 직결된다. 검색까지 Redis 큐를 태우면 오히려 느려진다. → 검색은 지금의 빠른 경로를 유지하되, 브로커가 "검색 진행 중"임을 알 수 있게 하고(학습이 검색에 양보), 큐로 강제하지 않는다.

**충돌 2 — 학습이 spawn 방식이라 게이트가 걸리지 않는다.**
현재 학습은 요청 시 `server/rag_train.py`를 곧바로 spawn한다. GPU 게이트를 적용하려면 학습을 **"즉시 spawn"에서 "큐에 적재 → 브로커가 조건 충족 시 실행"으로 전환**해야 한다. 가장 큰 구조 변경이다.

**충돌 3 — 큐에 소비자가 없다.**
`server/aiQueue.js`는 producer만 있다. `worker_heartbeat_sec`가 예고하는 **GPU 브로커(consumer)를 신규 구현**해야 한다.

**충돌 4 — 프로세스 간 GPU 락이 없다.**
`_embed_lock`은 rag_server.py **내부**만 보호한다. 상주 검색 서버와 학습 서브프로세스는 별개 OS 프로세스라 공유 세마포어가 없다. → Redis 분산 락, 또는 **모든 임베딩을 rag_server.py 한 곳으로 몰아 GPU 소유자를 단일화**한다(후자가 VRAM 이중 로드도 해결).

**충돌 5 — bge-m3 이중 로드.**
학습이 자체 bge-m3를 또 올려 VRAM이 두 배다. 학습 임베딩도 rag_server 경유로 보내면 모델 하나만 상주시켜 OOM 위험이 줄고 조정도 쉬워진다(충돌 4와 함께 처리).

**충돌 6 — Ollama(dgx-spark)는 별도 GPU 소비자.**
답변 생성·이미지 캡션이 Ollama로 간다. "GPU가 비었나" 판정은 bge-m3뿐 아니라 **Ollama 사용까지 포함한 전체 GPU 상태**로 봐야 한다. 논리 게이트만으로 부족하므로 물리 게이트(nvidia-smi)가 필요하다(5.3-3).

## 5.5 권장 구현 순서

1. **GPU 브로커 워커 신설** — `ai:queue:*`(우선순위 포함) 소비. GPU 작업의 유일한 디스패처(충돌 3).
2. **우선순위 레인 정의** — interactive high / training low. high가 비었을 때만 학습 admit(5.3-2).
3. **학습을 큐 잡으로 전환** — spawn 직결 제거. 파일/청크 단위 실행 + 매 단위 high 레인 확인 후 양보(충돌 2, 5.3-4).
4. **물리 안전 게이트** — nvidia-smi VRAM/util 임계치 도입(충돌 6).
5. **임베딩 단일화(권장)** — 학습 임베딩도 rag_server 경유로 bge-m3 단일 상주(충돌 4·5).

## 5.6 검증 기준

- 대량 폴더 업로드 학습 중에도 실시간 검색·답변 지연이 임계치 이내로 유지된다.
- 학습 진행 중 검색 요청이 들어오면, 학습이 다음 파일 단위에서 양보하고 검색이 먼저 처리된다.
- GPU VRAM/utilization이 임계치를 넘으면 신규 학습 작업이 admit되지 않는다.
- 검색·학습이 bge-m3를 이중 로드하지 않는다(임베딩 단일화 적용 시).
- 워커가 죽어도 큐의 학습 작업이 유실되지 않고 재개된다.

## 5.7 구현 대상 파일 예상

- `server/aiQueue.js` — 우선순위 레인 enqueue 보강
- `server/aiOptimization.js` — 워커/게이트 설정 플래그
- GPU 브로커 워커(신규) — `ai:queue:*` 소비, admission·양보 제어
- `server/rag_train.py` / `server/routes/rag.js` — 학습을 큐 잡으로 전환, 파일 단위 양보 지점 추가
- `server/rag_server.py` — 학습 임베딩 수용(임베딩 단일화 시)
- `server/aiMetrics.js` — GPU 점유/대기 메트릭 연동
