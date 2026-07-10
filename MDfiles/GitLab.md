# GitHub / GitLab History 연동 서비스 구축 의견

## 1. 목표

GitHub 혹은 GitLab과 연동된 서비스를 만든다면, 단순히 저장소 파일을 보여주는 기능보다 **History를 읽고 업무 맥락으로 재구성하는 서비스**가 EasyDocStation에 더 잘 맞는다.

현재 프로젝트 히스토리를 보면 최근에는 UI, 메일, EasySheet, RAG/LanceDB 개선이 빠르게 진행되었고, 이전 구간에는 회의록, 게시글 댓글, AgenticAI, STT 같은 기능이 촘촘히 쌓여 있다. 즉 이 서비스는 이미 "문서, 대화, AI 분석, 업무 기록"을 다루는 방향으로 발전하고 있다.

따라서 Git 연동의 핵심 가치는 다음과 같이 잡는 것이 좋다.

- 커밋/브랜치/머지 히스토리를 업무 타임라인으로 시각화한다.
- 커밋 diff를 AI가 읽고 변경 의도, 영향 범위, 위험도를 요약한다.
- 특정 파일이나 기능의 변경 이력을 RAG 검색 대상으로 만든다.
- 코드 리뷰, 보안 리뷰, 회귀 위험 분석을 게시글/댓글 흐름과 연결한다.
- GitHub/GitLab의 이슈, MR/PR, 댓글을 EasyDocStation의 논의 구조와 연결한다.

## 2. 서비스 콘셉트

권장 콘셉트는 **Repository Intelligence Board**이다.

사용자는 GitHub/GitLab 저장소를 연결하면 다음 화면을 볼 수 있다.

1. Repository
   - 파일 트리, README, 주요 디렉터리 구조를 표시한다.
   - 현재 EasyDocStation의 파일/첨부/RAG 구조와 유사하게 접근하면 된다.

2. Branch Graph
   - 브랜치, 커밋, 머지를 그래프로 표시한다.
   - 사용자가 올린 예시 화면처럼 커밋을 클릭하면 오른쪽 패널에 AI 분석과 토론을 보여준다.

3. Discussions
   - 특정 커밋, 파일 라인, PR/MR 단위로 의견을 남긴다.
   - 기존 게시글/댓글 모델을 재사용하기 좋다.

4. AI Code Analysis
   - 커밋 diff, 파일 변경, 취약 패턴, 테스트 누락 가능성을 요약한다.
   - 분석 결과는 RAG 학습 대상이 되어 이후 질문에 재사용된다.

## 3. GitHub와 GitLab 중 우선순위

초기 구현은 GitLab을 먼저 고려하는 것이 좋다.

이유:

- 기업/내부망 환경에서는 GitLab self-managed 사용 가능성이 높다.
- GitLab은 Project, Merge Request, Pipeline, Commit API가 조직 내부 개발 흐름과 잘 맞는다.
- OAuth 또는 Personal Access Token 기반 연동을 모두 제공하기 쉽다.
- 사내 구축형 EasyDocStation과 함께 배포할 때 GitLab self-hosted 연동 수요가 클 가능성이 있다.

다만 설계는 GitHub/GitLab을 직접 분기하지 말고 `GitProvider` 추상 계층으로 잡는 것이 좋다.

예상 Provider 인터페이스:

```txt
listRepositories()
getRepository()
listBranches()
listCommits()
getCommit()
getDiff()
listMergeRequestsOrPullRequests()
listComments()
createComment()
```

이렇게 잡으면 GitLab을 먼저 구현하고, 이후 GitHub는 adapter만 추가할 수 있다.

## 4. History 기반 핵심 기능

### 4.1 커밋 타임라인 요약

커밋 히스토리를 단순 로그가 아니라 기능 단위로 묶어 보여준다.

예:

- 2026-07-01 ~ 2026-07-04: 메일 기능 통합 및 안정화
- 2026-06-28 ~ 2026-06-29: RAG/LanceDB 버전드 마이그레이션과 EasySheet 연동
- 2026-05-03 ~ 2026-05-07: 회의록, 채널 설정, STT, AgenticAI 기능 확장

