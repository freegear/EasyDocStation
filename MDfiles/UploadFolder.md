# UploadFolder.md

## 1. 목적

EasyStation의 폴더 업로드는 단순한 다중 파일 업로드가 아니라, 사용자가 정리해 둔 **폴더 구조 자체를 데이터셋의 업무 맥락으로 보존하는 기능**으로 설계한다.

핵심 목표는 다음 3가지다.

- `folder_path`를 검색 가능한 메타데이터로 저장한다.
- 같은 폴더의 문서를 `folder_group_id`로 연결한다.
- RAG 검색 결과에서 같은 폴더의 관련 문서를 함께 추천한다.

이 기능은 “파일 여러 개 업로드”가 아니라 **자료실 단위 학습 기능**이다. 폴더명, 경로, 상위/하위 폴더 관계, 같은 폴더의 sibling 문서는 사용자가 이미 정리해 둔 업무 맥락이므로 RAG 학습과 검색에 함께 반영해야 한다.

## 2. 현재 EasyStation 기준

현재 EasyStation의 RAG/파일 처리 흐름은 대략 다음 구조를 사용한다.

- 파일 원본/첨부 저장: `server/routes/files.js`, `attachments`
- 게시글/댓글 첨부 RAG 학습 분류: `server/rag.js`
- 문서 파싱/청킹/학습: `server/rag_train.py`
- 벡터 저장소: 현재 문서 기준 LanceDB
- 학습 원본/변환 산출물: `Database/ObjectFile/FileTrainingData`
- RAG 학습 문서: [RAG.md](./RAG.md)

따라서 폴더 업로드도 별도 고립 기능으로 만들기보다, 기존 첨부/파일 저장 및 RAG 학습 파이프라인에 **폴더 메타데이터와 데이터셋 배치 개념을 추가**하는 방식이 안전하다.

## 3. 사용자 시나리오

사용자가 아래 폴더를 업로드한다고 가정한다.

```text
/계약자료/2026/고객A/견적서.pdf
/계약자료/2026/고객A/계약서.docx
/계약자료/2026/고객A/회의록.txt
```

시스템은 세 파일을 각각 독립 문서로 저장하되, 다음 업무 맥락을 함께 보존한다.

- 세 파일은 모두 `계약자료`, `2026`, `고객A` 키워드를 공유한다.
- 세 파일은 같은 `고객A` 폴더 그룹에 속한다.
- `계약서.docx` 검색 시 같은 폴더의 `견적서.pdf`, `회의록.txt`를 관련 문서로 추천할 수 있다.

## 4. 데이터 모델

### 4.1 파일 단위 메타데이터

각 파일에는 최소 아래 메타데이터를 저장한다.

```json
{
  "document_id": "doc_xxxx",
  "batch_id": "batch_20260708_xxxx",
  "dataset_id": "dataset_xxxx",

  "file_name": "계약서.docx",
  "extension": "docx",
  "file_size": 1234567,

  "root_folder": "계약자료",
  "relative_path": "2026/고객A/계약서.docx",
  "folder_path": "계약자료/2026/고객A",
  "parent_folder": "고객A",
  "folder_keywords": ["계약자료", "2026", "고객A"],

  "folder_group_id": "foldergrp_xxxx",
  "sibling_files": ["견적서.pdf", "회의록.txt"],

  "created_at": "2026-06-01T10:00:00",
  "modified_at": "2026-07-01T15:30:00",
  "uploaded_at": "2026-07-08T13:00:00",

  "hash": "sha256_xxxx",
  "hash_algorithm": "sha256",
  "upload_status": "uploaded",
  "storage_status": "committed",
  "owner": "user_xxxx",
  "security_level": "internal"
}
```

해시는 최종 저장 이후 별도 배치로 계산하지 않고, 서버가 업로드 스트림을 받는 동안 동시에 계산하는 것을 기본 정책으로 한다. 파일은 곧바로 최종 저장소에 쓰지 않고 `tmp_uploads/{batch_id}` 같은 임시 위치에 먼저 저장한 뒤, 해시 비교와 DB 기록이 끝난 경우에만 최종 저장소로 이동한다. 이렇게 하면 중복 파일이나 실패 파일이 최종 저장소와 RAG 학습 큐에 잘못 들어가는 것을 줄일 수 있다.

### 4.2 권장 테이블

기존 `attachments`만으로도 일부 정보는 저장할 수 있지만, 폴더 데이터셋을 안정적으로 관리하려면 별도 테이블을 두는 것이 좋다.

#### `folder_datasets`

