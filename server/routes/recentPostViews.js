const express = require('express')
const router = express.Router()
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { canAccessChannel } = require('../lib/channelAccess')

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

function rowToClient(row = {}) {
  const authorImageUrl = row.author_image_url || row.user_image_url || ''
  return {
    postId: String(row.post_id || ''),
    channelId: String(row.channel_id || ''),
    kind: row.kind || 'post',
    icon: row.icon || '📄',
    title: row.title || '(제목 없음)',
    tag: row.tag || '',
    summary: '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || row.created_at || null,
    authorId: row.author_id || null,
    authorName: row.author_name || '',
    authorImageUrl,
    commentCount: Number(row.comment_count) || 0,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    viewedAt: row.viewed_at ? new Date(row.viewed_at).getTime() : Date.now(),
  }
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50)
    const result = await db.query(
      `SELECT r.*, u.image_url AS user_image_url
       FROM recent_post_views r
       LEFT JOIN users u ON u.id = r.author_id
       WHERE r.user_id = $1
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
        safeText(body.title, 500) || '(제목 없음)',
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
