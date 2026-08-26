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

const DOCUMENT_KINDS = [
  { kind: 'business_registration', pattern: /사업자\s*등록증|사업자등록번호|법인\s*사업자/i },
  { kind: 'bankbook_copy', pattern: /통장\s*사본/i },
  { kind: 'shareholder_registry', pattern: /주주\s*명부/i },
  { kind: 'articles_of_incorporation', pattern: /(?:^|\s)정관(?:\s|$)/i },
  { kind: 'quotation', pattern: /견적서/i },
  { kind: 'tax_invoice', pattern: /세금\s*계산서/i },
]

function compactSearchText(value = '') {
  return normalizeText(value)
    .toLocaleLowerCase('ko-KR')
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function detectDocumentKind(query = '') {
  return DOCUMENT_KINDS.find(item => item.pattern.test(normalizeText(query)))?.kind || ''
}

function lexicalMatchCount(fileName = '', keywords = []) {
  const compactName = compactSearchText(fileName)
  if (!compactName) return 0
  return [...new Set((keywords || []).map(compactSearchText).filter(word => word.length >= 2))]
    .filter(word => compactName.includes(word))
    .length
}

function rankLocateReferences(refs = [], { keywords = [], channelId = '' } = {}) {
  const requestedKind = detectDocumentKind(buildFallbackQuery(keywords))
  return refs
    .map((ref, index) => ({
      ref,
      index,
      fileMatches: lexicalMatchCount(ref.file_name || ref.fileName || '', keywords),
      kindMatch: Boolean(requestedKind && ref.document_kind === requestedKind),
      currentChannel: Boolean(channelId && String(ref.channel_id || '') === String(channelId)),
    }))
    .sort((a, b) => (
      Number(b.fileMatches > 0) - Number(a.fileMatches > 0)
      || Number(b.kindMatch) - Number(a.kindMatch)
      || Number(b.currentChannel) - Number(a.currentChannel)
      || b.fileMatches - a.fileMatches
      || Number(a.ref.score ?? Number.POSITIVE_INFINITY) - Number(b.ref.score ?? Number.POSITIVE_INFINITY)
      || a.index - b.index
    ))
    .map(item => item.ref)
}

function deduplicateLocateReferences(refs = []) {
  const seen = new Set()
  return refs.filter(ref => {
    const fileHash = String(ref.file_hash || '').trim()
    const key = fileHash
      ? `file:${fileHash}`
      : `ref:${ref.post_id || ''}:${ref.comment_id || ''}:${ref.attachment_id || ''}:${ref.type || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
      fileHash: String(meta.file_hash || ''),
      file_hash: String(meta.file_hash || ''),
      documentKind: String(meta.document_kind || ''),
      document_kind: String(meta.document_kind || ''),
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

  // LanceDB에 삭제 전 벡터가 남아 있어도 실제 게시글이 존재하는 참조만 반환한다.
  const postIds = [...new Set(rawRefs.map(ref => ref.post_id).filter(Boolean))]
  const placeholders = postIds.map((_, i) => `$${i + 1}`).join(', ')
  const [postRes, attRes] = await Promise.all([
    db.query(`SELECT id, channel_id FROM posts WHERE id IN (${placeholders})`, postIds).catch(() => ({ rows: [] })),
    db.query(`SELECT post_id, channel_id FROM attachments WHERE post_id IN (${placeholders})`, postIds).catch(() => ({ rows: [] })),
  ])
  const existingPostIds = new Set()
  const channelByPost = new Map()
  for (const row of postRes.rows || []) {
    if (row.id) existingPostIds.add(String(row.id))
    if (row.id && row.channel_id) channelByPost.set(String(row.id), String(row.channel_id))
  }
  for (const row of attRes.rows || []) {
    if (row.post_id && row.channel_id && !channelByPost.has(String(row.post_id))) {
      channelByPost.set(String(row.post_id), String(row.channel_id))
    }
  }
  for (const ref of rawRefs) {
    const resolvedChannelId = channelByPost.get(String(ref.post_id)) || ''
    if (resolvedChannelId) {
      ref.channelId = resolvedChannelId
      ref.channel_id = resolvedChannelId
    }
  }

  return rawRefs
    .filter(ref => existingPostIds.has(String(ref.post_id)) && ref.channel_id && allowed.has(String(ref.channel_id)))
    .slice(0, limit * 2)
}

// 폴더 데이터셋 스코프 판정용: 사용자가 속한 팀 ID 목록 (rag.js getUserTeamIds 와 동일)
async function getUserTeamIds(userId) {
  if (!userId) return []
  try {
    const { rows } = await db.query(
      `SELECT team_id FROM team_members WHERE user_id=$1
         UNION SELECT team_id FROM team_admins WHERE user_id=$1`,
      [userId],
    )
    return rows.map(r => r.team_id)
  } catch (_) {
    return []
  }
}

async function locateWithRagFallback({ keywords = [], channelId = '', limit = 10 } = {}, user = {}) {
  const query = buildFallbackQuery(keywords)
  if (!query) return []

  const allowedChannelIds = await getAccessibleChannelIds(db, user)
  if (!allowedChannelIds.length) return []

  const userSecurityLevel = getUserSecurityLevel(user)
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
    // 폴더 데이터셋 접근 범위(모두/팀/채널/개인) 판정 컨텍스트 (UploadFolder.md 23.1).
    // 활성 테이블에 스코프 필드가 없으면 무시되어 기존 동작을 보존한다.
    scope_context: {
      user_id: String(user?.id || ''),
      team_ids: await getUserTeamIds(user?.id),
      accessible_channel_ids: allowedChannelIds,
      security_level: userSecurityLevel,
      is_site_admin: user?.role === 'site_admin',
    },
  }

  const results = await callRagServer(payload).catch(err => {
    console.warn('[QuestionLocate] RAG fallback failed:', err.message)
    return []
  })

  const filtered = (Array.isArray(results) ? results : []).filter(item => {
    if (!isWithinVectorDistance(item)) return false
    const meta = item?.metadata || {}
    // 보안등급: 폴더 청크는 effective_security_level, 그 외는 기존 security_level(없으면 0).
    const security = Number.parseInt(meta.effective_security_level ?? meta.security_level, 10) || 0
    if (security > userSecurityLevel) return false
    const metaChannelId = String(meta.channel_id || '').trim()
    return !metaChannelId || allowedChannelIds.map(String).includes(metaChannelId)
  })

  const refs = await hydrateReferences(filtered, { allowedChannelIds, limit })
  return deduplicateLocateReferences(rankLocateReferences(refs, { keywords, channelId })).slice(0, limit)
}

module.exports = {
  locateWithRagFallback,
  rankLocateReferences,
  deduplicateLocateReferences,
}
