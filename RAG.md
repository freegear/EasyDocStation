RAG.md

# 1. MakeItDown을 설치

# 2. 사용

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