AI는 커밋 메시지, 변경 파일, diff를 함께 보고 "이 시기에 무엇을 만들었는지"를 요약한다.

### 4.2 파일 단위 히스토리

사용자가 파일을 선택하면 다음을 보여준다.

- 이 파일을 바꾼 커밋 목록
- 변경이 잦은 구간
- 최근 변경 이유 요약
- 이 파일과 함께 자주 바뀐 파일
- 회귀 위험이 높은 연관 파일

이 기능은 현재 RAG 검색과 잘 맞는다. 파일별 변경 히스토리와 요약을 벡터화하면 "메일 동기화가 언제 바뀌었지?", "RAG cutoff 정책은 어디서 결정됐지?" 같은 질문에 답할 수 있다.

### 4.3 Merge Request / Pull Request 분석

MR/PR을 열면 다음 항목을 자동 생성한다.

- 변경 요약
- 영향 범위
- 위험도
- 테스트 필요 항목
- 보안 체크 포인트
- 문서 업데이트 필요 여부

특히 EasyDocStation에는 메일 OAuth, 인증, 파일 업로드, RAG 학습 데이터, DB 경로처럼 민감한 영역이 많다. 따라서 MR/PR 분석에는 보안 관점을 기본 포함하는 것이 좋다.

### 4.4 커밋 단위 토론

커밋이나 diff 라인에 대해 사용자가 게시글처럼 토론할 수 있게 한다.

구조:

- Repository
- Commit
- File
- Line range
- Discussion thread
- AI analysis card

기존 EasyDocStation의 게시글/댓글 UX와 연결하면 새 시스템을 크게 만들지 않아도 된다.

### 4.5 History RAG

Git History를 RAG 학습 대상으로 넣는 것이 이 서비스의 차별점이다.

학습 대상:

- 커밋 메시지
- 커밋 diff 요약
- 변경 파일 목록
- MR/PR 제목과 설명
- 리뷰 댓글
- CI 결과
- AI 분석 결과

단, 전체 diff 원문을 무조건 학습하면 비용과 노이즈가 커진다. 원문 diff는 저장하되, RAG에는 "요약 + 메타데이터 + 핵심 hunks" 중심으로 넣는 편이 좋다.

권장 메타데이터:

```txt
provider: gitlab | github
repository_id
repository_name
branch
commit_sha
author
committed_at
files_changed
file_path
change_type
mr_or_pr_id
risk_level
analysis_version
```

## 5. 화면 구성 의견

### 5.1 좌측 패널

- 연결된 Git 서버 목록
- 프로젝트/그룹 목록
- 저장소 검색
- 즐겨찾기 저장소

### 5.2 중앙 영역

탭 기반 구성이 적합하다.

- Repository: 파일 트리와 README
- Branch Graph: 커밋 그래프
- Changes: 선택 커밋의 diff
- History Insight: AI가 묶은 기간별 변경 요약
- MR/PR: 리뷰 대상 목록

### 5.3 우측 패널

우측은 "분석과 토론"에 집중한다.

- 선택 커밋 요약
- 위험도 카드
- 관련 파일
- 관련 게시글/회의록/RAG 문서
- 댓글 스레드
- AI에게 질문하기

사용자가 제공한 예시 이미지의 방향이 좋다. 중앙에서 히스토리를 탐색하고, 오른쪽에서 해당 커밋의 의미와 논의를 보는 구조가 자연스럽다.

## 6. 아키텍처 의견

### 6.1 연동 방식

초기에는 API 기반 동기화를 권장한다.

- GitLab REST API 또는 GraphQL API
- GitHub REST API 또는 GraphQL API
- Webhook은 2단계에서 추가

처음부터 webhook에 의존하면 로컬 개발과 재처리가 번거롭다. 먼저 수동 동기화와 주기 동기화를 만들고, 안정화 후 webhook으로 실시간성을 높이는 편이 좋다.

### 6.2 데이터 저장

권장 저장 구조:

