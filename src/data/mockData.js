export const TEAMS = [
  {
    id: 'team-1',
    name: 'Engineering',
    icon: '⚙️',
    channels: [
      { id: 'ch-1', name: 'general', type: 'public', unread: 3 },
      { id: 'ch-2', name: 'frontend', type: 'public', unread: 0 },
      { id: 'ch-3', name: 'backend', type: 'public', unread: 1 },
      { id: 'ch-4', name: 'devops', type: 'public', unread: 0 },
      { id: 'ch-5', name: 'code-review', type: 'private', unread: 2 },
    ],
    directMessages: [
      { id: 'dm-1', name: 'Alice Kim', avatar: 'AK', online: true },
      { id: 'dm-2', name: 'Bob Lee', avatar: 'BL', online: false },
      { id: 'dm-3', name: 'Carol Park', avatar: 'CP', online: true },
    ],
  },
  {
    id: 'team-2',
    name: 'Design',
    icon: '🎨',
    channels: [
      { id: 'ch-6', name: 'general', type: 'public', unread: 0 },
      { id: 'ch-7', name: 'ux-research', type: 'public', unread: 5 },
      { id: 'ch-8', name: 'assets', type: 'public', unread: 0 },
    ],
    directMessages: [
      { id: 'dm-4', name: 'Dave Choi', avatar: 'DC', online: true },
      { id: 'dm-5', name: 'Eve Jung', avatar: 'EJ', online: false },
    ],
  },
  {
    id: 'team-3',
    name: 'Product',
    icon: '📦',
    channels: [
      { id: 'ch-9', name: 'general', type: 'public', unread: 0 },
      { id: 'ch-10', name: 'roadmap', type: 'public', unread: 7 },
      { id: 'ch-11', name: 'launches', type: 'private', unread: 0 },
    ],
    directMessages: [
      { id: 'dm-6', name: 'Frank Yoo', avatar: 'FY', online: true },
    ],
  },
]

const now = Date.now()

