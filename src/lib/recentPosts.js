// "최근에 본 문서" 추적 — 게시글을 열람할 때 표시용 메타데이터 스냅샷을 저장한다. (WelcomeBoard.md 15절)
// 서버 DB에 저장할 스냅샷을 만들고, localStorage는 서버 조회 실패 시 fallback 용도로 유지한다.
// 열람한 그 시점의 정보를 그대로 보여주므로 "최근에 본" 의미에 부합한다(이후 글이 수정돼도 스냅샷 유지).
import {
  isTemplateContent,
  isMdPage,
  isEasySheet,
  getMdPageTitle,
  getEasySheetTitle,
  FORM_TEMPLATES,
} from '../templates/formTemplates'

const STORAGE_PREFIX = 'welcome-recent-posts-v1'
const MAX_RECENT = 20

function storageKey(userId) {
  return `${STORAGE_PREFIX}:${userId || 'anon'}`
}

// 마크업/HTML을 걷어낸 대략적 평문(요약·일반 글 제목 추출용).
function toPlainText(content) {
  return String(content || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')  // 이미지 마크다운
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')   // 링크 마크다운
    .replace(/<[^>]*>/g, ' ')               // HTML 태그
    .replace(/[#>*_`~]+/g, ' ')             // 경량 마크다운 기호
    .replace(/\s+/g, ' ')
    .trim()
}

function toPlainTextLine(line) {
  return toPlainText(line).replace(/^[-=*_#\s]+$/g, '').trim()
}

function isUntitled(title) {
  return !String(title || '').trim() || String(title || '').trim() === '(제목 없음)'
}

function deriveBodyPreview(content, max = 140) {
  return toPlainText(content).slice(0, max)
}

function deriveFirstMeaningfulLine(content, max = 100) {
  const rawLines = String(content || '').split(/\r?\n/)
  for (const line of rawLines) {
    const text = toPlainTextLine(line)
    if (text) return text.slice(0, max)
  }
  return toPlainText(content).slice(0, max)
}

function deriveFirstLink(content, max = 100) {
  const text = String(content || '')
  const markdownLink = text.match(/!?\[[^\]]*\]\((https?:\/\/[^)\s]+)[^)]*\)/i)
  const htmlHref = text.match(/href=["'](https?:\/\/[^"']+)["']/i)
  const rawUrl = text.match(/https?:\/\/[^\s<>"')]+/i)
  const url = markdownLink?.[1] || htmlHref?.[1] || rawUrl?.[0] || ''
  return url.replace(/[.,;:!?]+$/g, '').slice(0, max)
}

// content 종류에 따라 표시 제목/아이콘/kind를 만든다. (ChatArea 문서 목록과 동일 규칙)
// preferAttachmentTitle=true 이면 명시 제목 → 첨부 파일명 → 첫 번째 의미 있는 본문 줄 → 링크 순으로 제목을 뽑는다.
// ("최근에 본 문서"는 원본 title을 바꾸지 않고 표시용 제목만 보강함. WelcomeBoard.md 15.8)
function derivePostDisplay(post, { preferAttachmentTitle = false } = {}) {
  const content = String(post?.content || '')
  if (isTemplateContent(content)) {
    const meta = FORM_TEMPLATES.find(f => content.includes(`<title>${f.label}`))
    return { kind: 'template', icon: '📄', title: meta ? `${meta.label} 양식` : '양식 문서' }
  }
  if (isMdPage(content)) {
    return { kind: 'md', icon: '📝', title: getMdPageTitle(content, '문서').slice(0, 100) }
  }
  if (isEasySheet(content)) {
    return { kind: 'sheet', icon: '📊', title: getEasySheetTitle(content, 'EasySheet').slice(0, 100) }
  }
  // 일반 글: PG의 title 컬럼이 있으면 사용.
  const explicit = String(post?.title || '').trim()
  const firstAttachment = (Array.isArray(post?.attachments) ? post.attachments : [])
    .map(a => a?.name).filter(Boolean)[0] || ''
  const firstLine = deriveFirstMeaningfulLine(content)
  const firstLink = deriveFirstLink(content)
  // 문서명 우선 모드: 명시 제목/첨부명이 없으면 첫 번째 의미 있는 본문 줄을 표시용 제목으로 승격한다.
  if (preferAttachmentTitle) {
    return { kind: 'post', icon: '📄', title: (explicit || firstAttachment || firstLine || firstLink).slice(0, 100) || '(제목 없음)' }
  }
  return { kind: 'post', icon: '📄', title: (explicit || firstLine || firstLink).slice(0, 100) || '(제목 없음)' }
}

export function getRecentPosts(userId) {
  if (typeof window === 'undefined') return []
  try {
    const list = JSON.parse(window.localStorage.getItem(storageKey(userId)) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function makeWelcomePostSnapshot({ post, channel, team, viewedAt = Date.now(), preferAttachmentTitle = false }) {
  const { kind, icon, title } = derivePostDisplay(post, { preferAttachmentTitle })
  // 태그: 문서가 속한 "팀 · 채널" 을 함께 표기. (WelcomeBoard.md 15.8)
  const tag = [...new Set(
    [team?.name, channel?.name].map(s => String(s || '').trim()).filter(Boolean),
  )].join(' · ')
  return {
    postId: String(post?.id || ''),
    channelId: String(channel?.id || post?.channel_id || ''),
    kind,
    icon,
    title,
    tag,
    summary: isUntitled(title) ? deriveBodyPreview(post?.content) : '',
    createdAt: post?.createdAt || null,
    updatedAt: post?.updatedAt || post?.createdAt || null,
    authorId: post?.author?.id ?? null,
    authorName: post?.author?.name || '',
    authorImageUrl: post?.author?.image_url || post?.author?.imageUrl || '',
    commentCount: Number(post?.comment_count) || 0,
    attachments: (Array.isArray(post?.attachments) ? post.attachments : [])
      .map(a => a?.name)
      .filter(Boolean)
      .slice(0, 5),
    viewedAt,
  }
}

// 게시글 열람 시 호출 — 스냅샷을 최신순 맨 앞에 추가(같은 글은 중복 제거), 최대 MAX_RECENT건 유지.
export function recordRecentPostView({ post, channel, team, userId }) {
  if (!post?.id) return null
  // "최근에 본 문서"는 문서 중심 → 텍스트 글도 본문 대신 문서명(첨부)을 제목으로. (WelcomeBoard.md 15.8)
  const snapshot = makeWelcomePostSnapshot({ post, channel, team, viewedAt: Date.now(), preferAttachmentTitle: true })
  if (typeof window === 'undefined') return snapshot
  try {
    const deduped = getRecentPosts(userId).filter(item => item.postId !== snapshot.postId)
    const next = [snapshot, ...deduped].slice(0, MAX_RECENT)
    window.localStorage.setItem(storageKey(userId), JSON.stringify(next))
  } catch {
    /* localStorage가 막힌 환경에서는 무시 */
  }
  return snapshot
}