- PostgreSQL: 저장소, 브랜치, 커밋, MR/PR, 댓글, 동기화 상태
- Cassandra: 대량 이벤트/활동 로그가 필요할 경우
- LanceDB: 커밋 요약, diff 요약, 리뷰 댓글, AI 분석 결과 벡터 검색
- Redis: 동기화 작업 큐, rate limit, 최근 분석 캐시

현재 프로젝트가 이미 PostgreSQL, Cassandra, Redis, LanceDB를 함께 쓰는 방향이므로 이 흐름에 맞추면 된다.

### 6.3 동기화 단위

동기화는 저장소 전체를 매번 가져오지 말고 cursor 기반으로 나눈다.

1. Repository metadata
2. Branch list
3. Commit list
4. Commit detail and diff
5. MR/PR list
6. MR/PR comments
7. CI status
8. AI summary and embedding

각 단계는 실패해도 재시도 가능해야 한다.

## 7. 보안 의견

Git 연동에서 가장 중요한 부분은 토큰 관리다.

권장 정책:

- Personal Access Token은 평문 저장 금지
- 서버 측 암호화 후 저장
- 가능하면 GitLab OAuth App / GitHub App 방식 우선 검토
- 최소 권한 scope 사용
- 읽기 전용 연동과 쓰기 가능 연동을 분리
- 댓글 작성, MR 승인 같은 쓰기 작업은 별도 권한 요청
- 토큰 만료/폐기 상태를 사용자에게 명확히 표시

AI 분석 시에도 주의가 필요하다.

- private repository 코드를 외부 LLM으로 보낼지 여부를 설정으로 분리한다.
- 사내 배포에서는 local LLM 또는 내부 LLM 옵션을 우선 제공한다.
- secret scanning을 먼저 수행하고, 토큰/키로 보이는 문자열은 마스킹한 뒤 분석한다.

## 8. 구현 순서 제안

### 1단계: GitLab 읽기 전용 MVP

- GitLab 서버 URL 등록
- Access Token 등록
- Project 목록 조회
- Branch 목록 조회
- Commit 목록 조회
- Commit diff 조회
- 커밋 클릭 시 우측 상세 패널 표시

### 2단계: AI 요약

- 커밋 메시지와 diff 요약
- 변경 파일별 영향 범위 분석
- 위험도 태그 부여
- 분석 결과 저장

### 3단계: RAG 연동

- 커밋 요약과 MR/PR 설명을 RAG 학습
- "이 기능은 언제 바뀌었나?", "이 파일을 바꾼 이유는?" 같은 질문 지원
- EasyDocStation 기존 문서/게시글/회의록과 Git 히스토리 연결

### 4단계: Discussion 연동

- 커밋/파일/라인 단위 댓글
- AI 분석 카드에 대한 사용자 피드백
- GitLab MR note 또는 GitHub PR comment로 역동기화 옵션

### 5단계: Webhook과 CI 연동

- push, merge request, pipeline 이벤트 수신
- 새 커밋 자동 분석
- 실패한 pipeline의 원인 요약
- 배포 전 위험 변경 알림

## 9. 주의할 점

1. 전체 diff를 무제한 저장하거나 학습하면 비용과 성능 문제가 생긴다.
2. GitHub/GitLab API rate limit을 고려해야 한다.
3. private repo 코드는 보안 정책이 먼저 정해져야 한다.
4. AI 리뷰는 최종 판단자가 아니라 보조 분석자로 표시해야 한다.
5. 커밋 메시지만 보고 요약하면 부정확할 수 있으므로 diff와 파일 경로를 함께 봐야 한다.
6. 히스토리 그래프는 큰 저장소에서 무거워질 수 있으므로 기간/브랜치 필터가 필요하다.

## 10. 최종 의견

이 기능은 EasyDocStation의 방향과 잘 맞는다. 특히 기존의 RAG, 게시글/댓글, AgenticAI, 문서 관리 기능 위에 Git History를 얹으면 "개발 히스토리 기반 지식 관리"라는 강한 차별점이 생긴다.