폴더 업로드 단위의 상위 데이터셋이다.

- `id`
- `owner_id`
- `name`
- `root_folder`
- `source_type`: `browser_upload` 또는 `server_path`
- `source_root_id`: 서버 경로 등록 방식일 때만 사용. 관리자가 사전에 등록한 허용 루트 ID
- `source_sub_path`: 서버 경로 등록 방식일 때만 사용. 허용 루트 아래의 상대 경로
- `source_root_path`: 감사 및 추적용 스냅샷. 사용자가 직접 입력한 임의 절대 경로를 신뢰해 저장하지 않는다
- `status`: `pending`, `uploading`, `training`, `completed`, `failed`, `partial_failed`
- `file_count`
- `total_bytes`
- `created_at`
- `updated_at`

#### `server_source_roots`

서버 로컬 경로 등록에서 사용할 수 있는 허용 루트 디렉터리 목록이다.

`server_path` 방식은 사용자가 임의의 절대 경로를 제출하는 기능이 아니라, 관리자가 사전에 등록한 허용 루트 안에서 권한 있는 사용자만 상대 경로를 지정해 등록하는 방식으로 제한한다.

- `id`
- `name`
- `root_path`: 서버의 실제 루트 경로
- `owner_scope`: `user`, `team`, `org`
- `allowed_owner_id`: 접근 가능한 사용자, 팀, 조직 ID
- `enabled`
- `max_file_count`
- `max_total_bytes`
- `allowed_extensions`
- `created_by`
- `created_at`
- `updated_at`

#### `folder_upload_batches`

한 번의 등록 실행 단위다. 같은 데이터셋에 재등록/증분 등록이 가능하도록 분리한다.

- `id`
- `dataset_id`
- `owner_id`
- `status`
- `file_count`
- `completed_count`
- `failed_count`
- `total_bytes`
- `started_at`
- `finished_at`
- `error_message`

#### `folder_documents`

폴더 내 파일 1건에 대응하는 문서 메타데이터다.

`attachments`는 실제 원본 파일의 저장 위치, 소유권, 보안등급, 삭제 상태를 관리하는 기준 테이블로 둔다. `folder_documents`는 특정 `folder_datasets` 안에서 해당 원본 파일이 어떤 폴더 문맥과 상대 경로로 등록되었는지 나타내는 파생 메타데이터다.

- `id`
- `dataset_id`
- `batch_id`
- `attachment_id`
- `owner_id`
- `security_level`
- `effective_security_level`
- `file_name`
- `extension`
- `file_size`
- `content_type`
- `hash`
- `hash_algorithm`
- `upload_status`: `pending`, `uploading`, `uploaded`, `skipped_duplicate`, `upload_failed`
- `storage_status`: `temporary`, `committed`, `removed`
- `temp_path`
- `storage_path`
- `root_folder`
- `relative_path`
- `folder_path`
- `parent_folder`
- `folder_keywords`
- `folder_group_id`
- `sibling_files`
- `created_at_original`
- `modified_at_original`
- `uploaded_at`
- `training_status`
- `training_error`

소유권과 보안등급 정책:

- `attachments.owner_id`를 원본 파일의 최종 소유자로 본다.
- `folder_documents.owner_id`는 조회 최적화와 감사 목적으로 저장하되, 기본적으로 연결된 `attachments.owner_id`와 같아야 한다.
- `folder_datasets.owner_id`, `folder_upload_batches.owner_id`, `folder_documents.owner_id`, `attachments.owner_id`는 생성 시 일관성을 검증한다.
- 다른 사용자의 `attachment_id`를 임의로 `folder_documents`에 연결할 수 없게 한다.
- `folder_documents.security_level`은 기본적으로 `attachments.security_level`을 상속한다.
- `folder_datasets.security_level`이 더 엄격하면 `effective_security_level`은 데이터셋 기준으로 상향한다.
- 검색, RAG 컨텍스트 구성, 원본 열기 권한 검사는 `effective_security_level`과 앱 권한을 함께 기준으로 한다.
- 팀/조직 공유 데이터셋을 지원하는 경우에는 `owner_id`만으로 권한을 표현하지 않고 별도 ACL 또는 권한 테이블을 둔다.

#### `folder_relationships`

문서 간 폴더 기반 관계를 저장한다.

- `id`
- `dataset_id`
- `source_document_id`
- `target_document_id`
- `relation_type`: `same_folder`, `parent_child_folder`, `same_root_folder`
- `weight`: `1.0`, `0.7`, `0.4`
- `created_at`

