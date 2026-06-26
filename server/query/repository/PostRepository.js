const { client, isConnected } = require('../../cassandra')
const db = require('../../db')
const { getUserSecurityLevel } = require('../../lib/channelAccess')

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

class PostRepository {
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
}

module.exports = PostRepository