초기에는 GitLab 읽기 전용 연동으로 시작하는 것이 좋다. 그 다음 AI 요약, RAG 학습, 커밋 토론, MR/PR 역동기화 순서로 확장하면 위험을 작게 가져가면서도 빠르게 쓸 수 있는 서비스를 만들 수 있다.

핵심은 Git을 코드 저장소로만 보지 않는 것이다. Git History를 업무 기록, 의사결정 기록, 장애 추적 기록, 지식 검색 대상으로 바꾸는 것이 이 서비스의 가장 좋은 방향이다.

## 11. EasyGitLab UI 설정 요구사항

### 11.1 서비스 명칭 변경

현재 EasyStation의 GitLab UI 대상 화면에서 표시되는 서비스명이 **"Easy Code 생성 플랫폼"**으로 되어 있다.

이 명칭은 GitLab 연동 기능의 목적에 맞게 **"EasyGitLab"**으로 변경한다.

적용 대상:

- GitLab UI의 상단 또는 대표 타이틀
- GitLab 연동 화면에서 사용자에게 노출되는 서비스명
- 설정 페이지 제목 및 메뉴명

### 11.2 EasyGitLab 설정 진입

EasyStation UI의 왼쪽 사이드바 제일 아래에 있는 톱니바퀴 아이콘을 누르면 **EasyGitLab 설정** 페이지로 이동한다.

설정 페이지의 목적은 GitLab 또는 GitHub 연동에 필요한 기본 접속 정보를 등록하고 관리하는 것이다.

권장 메뉴명:

- EasyGitLab 설정

권장 페이지 제목:

- EasyGitLab 설정
- EasyGitLab URL/ID 설정

### 11.3 EasyGitLab URL/ID 설정 기능

GitLab/GitHub의 URL과 계정 정보를 설정하는 UI를 EasyGitLab UI 안에 추가한다.

설정 항목:

| 항목 | 설명 |
| --- | --- |
| Project Name | EasyGitLab에서 구분할 프로젝트 이름 |
| URL | GitLab 또는 GitHub 서버 URL |
| ID | GitLab 또는 GitHub 접속 계정 ID |
| PW | GitLab 또는 GitHub 접속 암호 |

입력 예시:

```txt
Project Name: EasyDocStation
URL: https://gitlab.example.com
ID: user@example.com
PW: ********
```

### 11.4 UI 배치 의견

EasyGitLab 설정 UI는 별도의 외부 페이지가 아니라 **EasyGitLab UI 내부 설정 화면**으로 제공한다.

권장 구성:

1. 왼쪽 사이드바 하단 톱니바퀴 클릭
2. EasyGitLab 설정 페이지 표시
3. EasyGitLab URL/ID 설정 영역 표시
4. Project Name, URL, ID, PW 입력
5. 저장 버튼으로 설정 저장

화면 내 주요 버튼:

- 저장
- 취소
- 연결 테스트

### 11.5 보안 고려사항

PW는 화면에서 기본적으로 마스킹 처리한다.

저장 시에는 평문 저장을 피하고 서버 측 암호화 저장을 고려해야 한다. 가능하면 향후에는 PW 방식보다 GitLab Personal Access Token, GitHub Personal Access Token, OAuth 방식으로 확장하는 것이 좋다.

초기 UI에서는 사용자가 요청한 필드인 `Project Name`, `URL`, `ID`, `PW`를 우선 제공하되, 실제 구현 단계에서는 보안 정책에 따라 `PW` 명칭을 `Password / Token` 또는 `Access Token`으로 조정할 수 있다.

### 11.6 정리

이번 EasyGitLab UI 요구사항의 핵심은 다음과 같다.

- GitLab UI의 서비스명을 **EasyGitLab**으로 변경한다.
- 왼쪽 사이드바 제일 아래 톱니바퀴에서 **EasyGitLab 설정** 페이지로 이동한다.
- EasyGitLab UI 내부에 **EasyGitLab URL/ID 설정** 기능을 추가한다.
- 설정 필드는 `Project Name`, `URL`, `ID`, `PW`로 구성한다.
- 현재 단계에서는 요구사항 문서 정리만 수행하고 코딩은 하지 않는다.
