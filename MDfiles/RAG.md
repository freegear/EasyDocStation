RAG.md

# 1. MakeItDown을 설치

# 2. RAG 학습 사용

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

상용화를 고려하면 MarkItDown 기반 문서 학습은 기존 LanceDB 메타데이터 스키마에 임시로 끼워 넣는 방식보다 버전드 마이그레이션 방식으로 진행한다.

기존 `my_rag_table`을 바로 overwrite하면 기존 게시글, 댓글, 첨부 파일 학습 데이터가 사라지고 재학습 중 RAG 검색 품질이 떨어질 수 있다. 따라서 새 테이블을 만들고 백그라운드에서 전체 재학습을 완료한 뒤 전환한다.

## 3.1 기본 원칙

1. 기존 `my_rag_table`은 유지한다.
2. 새 스키마를 가진 `my_rag_table_v2`를 생성한다.
3. MarkItDown 기반 Excel, PPT/PPTX, XML, HTML, CSV, ZIP 파이프라인은 v2 테이블을 대상으로 먼저 구현한다.
4. 전체 게시글, 댓글, 첨부 파일을 백그라운드로 재학습한다.
5. v2 검색 품질을 검증한다.
6. 검증이 끝나면 RAG 검색 테이블 포인터를 v2로 전환한다.
7. 문제가 있으면 즉시 v1으로 rollback 한다.

## 3.2 v2 메타데이터 필드

v2 스키마에는 기존 필드에 더해 아래 필드를 추가한다.

- `schema_version`: RAG 스키마 버전
- `document_kind`: `pdf`, `excel`, `presentation`, `xml`, `html`, `table`, `archive`, `text`
- `source_ext`: 원본 확장자
- `converted_by`: `markitdown`, `pdfplumber`, `unstructured`, `docx2txt`, `manual_text` 등
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
| PDF | 기존 PDF 파이프라인 | MarkItDown PDF 또는 OCR fallback |
| Excel | MarkItDown | 메타데이터 학습 |
| PPT/PPTX | MarkItDown | LibreOffice -> PDF -> PDF 파서 |
| XML | MarkItDown | XML 구조 텍스트 직접 추출 |
| HTML | MarkItDown | BeautifulSoup 본문 추출 |
| CSV | MarkItDown | CSV 파서 기반 행 단위 추출 |
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
개발/검증: 기존 my_rag_table 유지 + MarkItDown 산출물 저장
상용화 준비: my_rag_table_v2 생성 + 확장 메타데이터 반영
운영 전환: v2 백그라운드 재학습 완료 후 active_table 전환
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