## 5. 폴더 키워드 정규화

폴더 경로는 단순 문자열로만 저장하지 않고 검색 가능한 키워드로 분리한다.

예시:

```json
{
  "root_folder": "계약자료",
  "folder_path": "계약자료/2026/고객A",
  "parent_folder": "고객A",
  "folder_keywords": ["계약자료", "2026", "고객A"]
}
```

정규화 규칙은 다음을 권장한다.

- 경로 구분자는 `/`로 통일한다.
- 앞뒤 공백을 제거한다.
- 빈 세그먼트는 제거한다.
- 숨김 폴더, 시스템 폴더는 기본 제외한다.
- 한글/영문 원문은 보존한다.
- 검색용 보조 필드에는 소문자, 공백 정리, 특수문자 제거 버전을 추가할 수 있다.

검색 예시는 다음과 같다.

```text
고객A 관련 자료 찾아줘
2026년 계약자료만 보여줘
계약서와 같은 폴더에 있던 파일도 같이 보여줘
고객A 폴더의 최신 문서만 찾아줘
```

## 6. folder_group_id 설계

같은 폴더에 있던 파일들은 동일한 `folder_group_id`를 공유한다.

권장 생성 기준:

```text
folder_group_id = hash(dataset_id + normalized_folder_path)
```

예를 들어 `계약자료/2026/고객A` 폴더의 모든 파일은 동일한 `folder_group_id`를 가진다.

이를 통해 RAG 검색에서 다음 확장이 가능하다.

- 검색된 문서와 같은 폴더 문서 추가 조회
- 같은 고객/프로젝트 폴더 문서 묶음 표시
- 검색 결과 UI에서 “같은 폴더 관련 문서” 추천

## 7. 문서 관계 가중치

문서 관계는 최소 아래 3단계로 관리한다.

```text
같은 폴더 문서: 1.0
부모/자식 폴더 문서: 0.7
같은 루트 폴더 문서: 0.4
```

단기 구현에서는 `same_folder`만 먼저 적용해도 효과가 크다. 이후 부모/자식, 같은 루트 폴더 관계를 추가한다.

## 8. 처리 흐름

권장 처리 흐름은 다음과 같다.

```text
1. 사용자가 루트 폴더 선택
2. 시스템이 하위 폴더와 파일을 재귀 스캔
3. 파일 목록과 폴더 트리 미리보기 표시
4. 제외 확장자, 대용량 파일, 숨김 파일 필터링
5. dataset_id와 batch_id 생성
6. 파일별 업로드 시작 전 파일명, 상대 경로, 확장자, MIME, 크기 제한을 검증
7. 파일을 `tmp_uploads/{batch_id}` 임시 위치에 저장하면서 서버에서 스트리밍 SHA-256 해시 계산
8. 파일 수신 완료 후 `dataset_id + relative_path + hash` 기준으로 중복 여부 확인
9. 중복이면 임시 파일 삭제 후 `skipped_duplicate`로 기록
10. 신규 또는 새 버전이면 임시 파일을 최종 저장소로 이동하고 `committed`로 기록
11. 파일명, 경로, 날짜, 크기, 해시값 저장
12. 폴더명을 키워드로 정규화
13. 같은 폴더 파일들을 folder_group_id로 연결
14. 문서 파싱 및 텍스트 추출
15. 청크 생성
16. LanceDB 등 벡터 DB에 임베딩 저장
17. RAG 검색 시 folder_keywords, folder_group_id, relative_path를 함께 사용
18. 검색 결과에서 같은 폴더의 관련 문서를 함께 추천
```

MVP에서는 청크 업로드보다 서버 스트리밍 해시와 임시 저장 방식을 우선 적용한다. 이 방식은 기존 multipart 업로드 흐름과 잘 맞고 구현 범위가 작다. 단일 파일 크기가 커서 업로드 재개, 네트워크 중단 복구, 병렬 전송이 필요해지는 시점에 청크 업로드를 2단계 확장으로 추가한다.

## 9. 업로드 UX

### 9.1 브라우저 기반 폴더 업로드

Chrome, Edge 등 Chromium 기반 브라우저에서는 아래 방식을 사용할 수 있다.

```html
<input type="file" webkitdirectory multiple />
```

브라우저는 각 파일에 `webkitRelativePath`를 제공한다.

예시:

```text
계약자료/2026/고객A/계약서.docx
```

프론트는 이 값을 사용해 `root_folder`, `relative_path`, `folder_path`, `parent_folder`, `folder_keywords`를 계산하거나, 원문 `webkitRelativePath`를 서버에 보내 서버가 정규화하게 한다.

