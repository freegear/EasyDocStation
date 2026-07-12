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
  "security_level": 1
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
- `access_scope`: `all`, `team`, `channel`, `personal` (23장 참조. 업로더가 등록 시 선택)
- `scope_team_id`: `access_scope = team`일 때 대상 팀 ID
- `scope_channel_id`: `access_scope = channel`일 때 대상 채널 ID
- `security_level`: 데이터셋 최소 보안등급(정수). `effective_security_level` 계산의 상한 기준(4.4장)
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

> **전제 조건 — `attachments` 스키마 보강 (선행 필수)**
>
> 현재 `attachments`(`server/schema.sql`)는 `uploader_id`(`ON DELETE SET NULL`), `status`(기본 `PENDING`)만 있고 아래 정보를 아직 담지 못한다. `attachments`를 "기준 테이블"로 쓰려면 폴더 업로드 구현 전에 다음 컬럼을 먼저 추가한다.
>
> - `owner_id INTEGER`: 원본의 최종 소유자. `uploader_id`와 달리 소유자가 삭제돼도 `NULL`로 흩어지지 않도록 소유권 기준 컬럼으로 둔다.
> - `security_level INTEGER NOT NULL DEFAULT 0`: 보안등급의 원천. `users.security_level`, `posts.security_level`과 **같은 정수 체계**를 쓴다. 문자열(`internal` 등)은 사용하지 않는다.
> - `deleted_at TIMESTAMPTZ`: soft delete 시각. `status`에는 `deleted`/`removed` 상태를 추가한다.
>
> 이 컬럼이 없으면 아래 소유권·보안등급·삭제 정책은 상속할 원천 자체가 없으므로 성립하지 않는다. 즉 이 절의 정책은 위 스키마 보강을 반드시 전제한다.

- `id`
- `dataset_id`
- `batch_id`
- `attachment_id`
- `owner_id`
- `access_scope`: 상위 `folder_datasets.access_scope`를 상속 (23장)
- `scope_team_id`
- `scope_channel_id`
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
- **폴더 업로드 경로는 기존 게시글 첨부를 재사용하지 않고 전용 `attachments` 레코드를 새로 생성**하며, 이때 업로더를 곧바로 `owner_id`로 확정한다. 이렇게 하면 소유권·삭제 판단이 단순해진다. 다른 경로의 기존 첨부를 재사용하는 것은 같은 hash 중복 최적화(16장)에서만 제한적으로 허용한다.
- `folder_documents.owner_id`는 조회 최적화와 감사 목적으로 저장하되, 기본적으로 연결된 `attachments.owner_id`와 같아야 한다.
- `folder_datasets.owner_id`, `folder_upload_batches.owner_id`, `folder_documents.owner_id`, `attachments.owner_id`는 생성 시 일관성을 검증한다.
- 다른 사용자의 `attachment_id`를 임의로 `folder_documents`에 연결할 수 없게 한다.
- **보안등급은 모두 정수(`INTEGER`) 체계**를 쓴다. `users.security_level`과 같은 척도이며, 값이 클수록 더 높은 등급이다. `internal` 같은 문자열 표기는 사용하지 않는다.
- `folder_documents.security_level`은 기본적으로 `attachments.security_level`을 상속한다.
- `folder_datasets.security_level`이 더 높으면(더 엄격하면) `effective_security_level = max(attachment.security_level, dataset.security_level)`로 상향한다.
- 검색, RAG 컨텍스트 구성, 원본 열기 권한 검사는 `effective_security_level`과 요청 사용자의 `users.security_level`(및 앱 권한)을 함께 기준으로 한다.
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

> 폴더 업로드는 파일이 많아 학습 GPU 점유가 크다. 학습은 GPU가 비어 있을 때만 실행하고 대화형 요청(검색·답변)에 양보하도록 스케줄링한다. 상세 설계는 [RAG.md](./RAG.md)의 "5. GPU 학습 스케줄링" 장을 따른다.

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
- `access_scope`
- `scope_team_id`
- `scope_channel_id`
- `effective_security_level`
- `storage_status`
- `root_folder`
- `relative_path`
- `folder_path`
- `parent_folder`
- `folder_keywords`
- `folder_group_id`
- `sibling_files`

