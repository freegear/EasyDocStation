const RuleBasedIntentParser = require('../../intent/parser/RuleBasedIntentParser')
const IntentNormalizer = require('../../intent/normalizer/IntentNormalizer')
const IntentValidator = require('../../intent/validator/IntentValidator')
const PostQueryBuilder = require('../../query/builder/PostQueryBuilder')
const PostRepository = require('../../query/repository/PostRepository')
const SummaryService = require('../../summarize/SummaryService')

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