export const POSTS = {
  'ch-1': [
    {
      id: 'p1',
      title: 'Q2 스프린트 목표 및 주요 마일스톤 정리',
      content: `## 개요
이번 Q2 스프린트의 주요 목표와 마일스톤을 정리합니다. 팀 전체가 동일한 방향으로 나아갈 수 있도록 이 문서를 참고해 주세요.

## 주요 목표
1. **인증 시스템 개선** - OAuth 2.0 기반 소셜 로그인 추가 (Google, GitHub)
2. **성능 최적화** - API 응답 시간 30% 단축 목표
3. **테스트 커버리지 향상** - 현재 62% → 80% 이상으로 개선
4. **문서화** - 주요 API 엔드포인트 100% Swagger 문서화

## 마일스톤
- **Week 1-2**: 설계 및 프로토타이핑
- **Week 3-4**: 개발 및 코드 리뷰
- **Week 5-6**: QA 및 버그 수정
- **Week 7**: 스테이징 배포 및 최종 검토
- **Week 8**: 프로덕션 배포

## 담당자
- 인증 시스템: Bob Lee
- 성능 최적화: Carol Park
- 테스트: Alice Kim
- 문서화: 전 팀원 공동

## 주의사항
배포 전 반드시 스테이징 환경에서 E2E 테스트를 완료해야 합니다. 문의사항은 이 게시글에 댓글로 남겨주세요.`,
      author: { name: 'Kevin Im', avatar: 'KI' },
      tags: ['공지', '스프린트', 'Q2'],
      pinned: true,
      views: 24,
      createdAt: new Date(now - 3600000 * 72).toISOString(),
      comments: [
        { id: 'c1', author: { name: 'Alice Kim', avatar: 'AK' }, text: '확인했습니다! 테스트 커버리지 개선 관련해서 별도 미팅 잡으면 좋을 것 같아요.', createdAt: new Date(now - 3600000 * 70).toISOString() },
        { id: 'c2', author: { name: 'Bob Lee', avatar: 'BL' }, text: '인증 시스템 설계 문서 작성 후 리뷰 요청드리겠습니다.', createdAt: new Date(now - 3600000 * 68).toISOString() },
      ],
    },
    {
      id: 'p2',
      title: '온보딩 가이드: 개발 환경 설정 (신규 팀원 필독)',
      content: `## 개요
신규 팀원을 위한 개발 환경 설정 가이드입니다. 아래 순서대로 진행하면 약 30분 내에 로컬 환경을 구성할 수 있습니다.

## 사전 준비
- macOS 13+ 또는 Ubuntu 22.04+
- Git 설치 확인
- GitHub 계정 및 조직 접근 권한 (IT팀에 요청)

## 설치 순서

### 1. 패키지 매니저 설치
\`\`\`bash
# macOS
brew install nvm node@20 pnpm
# Ubuntu
curl -fsSL https://fnm.vercel.app/install | bash
\`\`\`

### 2. 레포지토리 클론
\`\`\`bash
git clone https://github.com/easydocstation/main-app.git
cd main-app
pnpm install
\`\`\`

### 3. 환경 변수 설정
\`.env.example\`을 복사하여 \`.env.local\`을 생성하고, 팀 채널에서 공유된 값으로 채워주세요.

### 4. 로컬 서버 실행
\`\`\`bash
pnpm dev
\`\`\`
\`http://localhost:3000\` 에서 확인할 수 있습니다.

## 문제 발생 시
\`#backend\` 채널에 문의하거나, 이 글에 댓글로 남겨주세요.`,
      author: { name: 'Carol Park', avatar: 'CP' },
      tags: ['온보딩', '개발환경', '필독'],
      pinned: false,
      views: 38,
      createdAt: new Date(now - 3600000 * 48).toISOString(),
      comments: [
        { id: 'c3', author: { name: 'Alice Kim', avatar: 'AK' }, text: 'pnpm 버전을 명시해 주면 더 좋을 것 같아요. 현재 팀은 pnpm 9.x 사용 중입니다.', createdAt: new Date(now - 3600000 * 46).toISOString() },
      ],
    },
    {
      id: 'p3',
      title: '코드 리뷰 가이드라인 v2.0',
      content: `## 목적
효율적이고 건강한 코드 리뷰 문화를 위해 가이드라인을 업데이트합니다.

## 리뷰어 체크리스트
- [ ] 비즈니스 로직이 요구사항과 일치하는가?
- [ ] 엣지 케이스가 처리되어 있는가?
- [ ] 테스트가 충분한가? (커버리지 기준: 함수 단위 80%)
- [ ] 성능에 영향을 미치는 N+1 쿼리, 메모리 누수 등은 없는가?
- [ ] 보안 취약점(XSS, SQL Injection 등)은 없는가?
- [ ] 코드가 읽기 쉽고 유지보수 가능한가?

## PR 크기 기준
- **Small**: 200줄 이하 — 당일 리뷰 권장
- **Medium**: 200~500줄 — 24시간 이내 리뷰
- **Large**: 500줄 이상 — 미리 설계 리뷰 진행 권장

## 피드백 작성 원칙
1. **Nitpick (nit)**: 사소한 의견 (블로킹 아님)
2. **Suggestion**: 개선 제안 (적용 여부 작성자 재량)
3. **Request**: 반드시 수정 필요 (머지 전 해결)

## 응답 SLA
리뷰 요청 후 **영업일 2일** 이내에 첫 리뷰를 제공합니다. 긴급 건은 \`#general\` 채널에 태깅해주세요.`,
      author: { name: 'Alice Kim', avatar: 'AK' },
      tags: ['프로세스', '코드리뷰'],
      pinned: false,
      views: 19,
      createdAt: new Date(now - 3600000 * 24).toISOString(),
      comments: [],
    },
  ],
  'ch-2': [
    {
      id: 'p4',
      title: 'React 19 마이그레이션 계획서',
      content: `## 배경
React 18에서 React 19로의 업그레이드를 통해 Actions, useOptimistic, Server Components 등 신규 기능을 활용할 수 있습니다.

## 주요 변경사항
- **Actions**: 비동기 상태 변경을 더 쉽게 처리
- **useOptimistic**: Optimistic UI 패턴 내장 지원
- **ref prop**: forwardRef 없이 컴포넌트에 ref 전달 가능
- **Context as provider**: \`<Context>\` 직접 사용 가능

## 마이그레이션 단계
1. 의존성 업그레이드 \`react@19\`, \`react-dom@19\`
2. 빌드 경고 확인 및 deprecated API 제거
3. 스냅샷 테스트 업데이트
4. 스테이징 배포 후 1주일 모니터링
5. 프로덕션 배포

## 예상 영향 범위
- \`ReactDOM.render\` → \`createRoot\` (이미 적용됨)
- \`defaultProps\` on function components → 제거 필요
- String refs → 이미 제거됨

## 일정
- 2025-05-01: 개발 환경 적용 및 테스트
- 2025-05-15: 스테이징 배포
- 2025-06-01: 프로덕션 배포`,
      author: { name: 'Carol Park', avatar: 'CP' },
      tags: ['React', '마이그레이션', 'Frontend'],
      pinned: false,
      views: 15,
      createdAt: new Date(now - 3600000 * 36).toISOString(),
      comments: [
        { id: 'c4', author: { name: 'Bob Lee', avatar: 'BL' }, text: 'defaultProps 사용하는 컴포넌트 grep으로 뽑아드릴까요?', createdAt: new Date(now - 3600000 * 34).toISOString() },
      ],
    },
  ],
  'ch-3': [
    {
      id: 'p5',
      title: 'API 성능 개선 보고서 - Redis 캐싱 도입',
      content: `## 요약
Redis 캐싱 레이어 도입으로 주요 API 엔드포인트의 응답 시간을 평균 58% 단축했습니다.

## 측정 결과
| 엔드포인트 | 이전 (p99) | 이후 (p99) | 개선율 |
|-----------|----------|----------|------|
| GET /users | 120ms | 18ms | 85% |
| GET /documents | 340ms | 95ms | 72% |
| GET /search | 890ms | 210ms | 76% |
| POST /auth | 55ms | 48ms | 13% |

## 구현 상세
- **캐시 TTL**: 읽기 전용 데이터 5분, 사용자 세션 1시간
- **캐시 무효화**: write 작업 시 관련 키 즉시 삭제
- **Redis 클러스터**: 3노드 구성 (가용성 보장)

## 주의사항
캐시 히트율은 현재 약 73%입니다. 캐시 미스 시나리오 테스트를 추가로 진행할 예정입니다.

## 다음 단계
- CDN 엣지 캐싱 검토
- 데이터베이스 인덱스 추가 최적화`,
      author: { name: 'Bob Lee', avatar: 'BL' },
      tags: ['성능', 'Redis', 'Backend', '보고서'],
      pinned: false,
      views: 31,
      createdAt: new Date(now - 3600000 * 20).toISOString(),
      comments: [
        { id: 'c5', author: { name: 'Kevin Im', avatar: 'KI' }, text: '훌륭한 성과입니다! 이 내용 다음 주 전체 미팅에서 공유해 주세요.', createdAt: new Date(now - 3600000 * 18).toISOString() },
      ],
    },
  ],
  'ch-7': [
    {
      id: 'p6',
      title: '신규 온보딩 플로우 사용자 인터뷰 결과 (n=12)',
      content: `## 조사 개요
- **기간**: 2025년 4월 1일 ~ 4월 7일
- **대상**: 신규 가입 후 7일 이내 사용자 12명
- **방법**: 30분 화상 인터뷰 + 화면 공유 세션

## 주요 발견사항

### 긍정적 피드백
- 1단계 (회원가입): 소요시간 평균 2.3분, 이탈률 8% (양호)
- 3단계 (팀 초대): "직관적이었다" 응답 83%

### 개선 필요 사항
- **2단계 (프로필 설정)**: 이탈률 **41%** — 가장 큰 문제
  - "어떤 정보를 왜 입력해야 하는지 모르겠다" (7/12명)
  - 직책 입력 필드가 필수여서 혼란 유발
  - 프로필 사진 업로드 UX 불명확

## 권고 사항
1. 프로필 설정 단계를 **선택적**으로 변경 (나중에 완성 가능)
2. 각 입력 필드에 **컨텍스트 설명** 추가
3. 진행률 표시바 추가 (현재 없음)
4. "나중에 하기" CTA 버튼 추가

## 다음 단계
개선안 와이어프레임을 이번 주 금요일까지 작성하겠습니다.`,
      author: { name: 'Eve Jung', avatar: 'EJ' },
      tags: ['UX리서치', '온보딩', '인터뷰'],
      pinned: false,
      views: 22,
      createdAt: new Date(now - 3600000 * 10).toISOString(),
      comments: [
        { id: 'c6', author: { name: 'Dave Choi', avatar: 'DC' }, text: '2단계 이탈률이 41%나 된다니 충격이네요. 빠르게 개선해야 할 것 같습니다.', createdAt: new Date(now - 3600000 * 8).toISOString() },
        { id: 'c7', author: { name: 'Frank Yoo', avatar: 'FY' }, text: '이 인사이트 기반으로 다음 스프린트에 반영하겠습니다. 감사합니다!', createdAt: new Date(now - 3600000 * 6).toISOString() },
      ],
    },
  ],
  'ch-10': [
    {
      id: 'p7',
      title: 'Q3 2025 제품 로드맵 (초안)',
      content: `## 비전
"모든 팀이 문서로 소통하는 세상" — Q3는 문서 협업 기능 강화에 집중합니다.

## 테마별 계획

### Theme 1: 실시간 협업 (7월)
- 동시 편집 (Google Docs 스타일)
- 댓글 & 멘션 시스템
- 변경 이력 및 버전 관리

### Theme 2: AI 통합 (8월)
- GROQ 기반 문서 요약 기능
- 스마트 태그 자동 생성
- 연관 문서 추천

### Theme 3: 외부 연동 (9월)
- Notion import/export
- GitHub 연동 (PR → 문서 자동 생성)
- Slack 이관 도구

## KPI 목표
- MAU: 10,000 → 25,000
- 문서 생성 수: 월 5만 건
- 유료 전환율: 3% → 7%

## 리스크
- 실시간 협업 기술 복잡도 (CRDTs 도입 필요)
- AI 비용 증가 가능성

피드백은 이번 주 금요일(2025-04-18)까지 댓글로 남겨주세요.`,
      author: { name: 'Frank Yoo', avatar: 'FY' },
      tags: ['로드맵', 'Q3', '전략'],
      pinned: true,
      views: 47,
      createdAt: new Date(now - 3600000 * 14).toISOString(),
      comments: [
        { id: 'c8', author: { name: 'Alice Kim', avatar: 'AK' }, text: 'Theme 2 AI 통합 정말 기대됩니다! 개발 일정 공유해 주실 수 있나요?', createdAt: new Date(now - 3600000 * 12).toISOString() },
        { id: 'c9', author: { name: 'Eve Jung', avatar: 'EJ' }, text: 'Notion import 기능은 사용자 요청이 많았던 기능이라 반가워요.', createdAt: new Date(now - 3600000 * 10).toISOString() },
      ],
    },
  ],
}

export const USERS = [
  { id: 'user-1', name: 'Kevin Im', email: 'kevin@easydocstation.com', avatar: 'KI', role: 'Admin' },
  { id: 'user-2', name: 'Alice Kim', email: 'alice@easydocstation.com', avatar: 'AK', role: 'Member' },
  { id: 'user-3', name: 'Bob Lee', email: 'bob@easydocstation.com', avatar: 'BL', role: 'Member' },
]

export const GROQ_MODELS = [
  { id: 'gemma4:e4b', label: 'EasyDoc AgenticAI (Gemma)' },
  { id: 'llava', label: 'Image Analysis (Llava)' },
]

export const GROQ_API_KEY = 'ollama' // 로컬 Ollama 사용 시 키가 필요 없으므로 임의 값 설정