`access_scope`, `scope_team_id`, `scope_channel_id`, `effective_security_level`은 검색 프리필터가 청크만 보고 접근 권한을 판정하기 위해 반드시 청크에 함께 저장한다(23장 참조).

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
  "access_scope": "team",
  "scope_team_id": "team_xxxx",
  "scope_channel_id": "",
  "effective_security_level": 1,
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
- 연결된 벡터 청크를 tombstone 처리한다(즉시 검색 제외). 물리 삭제는 이후 비동기 정리 작업에서 수행한다. 상세 기준은 17.5장을 따른다.
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

> **정책 변경(결정 사항): 데이터셋 삭제는 완전 삭제(hard delete)를 기본으로 한다.**
>
> 이전 판본은 "데이터셋을 삭제해도 원본 `attachments`는 유지, `delete_originals=false`가 기본"이었으나, 폴더 데이터셋은 원본까지 포함한 하나의 자료 단위로 취급하기로 결정했다. 따라서 데이터셋 삭제 시 **원본 파일, `attachments` 행, RAG 청크, LanceDB row를 모두 삭제**한다. 다만 아래의 참조 수 검증(17.4장)은 반드시 유지한다 — 같은 원본을 게시글 첨부나 다른 데이터셋이 참조 중이면 그 원본은 남겨야 게시글 첨부가 깨지지 않는다.

데이터셋 삭제 시 `dataset_id` 기준으로 다음을 수행한다.

- `folder_datasets.status`를 `removed` 또는 `deleted`로 변경한다.
- 해당 `dataset_id`의 `folder_documents`를 `removed`로 변경한다.
- 해당 `dataset_id`의 벡터 청크를 tombstone → 물리 삭제한다(17.5장 2단계).
- 각 `attachment_id`에 대해 참조 수(17.4장)를 확인한다.
  - **참조 수 = 0**(이 데이터셋만 참조): 원본 파일과 `attachments` 행을 삭제한다.
  - **참조 수 > 0**(게시글 첨부 또는 다른 데이터셋이 참조 중): 해당 원본과 `attachments`는 유지하고, 이 데이터셋의 `folder_documents`·청크만 제거한다.
- 삭제 실행은 17.7장의 최종 일관성·멱등·재시도 원칙을 따른다.

즉 "완전 삭제"는 **참조가 오직 이 데이터셋뿐인 원본에 대해서만 원본까지 물리 삭제**한다는 의미다. 공유 원본을 말없이 지워 다른 곳을 깨뜨리지 않는다. 폴더 업로드 전용으로 새로 만든 `attachments`는 애초에 이 데이터셋만 참조하므로(4.4장) 대부분 참조 수 0으로 원본까지 삭제된다.

### 17.4 중복 원본과 참조 수

같은 해시의 파일은 원본 저장을 공유할 수 있으므로 삭제 시 반드시 참조 수를 확인한다.

참조 수를 셀 실체(referencer)를 먼저 명시한다. 현재 하나의 `attachments`를 가리키는 경로는 두 갈래다.

- 게시글 첨부: `attachments.post_id` 및 `posts.attachments_1..10`
- 폴더 문서: `folder_documents.attachment_id`

게시글 참조는 두 곳에 정보가 있으므로 **권위(authoritative) 기준을 하나로 고정**한다. 이 문서는 `posts.attachments_1..10`(게시글이 실제로 노출·소유하는 슬롯)을 게시글 참조의 권위 기준으로 삼고, `attachments.post_id`는 역참조 캐시로만 취급한다. 둘이 어긋나면 `posts.attachments_1..10`을 우선한다.

따라서 참조 수는 다음과 같이 정의한다.

