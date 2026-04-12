const express = require('express')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
const { client, isConnected } = require('../cassandra')
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { trainPostImmediate, trainCommentImmediate } = require('../rag')

// ─── Helper: UUIDs → enriched attachment objects ──────────────
async function enrichAttachments(ids) {
  if (!ids || ids.length === 0) return []
  const results = await Promise.all(
    ids.map(async (item) => {
      const id = typeof item === 'object' ? item.id : item
      if (!id) return null
      const res = await db.query('SELECT * FROM attachments WHERE id = $1', [id])
      if (res.rowCount === 0) return null
      const a = res.rows[0]
      return { 
        id: a.id, 
        name: a.filename, 
        type: a.content_type, 
        size: a.size, 
        url: `/api/files/view/${a.id}`,
        thumbnail_url: a.thumbnail_path ? `/api/files/view/${a.id}?thumbnail=true` : null
      }
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

// ─── Helper: fetch comments for a post ───────────────────────
async function fetchComments(postId) {
  // ── Cassandra path ──────────────────────────────────────────
  if (isConnected()) {
    try {
      const result = await client.execute(
        'SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC',
        [postId], { prepare: true }
      )
      
      return Promise.all(result.rows.map(async row => {
        const authorRes = await db.query(
          'SELECT id, name, username, image_url FROM users WHERE id = $1',
          [row.author_id]
        )
        const author = authorRes.rows[0] || { id: null, name: '알 수 없음', username: 'unknown', image_url: null }
        const avatarLetters = author.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
        const attachments = await enrichAttachments(row.attachments || [])
        
        return {
          id: row.id,
          post_id: row.post_id.toString(),
          content: row.content,
          text: row.content,
          attachments,
          author: {
            id: author.id,
            name: author.name,
            username: author.username,
            avatar: avatarLetters,
            image_url: author.image_url,
          },
          createdAt: row.created_at,
          updatedAt: row.created_at, // Cassandra comments table doesn't have updated_at yet
        }
      }))
    } catch (err) {
      console.error('[Cassandra] 댓글 조회 오류:', err.message)
      // fallback to postgres
    }
  }

  // ── PostgreSQL fallback ─────────────────────────────────────
  const result = await db.query(`
    SELECT c.*, u.name AS author_name, u.username, u.image_url
    FROM comments c
    JOIN users u ON c.author_id = u.id
    WHERE c.post_id = $1
    ORDER BY c.created_at ASC
  `, [postId])

  return Promise.all(result.rows.map(async row => {
    const avatarLetters = row.author_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    const attachments = await enrichAttachments(row.attachments || [])
    return {
      id: row.id,
      post_id: row.post_id,
      content: row.content,
      text: row.content,  // 프론트 호환
      attachments,
      author: {
        id: row.author_id,
        name: row.author_name,
        username: row.username,
        avatar: avatarLetters,
        image_url: row.image_url,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }))
}

// ─── GET /api/posts/search ────────────────────────────────────
router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const { q } = req.query
    if (!q) return res.status(400).json({ error: 'Search query is required' })

    // Search in posts
    const postMatches = await db.query(`
      SELECT p.*, u.name AS author_name, u.username, u.image_url, t.name as team_name, c.name as channel_name
      FROM posts p
      JOIN users u ON p.author_id = u.id
      JOIN channels c ON p.channel_id = c.id
      JOIN teams t ON c.team_id = t.id
      WHERE p.content ILIKE $1
      ORDER BY p.created_at DESC
    `, [`%${q}%`])

    // Search in comments
    const commentMatches = await db.query(`
      SELECT c.*, u.name AS author_name, u.username, u.image_url, t.name as team_name, ch.name as channel_name, p.content as post_content
      FROM comments c
      JOIN users u ON c.author_id = u.id
      JOIN posts p ON c.post_id = p.id
      JOIN channels ch ON c.channel_id = ch.id
      JOIN teams t ON ch.team_id = t.id
      WHERE c.content ILIKE $1
      ORDER BY c.created_at DESC
    `, [`%${q}%`])

    const results = [
      ...postMatches.rows.map(row => ({
        type: 'post',
        id: row.id,
        content: row.content,
        createdAt: row.created_at,
        teamName: row.team_name,
        channelName: row.channel_name,
        channelId: row.channel_id,
        author: {
          id: row.author_id,
          name: row.author_name,
          username: row.username,
          image_url: row.image_url
        }
      })),
      ...commentMatches.rows.map(row => ({
        type: 'comment',
        id: row.id,
        postId: row.post_id,
        content: row.content,
        createdAt: row.created_at,
        teamName: row.team_name,
        channelName: row.channel_name,
        channelId: row.channel_id,
        postContent: row.post_content,
        author: {
          id: row.author_id,
          name: row.author_name,
          username: row.username,
          image_url: row.image_url
        }
      }))
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

    res.json(results)
  } catch (err) {
    next(err)
  }
})

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
        const comments = await fetchComments(row.id.toString())
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
          comments,
          tags: [], pinned: false, views: 0,
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
        thumbnail_url: a.thumbnail_path ? `/api/files/view/${a.id}?thumbnail=true` : null,
      }))
      const avatarLetters = row.author_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
      const comments = await fetchComments(row.id)
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
        comments,
        tags: [], pinned: false, views: row.views || 0,
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

    // immediate 모드일 때 즉시 RAG 학습 (비동기, 응답에 영향 없음)
    trainPostImmediate({ id: postId, channel_id: channelId, content, created_at: authoredAt })

    res.status(201).json({ id: postId, channelId, content, authoredAt })
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /api/posts/:id ────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params

    // ── Cassandra 삭제 ────────────────────────────────────────
    if (isConnected()) {
      try {
        // id는 PK가 아니므로 ALLOW FILTERING으로 먼저 조회
        const found = await client.execute(
          'SELECT channel_id, authored_at, author_id FROM posts WHERE id = ? ALLOW FILTERING',
          [id], { prepare: true }
        )
        if (found.rows.length > 0) {
          const row = found.rows[0]
          // 작성자 본인 확인
          if (String(row.author_id) === String(req.user.id)) {
            await client.execute(
              'DELETE FROM posts WHERE channel_id = ? AND authored_at = ?',
              [row.channel_id, row.authored_at], { prepare: true }
            )
          }
        }
      } catch (cassErr) {
        console.error('[Cassandra] 게시글 삭제 오류:', cassErr.message)
      }
    }

    // ── PostgreSQL 삭제 (댓글 포함, fallback 데이터) ──────────
    await db.query('DELETE FROM comments WHERE post_id = $1', [id])
    await db.query('DELETE FROM posts WHERE id = $1 AND author_id = $2', [id, req.user.id])

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── PUT /api/posts/:id ───────────────────────────────────────
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const { content } = req.body
    await db.query(
      'UPDATE posts SET content = $1, updated_at = NOW() WHERE id = $2 AND author_id = $3',
      [content, id, req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/posts/:id/comments ─────────────────────────────
router.get('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const comments = await fetchComments(req.params.id)
    res.json(comments)
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/posts/:id/comments ────────────────────────────
router.post('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const { id: postId } = req.params
    const { channelId, content, attachmentIds = [] } = req.body // 프론트에서 attachmentIds로 보낸다고 가정 (posts와 동일하게)
    if (!content) return res.status(400).json({ error: 'content is required' })

    const commentId = `c-${uuidv4()}`
    const createdAt = new Date()

    // ── Cassandra path ────────────────────────────────────────
    if (isConnected()) {
      let storagePaths = []
      if (attachmentIds.length > 0) {
        const pathsRes = await db.query(
          'SELECT storage_path FROM attachments WHERE id = ANY($1)',
          [attachmentIds]
        )
        storagePaths = pathsRes.rows.map(r => r.storage_path)
      }

      await client.execute(
        `INSERT INTO comments (post_id, id, author_id, content, attachments, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [postId, commentId, req.user.id, content, storagePaths, createdAt],
        { prepare: true }
      )
    }

    // ── PostgreSQL fallback (or concurrent write for search support)
    await db.query(
      `INSERT INTO comments (id, post_id, channel_id, author_id, content, attachments, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [commentId, postId, channelId, req.user.id, content, JSON.stringify(attachmentIds), createdAt]
    )

    // 방금 등록한 댓글을 전체 정보와 함께 반환
    const comments = await fetchComments(postId)
    const newComment = comments.find(c => c.id === commentId)

    // immediate 모드일 때 즉시 RAG 학습 (비동기, 응답에 영향 없음)
    trainCommentImmediate({ id: commentId, post_id: postId, content })

    res.status(201).json(newComment)
  } catch (err) {
    next(err)
  }
})

// ─── PUT /api/posts/:postId/comments/:commentId ───────────────
router.put('/:postId/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const { commentId } = req.params
    const { content, attachments } = req.body
    await db.query(
      `UPDATE comments SET content = $1, attachments = $2, updated_at = NOW()
       WHERE id = $3 AND author_id = $4`,
      [content, JSON.stringify(attachments || []), commentId, req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /api/posts/:postId/comments/:commentId ───────────
router.delete('/:postId/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const { postId, commentId } = req.params
    
    // ── Cassandra 삭제 ────────────────────────────────────────
    if (isConnected()) {
      try {
        const found = await client.execute(
          'SELECT post_id, created_at, author_id FROM comments WHERE id = ? ALLOW FILTERING',
          [commentId], { prepare: true }
        )
        if (found.rows.length > 0) {
          const row = found.rows[0]
          if (String(row.author_id) === String(req.user.id)) {
            await client.execute(
              'DELETE FROM comments WHERE post_id = ? AND created_at = ?',
              [row.post_id, row.created_at], { prepare: true }
            )
          }
        }
      } catch (cassErr) {
        console.error('[Cassandra] 댓글 삭제 오류:', cassErr.message)
      }
    }

    // ── PostgreSQL 삭제 ───────────────────────────────────────
    await db.query(
      'DELETE FROM comments WHERE id = $1 AND author_id = $2',
      [commentId, req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

module.exports = router
