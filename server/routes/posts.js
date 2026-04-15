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
  if (isConnected()) {
    for (const id of ids) {
      await client.execute('UPDATE attachments SET post_id = ? WHERE id = ?', [postId, id], { prepare: true })
    }
  }
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
    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })

    const lower = q.toLowerCase()

    // ── 1. Cassandra에서 전체 posts / comments 스캔 후 JS 필터링 ──
    const [allPostsResult, allCommentsResult] = await Promise.all([
      client.execute('SELECT * FROM posts ALLOW FILTERING', [], { prepare: true }),
      client.execute('SELECT * FROM comments ALLOW FILTERING', [], { prepare: true }),
    ])

    const matchedPosts    = allPostsResult.rows.filter(r => r.content && r.content.toLowerCase().includes(lower))
    const matchedComments = allCommentsResult.rows.filter(r => r.content && r.content.toLowerCase().includes(lower))

    if (matchedPosts.length === 0 && matchedComments.length === 0) return res.json([])

    // ── 2. 댓글의 channel_id는 게시글에서 조회 ──────────────────
    const postMap = new Map(allPostsResult.rows.map(p => [p.id.toString(), p]))

    // ── 3. 필요한 channel_id / author_id 일괄 수집 ──────────────
    const channelIds = new Set([
      ...matchedPosts.map(p => p.channel_id),
      ...matchedComments.map(c => {
        const post = postMap.get(c.post_id.toString())
        return post ? post.channel_id : null
      }).filter(Boolean),
    ])
    const authorIds = new Set([
      ...matchedPosts.map(p => p.author_id),
      ...matchedComments.map(c => c.author_id),
    ])

    // ── 4. PostgreSQL에서 메타데이터 일괄 조회 ───────────────────
    const [channelsRes, usersRes] = await Promise.all([
      db.query(
        `SELECT c.id, c.name, t.name AS team_name
         FROM channels c JOIN teams t ON c.team_id = t.id
         WHERE c.id = ANY($1)`,
        [[...channelIds]]
      ),
      db.query(
        'SELECT id, name, username, image_url FROM users WHERE id = ANY($1)',
        [[...authorIds]]
      ),
    ])
    const channelMap = new Map(channelsRes.rows.map(c => [c.id, c]))
    const userMap    = new Map(usersRes.rows.map(u => [u.id, u]))

    const makeAuthor = (authorId) => {
      const u = userMap.get(authorId) || { id: null, name: '알 수 없음', username: 'unknown', image_url: null }
      return { id: u.id, name: u.name, username: u.username, image_url: u.image_url }
    }

    // ── 5. 결과 조립 ─────────────────────────────────────────────
    const postResults = matchedPosts.map(row => {
      const ch = channelMap.get(row.channel_id) || {}
      return {
        type: 'post',
        id: row.id.toString(),
        content: row.content,
        createdAt: row.authored_at,
        teamName: ch.team_name || '',
        channelName: ch.name || '',
        channelId: row.channel_id,
        author: makeAuthor(row.author_id),
      }
    })

    const commentResults = matchedComments.map(row => {
      const post = postMap.get(row.post_id.toString())
      const ch   = post ? (channelMap.get(post.channel_id) || {}) : {}
      return {
        type: 'comment',
        id: row.id,
        postId: row.post_id.toString(),
        content: row.content,
        createdAt: row.created_at,
        teamName: ch.team_name || '',
        channelName: ch.name || '',
        channelId: post ? post.channel_id : '',
        postContent: post ? post.content : '',
        author: makeAuthor(row.author_id),
      }
    })

    const results = [...postResults, ...commentResults]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

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
        'SELECT * FROM posts WHERE channel_id = ? ORDER BY created_at ASC',
        [channelId], { prepare: true }
      )

      const posts = await Promise.all(result.rows.map(async row => {
        const authorRes = await db.query(
          'SELECT id, name, username, image_url FROM users WHERE id = $1',
          [row.author_id]
        )
        const author = authorRes.rows[0] || { id: null, name: '알 수 없음', username: 'unknown', image_url: null }
        const avatarLetters = author.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
        
        // Extract IDs from 10 columns
        const attachmentIds = [
          row.attachments_1, row.attachments_2, row.attachments_3, row.attachments_4, row.attachments_5,
          row.attachments_6, row.attachments_7, row.attachments_8, row.attachments_9, row.attachments_10
        ].filter(Boolean)
        
        const attachments = await enrichAttachments(attachmentIds)
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
          createdAt: row.created_at,
          comments,
          security_level: row.security_level || 0,
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
      const attachmentIds = [
        row.attachments_1, row.attachments_2, row.attachments_3, row.attachments_4, row.attachments_5,
        row.attachments_6, row.attachments_7, row.attachments_8, row.attachments_9, row.attachments_10
      ].filter(Boolean)

      let attachments = []
      if (attachmentIds.length > 0) {
        attachments = await enrichAttachments(attachmentIds)
      } else {
        const attRes = await db.query(
          `SELECT * FROM attachments WHERE post_id = $1 AND status = 'COMPLETED'`,
          [row.id]
        )
        attachments = attRes.rows.map(a => ({
          id: a.id, name: a.filename, type: a.content_type, size: a.size,
          url: `/api/files/view/${a.id}`,
          thumbnail_url: a.thumbnail_path ? `/api/files/view/${a.id}?thumbnail=true` : null,
        }))
      }

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
        security_level: row.security_level || 0,
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
    const { channelId, content, attachmentIds, security_level } = req.body
    if (!channelId || !content) return res.status(400).json({ error: 'channelId and content are required' })

    if (attachmentIds && attachmentIds.length > 10) {
      return res.status(400).json({ error: '첨부파일은 최대 10개까지만 가능합니다.' })
    }

    const isSiteAdmin = req.user.role === 'site_admin'
    const userLevel = isSiteAdmin ? 4 : (req.user.security_level ?? 0)
    const defaultLevel = Math.min(1, userLevel)
    const safePostLevel = Math.min(Math.max(parseInt(security_level ?? defaultLevel) || 0, 0), userLevel)

    const postId = uuidv4()
    const authoredAt = new Date()
    const ids = (attachmentIds || [])
    const attCols = Array(10).fill(null)
    ids.forEach((id, i) => { attCols[i] = id })

    // ── 0. 연결 고리 로직 (Prev/Next Post ID) ────────────────────────
    const channelRes = await db.query('SELECT root_post_id, tail_post_id FROM channels WHERE id = $1', [channelId])
    const channelData = channelRes.rows[0]
    const prevPostId = channelData?.tail_post_id || null

    // ── Cassandra write ───────────────────────────────────────
    if (isConnected()) {
      await client.execute(
        `INSERT INTO posts (
          channel_id, id, author_id, content, created_at, updated_at, 
          is_edited, prev_post_id, next_post_id, child_post_id, parent_id,
          attachments_1, attachments_2, attachments_3, attachments_4, attachments_5, 
          attachments_6, attachments_7, attachments_8, attachments_9, attachments_10,
          security_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          channelId, postId, req.user.id, content, authoredAt, authoredAt, 
          false, prevPostId, null, null, null,
          ...attCols,
          safePostLevel
        ],
        { prepare: true }
      )

      // ── 1. 이전 게시글의 Next Post ID 업데이트 (Cassandra) ─────────────────────
      if (prevPostId) {
        const prevRow = await client.execute(
          'SELECT created_at FROM posts WHERE id = ? ALLOW FILTERING',
          [prevPostId], { prepare: true }
        )
        if (prevRow.rows.length > 0) {
          await client.execute(
            'UPDATE posts SET next_post_id = ? WHERE channel_id = ? AND created_at = ?',
            [postId, channelId, prevRow.rows[0].created_at], { prepare: true }
          )
        }
      }
    } else {
      // ── PostgreSQL Fallback write ──────────────────────────────────
      await db.query(
        `INSERT INTO posts (
          channel_id, id, author_id, content, created_at, updated_at,
          is_edited, prev_post_id, next_post_id, child_post_id, parent_id,
          attachments_1, attachments_2, attachments_3, attachments_4, attachments_5,
          attachments_6, attachments_7, attachments_8, attachments_9, attachments_10,
          security_level
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          channelId, postId, req.user.id, content, authoredAt, authoredAt,
          false, prevPostId, null, null, null,
          ...attCols,
          safePostLevel
        ]
      )

      // ── 1. 이전 게시글의 Next Post ID 업데이트 (PostgreSQL) ─────────────────────
      if (prevPostId) {
        await db.query('UPDATE posts SET next_post_id = $1 WHERE id = $2', [postId, prevPostId])
      }
    }

    // ── 2. 채널의 Root/Tail ID 업데이트 (PostgreSQL — 메타데이터 핵심 관리) ────────────
    if (!channelData?.root_post_id) {
      await db.query('UPDATE channels SET root_post_id = $1, tail_post_id = $1 WHERE id = $2', [postId, channelId])
    } else {
      await db.query('UPDATE channels SET tail_post_id = $1 WHERE id = $2', [postId, channelId])
    }

    await linkAttachments(postId, ids)

    // 업로드 즉시 LanceDB 임베딩 (비동기, 응답에 영향 없음)
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
    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })
      const found = await client.execute(
        'SELECT channel_id, created_at, author_id FROM posts WHERE id = ? ALLOW FILTERING',
        [id], { prepare: true }
      )
      if (found.rows.length > 0) {
        const row = found.rows[0]
        const isSiteAdmin = req.user.role === 'site_admin'
        if (isSiteAdmin || String(row.author_id) === String(req.user.id)) {
          await client.execute(
            'DELETE FROM posts WHERE channel_id = ? AND created_at = ?',
            [row.channel_id, row.created_at], { prepare: true }
          )
          // 해당 게시글의 댓글도 Cassandra에서 삭제
          const cRows = await client.execute(
            'SELECT post_id, created_at FROM comments WHERE post_id = ? ALLOW FILTERING',
            [id], { prepare: true }
          )
          await Promise.all(cRows.rows.map(c =>
            client.execute(
              'DELETE FROM comments WHERE post_id = ? AND created_at = ?',
              [c.post_id, c.created_at], { prepare: true }
            )
          ))
        }
      }
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── PUT /api/posts/:id ───────────────────────────────────────
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const { content, security_level } = req.body
    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })
    const found = await client.execute(
      'SELECT channel_id, created_at, author_id FROM posts WHERE id = ? ALLOW FILTERING',
      [id], { prepare: true }
    )
    if (found.rows.length === 0) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })
    const row = found.rows[0]
    const isSiteAdmin = req.user.role === 'site_admin'
    if (!isSiteAdmin && String(row.author_id) !== String(req.user.id)) return res.status(403).json({ error: '권한이 없습니다.' })
    // security_level은 요청자의 레벨 이하만 허용
    const userLevel = req.user.security_level ?? 0
    const safeLevel = (security_level != null) ? Math.min(Math.max(parseInt(security_level) || 0, 0), userLevel) : undefined
    if (safeLevel !== undefined) {
      await client.execute(
        'UPDATE posts SET content = ?, security_level = ? WHERE channel_id = ? AND created_at = ?',
        [content, safeLevel, row.channel_id, row.created_at], { prepare: true }
      )
    } else {
      await client.execute(
        'UPDATE posts SET content = ? WHERE channel_id = ? AND created_at = ?',
        [content, row.channel_id, row.created_at], { prepare: true }
      )
    }
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
    const { content, attachmentIds = [], channelId, security_level } = req.body
    if (!content) return res.status(400).json({ error: 'content is required' })
    if (attachmentIds.length > 10) {
      return res.status(400).json({ error: '첨부파일은 최대 10개까지만 가능합니다.' })
    }

    const isSiteAdmin = req.user.role === 'site_admin'
    const userLevel = isSiteAdmin ? 4 : (req.user.security_level ?? 0)
    const defaultLevel = Math.min(1, userLevel)
    const safeCommentLevel = Math.min(Math.max(parseInt(security_level ?? defaultLevel) || 0, 0), userLevel)

    const commentId = `c-${uuidv4()}`
    const createdAt = new Date()

    // ── Cassandra write ───────────────────────────────────────
    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })
    await client.execute(
      `INSERT INTO comments (post_id, id, author_id, content, attachments, security_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [postId, commentId, req.user.id, content, attachmentIds, safeCommentLevel, createdAt],
      { prepare: true }
    )

    // 방금 등록한 댓글을 전체 정보와 함께 반환
    const comments = await fetchComments(postId)
    const newComment = comments.find(c => c.id === commentId)

    // 업로드 즉시 LanceDB 임베딩 (비동기, 응답에 영향 없음)
    trainCommentImmediate({ id: commentId, post_id: postId, channel_id: channelId || '', content, attachmentIds })

    res.status(201).json(newComment)
  } catch (err) {
    next(err)
  }
})

// ─── PUT /api/posts/:postId/comments/:commentId ───────────────
router.put('/:postId/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const { commentId } = req.params
    const { content, attachments = [], security_level } = req.body
    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })
    const found = await client.execute(
      'SELECT post_id, created_at, author_id FROM comments WHERE id = ? ALLOW FILTERING',
      [commentId], { prepare: true }
    )
    if (found.rows.length === 0) return res.status(404).json({ error: '댓글을 찾을 수 없습니다.' })
    const row = found.rows[0]
    const isSiteAdmin = req.user.role === 'site_admin'
    if (!isSiteAdmin && String(row.author_id) !== String(req.user.id)) return res.status(403).json({ error: '권한이 없습니다.' })
    const userLevel = req.user.security_level ?? 0
    const safeLevel = (security_level != null) ? Math.min(Math.max(parseInt(security_level) || 0, 0), userLevel) : undefined
    if (safeLevel !== undefined) {
      await client.execute(
        'UPDATE comments SET content = ?, attachments = ?, security_level = ? WHERE post_id = ? AND created_at = ?',
        [content, attachments, safeLevel, row.post_id, row.created_at], { prepare: true }
      )
    } else {
      await client.execute(
        'UPDATE comments SET content = ?, attachments = ? WHERE post_id = ? AND created_at = ?',
        [content, attachments, row.post_id, row.created_at], { prepare: true }
      )
    }
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
    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })
    const found = await client.execute(
      'SELECT post_id, created_at, author_id FROM comments WHERE id = ? ALLOW FILTERING',
      [commentId], { prepare: true }
    )
    if (found.rows.length > 0) {
      const row = found.rows[0]
      const isSiteAdmin = req.user.role === 'site_admin'
      if (isSiteAdmin || String(row.author_id) === String(req.user.id)) {
        await client.execute(
          'DELETE FROM comments WHERE post_id = ? AND created_at = ?',
          [row.post_id, row.created_at], { prepare: true }
        )
      }
    }
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

module.exports = router