```text
attachments 참조 수
= (해당 attachment_id를 참조하는 folder_documents 중 storage_status != 'removed' 개수)
+ (해당 attachment_id가 어떤 posts.attachments_1..10 슬롯에 아직 들어 있으면 1, 아니면 0)
```

- 초기 구현에서는 별도 카운터 컬럼을 두지 않고 삭제 시점에 위 기준으로 `COUNT` 조회한다(단순함 우선).
- 성능이 문제되면 이후 `reference_count` 캐시 컬럼을 도입하되, 정합성을 위해 증감 시점을 반드시 트랜잭션으로 묶는다.

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

**삭제는 2단계로 통일한다.** 앞선 17.1~17.3장의 "벡터 청크를 삭제한다"는 표현은 모두 아래 2단계를 의미하며, 즉시 물리 삭제를 뜻하지 않는다.

1. **tombstone(즉시 검색 제외):** 대상 청크의 `storage_status = 'removed'`, `deleted_at = now()`로 표시한다. 검색·RAG·원본 열기는 이 시점부터 해당 청크를 제외한다. 사용자 관점의 "삭제"는 여기서 완료된다.
2. **물리 삭제(비동기 정리):** 별도 정리 작업(배치/TTL)이 tombstone된 청크를 `vector_store.delete(...)`로 실제 제거한다. LanceDB의 물리 삭제/compaction 비용을 한데 모으기 위함이다.

삭제 대상 청크를 고르는 키는 다음과 같다(각 키로 1단계 tombstone을 표시하고, 2단계에서 물리 삭제한다).

```text
folder_document 제거
→ where folder_document_id = ...
→ folder_documents.storage_status = removed

folder_dataset 제거
→ where dataset_id = ...
→ folder_documents 일괄 removed

attachment 제거
→ where attachment_id = ...
→ 관련 folder_documents 일괄 removed
```

### 17.6 기존 CASCADE 삭제와의 충돌

위 삭제 흐름은 앱이 **의도적으로** 첨부/문서/데이터셋을 지우는 soft delete 경로만 다룬다. 그러나 현재 `attachments.channel_id`는 `ON DELETE CASCADE`(`server/schema.sql`)라서, **채널이 삭제되면 `attachments`가 물리 삭제(hard delete)** 되고 이를 참조하던 `folder_documents`·벡터 청크가 조용히 고아가 된다.

이 경로를 명시적으로 처리한다.

- 폴더 데이터셋이 특정 채널 수명주기에 묶이는 것이 맞는지 먼저 결정한다. 폴더 데이터셋은 채널과 독립적인 사용자/팀 자원으로 보는 것을 권장한다.
- 폴더 업로드 전용으로 새로 만든 `attachments`는 채널에 종속시키지 않도록 `channel_id`를 `NULL`로 두거나, CASCADE 대상에서 제외되는 소유 모델을 사용한다.
- 채널 삭제가 불가피하게 첨부를 지워야 한다면, hard delete 전에 연결된 `folder_documents`를 `removed` 처리하고 벡터 청크를 정리하는 정합성 단계(트리거 또는 애플리케이션 훅)를 반드시 거친다.

### 17.7 삭제 흐름의 원자성과 부분 실패

삭제는 서로 다른 3개 저장소를 건드린다.

- Postgres `attachments`
- Postgres `folder_documents`
- 벡터 저장소(LanceDB)

이들을 하나의 트랜잭션으로 묶을 수 없으므로, 삭제도 업로드(18장)와 마찬가지로 **최종 일관성(eventual consistency)** 으로 수렴시킨다. 핵심 원칙은 다음과 같다.

