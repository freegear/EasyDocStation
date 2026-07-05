const http = require('http')
const fs = require('fs')
const path = require('path')
const db = require('../db')
const { getDatabasePath } = require('../databasePaths')
const { getAccessibleChannelIds, getUserSecurityLevel } = require('../lib/channelAccess')

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')
const RAG_SERVER_PORT = 5001
const MAX_VECTOR_DISTANCE = 1.0

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
  catch (_) { return {} }
}

function normalizeText(value = '') {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim()
}

function buildFallbackQuery(keywords = []) {
  return [...new Set((keywords || []).map(normalizeText).filter(Boolean))].join(' ')
}

function isWithinVectorDistance(item = {}) {
  const distance = Number(item?.score)
  return Number.isFinite(distance) && distance < MAX_VECTOR_DISTANCE
}

function callRagServer(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      hostname: '127.0.0.1',
      port: RAG_SERVER_PORT,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, res => {
      let data = ''
      res.on('data', d => { data += d })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (Array.isArray(parsed)) return resolve(parsed)
          if (Array.isArray(parsed?.results)) return resolve(parsed.results)
          resolve([])
        } catch (err) {
          reject(new Error('RAG fallback result parse failed'))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('RAG fallback timeout'))
    })
    req.write(body)
    req.end()
  })
}

function resultKey(ref = {}) {
  return [
    ref.post_id || ref.postId || '',
    ref.comment_id || ref.commentId || '',
    ref.attachment_id || ref.attachmentId || '',
    ref.type || ref.source_type || '',
    ref.page_number || 0,
  ].join(':')
}

async function hydrateReferences(results = [], { allowedChannelIds = [], limit = 10 } = {}) {
  const allowed = new Set(allowedChannelIds.map(String))
  const rawRefs = []
  const seen = new Set()

  for (const item of Array.isArray(results) ? results : []) {
    const meta = item?.metadata || {}
    const postId = String(meta.post_id || '').trim()
    if (!postId || postId === 'rag_dataset') continue
    const channelId = String(meta.channel_id || '').trim()
    if (channelId && !allowed.has(channelId)) continue

    const ref = {
      id: String(meta.attachment_id || meta.comment_id || postId),
      type: String(meta.type || 'rag_reference'),
      source_type: String(meta.type || ''),
      label: String(meta.file_name || meta.source || '').trim() || normalizeText(item?.text).slice(0, 80) || `자료 ${rawRefs.length + 1}`,
      title: String(meta.file_name || meta.source || '').trim() || normalizeText(item?.text).slice(0, 80) || `자료 ${rawRefs.length + 1}`,
      contentPreview: normalizeText(item?.text).slice(0, 240),
      channelId,
      channel_id: channelId,
      postId,
      post_id: postId,
      commentId: String(meta.comment_id || ''),
      comment_id: String(meta.comment_id || ''),
      attachmentId: String(meta.attachment_id || ''),
      attachment_id: String(meta.attachment_id || ''),
      fileName: String(meta.file_name || meta.source || ''),
      file_name: String(meta.file_name || meta.source || ''),
      pageNumber: Number(meta.page_number || 0),
      page_number: Number(meta.page_number || 0),
      score: Number(item?.score || 0),
      searchScope: 'rag_fallback',
      search_scope: 'rag_fallback',
    }
    const key = resultKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    rawRefs.push(ref)
    if (rawRefs.length >= limit * 2) break
  }

  if (!rawRefs.length) return []

  const refsNeedChannel = rawRefs.filter(ref => !ref.channel_id)
  if (refsNeedChannel.length > 0) {
    const postIds = [...new Set(refsNeedChannel.map(ref => ref.post_id).filter(Boolean))]
    if (postIds.length > 0) {
      const placeholders = postIds.map((_, i) => `$${i + 1}`).join(', ')
      const [postRes, attRes] = await Promise.all([
        db.query(`SELECT id, channel_id FROM posts WHERE id IN (${placeholders})`, postIds).catch(() => ({ rows: [] })),
        db.query(`SELECT post_id, channel_id FROM attachments WHERE post_id IN (${placeholders})`, postIds).catch(() => ({ rows: [] })),
      ])
      const channelByPost = new Map()
      for (const row of postRes.rows || []) {
        if (row.id && row.channel_id) channelByPost.set(String(row.id), String(row.channel_id))
      }
      for (const row of attRes.rows || []) {
        if (row.post_id && row.channel_id && !channelByPost.has(String(row.post_id))) {
          channelByPost.set(String(row.post_id), String(row.channel_id))
        }
      }
      for (const ref of refsNeedChannel) {
        ref.channelId = channelByPost.get(String(ref.post_id)) || ''
        ref.channel_id = ref.channelId
      }
    }
  }

  return rawRefs
    .filter(ref => ref.post_id && ref.channel_id && allowed.has(String(ref.channel_id)))
    .slice(0, limit)
}

async function locateWithRagFallback({ keywords = [], channelId = '', limit = 10 } = {}, user = {}) {
  const query = buildFallbackQuery(keywords)
  if (!query) return []

  const allowedChannelIds = await getAccessibleChannelIds(db, user)
  if (!allowedChannelIds.length) return []

  const cfg = readConfig()
  const ragCfg = cfg.rag || {}
  const activeTable = ragCfg.active_table || ragCfg.table_name || 'my_rag_table'
  const payload = {
    config: {
      lancedb_path: getDatabasePath(cfg, 'lancedb Database Path'),
      table_name: activeTable,
      rag_table_name: activeTable,
      schema_version: Number(ragCfg.schema_version || 1),
      vector_size: ragCfg.vectorSize ?? 1024,
    },
    query,
    limit: Math.max(limit * 3, 20),
    allowed_channel_ids: allowedChannelIds,
  }

  const results = await callRagServer(payload).catch(err => {
    console.warn('[QuestionLocate] RAG fallback failed:', err.message)
    return []
  })

  const userSecurityLevel = getUserSecurityLevel(user)
  const filtered = (Array.isArray(results) ? results : []).filter(item => {
    if (!isWithinVectorDistance(item)) return false
    const meta = item?.metadata || {}
    const security = Number.parseInt(meta.security_level, 10) || 0
    if (security > userSecurityLevel) return false
    const metaChannelId = String(meta.channel_id || '').trim()
    return !metaChannelId || allowedChannelIds.map(String).includes(metaChannelId)
  })

  const refs = await hydrateReferences(filtered, { allowedChannelIds, limit })
  if (!channelId) return refs
  const current = refs.filter(ref => String(ref.channel_id) === String(channelId))
  const other = refs.filter(ref => String(ref.channel_id) !== String(channelId))
  return [...current, ...other].slice(0, limit)
}

module.exports = {
  locateWithRagFallback,
}