권장 UX:

- 폴더 선택
- 전체 파일 수, 총 용량 표시
- 폴더 트리 미리보기
- 제외될 파일 목록 표시
- 확장자/크기/숨김 파일 필터 결과 표시
- 업로드 시작
- 파일별 진행률 및 전체 진행률 표시
- 학습 진행 상태 표시

### 9.2 서버 로컬 경로 등록

사내 서버나 NAS에 이미 자료가 있는 경우, 서버 로컬 경로 등록 방식을 지원할 수 있다.

이 방식은 기능상 강력하지만 보안 위험도 크므로, 사용자가 서버의 임의 절대 경로를 입력하는 방식으로 제공하지 않는다. 관리자가 사전에 등록한 `server_source_roots` allowlist 안에서만 선택할 수 있게 하고, 사용자는 허용 루트 아래의 상대 경로만 지정한다.

권장 처리 흐름:

```text
1. 사용자가 source_root_id와 source_sub_path를 제출
2. 서버가 source_root_id의 allowlist 등록 여부와 enabled 상태 확인
3. 요청 사용자가 해당 root에 접근 가능한지 앱 권한 확인
4. source_sub_path를 정규화하고 traversal 여부 확인
5. 최종 경로가 realpath 기준으로 허용 root 내부인지 확인
6. symlink 정책 적용
7. 확장자, 파일 크기, 총 용량, 파일 수 제한 적용
8. 등록 작업 실행 및 감사 로그 기록
```

보안상 반드시 아래 제한이 필요하다.

- 허용 루트 디렉터리 allowlist
- 경로 traversal 방지
- 심볼릭 링크 처리 정책
- 앱 권한 확인: 사용자가 `server_path` 기능을 실행할 수 있는지 확인
- 루트 권한 확인: 사용자가 특정 `source_root_id`에 접근할 수 있는지 확인
- 확장자 제한
- 최대 파일 크기 제한
- 최대 총 용량 제한
- 서버 관리자 또는 권한 있는 사용자만 실행

권장 요청 예시:

```json
{
  "source_type": "server_path",
  "source_root_id": "company_contracts",
  "source_sub_path": "2026"
}
```

서버는 `source_root_id`로 등록된 실제 루트 경로를 조회한 뒤 `source_sub_path`를 결합한다. 결합된 경로는 반드시 정규화하고, `realpath` 기준으로 허용 루트 내부에 있는지 확인한다. 단순 문자열 비교만으로 검사하면 `/mnt/data1`과 `/mnt/data10` 같은 경로를 잘못 판단할 수 있으므로, 경로 API 기준의 부모/자식 관계 검사를 사용한다.

심볼릭 링크는 기본적으로 추적하지 않는 정책을 권장한다. 관리자가 특정 루트에서 symlink 추적을 허용하더라도, 매 파일의 `realpath`가 허용 루트 밖으로 벗어나면 등록하지 않는다.

## 10. API 설계안

### 10.1 브라우저 폴더 업로드

```http
POST /api/folder-datasets
Content-Type: multipart/form-data
```

FormData:

- `datasetName`
- `rootFolder`
- `files[]`
- `relativePaths[]`
- `modifiedAts[]`
- `securityLevel`
- `manifest`: 파일별 `relativePath`, `size`, `lastModified`, 선택적 `clientHash`를 담은 JSON 문자열

`relativePaths[]` 같은 병렬 배열은 순서 불일치에 취약하므로, 실제 구현에서는 `manifest`를 함께 받아 서버가 파일 파트와 경로 메타데이터를 검증하는 방식을 권장한다. 브라우저에서 계산한 `clientHash`는 업로드 전 중복 여부를 미리 확인하는 힌트로만 사용하고, 최종 중복 판단은 서버가 업로드 스트림에서 다시 계산한 SHA-256 해시를 기준으로 한다.

응답:

```json
{
  "dataset_id": "dataset_xxxx",
  "batch_id": "batch_xxxx",
  "status": "uploading",
  "file_count": 128
}
```

### 10.1.1 선택적 업로드 전 중복 확인

작은 파일이나 브라우저 성능에 무리가 없는 경우에는 프론트에서 SHA-256을 먼저 계산해 사전 중복 확인을 요청할 수 있다.

```http
POST /api/folder-datasets/check-duplicates
Content-Type: application/json
```

요청:

```json
{
  "dataset_id": "dataset_xxxx",
  "files": [
    {
      "relative_path": "2026/고객A/계약서.docx",
      "size": 1234567,
      "client_hash": "sha256_xxxx"
    }
  ]
}
```