- **Postgres 상태 변경을 먼저 확정한다.** `attachments.status`/`folder_documents.storage_status`를 `removed`로 바꾸는 것을 진실의 원천(source of truth)으로 삼는다. 이 단계가 성공하면 사용자 관점의 삭제는 완료된 것으로 본다.
- **벡터 tombstone/물리 삭제는 뒤따르는 비동기 작업**으로 처리한다. 벡터 삭제가 실패해 고아 청크가 남아도, 검색 단계에서 `storage_status = 'removed'`인 청크를 필터링하므로 사용자에게 노출되지 않는다.
- **정리 작업은 멱등(idempotent)하게** 만든다. 같은 tombstone 대상을 여러 번 삭제 시도해도 안전해야 한다.
- 주기적 **reconciliation 작업**으로 "Postgres에서 removed인데 벡터에 아직 남아 있는" 청크와 "벡터에는 있는데 대응 `folder_documents`가 없는" 고아 청크를 찾아 정리한다.
- 부분 실패는 실패로 롤백하지 않고 재시도 큐로 넘긴다. 즉 삭제는 "실패 시 원상복구"가 아니라 "성공할 때까지 재시도"로 설계한다.

### 17.8 보안등급 변경 시 재계산

`folder_datasets.security_level` 또는 원본 `attachments.security_level`이 사후에 변경되면, 그로부터 파생된 값이 자동으로 갱신되지 않는다. 오래된 등급으로 검색에 노출되는 보안 구멍을 막기 위해 **재계산을 명시한다.**

- `folder_documents.effective_security_level = max(attachments.security_level, folder_datasets.security_level)`는 파생 값이다.
- 데이터셋 또는 원본 첨부의 `security_level`이 변경되면, 영향받는 `folder_documents.effective_security_level`을 **다시 계산해 반영**한다.
- 재계산된 값은 **벡터 청크 메타데이터의 `effective_security_level`에도 전파**한다. 벡터 갱신도 17.7장과 같은 비동기·멱등·최종 일관성 원칙을 따른다.
- 전파가 완료되기 전까지 검색이 낮은(느슨한) 등급으로 노출되면 안 되므로, **상향(더 엄격해지는) 변경은 Postgres 기준값을 먼저 반영**하고 검색 권한 검사에서 Postgres의 최신 `effective_security_level`을 우선 신뢰한다. 벡터 메타데이터는 성능 최적화용 사본으로 취급한다.

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

### 0단계: `attachments` 스키마 보강 (선행 필수)

4.4장 전제 조건을 먼저 반영한다. 이 단계 없이는 소유권·보안등급·삭제 정책이 성립하지 않는다.

- `attachments`에 `owner_id INTEGER`, `security_level INTEGER NOT NULL DEFAULT 0`, `deleted_at TIMESTAMPTZ` 추가(재실행 안전 마이그레이션).
- `status`에 `deleted`/`removed` 상태 도입.
- `channel_id ON DELETE CASCADE`가 폴더 데이터셋을 끌고 가는 문제(17.6장) 처리 방향 확정.

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
- `server/schema.sql` 또는 `server/db.js` 마이그레이션 추가 (`attachments`에 `owner_id`, `security_level`, `deleted_at` 추가 및 신규 폴더 테이블 생성)

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
- 검색 결과에 같은 폴더 관련 문서가 표시되고, 같은 폴더 문서가 답변 생성 컨텍스트에도 포함된다(23.3).
- `access_scope`에 따라 접근 권한이 없는 사용자는 해당 데이터셋을 검색·열람할 수 없다(모두/팀/채널/개인, 23.1).
- `personal` 데이터셋은 업로더 외 다른 사용자 검색 결과·컨텍스트에 노출되지 않는다.
- 데이터셋 삭제 시 원본 파일·`attachments`·RAG 청크·LanceDB row가 모두 삭제되되, 공유 원본(참조 수 > 0)은 유지된다(23.2).
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

## 23. 접근 범위 모델 · 컨텍스트 주입 · 기존 구현 충돌

이 장은 아래 세 가지 결정 사항과, 이를 구현할 때 **기존 RAG 코드와 충돌하는 지점**을 정리한다. 여기 적힌 충돌은 무시하고 진행할 수 없는 선결 과제다.

### 23.1 접근 범위: 모두 / 팀 / 채널 / 개인

