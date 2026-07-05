const express = require('express')
const requireAuth = require('../middleware/auth')
const db = require('../db')
const { getAccessibleChannelIds } = require('../lib/channelAccess')

const router = express.Router()

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

function plainText(value) {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstTextLine(value, max = 100) {
  return plainText(value).slice(0, max)
}

function compactImageUrl(value) {
  const s = String(value || '')
  // data URLs can be very large; list surfaces only need a normal URL.
  return s.startsWith('data:') ? '' : s
}

function normalizeAttachments(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean).slice(0, 5)
  return []
}

function rowToClient(row = {}) {
  const attachments = normalizeAttachments(row.attachments)
  const title = String(row.title || '').trim()
    || attachments[0]
    || firstTextLine(row.content)
    || '(제목 없음)'
  const activityAt = row.unread_activity_at || row.updated_at || row.created_at || new Date()
  return {
    postId: String(row.id || ''),
    channelId: String(row.channel_id || ''),
    kind: 'post',
    icon: '📄',
    title,
    tag: [...new Set(
      [row.team_name, row.channel_name].map(s => String(s || '').trim()).filter(Boolean),
    )].join(' · '),
    summary: '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || row.created_at || null,
    authorId: row.author_id || null,
    authorName: row.author_name || '',
    authorImageUrl: compactImageUrl(row.author_image_url),
    commentCount: Number(row.comment_count) || 0,
    attachments,
    viewedAt: new Date(activityAt).getTime() || Date.now(),
    unreadPost: !!row.unread_post,
    unreadPostEdited: !!row.unread_post_edited,
    unreadCommentCount: Number(row.unread_comment_count) || 0,
    unreadActivityAt: activityAt,
  }
}

router.get('/recent-updates', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100)
    await ensureSoftDeleteSchema()
    const accessibleChannelIds = await getAccessibleChannelIds(db, req.user)
    if (!accessibleChannelIds.length) return res.json([])

    const { rows } = await db.query(
      `
      WITH scoped_posts AS (
        SELECT
          p.*,
          c.name AS channel_name,
          t.name AS team_name,
          clr.last_read_at,
          u.name AS author_name,
          u.image_url AS author_image_url,
          ARRAY_REMOVE(ARRAY[
            p.attachments_1, p.attachments_2, p.attachments_3, p.attachments_4, p.attachments_5,
            p.attachments_6, p.attachments_7, p.attachments_8, p.attachments_9, p.attachments_10
          ], NULL) AS attachment_ids
        FROM posts p
        JOIN channels c ON c.id = p.channel_id
        JOIN teams t ON t.id = c.team_id
        JOIN users u ON u.id = p.author_id
        LEFT JOIN channel_last_read clr
          ON clr.channel_id = p.channel_id AND clr.user_id = $1
        WHERE p.channel_id = ANY($2::varchar[])
          AND c.is_archived = false
          AND NOT EXISTS (
            SELECT 1 FROM deleted_items d
            WHERE d.item_type = 'post' AND d.item_id = p.id
          )
      ),
      enriched AS (
        SELECT
          sp.*,
          COALESCE(cm.comment_count, 0) AS comment_count,
          COALESCE(cm.unread_comment_count, 0) AS unread_comment_count,
          cm.last_unread_comment_at,
          (
            sp.author_id <> $1
            AND sp.created_at > COALESCE(sp.last_read_at, '-infinity'::timestamptz)
          ) AS unread_post,
          (
            sp.author_id <> $1
            AND COALESCE(sp.updated_at, sp.created_at) > sp.created_at
            AND COALESCE(sp.updated_at, sp.created_at) > COALESCE(sp.last_read_at, '-infinity'::timestamptz)
            AND NOT (sp.created_at > COALESCE(sp.last_read_at, '-infinity'::timestamptz))
          ) AS unread_post_edited,
          att.attachments
        FROM scoped_posts sp
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS comment_count,
            COUNT(*) FILTER (
              WHERE cm.author_id <> $1
                AND GREATEST(cm.created_at, COALESCE(cm.updated_at, cm.created_at)) > COALESCE(sp.last_read_at, '-infinity'::timestamptz)
            )::int AS unread_comment_count,
            MAX(GREATEST(cm.created_at, COALESCE(cm.updated_at, cm.created_at))) FILTER (
              WHERE cm.author_id <> $1
                AND GREATEST(cm.created_at, COALESCE(cm.updated_at, cm.created_at)) > COALESCE(sp.last_read_at, '-infinity'::timestamptz)
            ) AS last_unread_comment_at
          FROM comments cm
          WHERE cm.post_id = sp.id
            AND NOT EXISTS (
              SELECT 1 FROM deleted_items d
              WHERE d.item_type = 'comment' AND d.item_id = cm.id
            )
        ) cm ON true
        LEFT JOIN LATERAL (
          SELECT ARRAY_AGG(a.filename ORDER BY a.created_at ASC) AS attachments
          FROM (
            SELECT DISTINCT ON (a.id) a.id, a.filename, a.created_at
            FROM attachments a
            WHERE (
              a.id = ANY(sp.attachment_ids)
              OR (a.post_id = sp.id AND a.status = 'COMPLETED')
            )
              AND COALESCE(a.filename, '') <> ''
            ORDER BY a.id, a.created_at ASC
            LIMIT 5
          ) a
        ) att ON true
      )
      SELECT *,
        GREATEST(
          CASE WHEN unread_post THEN created_at ELSE '-infinity'::timestamptz END,
          CASE WHEN unread_post_edited THEN COALESCE(updated_at, created_at) ELSE '-infinity'::timestamptz END,
          COALESCE(last_unread_comment_at, '-infinity'::timestamptz)
        ) AS unread_activity_at
      FROM enriched
      WHERE unread_post OR unread_post_edited OR unread_comment_count > 0
      ORDER BY unread_activity_at DESC
      LIMIT $3
      `,
      [req.user.id, accessibleChannelIds, limit],
    )

    res.json((rows || []).map(rowToClient))
  } catch (err) {
    next(err)
  }
})

module.exports = router
