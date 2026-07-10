const express = require('express')
const router = express.Router()
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { canAccessChannel } = require('../lib/channelAccess')

let softDeleteSchemaEnsured = false
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

function safeText(value, max = 1000) {
  return String(value || '').slice(0, max)
}

function safeDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function safeAttachments(value) {
  const list = Array.isArray(value) ? value : []
  return list.map(item => String(item || '').trim()).filter(Boolean).slice(0, 5)
}

function safeInt(value) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

function plainText(value) {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function plainTextLine(value) {
  return plainText(value).replace(/^[-=*_#\s]+$/g, '').trim()
}

function firstMeaningfulLine(value, max = 100) {
  const rawLines = String(value || '').split(/\r?\n/)
  for (const line of rawLines) {
    const text = plainTextLine(line)
    if (text) return safeText(text, max)
  }
  return safeText(plainText(value), max)
}

function firstLink(value, max = 100) {
  const text = String(value || '')
  const markdownLink = text.match(/!?\[[^\]]*\]\((https?:\/\/[^)\s]+)[^)]*\)/i)
  const htmlHref = text.match(/href=["'](https?:\/\/[^"']+)["']/i)
  const rawUrl = text.match(/https?:\/\/[^\s<>"')]+/i)
  const url = markdownLink?.[1] || htmlHref?.[1] || rawUrl?.[0] || ''
  return safeText(url.replace(/[.,;:!?]+$/g, ''), max)
}

function isUntitled(value) {
  const title = String(value || '').trim()
  return !title || title === '(제목 없음)'
}

function displayTitle({ title, summary, content, attachments }) {
  const rawTitle = String(title || '').trim()
  if (!isUntitled(rawTitle)) return safeText(rawTitle, 500)
  const firstAttachment = Array.isArray(attachments) ? attachments.find(Boolean) : ''
  const textSource = content || summary
  return safeText(firstAttachment || firstMeaningfulLine(textSource) || firstLink(textSource) || '(제목 없음)', 500)
}

function rowToClient(row = {}) {
  const authorImageUrl = row.author_image_url || row.user_image_url || ''
  const attachments = Array.isArray(row.attachments) ? row.attachments : []
  const title = displayTitle({
    title: row.title,
    summary: row.summary,
    content: row.post_content,
    attachments,
  })
  return {
    postId: String(row.post_id || ''),
    channelId: String(row.channel_id || ''),
    kind: row.kind || 'post',
    icon: row.icon || '📄',
    title,
    tag: row.tag || '',
    summary: '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || row.created_at || null,
    authorId: row.author_id || null,
    authorName: row.author_name || '',
    authorImageUrl,
    commentCount: Number(row.comment_count) || 0,
    attachments,
    viewedAt: row.viewed_at ? new Date(row.viewed_at).getTime() : Date.now(),
  }
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50)
    await ensureSoftDeleteSchema()
    const result = await db.query(
      `SELECT r.*, u.image_url AS user_image_url, p.content AS post_content
       FROM recent_post_views r
       JOIN posts p ON p.id::text = r.post_id
       LEFT JOIN users u ON u.id = r.author_id
       WHERE r.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM deleted_items d
           WHERE d.item_type = 'post' AND d.item_id = r.post_id
         )
       ORDER BY viewed_at DESC
       LIMIT $2`,
      [req.user.id, limit * 2],
    )

    const visible = []
    for (const row of result.rows || []) {
      if (visible.length >= limit) break
      const allowed = await canAccessChannel(db, req.user, row.channel_id).catch(() => false)
      if (!allowed) continue
      if (!row.author_image_url && row.user_image_url && row.author_id) {
        db.query(
          `UPDATE recent_post_views
           SET author_image_url = $1
           WHERE user_id = $2 AND post_id = $3 AND author_image_url = ''`,
          [row.user_image_url, req.user.id, row.post_id],
        ).catch(() => {})
      }
      visible.push(rowToClient(row))
    }
    res.json(visible)
  } catch (err) {
    next(err)
  }
})

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {}
    const postId = safeText(body.postId, 100)
    const channelId = safeText(body.channelId, 50)
    if (!postId || !channelId) return res.status(400).json({ error: 'postId and channelId are required' })

    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: 'Forbidden' })

    const attachments = safeAttachments(body.attachments)
    const viewedAt = safeDate(body.viewedAt) || new Date()
    const authorId = safeInt(body.authorId)
    let authorImageUrl = safeText(body.authorImageUrl, 500000)
    if (!authorImageUrl && authorId) {
      const userResult = await db.query(
        'SELECT image_url FROM users WHERE id = $1 LIMIT 1',
        [authorId],
      ).catch(() => ({ rows: [] }))
      authorImageUrl = safeText(userResult.rows?.[0]?.image_url, 500000)
    }
    await db.query(
      `INSERT INTO recent_post_views (
         user_id, post_id, channel_id, team_id, kind, icon, title, tag, summary,
         created_at, updated_at, author_id, author_name, author_image_url, comment_count, attachments, viewed_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (user_id, post_id)
       DO UPDATE SET
         channel_id = EXCLUDED.channel_id,
         team_id = EXCLUDED.team_id,
         kind = EXCLUDED.kind,
         icon = EXCLUDED.icon,
         title = EXCLUDED.title,
         tag = EXCLUDED.tag,
         summary = EXCLUDED.summary,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         author_id = EXCLUDED.author_id,
         author_name = EXCLUDED.author_name,
         author_image_url = COALESCE(NULLIF(EXCLUDED.author_image_url, ''), recent_post_views.author_image_url),
         comment_count = EXCLUDED.comment_count,
         attachments = EXCLUDED.attachments,
         viewed_at = EXCLUDED.viewed_at`,
      [
        req.user.id,
        postId,
        channelId,
        safeText(body.teamId, 50) || null,
        safeText(body.kind, 30) || 'post',
        safeText(body.icon, 10) || '📄',
        displayTitle({
          title: safeText(body.title, 500),
          summary: safeText(body.summary, 1000),
          attachments,
        }),
        safeText(body.tag, 200),
        '',
        safeDate(body.createdAt),
        safeDate(body.updatedAt),
        authorId,
        safeText(body.authorName, 200),
        authorImageUrl,
        Math.max(0, Number.parseInt(body.commentCount, 10) || 0),
        JSON.stringify(attachments),
        viewedAt,
      ],
    )
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

module.exports = router