응답:

```json
{
  "duplicates": [
    {
      "relative_path": "2026/고객A/계약서.docx",
      "hash": "sha256_xxxx",
      "action": "skip_upload"
    }
  ]
}
```

이 API는 네트워크 비용을 줄이기 위한 최적화일 뿐이다. 클라이언트 해시는 신뢰하지 않고, 업로드된 파일은 서버에서 반드시 다시 해시를 계산한다.

### 10.1.2 대용량 파일용 청크 업로드 확장

MVP 이후 대용량 파일, 업로드 재개, 네트워크 중단 복구가 필요하면 청크 업로드를 별도 단계로 추가한다.

```http
POST /api/folder-datasets/upload-sessions
PUT /api/folder-datasets/upload-sessions/:sessionId/chunks/:chunkIndex
POST /api/folder-datasets/upload-sessions/:sessionId/complete
DELETE /api/folder-datasets/upload-sessions/:sessionId
```

청크 업로드 정책:

- `upload_session_id` 단위로 임시 디렉터리를 생성한다.
- 각 청크는 `chunk_index`, `chunk_count`, `chunk_size`, 선택적 `chunk_hash`를 가진다.
- 서버는 청크를 모두 받은 뒤 재조립하면서 최종 SHA-256을 다시 계산한다.
- 최종 해시 기준으로 중복 여부를 판단한다.
- 완료되지 않은 세션은 TTL 기반 정리 작업으로 삭제한다.

### 10.2 서버 경로 미리보기

```http
POST /api/folder-datasets/preview-server-path
```

요청:

```json
{
  "root_path": "/mnt/company-datasets/contracts/2026"
}
```

응답:

```json
{
  "root_folder": "2026",
  "file_count": 128,
  "total_bytes": 987654321,
  "tree": [],
  "excluded": []
}
```

### 10.3 서버 경로 등록

```http
POST /api/folder-datasets/from-server-path
```

요청:

```json
{
  "dataset_name": "2026 계약자료",
  "root_path": "/mnt/company-datasets/contracts/2026",
  "security_level": 1
}
```

### 10.4 상태 조회

```http
GET /api/folder-datasets/:datasetId
GET /api/folder-datasets/:datasetId/batches/:batchId
```

## 11. 기존 RAG 파이프라인 연동

폴더 업로드된 파일도 기존 파일 형식별 학습 전략을 재사용한다.

- PDF: 기존 PDF 파서
- TXT/Markdown: 기존 텍스트 청킹
- Excel: MarkItDown 기반 Excel 학습
- PPT/PPTX: MarkItDown 기반 PPT 학습
- Word/Office: MarkItDown 대상
- 이미지: 기존 이미지 메타/처리 전략
- ZIP: 별도 압축 해제 정책과 충돌하지 않게 제한

`server/rag.js`의 파일 분류 결과에 폴더 메타데이터를 포함하고, `server/rag_train.py`가 각 청크에 아래 필드를 추가해야 한다.

- `dataset_id`
- `batch_id`
- `attachment_id`
- `folder_document_id`
- `owner_id`
- `effective_security_level`
- `storage_status`
- `root_folder`
- `relative_path`
- `folder_path`
- `parent_folder`
- `folder_keywords`
- `folder_group_id`
- `sibling_files`

## 12. LanceDB 메타데이터

현재 EasyStation은 RAG 문서 기준 LanceDB를 사용하므로, 벡터 청크에도 폴더 메타데이터를 저장한다.

청크 메타데이터 예시:

```json
{
  "source": "계약서.docx",
  "file_name": "계약서.docx",
  "type": "word",
  "dataset_id": "dataset_xxxx",
  "batch_id": "batch_xxxx",
  "attachment_id": "attachment_xxxx",
  "folder_document_id": "doc_xxxx",
  "owner_id": "user_xxxx",
  "effective_security_level": "internal",
  "storage_status": "committed",
  "relative_path": "2026/고객A/계약서.docx",
  "folder_path": "계약자료/2026/고객A",
  "folder_keywords": ["계약자료", "2026", "고객A"],
  "folder_group_id": "foldergrp_xxxx",
  "original_content": "..."
}
```

스키마가 고정되어 있거나 배열 타입 저장이 어렵다면 단기적으로는 아래처럼 문자열 필드를 병행한다.

```json
{
  "folder_keywords_text": "계약자료 2026 고객A"
}
```

## 13. RAG 검색 전략

검색은 다음 단계로 보강한다.

