const RuleBasedIntentParser = require('../../intent/parser/RuleBasedIntentParser')
const IntentNormalizer = require('../../intent/normalizer/IntentNormalizer')
const IntentValidator = require('../../intent/validator/IntentValidator')
const PostQueryBuilder = require('../../query/builder/PostQueryBuilder')
const PostRepository = require('../../query/repository/PostRepository')
const SummaryService = require('../../summarize/SummaryService')
const { ACTIONS } = require('../../intent/schema/IntentSchema')
const config = require('../../../config.json')
const { locateWithRagFallback } = require('../../services/ragLocateFallback')

function stripHtml(value = '') {
  return String(value)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildPostTitle(post = {}) {
  const text = stripHtml(post.content)
  if (!text) return `게시글 ${String(post.id || '').slice(0, 8)}`
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || text
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine
}

function buildFrontendLink({ channelId, postId, commentId = '' } = {}) {
  const base = String(
    config?.site_url ||
    process.env.CLIENT_ORIGIN ||
    'http://localhost:5173',
  ).replace(/\/+$/, '')
  const params = new URLSearchParams({
    channelId: String(channelId || ''),
    postId: String(postId || ''),
  })
  if (commentId) params.set('commentId', String(commentId))
  return `${base}/?${params.toString()}`
}

function buildLocateMessage(references = [], intent = {}) {
  if (!references.length) {
    const keyword = (intent.keywords || []).slice(0, 3).join(' ')
    if (intent.target === 'diagram') {
      return `현재 채널과 접근 가능한 다른 채널에서 "${keyword}" 관련 블럭도 이미지 또는 PPT 자료 링크를 찾지 못했습니다.`
    }
    if (intent.target === 'image') {
      return `현재 채널과 접근 가능한 다른 채널에서 "${keyword}" 관련 이미지 자료 링크를 찾지 못했습니다.`
    }
    return `현재 채널과 접근 가능한 다른 채널에서 "${keyword}" 관련 자료 링크를 찾지 못했습니다.`
  }

  const usedFallback = references.some(ref => ref.searchScope === 'accessible_channels' || ref.search_scope === 'accessible_channels')
  const targetLabel = intent.target === 'diagram'
    ? '블럭도 이미지 또는 PPT 자료'
    : intent.target === 'image'
      ? '이미지 자료'
      : '관련 자료'
  const lines = references.map((ref, index) => {
    const label = ref.fileName || ref.file_name || ref.title || ref.label || `자료 ${index + 1}`
    return `${index + 1}. ${label}\n   링크: ${ref.link}`
  })
  const header = usedFallback
    ? `현재 선택된 채널에서는 ${targetLabel}를 찾지 못했고, 접근 가능한 다른 채널에서 찾았습니다.`
    : `현재 선택된 채널에서 ${targetLabel}를 찾았습니다.`
  return [header, '', ...lines].join('\n')
}

class HandleUserQuestionUseCase {
  constructor({
    parser = new RuleBasedIntentParser(),
    normalizer = new IntentNormalizer(),
    validator = new IntentValidator(),
    postQueryBuilder = new PostQueryBuilder(),
    postRepository = new PostRepository(),
    summaryService = new SummaryService(),
  } = {}) {
    this.parser = parser
    this.normalizer = normalizer
    this.validator = validator
    this.postQueryBuilder = postQueryBuilder
    this.postRepository = postRepository
    this.summaryService = summaryService
  }

  async execute({ question, channelId, user, model, now = new Date() }) {
    const parsedIntent = this.parser.parse(question, { now })
    const intent = this.normalizer.normalize(parsedIntent, { channelId })
    const validation = await this.validator.validate(intent, { user })

    if (validation.status !== 'valid') {
      return {
        ok: false,
        status: validation.status,
        errors: validation.errors,
        intent,
      }
    }

    if (intent.action === ACTIONS.LOCATE) {
      let located = await this.postRepository.locateReferences({
        channelId: intent.channelId,
        target: intent.target,
        keywords: intent.keywords,
        matchMode: intent.matchMode,
        limit: 10,
      }, user)
      if (located.length === 0) {
        located = await locateWithRagFallback({
          channelId: intent.channelId,
          keywords: intent.keywords,
          limit: 10,
        }, user)
      }
      const references = located.map((ref) => ({
        ...ref,
        link: buildFrontendLink({
          channelId: ref.channelId || ref.channel_id,
          postId: ref.postId || ref.post_id,
          commentId: ref.commentId || ref.comment_id,
        }),
      }))

      return {
        ok: true,
        intent,
        count: references.length,
        references,
        links: references.map(ref => ref.link),
        message: buildLocateMessage(references, intent),
        summary: buildLocateMessage(references, intent),
      }
    }

    const postQuery = this.postQueryBuilder.build(intent)
    const posts = await this.postRepository.findByDateRange(postQuery, user)
    const summaryResult = await this.summaryService.summarizePosts(posts, intent, { model })
    const references = posts.map((post) => ({
      id: post.id,
      type: 'post',
      label: buildPostTitle(post),
      title: buildPostTitle(post),
      contentPreview: stripHtml(post.content).slice(0, 240),
      channelId: post.channelId,
      channel_id: post.channelId,
      postId: post.id,
      post_id: post.id,
      authorId: post.authorId,
      createdAt: post.createdAt,
    }))

    return {
      ok: true,
      intent,
      query: {
        channelId: postQuery.channelId,
        from: postQuery.from.toISOString(),
        to: postQuery.to.toISOString(),
        limit: postQuery.limit,
      },
      count: posts.length,
      posts: references,
      references,
      summary: summaryResult.summary,
      model: summaryResult.model,
      fallback: summaryResult.fallback,
      error: summaryResult.error,
    }
  }
}

module.exports = HandleUserQuestionUseCase
