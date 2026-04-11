const express = require('express')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
const { client, isConnected } = require('../cassandra')
const db = require('../db')
const requireAuth = require('../middleware/auth')

// ─── Helper: UUIDs → enriched attachment objects ──────────────
async function enrichAttachments(ids) {
  if (!ids || ids.length === 0) return []
  const results = await Promise.all(
    ids.map(async (id) => {
      const res = await db.query('SELECT * FROM attachments WHERE id = $1', [id])
      if (res.rowCount === 0) return null
      const a = res.rows[0]
      return { id: a.id, name: a.filename, type: a.content_type, size: a.size, url: `/api/files/view/${a.id}` }
    })
  )
  return results.filter(Boolean)
}

// ─── Helper: link attachment rows to a post ───────────────────
async function linkAttachments(postId, ids) {
  if (!ids || ids.length === 0) return
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(',')
  await db.query(
    `UPDATE attachments SET post_id = $1 WHERE id IN (${placeholders})`,
    [postId, ...ids]
  )
}

// ─── GET /api/posts ───────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { channelId } = req.query
    if (!channelId) return res.status(400).json({ error: 'channelId is required' })

    // ── Cassandra path ────────────────────────────────────────
    if (isConnected()) {
      const result = await client.execute(
        'SELECT * FROM posts WHERE channel_id = ? ORDER BY authored_at ASC',
        [channelId], { prepare: true }
      )

      const posts = await Promise.all(result.rows.map(async row => {
        const authorRes = await db.query(
          'SELECT id, name, username, image_url FROM users WHERE id = $1',
          [row.author_id]
        )
        const author = authorRes.rows[0] || { id: null, name: '알 수 없음', username: 'unknown', image_url: null }
        const avatarLetters = author.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
        const attachments = await enrichAttachments(row.attachments || [])
        return {
          id: row.id.toString(),
          channel_id: row.channel_id,
          content: row.content,
          attachments,
          author: {
            id: author.id,
            name: author.name,
            username: author.username,
            avatar: avatarLetters,
            image_url: author.image_url,
          },
          createdAt: row.authored_at,
          comments: [], tags: [], pinned: false, views: 0,
        }
      }))

      return res.json(posts)
    }

    // ── PostgreSQL fallback ───────────────────────────────────
    const result = await db.query(`
      SELECT p.*, u.id AS u_id, u.name AS author_name, u.username, u.image_url
      FROM posts p
      JOIN users u ON p.author_id = u.id
      WHERE p.channel_id = $1
      ORDER BY p.created_at ASC
    `, [channelId])

    const posts = await Promise.all(result.rows.map(async row => {
      const attRes = await db.query(
        `SELECT * FROM attachments WHERE post_id = $1 AND status = 'COMPLETED'`,
        [row.id]
      )
      const attachments = attRes.rows.map(a => ({
        id: a.id, name: a.filename, type: a.content_type, size: a.size,
        url: `/api/files/view/${a.id}`,
      }))
      const avatarLetters = row.author_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
      return {
        id: row.id,
        channel_id: row.channel_id,
        content: row.content,
        attachments,
        author: {
          id: row.author_id,
          name: row.author_name,
          username: row.username,
          avatar: avatarLetters,
          image_url: row.image_url,
        },
        createdAt: row.created_at,
        comments: [], tags: [], pinned: false, views: row.views || 0,
      }
    }))

    res.json(posts)
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/posts ──────────────────────────────────────────
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { channelId, content, attachmentIds } = req.body
    if (!channelId || !content) return res.status(400).json({ error: 'channelId and content are required' })

    const postId = uuidv4()
    const authoredAt = new Date()
    const ids = attachmentIds || []

    // ── Cassandra path ────────────────────────────────────────
    if (isConnected()) {
      await client.execute(
        `INSERT INTO posts (channel_id, id, author_id, content, attachments, authored_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [channelId, postId, req.user.id, content, ids, authoredAt],
        { prepare: true }
      )
    } else {
      // ── PostgreSQL fallback ─────────────────────────────────
      await db.query(
        `INSERT INTO posts (id, channel_id, author_id, content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [postId, channelId, req.user.id, content, authoredAt]
      )
    }

    await linkAttachments(postId, ids)

    res.status(201).json({ id: postId, channelId, content, authoredAt })
  } catch (err) {
    next(err)
  }
})

module.exports = router