```text
1차 검색: 벡터 유사도 기반 문서 검색
2차 보정: folder_keywords와 folder_path 기반 필터링
3차 확장: 같은 folder_group_id 문서 추가 조회
4차 보강: 부모/자식 폴더 문서 일부 참조
5차 응답: 원본 문서명, 경로, 관련 문서 표시
```

예시:

```text
질문: 고객A 계약 조건을 알려줘
```

처리:

1. 벡터 검색으로 `계약서.docx` 청크를 찾는다.
2. 해당 청크의 `folder_group_id`를 확인한다.
3. 같은 폴더의 `견적서.pdf`, `회의록.txt` 일부를 관련 문서로 확장한다.
4. 답변에는 “참조 문서”와 “같은 폴더 관련 문서”를 함께 표시한다.

## 14. 검색 결과 UI

검색 결과에는 파일명만 표시하지 말고 폴더 경로와 관련 문서를 함께 보여준다.

예시:

```text
계약서.docx
경로: 계약자료/2026/고객A
관련 문서: 견적서.pdf, 회의록.txt
```

UI 구성:

- 문서명
- 폴더 경로
- 데이터셋명
- 같은 폴더 관련 문서
- 원본 열기
- 폴더 그룹 보기

## 15. 보안 및 제한

폴더 업로드는 대량 파일을 다루므로 다음 제한이 필요하다.

- 허용 확장자 목록
- 차단 확장자 목록
- 단일 파일 최대 크기
- 배치 총 용량 제한
- 배치 파일 수 제한
- 숨김 파일 제외
- 시스템 파일 제외: `.DS_Store`, `Thumbs.db` 등
- 실행 파일 제외: `.exe`, `.bat`, `.cmd`, `.sh` 등은 기본 차단
- 압축 파일 처리 정책 별도
- 사용자별/팀별 권한
- `security_level` 상속

서버 경로 등록 방식에서는 특히 경로 traversal과 심볼릭 링크 처리를 조심해야 한다. 기본 정책은 다음과 같이 둔다.

- `server_path`는 관리자 또는 권한 있는 사용자만 실행할 수 있다.
- 사용자가 임의의 절대 경로를 제출하지 못하게 한다.
- 서버 경로는 `server_source_roots` allowlist에 등록된 루트 아래로만 제한한다.
- 요청에는 `source_root_id`와 상대 경로인 `source_sub_path`만 받는다.
- `source_sub_path`는 정규화한 뒤 `..`, 절대 경로, 루트 이탈 여부를 검사한다.
- 최종 대상 경로와 스캔 중 발견한 각 파일 경로는 `realpath` 기준으로 허용 루트 내부인지 확인한다.
- 심볼릭 링크는 기본적으로 제외한다.
- symlink 추적을 허용하는 경우에도 `realpath`가 허용 루트 밖이면 제외한다.
- OS 파일 권한과 별개로 앱 레벨의 사용자/팀/조직 권한을 반드시 확인한다.
- 실행 결과와 차단된 파일은 감사 로그에 남긴다.

감사 로그에는 최소한 다음 항목을 기록한다.

- `user_id`
- `dataset_id`
- `source_root_id`
- `requested_sub_path`
- `resolved_path`
- `file_count`
- `total_bytes`
- `excluded_count`
- `status`
- `failure_reason`
- `started_at`
- `completed_at`

## 16. 중복 처리

파일 해시를 저장해 중복을 감지한다.

해시 계산은 서버에서 파일 업로드 스트림을 읽는 동안 수행한다. 서버는 업로드 파일을 최종 저장소에 바로 쓰지 않고 임시 위치에 저장한다. 파일 수신과 해시 계산이 모두 성공한 뒤에만 중복 여부를 판단하고, 신규 파일이면 최종 저장소로 이동한다.

권장 정책:

- 같은 `dataset_id` 안에서 같은 `relative_path`와 같은 `hash`면 재등록 생략
- 같은 `relative_path`지만 `hash`가 다르면 새 버전으로 등록
- 다른 경로지만 같은 `hash`면 중복 원본 저장은 피하되, 폴더 문맥은 별도로 저장
- 중복으로 판단된 파일은 임시 파일을 삭제하고 `upload_status = skipped_duplicate`로 기록
- 신규 파일은 임시 파일을 최종 저장소로 atomic move 한 뒤 `storage_status = committed`로 기록
- 해시 계산 실패, 파일 이동 실패, DB 기록 실패가 발생하면 임시 파일을 삭제하고 해당 파일만 실패 처리

권장 처리 순서:

