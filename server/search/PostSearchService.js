const db = require('../db')
const { getAccessibleChannelIds, getUserSecurityLevel } = require('../lib/channelAccess')

let searchIndexSchemaEnsured = false
let softDeleteSchemaEnsured = false

function normalizeLimit(value, fallback = 50) {
  return Math.max(1, Math.min(100, Number(value) || fallback))
}

function normalizeSourceTypes(sourceTypes = []) {
  const allowed = new Set(['post', 'comment', 'image_attachment'])
  const normalized = (Array.isArray(sourceTypes) ? sourceTypes : [])
    .map(type => String(type || '').trim())
    .filter(type => allowed.has(type))
  return normalized.length ? [...new Set(normalized)] : ['post', 'comment', 'image_attachment']
}

function shouldSearchAttachmentTable(options = {}) {
  return options.includeAttachmentTable === true || options.target === 'diagram' || options.target === 'attachments' || options.target === 'image'
}

function buildAttachmentTypeFilter(options = {}) {
  if (options.target === 'image') {
    return `AND (
      LOWER(COALESCE(a.content_type, '')) LIKE 'image/%'
      OR a.filename ~* '\\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$'
    )`
  }
  if (options.target === 'diagram') {
    return `AND (
      LOWER(COALESCE(a.content_type, '')) LIKE 'image/%'
      OR LOWER(COALESCE(a.content_type, '')) LIKE '%presentation%'
      OR a.filename ~* '\\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|ppt|pptx)$'
    )`
  }
  if (options.target === 'attachments') {
    return ''
  }
  return ''
}

async function ensureSearchIndexSchema() {
  if (searchIndexSchemaEnsured) return
  await db.query(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id             TEXT PRIMARY KEY,
      source_type    TEXT NOT NULL CHECK (source_type IN ('post', 'comment', 'image_attachment')),
      source_id      TEXT NOT NULL,
      post_id        TEXT NOT NULL,
      comment_id     TEXT,
      attachment_id  TEXT,
      channel_id     TEXT NOT NULL,
      author_id      INTEGER,
      file_name      TEXT,
      content        TEXT NOT NULL DEFAULT '',
      security_level INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`
    ALTER TABLE search_documents ADD COLUMN IF NOT EXISTS comment_id TEXT;
    ALTER TABLE search_documents ADD COLUMN IF NOT EXISTS attachment_id TEXT;
    ALTER TABLE search_documents ADD COLUMN IF NOT EXISTS file_name TEXT;
    ALTER TABLE search_documents DROP CONSTRAINT IF EXISTS search_documents_source_type_check;
    ALTER TABLE search_documents
      ADD CONSTRAINT search_documents_source_type_check
      CHECK (source_type IN ('post', 'comment', 'image_attachment'))
  `)
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_search_documents_source ON search_documents(source_type, source_id)')
  await db.query('CREATE INDEX IF NOT EXISTS idx_search_documents_channel_created ON search_documents(channel_id, created_at DESC)')
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    await db.query('CREATE INDEX IF NOT EXISTS idx_search_documents_content_trgm ON search_documents USING gin (content gin_trgm_ops)')
  } catch (e) {
    console.warn('[PostSearchService] pg_trgm index skipped:', e.message)
  }
  searchIndexSchemaEnsured = true
}

async function ensureSoftDeleteSchema() {
  if (softDeleteSchemaEnsured) return
  await db.query(`
    CREATE TABLE IF NOT EXISTS deleted_items (
      item_type   TEXT NOT NULL,
      item_id     VARCHAR(50) NOT NULL,
      channel_id  VARCHAR(50),
      post_id     VARCHAR(50),
      author_id   INTEGER,
      deleted_by  INTEGER,
      preview     TEXT,
      deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (item_type, item_id)
    )
  `)
  await db.query('CREATE INDEX IF NOT EXISTS idx_deleted_items_channel ON deleted_items(item_type, channel_id)')
  await db.query('CREATE INDEX IF NOT EXISTS idx_deleted_items_post ON deleted_items(item_type, post_id)')
  await db.query('CREATE INDEX IF NOT EXISTS idx_deleted_items_deleted_at ON deleted_items(deleted_at)')
  softDeleteSchemaEnsured = true
}

