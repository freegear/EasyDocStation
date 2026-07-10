import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { wrapWithMailCard, stripMailCardMarker } from '../../templates/formTemplates'
import { MAIL_TEXT } from './mailText'
import { buildMailCardData, buildMailDeepLinkClient, buildMailPostContent } from './mailPostContent'
import { normalizeMailSummary } from './mailSummaryUtils'

function MailToPostDialog({ message, summary, teams = [], defaultTeamId = '', defaultChannelId = '', onClose, onSubmit, targetLanguage = 'ko', mt = MAIL_TEXT.ko }) {
  const pd = mt.postDialog
  const availableTeams = Array.isArray(teams) ? teams : []
  const deepLink = buildMailDeepLinkClient(message, targetLanguage)

  const [teamId, setTeamId] = useState(() => {
    if (defaultTeamId && availableTeams.some(t => String(t.id) === String(defaultTeamId))) return String(defaultTeamId)
    return availableTeams[0]?.id != null ? String(availableTeams[0].id) : ''
  })
  const selectedTeam = availableTeams.find(t => String(t.id) === String(teamId)) || null
  const channelOptions = (selectedTeam?.channels || []).filter(c => !c.is_archived)

  const [channelId, setChannelId] = useState(() => {
    const first = channelOptions[0]
    if (defaultChannelId && channelOptions.some(c => String(c.id) === String(defaultChannelId))) return String(defaultChannelId)
    return first?.id != null ? String(first.id) : ''
  })
  const [postId, setPostId] = useState('') // '' = 새 게시글
  const [recentPosts, setRecentPosts] = useState([])
  const [postsLoading, setPostsLoading] = useState(false)
  const [content, setContent] = useState(() => buildMailPostContent(message, summary, mt, deepLink))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // 등록 시 상세 재조회로 확보한 완전한 메일(요약+본문). (MailService.md 24.12)
  const [detailMsg, setDetailMsg] = useState(message)
  const [detailSummary, setDetailSummary] = useState(summary)
  const [detailLoading, setDetailLoading] = useState(false)
  const contentEditedRef = useRef(false)

  // 다이얼로그가 열리면 메일 상세를 재조회해 저장된 요약 + 완전한 본문(body_html/body_text)을 확보한다.
  // 진입 경로(목록 우클릭=경량 snippet만 / 본문 뷰=상세)에 무관하게 "메일 양식 그대로" 캡처. (MailService.md 24.12)
  useEffect(() => {
    const id = message?.id
    const tenantId = message?.tenant_id
    if (!id || !tenantId) return undefined
    let cancelled = false
    const timer = window.setTimeout(() => {
      setDetailLoading(true)
      const params = new URLSearchParams({ tenantId: String(tenantId), targetLanguage: targetLanguage || 'ko' })
      apiFetch(`/mail/messages/${id}?${params.toString()}`)
        .then(detail => {
          if (cancelled || !detail) return
          const nextSummary = normalizeMailSummary(detail.summary) || summary || null
          setDetailMsg(detail)
          setDetailSummary(nextSummary)
          // 사용자가 아직 편집하지 않았으면 미리보기 내용을 완전한 상세로 갱신
          if (!contentEditedRef.current) {
            setContent(buildMailPostContent(detail, nextSummary, mt, deepLink))
          }
        })
        .catch(() => { /* 실패 시 진입 시점 메일로 폴백 */ })
        .finally(() => { if (!cancelled) setDetailLoading(false) })
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id])

  // 팀이 바뀌면 채널을 그 팀의 첫 채널로 리셋
  useEffect(() => {
    const opts = (availableTeams.find(t => String(t.id) === String(teamId))?.channels || []).filter(c => !c.is_archived)
    const timer = window.setTimeout(() => {
      setChannelId(prev => (opts.some(c => String(c.id) === String(prev)) ? prev : (opts[0]?.id != null ? String(opts[0].id) : '')))
    }, 0)
    return () => window.clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId])

  // 채널이 바뀌면 최근 게시글 20개 조회 + 새 게시글로 리셋
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      setPostId('')
      if (!channelId) {
        setRecentPosts([])
        return
      }
      setPostsLoading(true)
      apiFetch(`/posts?channelId=${encodeURIComponent(channelId)}&limit=20`)
        .then(data => {
          if (cancelled) return
          const list = Array.isArray(data) ? data : (Array.isArray(data?.posts) ? data.posts : [])
          setRecentPosts(list.slice().reverse()) // 백엔드는 created_at ASC → 최신순으로 뒤집기
        })
        .catch(() => { if (!cancelled) setRecentPosts([]) })
        .finally(() => { if (!cancelled) setPostsLoading(false) })
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [channelId])

  useEffect(() => {
    function onKeyDown(event) { if (event.key === 'Escape' && !submitting) onClose?.() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, submitting])

  function postPreview(post) {
    const raw = stripMailCardMarker(String(post?.content || '')).replace(/\s+/g, ' ').trim()
    return raw.length > 60 ? `${raw.slice(0, 60)}…` : (raw || pd.newPost)
  }

  async function handleSubmit() {
    const text = content.trim()
    if (!channelId) { setError(pd.selectChannelFirst); return }
    if (!text) { setError(pd.emptyContent); return }
    const mailAttachments = Array.isArray(detailMsg?.attachments)
      ? detailMsg.attachments
      : (Array.isArray(message?.attachments) ? message.attachments : [])
    // 새 게시글이면 인라인 카드 데이터 주석을 덧붙인다(게시글=C). 댓글은 마크다운 그대로(댓글=A). (MailService.md 24.3/24.7)
    // 카드 스냅샷은 재조회한 완전한 상세(요약+본문)로 구성한다. (MailService.md 24.12)
    const finalContent = postId
      ? text
      : wrapWithMailCard(text, buildMailCardData(detailMsg, detailSummary, deepLink, targetLanguage))
    setSubmitting(true)
    setError('')
    try {
      await onSubmit?.({
        channelId,
        postId: postId || '',
        content: finalContent,
        messageId: detailMsg?.id || message?.id || '',
        tenantId: detailMsg?.tenant_id || message?.tenant_id || '',
        mailAttachmentIds: mailAttachments.map(att => att.id).filter(Boolean),
      })
      onClose?.()
    } catch (err) {
      setError(err?.message || pd.failed)
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-4 py-6"
      onClick={() => { if (!submitting) onClose?.() }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl shadow-gray-900/20"
        onClick={event => event.stopPropagation()}
      >
        <header className="flex items-center justify-between bg-indigo-600 px-5 py-4">
          <h3 className="text-base font-extrabold text-white">{pd.title}</h3>
          <button
            type="button"
            onClick={() => { if (!submitting) onClose?.() }}
            className="rounded-full p-1 text-indigo-100 transition hover:bg-indigo-500 hover:text-white"
            aria-label={pd.cancel}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {availableTeams.length === 0 ? (
            <p className="rounded-lg bg-gray-50 px-3 py-6 text-center text-sm font-bold text-gray-500">{pd.noTeams}</p>
          ) : (
            <>
              {/* Team 선택 */}
              <label className="block">
                <span className="mb-1 block text-xs font-extrabold text-gray-500">{pd.team}</span>
                <select
                  value={teamId}
                  onChange={event => setTeamId(event.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-800 focus:border-indigo-400 focus:outline-none"
                >
                  {availableTeams.map(team => (
                    <option key={team.id} value={String(team.id)}>{team.name}</option>
                  ))}
                </select>
              </label>

              {/* Channel 선택 */}
              <label className="block">
                <span className="mb-1 block text-xs font-extrabold text-gray-500">{pd.channel}</span>
                <select
                  value={channelId}
                  onChange={event => setChannelId(event.target.value)}
                  disabled={channelOptions.length === 0}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-800 focus:border-indigo-400 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
                >
                  {channelOptions.length === 0 ? (
                    <option value="">{pd.noChannels}</option>
                  ) : (
                    channelOptions.map(channel => (
                      <option key={channel.id} value={String(channel.id)}>{channel.name}</option>
                    ))
                  )}
                </select>
              </label>

              {/* 게시글 선택 */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-extrabold text-gray-500">{pd.post}</span>
                  <span className="text-[11px] font-bold text-gray-400">{pd.recentHint}</span>
                </div>
                <div className="max-h-52 overflow-y-auto rounded-lg border border-gray-200">
                  <label className="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 hover:bg-indigo-50">
                    <input
                      type="radio"
                      name="mail-to-post-target"
                      checked={!postId}
                      onChange={() => setPostId('')}
                      className="h-4 w-4"
                    />
                    <span className="text-sm font-extrabold text-indigo-700">{pd.newPost}</span>
                  </label>
                  {postsLoading ? (
                    <p className="px-3 py-4 text-center text-xs font-bold text-gray-400">{pd.loadingPosts}</p>
                  ) : recentPosts.length === 0 ? (
                    <p className="px-3 py-4 text-center text-xs font-bold text-gray-400">{pd.noPosts}</p>
                  ) : (
                    recentPosts.map(post => (
                      <label key={post.id} className="flex cursor-pointer items-start gap-2 border-b border-gray-100 px-3 py-2 last:border-b-0 hover:bg-gray-50">
                        <input
                          type="radio"
                          name="mail-to-post-target"
                          checked={String(postId) === String(post.id)}
                          onChange={() => setPostId(String(post.id))}
                          className="mt-0.5 h-4 w-4"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-bold text-gray-800">{postPreview(post)}</span>
                          <span className="block text-[11px] font-semibold text-gray-400">
                            {post.author?.name || pd.unknownAuthor}
                            {post.createdAt ? ` · ${new Date(post.createdAt).toLocaleString()}` : ''}
                          </span>
                        </span>
                      </label>
                    ))
                  )}
                </div>
                <p className="mt-1 text-[11px] font-bold text-gray-400">{postId ? pd.asComment : pd.asNewPost}</p>
              </div>

              {/* 등록할 내용(편집 가능) */}
              <label className="block">
                <span className="mb-1 flex items-center gap-2 text-xs font-extrabold text-gray-500">
                  {pd.content}
                  {detailLoading && <span className="font-bold text-indigo-400">{pd.loadingDetail}</span>}
                </span>
                <textarea
                  value={content}
                  onChange={event => { contentEditedRef.current = true; setContent(event.target.value) }}
                  rows={8}
                  className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium leading-6 text-gray-800 focus:border-indigo-400 focus:outline-none"
                />
              </label>

              {Array.isArray(detailMsg?.attachments) && detailMsg.attachments.length > 0 && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <div className="mb-1 text-xs font-extrabold text-gray-500">{pd.attachments}</div>
                  <div className="flex flex-wrap gap-2">
                    {detailMsg.attachments.slice(0, 10).map(att => (
                      <span key={att.id} className="max-w-full truncate rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-bold text-gray-600">
                        {att.filename || att.name || att.id}
                      </span>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] font-bold text-gray-400">{pd.attachmentsHint}</p>
                </div>
              )}

              {error && <p className="text-xs font-bold text-red-500">{error}</p>}
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={() => { if (!submitting) onClose?.() }}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-bold text-gray-600 transition hover:bg-gray-50"
          >
            {pd.cancel}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || availableTeams.length === 0 || !channelId}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-extrabold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? pd.registering : pd.register}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default MailToPostDialog