```text
1. 업로드 전 파일명, relative_path, 확장자, MIME, 크기 제한 검증
2. 임시 파일 생성
3. 수신 스트림을 임시 파일에 쓰면서 SHA-256 계산
4. 수신 완료 후 실제 수신 크기와 manifest 크기 비교
5. hash 기준 중복 조회
6. 중복이면 임시 파일 삭제 + skipped_duplicate 기록
7. 신규이면 최종 저장소로 이동 + folder_documents 저장
8. RAG 학습 큐 등록
```

브라우저에서 계산한 사전 해시는 선택적 최적화로만 사용한다. 사용자가 보낸 해시는 조작 가능하므로 보안 판단이나 최종 중복 판단에는 사용하지 않는다.

## 17. 첨부와 폴더 문서 생명주기

`attachments`와 `folder_documents`의 역할을 분리한다.

```text
attachments
= 실제 원본 파일, 저장 위치, owner, security_level, 삭제 상태의 기준

folder_documents
= 특정 folder_dataset 안에서 attachment가 어떤 폴더 문맥으로 등록되었는지 나타내는 파생 문서
```

따라서 데이터셋이나 폴더 문서를 삭제해도 원본 `attachments`는 기본적으로 유지한다. 원본 파일 삭제는 별도 옵션과 참조 수 검증을 거쳐 수행한다.

### 17.1 첨부 삭제

`attachments`가 삭제되면 해당 원본을 참조하는 폴더 문서와 벡터 청크는 더 이상 유효하지 않다.

권장 정책:

- `attachments.status`를 `deleted` 또는 `removed`로 변경한다.
- 연결된 `folder_documents.storage_status`를 `removed`로 변경한다.
- 연결된 벡터 청크를 삭제하거나 tombstone 처리한다.
- 검색/RAG 결과와 원본 열기 UI에서 제외한다.
- 물리 파일 삭제는 즉시 수행하지 않고 soft delete 이후 비동기 정리 작업에서 처리한다.

### 17.2 폴더 문서 삭제

특정 데이터셋에서 문서 1건만 제거하는 경우다.

권장 정책:

- 해당 `folder_documents.storage_status`를 `removed`로 변경한다.
- 해당 `folder_document_id`를 가진 벡터 청크를 삭제한다.
- 연결된 `attachments` 원본은 기본적으로 유지한다.
- 같은 `attachment_id`를 참조하는 다른 데이터셋이나 일반 첨부가 있을 수 있으므로 원본 파일을 즉시 삭제하지 않는다.

### 17.3 데이터셋 삭제

데이터셋 삭제는 폴더 문맥 삭제와 원본 파일 삭제를 분리한다.

권장 기본값:

- `folder_datasets.status`를 `removed` 또는 `deleted`로 변경한다.
- 해당 `dataset_id`의 `folder_documents`를 `removed`로 변경한다.
- 해당 `dataset_id`의 벡터 청크를 삭제한다.
- 연결된 `attachments` 원본은 기본적으로 유지한다.

원본까지 삭제하는 옵션을 제공할 경우:

- 기본값은 `delete_originals = false`로 둔다.
- `delete_originals = true`일 때만 원본 삭제 후보를 계산한다.
- 삭제 후보 `attachment_id`가 다른 `folder_documents`나 일반 첨부 흐름에서 참조 중이면 원본을 유지한다.
- 참조 수가 0이고 사용자가 원본 삭제 권한을 가진 경우에만 `attachments`를 삭제 처리한다.

### 17.4 중복 원본과 참조 수

같은 해시의 파일은 원본 저장을 공유할 수 있으므로 삭제 시 반드시 참조 수를 확인한다.

```text
attachments 참조 수 > 1
→ 원본 유지

attachments 참조 수 = 1이고 원본 삭제 요청이 명시됨
→ 권한 확인 후 원본 삭제 가능
```

### 17.5 벡터 청크 삭제 기준

벡터 청크에는 최소한 다음 메타데이터를 저장한다.

- `attachment_id`
- `folder_document_id`
- `dataset_id`
- `owner_id`
- `effective_security_level`
- `storage_status`
- `deleted_at`

삭제 작업은 다음 키를 기준으로 수행한다.

```text
folder_document 제거
→ vector_store.delete(where folder_document_id = ...)
→ folder_documents.storage_status = removed

folder_dataset 제거
→ vector_store.delete(where dataset_id = ...)
→ folder_documents 일괄 removed

attachment 제거
→ vector_store.delete(where attachment_id = ...)
→ 관련 folder_documents 일괄 removed
```

