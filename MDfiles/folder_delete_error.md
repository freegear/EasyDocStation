# 폴더 삭제 시 "서버 오류가 발생했습니다" 수정 계획

## 1. 증상

메일 사이드바에서 특정 폴더(`Quotaviolate`, `Reserved` 등)를 삭제하면 삭제되지 않고 본문에
빨간 글씨로 **"서버 오류가 발생했습니다."** 가 표시된다.

## 2. 원인 (진단 완료)

폴더 삭제 로직의 버그가 아니라, **IMAP 서버가 해당 메일함 삭제를 거부**하고 그 예외가
그대로 500 오류로 프론트에 전달되는 문제다.

`logs/run-dgx-spark.log` 결정적 로그:

```
executedCommand: '7 DELETE Quotaviolate'
responseText:    'Cannot delete this mailbox.'   ← IMAP 서버가 NO 응답으로 거부
executedCommand: '7 DELETE Reserved'
responseText:    'Cannot delete this mailbox.'
```

### 처리 흐름

1. 프론트 삭제 요청 → `server/routes/mail.js:1428` `DELETE /accounts/:id/folders/:folderId`
2. 로컬 DB상 폴더가 `type='custom'`, `is_local=false` → **프로바이더 삭제 먼저 시도** (`mail.js:1457`)
3. `server/mail/providerRename.js:176` `client.mailboxDelete(currentPath)` 실행
4. IMAP 서버(네이버 등)가 `Quotaviolate`·`Reserved`를 **예약/시스템 메일함**으로 취급 →
   `NO Cannot delete this mailbox.` 반환
5. imapflow가 `Error: Command failed` throw → 라우트 `catch`의 `next(err)` →
   공통 에러 핸들러가 **500 "서버 오류가 발생했습니다"** 응답

### 근본 문제

`Quotaviolate`/`Reserved`는 IMAP 서버에서는 삭제 불가한 특수 메일함이지만,
로컬 DB에는 일반 사용자 폴더(`type='custom'`)로 저장되어 삭제 버튼이 노출된다.
→ 삭제 시도 → 서버 거부 → 500 오류가 반복된다.

## 3. 수정 계획

### 1번 — 에러 메시지 개선 ✅ 적용 완료 (2026-07-04)

**적용 내용**
- `server/mail/providerRename.js`: `isMailboxDeleteRejectedError(err)` 헬퍼 추가
  (`isMailboxMissingError` 패턴 미러링, `NONEXISTENT`(없음)과 구분).
- `deleteImapMailbox`: `client.mailboxDelete()`를 try/catch로 감싸 서버 거부 시
  예외 대신 `{ rejected: true, reason: 'server_rejected', message: '이 메일함은 서버에서 삭제할 수 없습니다.' }` 반환.
  하위 폴더 있는 경우도 throw → `{ rejected: true, reason: 'has_children', message }` 로 변경(동일하게 500 방지).
- `server/routes/mail.js:1457` 부근: `applied.rejected`면 `409` + `applied.message` 로 응답.
- 프론트(`src/lib/api.js`)가 응답 `error` 필드를 `err.message`로 사용 →
  `MailPage.jsx:5512`에서 그대로 노출. 체인 확인 완료.
- 검증: 실제 로그 응답 문자열(`Cannot delete this mailbox.`)에 대해 판별식 true,
  `NONEXISTENT`/`null`에 대해 false 확인.

**설계 원본 (참고)**

IMAP 삭제 거부 예외를 잡아 500 대신 명확한 메시지로 반환한다.

- **판별 함수 추가**: `server/mail/imapSync.js`의 `isMailboxMissingError(err)` 패턴을 그대로 따라
  `isMailboxDeleteRejectedError(err)` 를 만든다.
  판정 기준: `err.responseText` / `err.response` 에 `Cannot delete this mailbox` 또는
  `NO ... DELETE` 거부 신호가 있는지 정규식으로 확인.
  (관련 export/require 위치에 맞춰 `providerRename.js`에서 사용 가능하게 배치)
- **`deleteImapMailbox` 보강** (`server/mail/providerRename.js:157`):
  `client.mailboxDelete(currentPath)` 를 try/catch로 감싸고, 거부 에러면
  `{ skipped: true, reason: 'delete_rejected' }` 같은 형태로 반환하거나 전용 에러 코드를 세운다.
- **라우트 응답 처리** (`server/routes/mail.js:1457` 부근):
  `applied.skipped` 사유가 `delete_rejected` 이면 `409`(또는 `400`)와 함께
  **"이 메일함은 서버에서 삭제할 수 없습니다."** 메시지로 반환.
  → 프론트는 이 메시지를 그대로 노출하므로 사용자가 원인을 이해할 수 있다.

### 실측 결과 (2026-07-04) — ⚠️ flags/specialUse로는 구분 불가

일회성 스크립트로 각 IMAP 계정의 `client.list()` 응답을 실측한 결과, **삭제 불가 폴더가
일반 사용자 폴더와 완전히 동일한 메타데이터**를 갖는다:

| 계정 | 삭제 불가 폴더 | specialUse | flags |
|---|---|---|---|
| `freegear@siliconcube.co.kr` (imap, delim=`.`) | Quotaviolate, Reserved | `null` | `["\HasNoChildren"]` |
| `jylim3@naver.com` (naver) | 내게쓴메일함, 청구·결제, 카페, 프로모션, SNS | `null` | `["\HasNoChildren"]` |