폴더 업로드 데이터셋은 채널·팀에만 귀속되지 않는다. 업로더가 등록 시 다음 4가지 중 하나를 **선택**한다.

- `all` (모두): 해당 워크스페이스의 모든 사용자가 검색·열람 가능.
- `team` (팀): `scope_team_id` 팀에 연결된 사용자만 검색·열람 가능.
- `channel` (채널): `scope_channel_id` 채널에 연결된 사용자만 검색·열람 가능.
- `personal` (개인): 업로더 본인(`owner_id`)만 검색·열람 가능.

이 범위는 `folder_datasets`에 저장하고, `folder_documents`와 **벡터 청크 메타데이터에까지 복제**한다. 검색 프리필터가 청크만 보고 판정해야 하기 때문이다. 사용자 `U`의 접근 판정은 다음 OR 조건이다.

```text
접근 허용 =
   access_scope = 'all'
OR (access_scope = 'team'     AND scope_team_id ∈ U의 소속 팀)
OR (access_scope = 'channel'  AND scope_channel_id ∈ U의 접근 가능 채널)
OR (access_scope = 'personal' AND owner_id = U.id)
그리고 항상: effective_security_level ≤ U.security_level
```

### 23.2 데이터셋 삭제: 완전 삭제

17.3장 결정에 따라 데이터셋 삭제는 원본 파일·`attachments`·RAG 청크·LanceDB row를 **모두 삭제**한다. 단, 17.4장의 참조 수 검증을 유지해 공유 원본은 보호한다.

### 23.3 같은 폴더 관련 문서: 생성 컨텍스트에 주입

같은 폴더(`folder_group_id`) 관련 문서는 UI 추천에 그치지 않고 **답변 생성 컨텍스트에 포함**한다. 1차 벡터 검색 결과의 `folder_group_id`를 모아 같은 그룹 문서 청크를 추가 조회하고, 최종 컨텍스트에 병합한다. 단 아래 제약을 지킨다.

- 확장된 형제 문서도 23.1의 접근 범위와 `effective_security_level` 필터를 **다시 통과**시킨다(권한 누수 방지).
- 그룹당 상위 N개로 제한하고, 원문 문서보다 낮은 가중치(7장 same_folder=1.0 기준 아래)로 넣어 컨텍스트 토큰 예산을 지킨다.

### 23.4 기존 구현과의 충돌 (선결 과제)

**충돌 1 — RAG ACL이 채널 전용 하드필터다. (차단성)**
현재 `server/rag_search.py`는 `metadata.channel_id IN (allowed_channel_ids)`로만 필터하고, `allowed_channel_ids`가 비면 무조건 빈 결과를 낸다. `server/routes/rag.js`도 접근 채널이 0개면 검색을 아예 안 한다. 폴더 데이터셋 청크는 `channel_id`가 없어 **현재 로직에서는 아무에게도 안 보인다.** `all`/`team`/`personal` 범위는 채널 필터로 표현조차 불가능하다. → `rag_search.py`의 프리필터를 23.1 OR 조건으로 확장하고, `rag.js`·`ragLocateFallback.js`가 채널 ID 대신 "사용자 스코프 컨텍스트(소속 팀, 접근 채널, user_id, security_level)"를 전달하도록 재설계해야 한다.

**충돌 2 — LanceDB 메타데이터가 고정 struct 스키마다. (차단성)**
`server/rag_train.py`의 `required` 필드 목록과 struct 서브필드가 고정이라, `access_scope`·`scope_team_id`·`scope_channel_id`·`owner_id`·`dataset_id`·`folder_group_id`·`effective_security_level`을 넣으려면 **schema_version 업 + 테이블 재생성/백필**이 필요하다. 무시하면 신규 필드가 저장되지 않는다.

