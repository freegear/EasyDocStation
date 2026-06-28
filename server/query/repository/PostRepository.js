const { client, isConnected } = require('../../cassandra')
const db = require('../../db')
const { getAccessibleChannelIds, getUserSecurityLevel } = require('../../lib/channelAccess')
const PostSearchService = require('../../search/PostSearchService')

function normalizePost(row = {}) {
  return {
    id: String(row.id || ''),
    channelId: String(row.channel_id || ''),
    authorId: row.author_id ?? null,
    content: String(row.content || ''),
    securityLevel: Number.parseInt(row.security_level, 10) || 0,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  }
}

function stripHtml(value = '') {
  return String(value || '')
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

function normalizeSearchTerm(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[?？!！.,，。]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripKoreanParticle(value = '') {
  return String(value || '').replace(/(은|는|이|가|을|를|의)$/u, '')
}

function buildSearchTerms(keywords = [], options = {}) {
  const terms = []
  for (const keyword of keywords || []) {
    const normalized = normalizeSearchTerm(keyword)
    if (!normalized) continue
    terms.push(normalized)
    const compact = normalized.replace(/\s+/g, '')
    if (compact && compact !== normalized) terms.push(compact)
    if (options.exactOnly) continue
    for (const part of normalized.split(/\s+/)) {
      if (part.length >= 2) terms.push(part)
      const stripped = stripKoreanParticle(part)
      if (stripped.length >= 2 && stripped !== part) terms.push(stripped)
    }
  }
  return [...new Set(terms)]
}

function isDiagramTarget(target = '') {
  return String(target || '') === 'diagram'
}

function isImageTarget(target = '') {
  return String(target || '') === 'image'
}

function buildAttachmentTypeFilter(target = '') {
  if (isImageTarget(target)) {
    return `AND (
      LOWER(COALESCE(a.content_type, '')) LIKE 'image/%'
      OR a.filename ~* '\\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$'
    )`
  }
  if (isDiagramTarget(target)) {
    return `AND (
      LOWER(COALESCE(a.content_type, '')) LIKE 'image/%'
      OR LOWER(COALESCE(a.content_type, '')) LIKE '%presentation%'
      OR a.filename ~* '\\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|ppt|pptx)$'
    )`
  }
  return ''
}

function firstContentLine(value = '') {
  const text = stripHtml(value)
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || text
}

function normalizeLocatorRow(row = {}) {
  const postId = String(row.post_id || row.postId || row.id || '')
  const commentId = String(row.comment_id || row.commentId || '')
  const attachmentId = String(row.attachment_id || row.attachmentId || '')
  const fileName = String(row.file_name || row.fileName || '')
  const preview = stripHtml(row.content || row.post_content || row.postContent || '').slice(0, 240)
  const title = fileName || firstContentLine(row.content || row.post_content || row.postContent || '') || `게시글 ${postId.slice(0, 8)}`
  return {
    id: String(row.id || postId),
    type: String(row.type || row.source_type || 'post'),
    label: title.length > 80 ? `${title.slice(0, 80)}...` : title,
    title: title.length > 80 ? `${title.slice(0, 80)}...` : title,
    contentPreview: preview,
    channelId: String(row.channel_id || row.channelId || ''),
    channel_id: String(row.channel_id || row.channelId || ''),
    postId,
    post_id: postId,
    commentId,
    comment_id: commentId,
    attachmentId,
    attachment_id: attachmentId,
    fileName,
    file_name: fileName,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at || row.createdAt).toISOString(),
    score: Number(row.score || 0),
    searchScope: String(row.search_scope || 'current_channel'),
    search_scope: String(row.search_scope || 'current_channel'),
    exclusionKey: [
      String(row.type || row.source_type || 'post'),
      postId,
      commentId,
      attachmentId,
    ].join(':'),
  }
}

class PostRepository {
  constructor({ postSearchService = new PostSearchService() } = {}) {
    this.postSearchService = postSearchService
  }

  async ensureLocateExclusionSchema() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS question_locate_exclusions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        source_type TEXT NOT NULL DEFAULT '',
        post_id TEXT NOT NULL DEFAULT '',
        comment_id TEXT NOT NULL DEFAULT '',
        attachment_id TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, source_type, post_id, comment_id, attachment_id)
      )
    `)
    await db.query('CREATE INDEX IF NOT EXISTS idx_question_locate_exclusions_user ON question_locate_exclusions(user_id)')
  }

  async getLocateExclusionKeys(user = {}) {
    const userId = Number.parseInt(user?.id, 10)
    if (!Number.isFinite(userId)) return new Set()
    try {
      await this.ensureLocateExclusionSchema()
      const result = await db.query(
        `SELECT source_type, post_id, comment_id, attachment_id
         FROM question_locate_exclusions
         WHERE user_id = $1`,
        [userId],
      )
      return new Set((result.rows || []).map(row => [
        String(row.source_type || ''),
        String(row.post_id || ''),
        String(row.comment_id || ''),
        String(row.attachment_id || ''),
      ].join(':')))
    } catch (err) {
      console.warn('[QuestionLocate] exclusion lookup skipped:', err.message)
      return new Set()
    }
  }

  async addLocateExclusion(payload = {}, user = {}) {
    const userId = Number.parseInt(user?.id, 10)
    if (!Number.isFinite(userId)) throw new Error('user_id is required')
    await this.ensureLocateExclusionSchema()
    const sourceType = String(payload.sourceType || payload.source_type || payload.type || '').trim()
    const postId = String(payload.postId || payload.post_id || '').trim()
    const commentId = String(payload.commentId || payload.comment_id || '').trim()
    const attachmentId = String(payload.attachmentId || payload.attachment_id || '').trim()
    const reason = String(payload.reason || 'wrong_result').trim()
    if (!sourceType || !postId) throw new Error('sourceType and postId are required')

    await db.query(
      `INSERT INTO question_locate_exclusions
         (user_id, source_type, post_id, comment_id, attachment_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, source_type, post_id, comment_id, attachment_id)
       DO UPDATE SET reason = EXCLUDED.reason, created_at = NOW()`,
      [userId, sourceType, postId, commentId, attachmentId, reason],
    )

    return {
      sourceType,
      postId,
      commentId,
      attachmentId,
    }
  }

  async findByDateRange(query, user = {}) {
    const userSecurityLevel = getUserSecurityLevel(user)

    if (isConnected()) {
      const result = await client.execute(
        `SELECT id, channel_id, author_id, content, security_level, created_at
         FROM posts
         WHERE channel_id = ? AND created_at >= ? AND created_at < ?
         ORDER BY created_at ASC
         LIMIT ?`,
        [query.channelId, query.from, query.to, query.limit],
        { prepare: true },
      )

      return result.rows
        .map(normalizePost)
        .filter((post) => post.id && post.securityLevel <= userSecurityLevel)
    }

    const result = await db.query(
      `SELECT id, channel_id, author_id, content, security_level, created_at
       FROM posts
       WHERE channel_id = $1
         AND created_at >= $2
         AND created_at < $3
         AND COALESCE(security_level, 0) <= $4
       ORDER BY created_at ASC
       LIMIT $5`,
      [query.channelId, query.from, query.to, userSecurityLevel, query.limit],
    )

    return result.rows.map(normalizePost).filter((post) => post.id)
  }

  async locateReferences(query, user = {}) {
    const exactOnly = query.matchMode === 'exact_token_first'
    const terms = buildSearchTerms(query.keywords, { exactOnly })
    if (terms.length === 0) return []

    const currentChannelIds = query.channelId
      ? await getAccessibleChannelIds(db, user, [query.channelId])
      : []
    const allAccessibleChannelIds = await getAccessibleChannelIds(db, user)
    if (currentChannelIds.length === 0 && allAccessibleChannelIds.length === 0) return []

    const userSecurityLevel = getUserSecurityLevel(user)
    const excludedKeys = await this.getLocateExclusionKeys(user)
    const targetTypes = query.target === 'posts'
      ? ['post', 'comment']
      : query.target === 'attachments' || isImageTarget(query.target)
        ? ['image_attachment']
        : isDiagramTarget(query.target)
          ? ['image_attachment']
          : ['post', 'comment', 'image_attachment']
    const attachmentTypeFilter = buildAttachmentTypeFilter(query.target)

    const filterLocatedRows = (rows = []) => {
      const seen = new Set()
      return rows
        .sort((a, b) => Number(b.matched_terms || b.score || 0) - Number(a.matched_terms || a.score || 0))
        .map(normalizeLocatorRow)
        .filter((row) => {
          const key = `${row.postId}:${row.commentId}:${row.attachmentId}:${row.type}`
          if (!row.postId || !row.channelId || seen.has(key) || excludedKeys.has(row.exclusionKey)) return false
          seen.add(key)
          return true
        })
        .slice(0, query.limit || 10)
    }

    const runExactTokenLookup = async () => {
      const exactTerm = String(query.keywords?.[0] || terms[0] || '').trim()
      if (!exactTerm || allAccessibleChannelIds.length === 0) return []
      const currentChannelId = currentChannelIds[0] || ''
      const sourceTypes = targetTypes
      const searchOptions = {
        query: exactTerm,
        user,
        limit: query.limit || 10,
        currentChannelId,
        sourceTypes,
        target: query.target,
        includeAttachmentTable: query.target !== 'posts',
      }

      const currentResults = currentChannelIds.length
        ? await this.postSearchService.exactSearch({
            ...searchOptions,
            channelIds: currentChannelIds,
          })
        : []
      if (currentResults.length > 0) return filterLocatedRows(currentResults)

      const currentSet = new Set(currentChannelIds.map(String))
      const fallbackChannelIds = allAccessibleChannelIds
        .map(String)
        .filter(channelId => !currentSet.has(channelId))
      if (!fallbackChannelIds.length) return []

      const fallbackResults = await this.postSearchService.exactSearch({
        ...searchOptions,
        channelIds: fallbackChannelIds,
      })
      return filterLocatedRows(fallbackResults.map(row => ({
        ...row,
        searchScope: 'accessible_channels',
        search_scope: 'accessible_channels',
      })))
    }

    if (exactOnly) {
      try {
        return await runExactTokenLookup()
      } catch (err) {
        console.warn('[QuestionLocate] exact lookup failed:', err.message)
        return []
      }
    }

    try {
      const exactFirstResults = await runExactTokenLookup()
      if (exactFirstResults.length > 0) return exactFirstResults
    } catch (err) {
      console.warn('[QuestionLocate] exact-first lookup skipped:', err.message)
    }

    const runLookup = async (channelIds = [], searchScope = 'current_channel') => {
      if (!channelIds.length) return []

      const result = await db.query(
        `WITH matched AS (
           SELECT
             $6::text AS search_scope,
             d.source_type AS type,
             d.source_id AS id,
             d.post_id,
             d.comment_id,
             d.attachment_id,
             d.channel_id,
             d.file_name,
             d.content,
             d.created_at,
             p.content AS post_content,
             (
               SELECT COUNT(*)
               FROM unnest($2::text[]) term
               WHERE LOWER(COALESCE(d.content, '') || ' ' || COALESCE(d.file_name, '')) LIKE '%' || LOWER(term) || '%'
             ) AS matched_terms
           FROM search_documents d
           LEFT JOIN posts p ON p.id = d.post_id
           WHERE d.channel_id = ANY($1)
             AND d.security_level <= $3
             AND d.source_type = ANY($5)
             AND EXISTS (
               SELECT 1
               FROM unnest($2::text[]) term
               WHERE LOWER(COALESCE(d.content, '') || ' ' || COALESCE(d.file_name, '')) LIKE '%' || LOWER(term) || '%'
             )
         )
         SELECT
           *,
           (matched_terms::float / GREATEST(array_length($2::text[], 1), 1)) AS score
         FROM matched
         ORDER BY matched_terms DESC, created_at DESC
         LIMIT $4`,
        [channelIds, terms, userSecurityLevel, query.limit || 10, targetTypes, searchScope],
      )

      let rows = result.rows || []

      if (query.target !== 'posts') {
        const attachmentResult = await db.query(
          `SELECT
             $5::text AS search_scope,
             'attachment' AS type,
             a.id,
             COALESCE(a.post_id, c.post_id, '') AS post_id,
             COALESCE(a.comment_id, c.id, '') AS comment_id,
             a.id AS attachment_id,
             COALESCE(a.channel_id, c.channel_id, p.channel_id, '') AS channel_id,
             a.filename AS file_name,
             COALESCE(p.content, c.content, a.filename, '') AS content,
             a.created_at,
             COALESCE(p.content, c.content, '') AS post_content,
             (
               SELECT COUNT(*)
               FROM unnest($2::text[]) term
               WHERE LOWER(COALESCE(a.filename, '') || ' ' || COALESCE(p.content, '') || ' ' || COALESCE(c.content, '')) LIKE '%' || LOWER(term) || '%'
             ) AS matched_terms,
             (
               (
                 SELECT COUNT(*)
                 FROM unnest($2::text[]) term
                 WHERE LOWER(COALESCE(a.filename, '') || ' ' || COALESCE(p.content, '') || ' ' || COALESCE(c.content, '')) LIKE '%' || LOWER(term) || '%'
               )::float / GREATEST(array_length($2::text[], 1), 1)
             ) AS score
           FROM attachments a
           LEFT JOIN comments c ON c.id = a.comment_id
           LEFT JOIN posts p ON p.id = COALESCE(a.post_id, c.post_id)
           WHERE COALESCE(a.channel_id, c.channel_id, p.channel_id, '') = ANY($1)
             AND COALESCE(c.security_level, p.security_level, 0) <= $3
             AND COALESCE(a.status, '') = 'COMPLETED'
             ${attachmentTypeFilter}
             AND EXISTS (
               SELECT 1
               FROM unnest($2::text[]) term
               WHERE LOWER(COALESCE(a.filename, '') || ' ' || COALESCE(p.content, '') || ' ' || COALESCE(c.content, '')) LIKE '%' || LOWER(term) || '%'
             )
           ORDER BY matched_terms DESC, a.created_at DESC
           LIMIT $4`,
          [channelIds, terms, userSecurityLevel, query.limit || 10, searchScope],
        )
        rows = [...rows, ...(attachmentResult.rows || [])]
      }

      return filterLocatedRows(rows)
    }

    try {
      const currentResults = await runLookup(currentChannelIds, 'current_channel')
      if (currentResults.length > 0) return currentResults

      const currentSet = new Set(currentChannelIds.map(String))
      const fallbackChannelIds = allAccessibleChannelIds
        .map(String)
        .filter(channelId => !currentSet.has(channelId))
      return await runLookup(fallbackChannelIds, 'accessible_channels')
    } catch (err) {
      console.warn('[QuestionLocate] search_documents lookup failed:', err.message)
      return []
    }
  }
}

module.exports = PostRepository