- 이들은 모두 `specialUse=null`, `flags=["\HasNoChildren"]` 로, 사용자가 만든 진짜 custom
  폴더와 **IMAP 속성만으로는 전혀 구별되지 않는다.**
- 즉 네이버 자동분류함(청구·결제/카페/프로모션/SNS/내게쓴메일함)과 siliconcube 서버
  예약함(Quotaviolate/Reserved)은 서버가 삭제만 막을 뿐, LIST 응답에 삭제 불가 표식을 주지 않는다.

**결론**: 원래 계획한 "flags/specialUse 기반 UI 차단"은 **불가능**하다. 아래 2번을 방향 전환한다.

### 2번(수정) — 서버 거부를 학습해 UI 차단 ✅ 적용 완료 (2026-07-04)

**적용 내용** (⚠️ 백엔드 재시작 필요 — 스키마 마이그레이션 + 새 코드 로드)
- `server/mail/schema.js`: `mail_folders`에 `deletable BOOLEAN NOT NULL DEFAULT TRUE` 컬럼 추가
  (`ADD COLUMN IF NOT EXISTS`, 멱등). sync_status/color_key와 동일한 마이그레이션 경로.
- `server/mail/repository.js`:
  - `ACCOUNT_FOLDERS_SUBQUERY`에 `'deletable', mf.deletable` 추가 → 프론트가 폴더별 값 수신.
  - `setFolderDeletable({ tenantId, accountId, folderId, deletable })` 추가 + export.
- `server/routes/mail.js`(폴더 삭제 라우트): `applied.reason === 'server_rejected'`면
  `repo.setFolderDeletable(..., deletable:false)`로 학습. (`has_children`는 학습 안 함 — 하위 정리 후 삭제 가능.)
- `src/features/mail/MailPage.jsx`:
  - `FolderContextMenu`: `menu.folder.deletable === false`면 삭제 버튼 비활성화 + 툴팁.
  - 삭제 실패가 `409`면 로컬 `accounts` 상태의 해당 폴더를 즉시 `deletable:false`로 반영(재조회 불필요).
- 검증: 백엔드 5파일 `node -c` 통과, 프론트 esbuild 통과(vite HMR로 즉시 반영).

**설계 원본 (참고)**
flags로 구분이 안 되므로, **서버가 삭제를 거부한 폴더를 기억**하는 방식으로 전환한다.

- 1번에서 `deleteImapMailbox`가 `rejected(server_rejected)`를 반환할 때,
  해당 폴더에 삭제 불가 플래그를 영속화한다.
  예: `mail_folders`에 `deletable=false`(또는 기존 `sync_status`류 컬럼 재사용) 저장.
- 프론트는 이 플래그가 있는 폴더의 **삭제 메뉴를 비활성화**한다.
- 장점: provider/locale/폴더명에 의존하지 않고, 첫 시도 1회만 명확한 안내(1번) 후 재노출 안 함.
- 대안(보조): 알려진 네이버 자동분류함 이름(내게쓴메일함/청구·결제/카페/프로모션/SNS)을
  이름 기반으로도 선차단 — 단, locale·서버별로 취약하므로 학습 방식의 보조로만 사용.

### 2번(구계획, 폐기) — flags/specialUse 기반 판별

애초에 삭제 버튼을 막거나 특수 폴더로 표시한다.

- **선행 확인 필요**: `Quotaviolate`/`Reserved`가 네이버 서버 `client.list()` 응답에서
  어떤 `flags` / `specialUse` 를 갖는지 확인한다.
  - 현재 `listImapFolders` (`server/mail/imapSync.js:83`)는 `\Noselect` 플래그만 제외하고
    나머지는 전부 폴더로 올린다(`classifyMailbox`는 이들을 `custom`으로 분류).
  - 네이버가 이 폴더들에 어떤 속성을 주는지(예: 특정 flag, 이름 규칙) 실측 후 판별 조건을 정한다.
- **분류 보강**: 특수 메일함으로 식별되면 `type='custom'`이 아니라 삭제 불가 표시를 남기고,
  프론트에서 삭제 버튼을 비활성화한다.
- 판별 기준이 불명확하면 최소한 1번(에러 메시지)만으로도 UX는 크게 개선된다.

## 4. 적용 순서

1. ✅ 1번(에러 메시지 개선) 적용 — 500 → 명확한 409 메시지. (완료)
2. ✅ 실측 완료 — 삭제 불가 폴더는 flags/specialUse가 일반 폴더와 동일 → 속성 기반 판별 불가 확인.
   (자동 동기화는 `listImapFolders`를 안 거치므로, 일회성 스크립트로 각 계정 `client.list()` 직접 실측.)
3. ✅ 2번(수정) — 서버 거부(`server_rejected`)를 `mail_folders.deletable`에 영속화 → 프론트 삭제 메뉴 비활성화. (완료, **백엔드 재시작 필요**)

## 5. 관련 파일

- `server/routes/mail.js:1428` — 폴더 삭제 라우트
- `server/mail/providerRename.js:157,186` — `deleteImapMailbox`, `deleteFolderOnProvider`
- `server/mail/imapSync.js:83,104` — `listImapFolders`, `isMailboxMissingError`(참고 패턴)
