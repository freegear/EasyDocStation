const express = require('express')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
const { client } = require('../cassandra')
const db = require('../db')
const requireAuth = require('../middleware/auth')

// GET /api/posts — Fetch posts for a specific channel
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { channelId } = req.query
    if (!channelId) return res.status(400).json({ error: 'channelId is required' })

    const query = 'SELECT * FROM posts WHERE channel_id = ?'
    const result = await client.execute(query, [channelId], { prepare: true })
    
    // Map Cassandra rows to match frontend expectation
    const posts = await Promise.all(result.rows.map(async row => {
      // Fetch author info from PostgreSQL
      const authorRes = await db.query('SELECT name, username FROM users WHERE id = $1', [row.author_id])
      const author = authorRes.rows[0] || { name: '알 수 없음', username: 'unknown' }

      return {
        id: row.id.toString(),
        channel_id: row.channel_id,
        content: row.content,
        attachments: row.attachments || [], // These are paths
        author: {
          id: row.author_id,
          name: author.name,
          username: author.username,
          avatar: author.name[0]
        },
        createdAt: row.authored_at,
        pinned: false, // Default for now
        views: 0
      }
    }))

    res.json(posts)
  } catch (err) {
    next(err)
  }
})

// POST /api/posts — Create a new post
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { channelId, content, attachmentIds } = req.body
    if (!channelId || !content) return res.status(400).json({ error: 'channelId and content are required' })

    const postId = uuidv4()
    const authoredAt = new Date()
    
    // Fetch attachment paths from SQL
    let paths = []
    if (attachmentIds && attachmentIds.length > 0) {
      const placeholders = attachmentIds.map((_, i) => `$${i + 1}`).join(',')
      const attachRes = await db.query(
        `SELECT storage_path FROM attachments WHERE id IN (${placeholders})`,
        attachmentIds
      )
      paths = attachRes.rows.map(r => r.storage_path)
    }

    // Save to Cassandra
    const query = `
      INSERT INTO posts (channel_id, id, author_id, content, attachments, authored_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    await client.execute(query, [
      channelId,
      postId,
      req.user.id,
      content,
      paths,
      authoredAt
    ], { prepare: true })

    // Update SQL attachments with post_id
    if (attachmentIds && attachmentIds.length > 0) {
      const placeholders = attachmentIds.map((_, i) => `$${i + 2}`).join(',')
      await db.query(
        `UPDATE attachments SET post_id = $1 WHERE id IN (${placeholders})`,
        [postId, ...attachmentIds]
      )
    }

    res.status(201).json({
      id: postId,
      channelId,
      content,
      attachments: paths,
      authoredAt
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