## 18. 실패 처리

폴더 업로드는 일부 파일 실패가 전체 실패로 이어지지 않도록 설계한다.

상태:

- `pending`
- `uploading`
- `uploaded`
- `skipped_duplicate`
- `upload_failed`
- `training`
- `completed`
- `failed`
- `partial_failed`

파일별 실패 사유:

- 확장자 차단
- 크기 초과
- 읽기 실패
- 해시 계산 실패
- 임시 저장 실패
- 최종 저장소 이동 실패
- DB 기록 실패
- 파싱 실패
- 임베딩 실패
- 벡터 저장 실패

롤백 정책:

- 업로드 중 실패하면 임시 파일을 즉시 삭제한다.
- 최종 저장소 이동 후 DB 기록에 실패하면 최종 파일을 삭제하거나 고아 파일 정리 대상으로 표시한다.
- DB 기록은 되었지만 RAG 학습에 실패하면 원본 파일은 유지하고 `training_status = failed`로 둔다.
- 배치 완료 시 `tmp_uploads/{batch_id}`에 남은 파일을 정리한다.
- 오래된 미완료 임시 업로드는 TTL 기반 정리 작업으로 삭제한다.

## 19. 구현 단계

### 1단계: 브라우저 폴더 업로드 MVP

- `<input webkitdirectory multiple>` 추가
- 상대 경로 수집
- 서버 multipart 업로드
- `folder_datasets`, `folder_upload_batches`, `folder_documents` 저장
- 기존 RAG 학습 파이프라인에 폴더 메타데이터 전달
- LanceDB 청크 메타데이터에 `attachment_id`, `folder_document_id`, `dataset_id`, `folder_path`, `folder_group_id`, `effective_security_level` 저장

### 2단계: 검색 결과 관련 문서 추천

- 검색 결과의 `folder_group_id` 수집
- 같은 `folder_group_id` 문서 조회
- UI에 “같은 폴더 관련 문서” 표시

### 3단계: 서버 로컬 경로 등록

- 허용 루트 디렉터리 설정
- 서버 경로 미리보기
- 서버 재귀 스캔
- 권한/용량/확장자 제한
- 배치 등록

### 4단계: 관계 가중치 검색 보강

- `folder_relationships` 생성
- 같은 폴더/부모 자식/같은 루트 가중치 반영
- RAG 컨텍스트 확장 로직 추가

## 20. 구현 대상 파일 예상

프론트엔드:

- `src/components` 또는 RAG 관리 화면 관련 컴포넌트
- 폴더 업로드 모달/페이지 신규 컴포넌트
- 파일 트리 미리보기 컴포넌트
- 업로드 진행률 UI

백엔드:

- `server/routes/folderDatasets.js` 신규
- `server/routes/files.js` 연동 또는 공통 저장 헬퍼 추출
- `server/rag.js` 폴더 업로드 payload 연동
- `server/rag_train.py` 청크 메타데이터 확장
- `server/schema.sql` 또는 `server/db.js` 마이그레이션 추가

검색:

- `server/rag_server.py`
- `server/rag_search.py`
- `server/routes/rag.js`
- `server/services/ragLocateFallback.js`

문서:

- [RAG.md](./RAG.md)
- [UploadFolder.md](./UploadFolder.md)

## 21. 검증 기준

- 폴더를 선택하면 하위 파일 목록이 유지된다.
- 서버에 `relative_path`, `folder_path`, `folder_keywords`가 저장된다.
- 같은 폴더 파일들이 같은 `folder_group_id`를 가진다.
- RAG 청크 메타데이터에 폴더 정보가 들어간다.
- `고객A 관련 자료 찾아줘` 질의에서 `고객A` 폴더 문서가 우선 검색된다.
- 검색 결과에 같은 폴더 관련 문서가 표시된다.
- 일부 파일 파싱 실패 시 나머지 파일 학습은 계속된다.

## 22. 결론

EasyStation의 폴더 업로드 기능은 사용자가 이미 정리해 둔 자료실 구조를 AI가 이해할 수 있게 만드는 기능이다.

따라서 구현의 핵심은 파일 내용만 학습하는 것이 아니라, 아래 정보를 함께 저장하고 검색에 활용하는 것이다.

```text
1. folder_path
2. folder_keywords
3. folder_group_id
4. sibling_files
5. folder_relationships
```

이 구조를 적용하면 EasyStation은 파일 단위 검색을 넘어 고객, 프로젝트, 연도, 업무 분류 단위로 문서를 이해하고 답변할 수 있다.