**충돌 3 — `security_level`이 청크 스키마에 없어 사실상 무력하다.**
`server/services/ragLocateFallback.js`는 `meta.security_level`로 필터하지만, 그 필드는 `rag_train.py`의 청크 스키마에 **없다.** 현재 벡터 검색 단계의 보안등급 필터는 항상 0으로 취급되어 무력하다. 폴더 업로드의 `effective_security_level`을 실제로 적용하려면 이 필드를 스키마에 먼저 넣어야 한다(충돌 2와 함께 처리).

**충돌 4 — 데이터셋을 pseudo 채널로 우회한 선례가 있다.**
기존 "수동 데이터셋" 업로드는 `server/routes/rag.js`에서 `channel_id: 'rag_dataset'`(실재하지 않는 채널)로 저장한다. 이 값은 어떤 사용자의 접근 가능 채널에도 없어 메인 검색에서 걸리지 않는다. 폴더 업로드는 이 우회를 답습하지 말고 23.1 스코프 모델로 정식 처리한다.

**충돌 5 — 벡터 삭제 키가 `post_id`/`comment_id`뿐이다. (차단성)**
`server/rag_train.py`의 삭제는 `metadata.post_id` / `comment_id` 기준만 지원한다. 데이터셋 완전 삭제(23.2)를 위해 `metadata.dataset_id` / `attachment_id` 기준 삭제 키를 추가해야 하며, 이는 충돌 2의 스키마 확장이 선행돼야 한다.

**충돌 6 — 컨텍스트 조립·캐시가 이미 예산에 묶여 있다.**
`server/routes/rag.js`의 컨텍스트 조립부는 `finalResults`를 그대로 join하고 결과를 캐시한다. 23.3의 형제 문서 확장은 이 파이프라인에 얹되, ACL 재검증과 개수 상한을 반드시 적용해 권한 누수와 캐시 키 불일치를 막는다. 방향 자체는 기존 `priorityBoost`(채널/팀 근접도 가감) 확장으로 자연스럽게 붙는다.

### 23.5 처리 순서 권고

1. `attachments` 스키마 보강(19장 0단계) + 폴더 테이블에 `access_scope` 계열 컬럼 추가.
2. LanceDB schema_version 업 + `access_scope`·`scope_*`·`owner_id`·`dataset_id`·`effective_security_level` 필드 추가 및 백필(충돌 2·3).
3. `rag_search.py` 프리필터를 23.1 OR 조건으로 확장, 호출부(`rag.js`·`ragLocateFallback.js`)를 스코프 컨텍스트 전달로 변경(충돌 1·4).
4. `rag_train.py`에 `dataset_id`/`attachment_id` 삭제 키 추가(충돌 5), 데이터셋 완전 삭제 흐름 연결(23.2).
5. 같은 폴더 컨텍스트 주입 + ACL 재검증 + 개수 상한(23.3, 충돌 6).

### 23.6 구현 현황 (2026-07-11 기준)

**1단계(업로드/저장) — 완료**
- `attachments` 보강 + `folder_datasets`/`folder_upload_batches`/`folder_documents`/`folder_relationships` 테이블(`server/folder/schema.js`, boot 자동 마이그레이션).
- 업로드/목록/상세/완전삭제 라우트(`server/routes/folderDatasets.js`), 데이터 접근 계층(`server/folder/repository.js`).
- 기존 JSON 데이터셋 흡수(`server/scripts/absorb-rag-datasets.js`).
- 프론트 폴더 업로드 모달(`src/features/folderUpload/FolderUploadModal.jsx`).

**스코프 검색 인프라 — 완료(단, 활성화는 마이그레이션 필요)**
- LanceDB **schema v3** 필드(스코프+폴더): `server/rag_train.py` `schema_v3_fields()`. **`schema_version >= 3`에서만 적용**되어 활성 v2 테이블은 무영향.
- 스코프 인지형 검색 ACL: `server/rag_server.py` `build_acl_clause()`(모두/팀/채널/개인 + `effective_security_level` + site_admin). 테이블에 스코프 필드가 있을 때만 스코프 절 적용 → v2 검색 동작 보존.
- 폴더 문서 학습 인제션: `server/rag_train.py` `ingest_folder_document()`(기존 파서 재사용 + 스코프 stamp).
- `dataset_id`/`attachment_id` 벡터 삭제 키.
- 검색 호출부 `server/routes/rag.js`에 `scope_context` 전달 + 캐시 키 스코프 지문(사용자 간 누수 방지).
- 라우트 학습/삭제 트리거: `server/folder/ragTrainer.js`(**`folderVectorsEnabled()`=schema>=3일 때만 실제 수행**), 업로드 시 백그라운드 학습, 삭제 시 벡터 삭제.