function rowToSearchResult(row = {}) {
  return {
    type: row.type,
    id: row.id,
    postId: row.post_id,
    commentId: row.comment_id || '',
    attachmentId: row.attachment_id || '',
    fileName: row.file_name || '',
    content: row.content,
    createdAt: row.created_at,
    teamName: row.team_name || '',
    channelName: row.channel_name || '',
    channelId: row.channel_id,
    postContent: row.type === 'comment' || row.type === 'image_attachment' || row.type === 'attachment' ? (row.post_content || '') : '',
    score: Number(row.score || 0),
    matchScore: Number(row.match_score || 0),
    recencyScore: Number(row.recency_score || 0),
    searchScope: row.search_scope || '',
    search_scope: row.search_scope || '',
    author: {
      id: row.author_id,
      name: row.author_name || '알 수 없음',
      username: row.author_username || 'unknown',
      image_url: row.author_image_url || null,
    },
  }
}

class PostSearchService {
  async exactSearch({
    query,
    user = {},
    limit = 50,
    currentChannelId = '',
    currentTeamId = '',
    channelIds = null,
    sourceTypes = null,
    target = '',
    includeAttachmentTable = false,
  } = {}) {
    const term = String(query || '').trim()
    if (!term) return []

    await ensureSearchIndexSchema()

    const requestedChannelIds = Array.isArray(channelIds) && channelIds.length
      ? channelIds.map(String)
      : null
    const accessibleChannelIds = requestedChannelIds
      ? await getAccessibleChannelIds(db, user, requestedChannelIds)
      : await getAccessibleChannelIds(db, user)
    if (!accessibleChannelIds.length) return []

    const safeLimit = normalizeLimit(limit)
    const userLevel = getUserSecurityLevel(user)
    const safeCurrentChannelId = accessibleChannelIds.includes(String(currentChannelId || '').trim())
      ? String(currentChannelId || '').trim()
      : ''
    const safeCurrentTeamId = String(currentTeamId || '').trim()
    const safeSourceTypes = normalizeSourceTypes(sourceTypes)

    const searchRes = await db.query(
      `WITH matched AS (
         SELECT
           d.*,
           POSITION(LOWER($2) IN LOWER(COALESCE(d.content, '') || ' ' || COALESCE(d.file_name, ''))) AS match_pos,
           MIN(EXTRACT(EPOCH FROM d.created_at)) OVER () AS min_epoch,
           MAX(EXTRACT(EPOCH FROM d.created_at)) OVER () AS max_epoch
         FROM search_documents d
         WHERE d.channel_id = ANY($1)
           AND d.security_level <= $3
           AND d.source_type = ANY($7)
           AND LOWER(COALESCE(d.content, '') || ' ' || COALESCE(d.file_name, '')) LIKE '%' || LOWER($2) || '%'
       ),
       scored AS (
         SELECT
           m.*,
           CASE
             WHEN LOWER(COALESCE(m.content, '') || ' ' || COALESCE(m.file_name, '')) = LOWER($2) THEN 1.0
             ELSE LEAST(
               1.0,
               GREATEST(
                 0.0,
                 (
                   (1.0 - ((GREATEST(m.match_pos, 1) - 1)::float / GREATEST(char_length(COALESCE(m.content, '') || ' ' || COALESCE(m.file_name, '')), 1))) * 0.7
                 ) + (
                   LEAST(1.0, char_length($2)::float / GREATEST(char_length(COALESCE(m.content, '') || ' ' || COALESCE(m.file_name, '')), char_length($2), 1)) * 0.3
                 )
               )
             )
           END AS match_score,
           CASE
             WHEN m.max_epoch = m.min_epoch THEN 1.0
             ELSE (EXTRACT(EPOCH FROM m.created_at) - m.min_epoch) / NULLIF(m.max_epoch - m.min_epoch, 0)
           END AS recency_score
         FROM matched m
       )
       SELECT
         s.source_type AS type,
         s.source_id AS id,
         s.post_id,
         s.comment_id,
         s.attachment_id,
         s.channel_id,
         s.author_id,
         s.file_name,
         s.content,
         s.created_at,
         CASE WHEN $5::text <> '' AND s.channel_id = $5 THEN 'current_channel' ELSE 'accessible_channels' END AS search_scope,
         c.name AS channel_name,
         t.name AS team_name,
         u.name AS author_name,
         u.username AS author_username,
         u.image_url AS author_image_url,
         p.content AS post_content,
         (
           (s.match_score * 0.45)
           + (s.recency_score * 0.35)
           + (CASE WHEN $5::text <> '' AND s.channel_id = $5 THEN 0.14 ELSE 0 END)
           + (CASE WHEN $6::text <> '' AND c.team_id = $6 THEN 0.06 ELSE 0 END)
         ) AS score,
         s.match_score,
         s.recency_score
       FROM scored s
       JOIN channels c ON c.id = s.channel_id
       JOIN teams t ON t.id = c.team_id
       LEFT JOIN users u ON u.id = s.author_id
       LEFT JOIN posts p ON p.id = s.post_id
       ORDER BY score DESC, s.created_at DESC
       LIMIT $4`,
      [accessibleChannelIds, term, userLevel, safeLimit, safeCurrentChannelId, safeCurrentTeamId, safeSourceTypes],
    )

    let rows = searchRes.rows || []

    if (shouldSearchAttachmentTable({ target, includeAttachmentTable })) {
      const attachmentRes = await db.query(
        `SELECT
           'attachment' AS type,
           a.id,
           COALESCE(a.post_id, cmt.post_id, '') AS post_id,
           COALESCE(a.comment_id, cmt.id, '') AS comment_id,
           a.id AS attachment_id,
           COALESCE(a.channel_id, cmt.channel_id, p.channel_id, '') AS channel_id,
           COALESCE(cmt.author_id, p.author_id, a.uploader_id) AS author_id,
           a.filename AS file_name,
           COALESCE(p.content, cmt.content, a.filename, '') AS content,
           a.created_at,
           CASE WHEN $5::text <> '' AND COALESCE(a.channel_id, cmt.channel_id, p.channel_id, '') = $5 THEN 'current_channel' ELSE 'accessible_channels' END AS search_scope,
           ch.name AS channel_name,
           tm.name AS team_name,
           u.name AS author_name,
           u.username AS author_username,
           u.image_url AS author_image_url,
           COALESCE(p.content, cmt.content, '') AS post_content,
           1.0 AS match_score,
           0.0 AS recency_score,
           0.42
             + (CASE WHEN $5::text <> '' AND COALESCE(a.channel_id, cmt.channel_id, p.channel_id, '') = $5 THEN 0.14 ELSE 0 END)
             + (CASE WHEN $6::text <> '' AND ch.team_id = $6 THEN 0.06 ELSE 0 END) AS score
         FROM attachments a
         LEFT JOIN comments cmt ON cmt.id = a.comment_id
         LEFT JOIN posts p ON p.id = COALESCE(a.post_id, cmt.post_id)
         JOIN channels ch ON ch.id = COALESCE(a.channel_id, cmt.channel_id, p.channel_id, '')
         JOIN teams tm ON tm.id = ch.team_id
         LEFT JOIN users u ON u.id = COALESCE(cmt.author_id, p.author_id, a.uploader_id)
         WHERE COALESCE(a.channel_id, cmt.channel_id, p.channel_id, '') = ANY($1)
           AND COALESCE(cmt.security_level, p.security_level, 0) <= $3
           AND COALESCE(a.status, '') = 'COMPLETED'
           ${buildAttachmentTypeFilter({ target })}
           AND LOWER(COALESCE(a.filename, '') || ' ' || COALESCE(p.content, '') || ' ' || COALESCE(cmt.content, '')) LIKE '%' || LOWER($2) || '%'
         ORDER BY score DESC, a.created_at DESC
         LIMIT $4`,
        [accessibleChannelIds, term, userLevel, safeLimit, safeCurrentChannelId, safeCurrentTeamId],
      )
      rows = [...rows, ...(attachmentRes.rows || [])]
    }

    await ensureSoftDeleteSchema().catch(() => {})
    const delRes = await db.query(
      'SELECT item_type, item_id FROM deleted_items WHERE channel_id = ANY($1)',
      [accessibleChannelIds],
    ).catch(() => ({ rows: [] }))
    const delPostIds = new Set()
    const delCommentIds = new Set()
    for (const item of delRes.rows || []) {
      if (item.item_type === 'post') delPostIds.add(String(item.item_id))
      else if (item.item_type === 'comment') delCommentIds.add(String(item.item_id))
    }

    const seen = new Set()
    return rows
      .filter((row) => {
        if (row.post_id && delPostIds.has(String(row.post_id))) return false
        if (row.type === 'post' && delPostIds.has(String(row.id))) return false
        if (row.comment_id && delCommentIds.has(String(row.comment_id))) return false
        if (row.type === 'comment' && delCommentIds.has(String(row.id))) return false
        const key = [row.type, row.id, row.post_id, row.comment_id || '', row.attachment_id || ''].join(':')
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, safeLimit)
      .map(rowToSearchResult)
  }
}

module.exports = PostSearchService