**활성화(마이그레이션) — 운영 단계로 남김 (사용자가 파괴적 방식 승인)**
현재 `config.json`의 `rag.schema_version = 2`, `active_table = my_rag_table_v2`(16,223행)이다. 스코프 검색을 켜려면:
1. 게시글/댓글 전체를 schema v3 테이블로 **재학습**(기존 rebuild 흐름). 재학습 완료 전까지 검색이 비므로 저부하 시간대에 수행.
2. `config.json` `rag.schema_version = 3`, `active_table`을 v3로 전환.
3. `node server/scripts/train-folder-datasets.js`로 기존/보류 폴더 문서 백필.
마이그레이션 전까지 폴더 업로드는 저장은 되고 `training_status = pending`(응답 `training: pending_migration`)으로 대기하며, 활성 v2 데이터는 절대 손상되지 않는다.

**같은 폴더 컨텍스트 주입(23.3) — 완료**
- 1차 결과의 `folder_group_id`를 모아 같은 그룹 청크를 추가 조회하고 ACL 재검증 + 그룹당/전체 개수 상한을 적용해 생성 컨텍스트에 병합: `server/routes/rag.js` `expandFolderSiblings()`/`buildFolderSiblingContext()`.
- 검색 엔진 양쪽 경로 대칭: `server/rag_server.py`(상시 HTTP 서버)와 `server/rag_search.py`(subprocess 폴백) 모두 `with_folder_group_filter()`로 `folder_group_ids` 필터를 ACL 위에 AND 결합. 두 경로 모두 스코프 ACL(`build_acl_clause`) 반영 완료.

**GPU 학습 스케줄링 (RAG.md 5장) — 1~5단계 구현 완료**

폴더 업로드 대량 학습이 실시간 검색·답변과 GPU를 경합하는 문제를 5단계로 해소했다. 상세 설계·플래그·검증 기준은 [GpuScheduling.md](./GpuScheduling.md)(§9.1 구현 현황) 참조.

1. **경량 협조 게이트** — `server/gpu/gpuGate.js`(nvidia-smi 물리 게이트 + Redis 논리 리스 + `waitForTrainingSlot`). `ragTrainer`가 파일 배치 단위로 양보. 검색·Ollama 하트비트(`markInteractiveBusy`/`withInteractiveLease`). 기본 on, nvidia-smi/Redis 폴백으로 안전.
2. **임베딩 단일화** — `rag_train.py` `embed_texts()`가 rag_server `/embed`로 통일(기존 구현). bge-m3 이중 로드 제거.
3. **관측성** — `aiMetrics` GPU 메트릭 + `GET /api/admin/gpu-optimization`의 `gpu_scheduling` 상태 + SiteAdminPage "GPU 학습 스케줄링" 패널.
4. **정식 단일 브로커 큐** (opt-in) — `server/gpu/broker.js`(전용 커넥션 소비자 그룹). `broker_enabled`+`queue_enabled` 시 `ai:queue:training`으로 학습 적재, 아니면 직접 게이트 경로. `index.js`에서 기동.
5. **운영 성숙** — 기아 방지(`max_yield_wait_sec`), 파일 단위 양보(`train_yield_batch`), Ollama 논리 레인(리스).

`training_status`는 `trainBatchDirect`가 배치 단위로 소유(직접·브로커 경로 정확). 기본값에서 검색·기존 학습 경로 동작을 보존한다.
