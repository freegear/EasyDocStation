const express = require('express')
const router = express.Router()
const { randomUUID } = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { client, isConnected } = require('../cassandra')
const db = require('../db')
const config = require('../../config.json')
const { getDatabasePath } = require('../databasePaths')
const requireAuth = require('../middleware/auth')
const { trainPostImmediate, retrainPostImmediate, trainCommentImmediate, retrainCommentImmediate } = require('../rag')
const PostSearchService = require('../search/PostSearchService')
const { isEasySheet, extractEasySheetText } = require('../lib/easySheet')
const {
  markTrainingStarted,
  markTrainingCompleted,
  clearTrainingStatus,
  getTrainingStatus,
} = require('../trainingStatus')
const { ACCESS_DENIED_MESSAGE, canAccessChannel, getAccessibleChannelIds } = require('../lib/channelAccess')
const STORAGE_BASE = getDatabasePath(config, 'ObjectFile Path')
const STORAGE_BASE_ABS = path.resolve(STORAGE_BASE)
const postSearchService = new PostSearchService()
let attachmentRefSchemaEnsured = false
let searchIndexSchemaEnsured = false
const IMAGE_SEARCH_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
])
const IMAGE_SEARCH_FILE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i

function securityLevelOf(value = {}) {
  if (value?.role === 'site_admin') return 4
  const parsed = Number.parseInt(value?.security_level, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

async function getAuthorSecurityLevel(authorId) {
  if (!authorId) return 0
  const result = await db.query('SELECT role, security_level FROM users WHERE id = $1 LIMIT 1', [authorId])
  return securityLevelOf(result.rows?.[0] || {})
}

async function getChannelMembershipForUser(userId, channelId) {
  if (!userId || !channelId) {
    return { isTeamMember: false, isChannelMember: false }
  }
  const result = await db.query(
    `
    SELECT
      EXISTS (
        SELECT 1
        FROM channels c
        WHERE c.id = $2
          AND (
            EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = c.team_id AND tm.user_id = $1)
            OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = c.team_id AND ta.user_id = $1)
          )
      ) AS is_team_member,
      EXISTS (
        SELECT 1
        FROM channels c
        WHERE c.id = $2
          AND (
            EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1)
            OR EXISTS (SELECT 1 FROM channel_admins ca WHERE ca.channel_id = c.id AND ca.user_id = $1)
          )
      ) AS is_channel_member
    `,
    [userId, channelId],
  )
  const row = result.rows?.[0] || {}
  return {
    isTeamMember: Boolean(row.is_team_member),
    isChannelMember: Boolean(row.is_channel_member),
  }
}

async function canMutatePostRow(user = {}, row = {}) {
  if (!user?.id || !row?.channel_id || !row?.author_id) return false
  if (user.role === 'site_admin') return true

  const userLevel = securityLevelOf(user)
  const authorLevel = await getAuthorSecurityLevel(row.author_id)
  if (userLevel < authorLevel) return false

  const { isTeamMember, isChannelMember } = await getChannelMembershipForUser(user.id, row.channel_id)
  if (!isTeamMember) return false
  if (userLevel >= 3) return true
  return isChannelMember
}

async function canMutateCommentRow(user = {}, row = {}) {
  return canMutatePostRow(user, {
    author_id: row?.author_id,
    channel_id: row?.channel_id,
  })
}

// ── 채널 단위 배치 권한/작성자 캐시 ───────────────────────────────
// 한 채널을 열 때 글·댓글마다 작성자/멤버십을 개별 조회하면 N+1 쿼리가
// 폭발한다. 요청 1회 동안 작성자 레코드를 캐시하고(중복 조회 제거),
// 멤버십은 채널당 1회만 계산해 메모리에서 권한을 판정한다.
function makeUserCache() {
  const cache = new Map()
  return {
    // 같은 author_id 동시 조회를 막기 위해 Promise 자체를 캐시한다.
    get(userId) {
      if (userId == null) return Promise.resolve(null)
      const key = String(userId)
      if (cache.has(key)) return cache.get(key)
      const promise = db
        .query(
          'SELECT id, name, username, image_url, role, security_level FROM users WHERE id = $1 LIMIT 1',
          [userId],
        )
        .then((r) => r.rows?.[0] || null)
        .catch(() => null)
      cache.set(key, promise)
      return promise
    },
    // 이미 조회된 행(JOIN 결과 등)을 캐시에 주입해 중복 쿼리를 막는다.
    prime(userId, record) {
      if (userId == null || !record) return
      cache.set(String(userId), Promise.resolve(record))
    },
  }
}

function compactListImageUrl(imageUrl) {
  const value = String(imageUrl || '')
  if (!value) return null
  return value.startsWith('data:') ? null : value
}

async function buildChannelPermissionContext(user, channelId) {
  const membership = channelId
    ? await getChannelMembershipForUser(user?.id, channelId)
    : { isTeamMember: false, isChannelMember: false }
  return { user: user || {}, userLevel: securityLevelOf(user || {}), membership }
}

// canMutatePostRow 와 동일한 판정을 사전 계산된 컨텍스트로 수행한다.
// authorRecord 는 role/security_level 을 포함한 작성자 행이어야 한다.
function canMutateWithContext(ctx, authorRecord) {
  const user = ctx?.user || {}
  if (!user?.id || !authorRecord?.id) return false
  if (user.role === 'site_admin') return true
  const authorLevel = securityLevelOf(authorRecord)
  if (ctx.userLevel < authorLevel) return false
  if (!ctx.membership.isTeamMember) return false
  if (ctx.userLevel >= 3) return true
  return ctx.membership.isChannelMember
}

function toAttachmentIdArray(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (typeof item === 'object' ? item?.id : item))
    .map((v) => String(v || '').trim())
    .filter(Boolean)
}

function extractPostAttachmentIds(postRow = {}) {
  const keys = [
    'attachments_1', 'attachments_2', 'attachments_3', 'attachments_4', 'attachments_5',
    'attachments_6', 'attachments_7', 'attachments_8', 'attachments_9', 'attachments_10',
  ]
  return keys
    .map((k) => String(postRow?.[k] || '').trim())
    .filter(Boolean)
}

function resolveStoragePathSafe(storagePath = '') {
  const safeRel = String(storagePath || '').trim()
  if (!safeRel) return null
  const abs = path.resolve(STORAGE_BASE_ABS, safeRel)
  if (abs !== STORAGE_BASE_ABS && !abs.startsWith(`${STORAGE_BASE_ABS}${path.sep}`)) return null
  return abs
}

function resolveAttachmentScopedDir(storagePath = '') {
  const rel = String(storagePath || '').trim()
  if (!rel) return null
  const normalized = rel.replace(/\\/g, '/').split('/').filter(Boolean)
  if (normalized.length < 3) return null
  const [channelPart, fileUuidPart] = normalized
  if (!channelPart || !fileUuidPart) return null
  const scopedRel = path.join(channelPart, fileUuidPart)
  return resolveStoragePathSafe(scopedRel)
}

async function ensureAttachmentRefTable() {
  if (attachmentRefSchemaEnsured) return
  await db.query(`
    CREATE TABLE IF NOT EXISTS attachment_refs (
      attachment_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (attachment_id, owner_type, owner_id)
    )
  `)
  await db.query('CREATE INDEX IF NOT EXISTS idx_attachment_refs_owner ON attachment_refs(owner_type, owner_id)')
  await db.query('ALTER TABLE attachments ADD COLUMN IF NOT EXISTS ref_count INTEGER NOT NULL DEFAULT 0')
  await db.query("ALTER TABLE attachments ADD COLUMN IF NOT EXISTS delete_status TEXT NOT NULL DEFAULT 'active'")
  await db.query('ALTER TABLE attachments ADD COLUMN IF NOT EXISTS delete_requested_at TIMESTAMPTZ NULL')
  await db.query('ALTER TABLE attachments ADD COLUMN IF NOT EXISTS comment_id VARCHAR(50)')
  attachmentRefSchemaEnsured = true
}

function uniqAttachmentIds(ids = []) {
  return [...new Set((ids || []).map((v) => String(v || '').trim()).filter(Boolean))]
}

function isImageSearchAttachment(row = {}) {
  const contentType = String(row.content_type || '').toLowerCase()
  const filename = String(row.filename || '')
  return IMAGE_SEARCH_CONTENT_TYPES.has(contentType) || IMAGE_SEARCH_FILE_EXT_RE.test(filename)
}

function normalizeSearchContent(content = '') {
  // EasySheet 게시글은 본문이 IWorkbookData JSON이므로 셀 텍스트만 추출해 인덱싱한다.
  if (isEasySheet(content)) {
    return extractEasySheetText(content)
  }
  return String(content || '')
    .replace(/<!--\s*md-doc-meta:[\s\S]*?-->/gi, ' ')
    .replace(/<!--\s*md-image-meta:[\s\S]*?-->/gi, ' ')
    .replace(/<!--\s*md-page\s*-->/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function ensureSearchIndexSchema() {
  if (searchIndexSchemaEnsured) return
  await db.query(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id             TEXT PRIMARY KEY,
      source_type    TEXT NOT NULL CHECK (source_type IN ('post', 'comment', 'image_attachment')),
      source_id      TEXT NOT NULL,
      post_id        TEXT NOT NULL,
      comment_id     TEXT,
      attachment_id  TEXT,
      channel_id     TEXT NOT NULL,
      author_id      INTEGER,
      file_name      TEXT,
      content        TEXT NOT NULL DEFAULT '',
      security_level INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`
    ALTER TABLE search_documents ADD COLUMN IF NOT EXISTS comment_id TEXT;
    ALTER TABLE search_documents ADD COLUMN IF NOT EXISTS attachment_id TEXT;
    ALTER TABLE search_documents ADD COLUMN IF NOT EXISTS file_name TEXT;
    ALTER TABLE search_documents DROP CONSTRAINT IF EXISTS search_documents_source_type_check;
    ALTER TABLE search_documents
      ADD CONSTRAINT search_documents_source_type_check
      CHECK (source_type IN ('post', 'comment', 'image_attachment'))
  `)
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_search_documents_source ON search_documents(source_type, source_id)')
  await db.query('CREATE INDEX IF NOT EXISTS idx_search_documents_channel_created ON search_documents(channel_id, created_at DESC)')
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    await db.query('CREATE INDEX IF NOT EXISTS idx_search_documents_content_trgm ON search_documents USING gin (content gin_trgm_ops)')
  } catch (e) {
    console.warn('[SearchIndex] pg_trgm 인덱스 준비 실패:', e.message)
  }
  searchIndexSchemaEnsured = true
}

async function upsertSearchDocument({
  sourceType,
  sourceId,
  postId,
  commentId = '',
  attachmentId = '',
  channelId,
  authorId,
  fileName = '',
  content,
  securityLevel = 0,
  createdAt = new Date(),
}) {
  const safeSourceType = String(sourceType || '').trim()
  const safeSourceId = String(sourceId || '').trim()
  const safePostId = String(postId || '').trim()
  const safeChannelId = String(channelId || '').trim()
  const safeContent = normalizeSearchContent(content)
  if (!safeSourceType || !safeSourceId || !safePostId || !safeChannelId) return
  await ensureSearchIndexSchema()
  await db.query(
    `INSERT INTO search_documents (
       id, source_type, source_id, post_id, comment_id, attachment_id, channel_id, author_id,
       file_name, content, security_level, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT (id)
     DO UPDATE SET
       post_id = EXCLUDED.post_id,
       comment_id = EXCLUDED.comment_id,
       attachment_id = EXCLUDED.attachment_id,
       channel_id = EXCLUDED.channel_id,
       author_id = EXCLUDED.author_id,
       file_name = EXCLUDED.file_name,
       content = EXCLUDED.content,
       security_level = EXCLUDED.security_level,
       created_at = EXCLUDED.created_at,
       updated_at = NOW()`,
    [
      `${safeSourceType}:${safeSourceId}`,
      safeSourceType,
      safeSourceId,
      safePostId,
      String(commentId || ''),
      String(attachmentId || ''),
      safeChannelId,
      authorId || null,
      String(fileName || ''),
      safeContent,
      Number.parseInt(securityLevel, 10) || 0,
      createdAt,
    ],
  )
}

async function deleteSearchDocument(sourceType, sourceId) {
  const safeSourceType = String(sourceType || '').trim()
  const safeSourceId = String(sourceId || '').trim()
  if (!safeSourceType || !safeSourceId) return
  await ensureSearchIndexSchema()
  await db.query('DELETE FROM search_documents WHERE id = $1', [`${safeSourceType}:${safeSourceId}`])
}

function getOllamaChatUrl() {
  const host = String(process.env.OLLAMA_HOST || '127.0.0.1').trim() || '127.0.0.1'
  const port = String(process.env.OLLAMA_PORT || '11434').trim() || '11434'
  return `http://${host}:${port}/api/chat`
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function prepareImageForSearch(imagePath, { maxSize = 1600, quality = 86 } = {}) {
  if (!imagePath || !fs.existsSync(imagePath)) return ''
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eds-image-index-'))
  const tmpPath = path.join(tmpDir, 'image.jpg')
  try {
    await execFileAsync(
      'python3',
      ['-c', `
from PIL import Image, ImageOps
import sys
src, dst, max_size, quality = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
im = Image.open(src)
im = ImageOps.exif_transpose(im)
im.thumbnail((max_size, max_size))
if im.mode not in ("RGB", "L"):
    im = im.convert("RGB")
im.save(dst, "JPEG", quality=quality, optimize=True)
`, imagePath, tmpPath, String(maxSize), String(quality)],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    )
    return {
      path: fs.existsSync(tmpPath) ? tmpPath : imagePath,
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    }
  } catch (e) {
    console.warn(`[SearchIndex] 이미지 전처리 실패, 원본 사용: ${e.message}`)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    return { path: imagePath, cleanup: () => {} }
  }
}

async function ocrImageForSearch(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return ''
  const prepared = await prepareImageForSearch(imagePath, { maxSize: 2200, quality: 88 })
  try {
    const { stdout } = await execFileAsync(
      'tesseract',
      [prepared.path, 'stdout', '-l', 'eng+kor', '--psm', '6'],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
    )
    return String(stdout || '').replace(/\s+\n/g, '\n').trim()
  } catch (e) {
    console.warn(`[SearchIndex] 이미지 OCR 실패: ${e.message}`)
    return ''
  } finally {
    prepared.cleanup()
  }
}

function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

async function describeImageForSearch(imagePath, fileName = '') {
  if (!imagePath || !fs.existsSync(imagePath)) return ''
  const ocrText = await ocrImageForSearch(imagePath)
  const useVision = String(process.env.EASYDOC_IMAGE_VISION_ENRICH || '1').trim() === '1'
  if (!useVision) {
    return [
      '[OCR_TEXT]',
      ocrText || '',
      '[KEYWORDS]',
      `${fileName || ''} ${ocrText || ''}`.trim(),
    ].filter(Boolean).join('\n')
  }

  const prepared = await prepareImageForSearch(imagePath, { maxSize: 1400, quality: 82 })
  const imgB64 = fs.readFileSync(prepared.path).toString('base64')
  const model = String(process.env.EASYDOC_OCR_MODEL || config?.rag?.ocr_model || 'gemma4:e4b').trim()
  const payload = {
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content:
          'You are an OCR, image understanding, and search indexing engine. ' +
          'Extract every visible text exactly, especially product names, model numbers, abbreviations, labels, signs, and diagram terms. ' +
          'Also describe the visual scene in Korean so the image can be found even when it has no text. ' +
          'Mention people, objects, equipment, location type, actions, colors, safety context, and notable details. ' +
          'Do not omit English identifiers.',
      },
      {
        role: 'user',
        content:
          `Analyze this image for search indexing. File name: ${fileName || 'image'}.\n` +
          'Return sections: [EXACT_VISIBLE_TEXT], [VISUAL_DESCRIPTION_KO], [SEARCH_KEYWORDS].',
        images: [imgB64],
      },
    ],
    options: { temperature: 0 },
  }
  try {
    const res = await fetchWithTimeout(getOllamaChatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 90000)
    if (!res.ok) throw new Error(`Ollama image analysis failed: HTTP ${res.status}`)
    const data = await res.json().catch(() => ({}))
    const visionText = String(data?.message?.content || '').trim()
    return [
      '[OCR_TEXT]',
      ocrText || '',
      '[VISION_DESCRIPTION]',
      visionText || '',
    ].filter(Boolean).join('\n')
  } catch (e) {
    console.warn(`[SearchIndex] 이미지 Vision 분석 실패, OCR만 사용: ${e.message}`)
    return [
      '[OCR_TEXT]',
      ocrText || '',
      '[KEYWORDS]',
      `${fileName || ''} ${ocrText || ''}`.trim(),
    ].filter(Boolean).join('\n')
  } finally {
    prepared.cleanup()
  }
}

async function indexImageAttachmentForSearch({
  attachmentId,
  postId,
  commentId = '',
  channelId = '',
  authorId = null,
  securityLevel = 0,
  createdAt = new Date(),
  skipExistingVision = false,
}) {
  const id = String(attachmentId || '').trim()
  if (!id) return { indexed: false, reason: 'EMPTY_ATTACHMENT_ID' }
  const result = await db.query(
    'SELECT id, filename, content_type, storage_path FROM attachments WHERE id = $1 LIMIT 1',
    [id],
  )
  const attachment = result.rows?.[0]
  if (!attachment || !isImageSearchAttachment(attachment)) return { indexed: false, reason: 'NOT_IMAGE' }

  const imagePath = resolveStoragePathSafe(attachment.storage_path)
  if (!imagePath || !fs.existsSync(imagePath)) return { indexed: false, reason: 'FILE_NOT_FOUND' }

  const existingDoc = await db.query(
    'SELECT content FROM search_documents WHERE id = $1 LIMIT 1',
    [`image_attachment:${id}`],
  ).catch(() => ({ rows: [] }))
  const existingContent = String(existingDoc.rows?.[0]?.content || '').trim()
  const existingBody = existingContent.replace(/^이미지 첨부 검색 분석:[^\n]*(\n\n)?/, '').trim()
  const hasVisionDescription = /\[(VISION_DESCRIPTION|VISUAL_DESCRIPTION_KO)\]/.test(existingBody)
  if (skipExistingVision && existingBody && hasVisionDescription) {
    return { indexed: false, reason: 'VISION_EXISTS', attachmentId: id, fileName: attachment.filename || '' }
  }
  const caption = existingBody && hasVisionDescription
    ? existingBody
    : await describeImageForSearch(imagePath, attachment.filename)
  const content = [
    `이미지 첨부 검색 분석: ${attachment.filename || id}`,
    caption,
  ].filter(Boolean).join('\n\n')
  if (!caption.trim()) return { indexed: false, reason: 'EMPTY_CAPTION' }

  await upsertSearchDocument({
    sourceType: 'image_attachment',
    sourceId: id,
    postId,
    commentId,
    attachmentId: id,
    channelId,
    authorId,
    fileName: attachment.filename || '',
    content,
    securityLevel,
    createdAt,
  })
  return { indexed: true, attachmentId: id, fileName: attachment.filename || '' }
}

function indexImageAttachmentsForSearchAsync(items = []) {
  const jobs = (Array.isArray(items) ? items : []).filter(Boolean)
  if (jobs.length === 0) return
  ;(async () => {
    for (const item of jobs) {
      try {
        const result = await indexImageAttachmentForSearch(item)
        if (result.indexed) {
          console.log(`[SearchIndex] 이미지 첨부 인덱싱 완료: ${result.attachmentId} ${result.fileName}`)
        }
      } catch (e) {
        console.warn(`[SearchIndex] 이미지 첨부 인덱싱 실패: ${item?.attachmentId || ''} ${e.message}`)
      }
    }
  })()
}

async function recalcAttachmentRefCount(attachmentIds = []) {
  const ids = uniqAttachmentIds(attachmentIds)
  if (ids.length === 0) return
  await ensureAttachmentRefTable()
  for (const attachmentId of ids) {
    const countRes = await db.query('SELECT COUNT(*)::int AS cnt FROM attachment_refs WHERE attachment_id = $1', [attachmentId])
    const cnt = Number(countRes.rows?.[0]?.cnt || 0)
    await db.query(
      `UPDATE attachments
       SET ref_count = $2,
           delete_status = CASE WHEN $2 > 0 THEN 'active' ELSE delete_status END
       WHERE id = $1`,
      [attachmentId, cnt],
    )
  }
}

async function syncAttachmentRefs({ ownerType, ownerId, nextAttachmentIds = [], actorUserId = '' }) {
  await ensureAttachmentRefTable()
  const safeOwnerType = String(ownerType || '').trim()
  const safeOwnerId = String(ownerId || '').trim()
  if (!safeOwnerType || !safeOwnerId) return

  const nextIds = uniqAttachmentIds(nextAttachmentIds)
  const existingRes = await db.query(
    'SELECT attachment_id FROM attachment_refs WHERE owner_type = $1 AND owner_id = $2',
    [safeOwnerType, safeOwnerId],
  )
  const prevIds = uniqAttachmentIds(existingRes.rows.map((r) => r.attachment_id))
  const prevSet = new Set(prevIds)
  const nextSet = new Set(nextIds)
  const toAdd = nextIds.filter((id) => !prevSet.has(id))
  const toRemove = prevIds.filter((id) => !nextSet.has(id))

  for (const attachmentId of toAdd) {
    await db.query(
      `INSERT INTO attachment_refs (attachment_id, owner_type, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (attachment_id, owner_type, owner_id) DO NOTHING`,
      [attachmentId, safeOwnerType, safeOwnerId],
    )
  }
  for (const attachmentId of toRemove) {
    await db.query(
      'DELETE FROM attachment_refs WHERE attachment_id = $1 AND owner_type = $2 AND owner_id = $3',
      [attachmentId, safeOwnerType, safeOwnerId],
    )
  }

  await recalcAttachmentRefCount([...toAdd, ...toRemove])
  console.log(
    `[ATTACH-REF] sync ownerType=${safeOwnerType} ownerId=${safeOwnerId} actorUserId=${actorUserId || ''} ` +
    `prev=${prevIds.length} next=${nextIds.length} add=${toAdd.length} remove=${toRemove.length}`,
  )
}

async function isAttachmentReferencedElsewhere(attachmentId, { excludedPostId = '', excludedCommentId = '' } = {}) {
  const id = String(attachmentId || '').trim()
  if (!id) return false

  // PostgreSQL: posts reference check
  const postRef = await db.query(
    `SELECT id
     FROM posts
     WHERE id <> $2
       AND $1 IN (
         attachments_1, attachments_2, attachments_3, attachments_4, attachments_5,
         attachments_6, attachments_7, attachments_8, attachments_9, attachments_10
       )
     LIMIT 1`,
    [id, String(excludedPostId || '')],
  )
  if (postRef.rowCount > 0) return true

  // PostgreSQL: comments reference check
  const commentRef = await db.query(
    `SELECT id
     FROM comments c
     WHERE c.id <> $2
       AND EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(COALESCE(c.attachments, '[]'::jsonb)) AS e(v)
         WHERE e.v = $1
       )
     LIMIT 1`,
    [id, String(excludedCommentId || '')],
  )
  if (commentRef.rowCount > 0) return true

  // Cassandra: comments list<text> contains check
  if (isConnected()) {
    try {
      const cassCommentRef = await client.execute(
        'SELECT id FROM comments WHERE attachments CONTAINS ? ALLOW FILTERING',
        [id], { prepare: true },
      )
      const hit = (cassCommentRef.rows || []).some((r) => String(r.id || '') !== String(excludedCommentId || ''))
      if (hit) return true
    } catch (_) {}

    // Cassandra: posts attachments_N check
    const cols = [
      'attachments_1', 'attachments_2', 'attachments_3', 'attachments_4', 'attachments_5',
      'attachments_6', 'attachments_7', 'attachments_8', 'attachments_9', 'attachments_10',
    ]
    for (const col of cols) {
      try {
        const cassPostRef = await client.execute(
          `SELECT id FROM posts WHERE ${col} = ? ALLOW FILTERING`,
          [id], { prepare: true },
        )
        const hit = (cassPostRef.rows || []).some((r) => String(r.id || '') !== String(excludedPostId || ''))
        if (hit) return true
      } catch (_) {}
    }
  }

  return false
}

async function deleteAttachmentPhysicalAndRecords(attachmentId, { excludedPostId = '', excludedCommentId = '' } = {}) {
  const id = String(attachmentId || '').trim()
  if (!id) return { deleted: false, reason: 'EMPTY_ID' }
  await ensureAttachmentRefTable()

  const refRes = await db.query('SELECT COUNT(*)::int AS cnt FROM attachment_refs WHERE attachment_id = $1', [id])
  const refCount = Number(refRes.rows?.[0]?.cnt || 0)
  if (refCount > 0) {
    await db.query(
      "UPDATE attachments SET ref_count = $2, delete_status = 'active' WHERE id = $1",
      [id, refCount],
    ).catch(() => {})
    return { deleted: false, reason: 'STILL_REFERENCED' }
  }

  await db.query(
    "UPDATE attachments SET delete_status = 'deleting', delete_requested_at = NOW() WHERE id = $1",
    [id],
  ).catch(() => {})
  const inUse = await isAttachmentReferencedElsewhere(id, { excludedPostId, excludedCommentId })
  if (inUse) {
    await db.query(
      "UPDATE attachments SET delete_status = 'active' WHERE id = $1",
      [id],
    ).catch(() => {})
    return { deleted: false, reason: 'STILL_REFERENCED' }
  }

  const pgMeta = await db.query(
    'SELECT id, storage_path, thumbnail_path FROM attachments WHERE id = $1 LIMIT 1',
    [id],
  )
  const meta = pgMeta.rows?.[0] || null

  if (meta) {
    const filePath = resolveStoragePathSafe(meta.storage_path)
    const thumbPath = resolveStoragePathSafe(meta.thumbnail_path)
    const fileDir = filePath ? path.dirname(filePath) : null
    const scopedAttachmentDir = resolveAttachmentScopedDir(meta.storage_path)
    const baseName = filePath ? path.basename(filePath, path.extname(filePath)) : ''

    const artifactNames = [
      `${baseName}.rttm`,
      `${baseName}.txt`,
      `${baseName}.diarization.log`,
      `${baseName}.diarization.bridge.log`,
      `${baseName}.json`,
      `${baseName}.srt`,
      `${baseName}.vtt`,
    ]

    const safeDelete = (targetPath) => {
      if (!targetPath) return
      const safePath = resolveStoragePathSafe(path.relative(STORAGE_BASE_ABS, targetPath))
      if (!safePath) return
      if (fs.existsSync(safePath)) {
        try { fs.unlinkSync(safePath) } catch (_) {}
      }
    }

    if (filePath && fs.existsSync(filePath)) {
      safeDelete(filePath)
    }
    if (thumbPath && fs.existsSync(thumbPath)) {
      safeDelete(thumbPath)
    }

    if (scopedAttachmentDir && scopedAttachmentDir.startsWith(`${STORAGE_BASE_ABS}${path.sep}`)) {
      try {
        fs.rmSync(scopedAttachmentDir, { recursive: true, force: true })
      } catch (_) {}
    } else if (fileDir && fileDir.startsWith(`${STORAGE_BASE_ABS}${path.sep}`)) {
      for (const name of artifactNames) {
        safeDelete(path.join(fileDir, name))
      }

      try {
        const remaining = fs.readdirSync(fileDir).filter((name) => name !== '.' && name !== '..')
        if (remaining.length === 0) {
          fs.rmdirSync(fileDir)
        }
      } catch (_) {}
    }
  }

  await db.query('DELETE FROM attachment_refs WHERE attachment_id = $1', [id]).catch(() => {})
  await db.query('DELETE FROM attachments WHERE id = $1', [id])
  if (isConnected()) {
    try { await client.execute('DELETE FROM attachments WHERE id = ?', [id], { prepare: true }) } catch (_) {}
  }
  return { deleted: true, reason: 'OK' }
}

async function ensurePostPinTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS post_pins (
      post_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      pinned BOOLEAN NOT NULL DEFAULT false,
      pinned_at TIMESTAMPTZ NULL,
      pinned_by TEXT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query('CREATE INDEX IF NOT EXISTS idx_post_pins_channel_id ON post_pins(channel_id)')
}

async function getPinnedMapByChannel(channelId) {
  await ensurePostPinTable()
  const r = await db.query(
    `SELECT post_id, pinned, pinned_at, pinned_by
     FROM post_pins
     WHERE channel_id = $1`,
    [String(channelId)],
  )
  const map = new Map()
  for (const row of r.rows || []) {
    map.set(String(row.post_id), {
      pinned: Boolean(row.pinned),
      pinned_at: row.pinned_at || null,
      pinned_by: row.pinned_by || null,
    })
  }
  return map
}

async function ensureLikeTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS comment_likes (
      comment_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (comment_id, user_id)
    )
  `)
  await db.query('CREATE INDEX IF NOT EXISTS idx_post_likes_post_id ON post_likes(post_id)')
  await db.query('CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON comment_likes(comment_id)')
}

async function getPostLikeMap(postIds = [], userId = null) {
  const ids = [...new Set((postIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  const map = new Map(ids.map((id) => [id, { likeCount: 0, likedByMe: false }]))
  if (ids.length === 0) return map
  await ensureLikeTables()
  const countRes = await db.query(
    `SELECT post_id, COUNT(*)::int AS like_count
     FROM post_likes
     WHERE post_id = ANY($1)
     GROUP BY post_id`,
    [ids],
  )
  for (const row of countRes.rows || []) {
    const key = String(row.post_id)
    map.set(key, { ...(map.get(key) || {}), likeCount: Number(row.like_count || 0) })
  }
  if (userId) {
    const myRes = await db.query(
      'SELECT post_id FROM post_likes WHERE post_id = ANY($1) AND user_id = $2',
      [ids, userId],
    )
    for (const row of myRes.rows || []) {
      const key = String(row.post_id)
      map.set(key, { ...(map.get(key) || {}), likedByMe: true })
    }
  }
  return map
}

async function getCommentLikeMap(commentIds = [], userId = null) {
  const ids = [...new Set((commentIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  const map = new Map(ids.map((id) => [id, { likeCount: 0, likedByMe: false }]))
  if (ids.length === 0) return map
  await ensureLikeTables()
  const countRes = await db.query(
    `SELECT comment_id, COUNT(*)::int AS like_count
     FROM comment_likes
     WHERE comment_id = ANY($1)
     GROUP BY comment_id`,
    [ids],
  )
  for (const row of countRes.rows || []) {
    const key = String(row.comment_id)
    map.set(key, { ...(map.get(key) || {}), likeCount: Number(row.like_count || 0) })
  }
  if (userId) {
    const myRes = await db.query(
      'SELECT comment_id FROM comment_likes WHERE comment_id = ANY($1) AND user_id = $2',
      [ids, userId],
    )
    for (const row of myRes.rows || []) {
      const key = String(row.comment_id)
      map.set(key, { ...(map.get(key) || {}), likedByMe: true })
    }
  }
  return map
}

// ─── Telegram mention 알림 ────────────────────────────────────
function extractMentions(content) {
  const source = String(content || '')
  const separator = '\u2063'
  const escapedSep = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const names = new Set()
  const addName = (raw) => {
    const n = String(raw || '')
      .replaceAll(separator, '')
      .replace(/[.,!?;:)\]]+$/g, '')
      .trim()
    if (n) names.add(n.toLowerCase())
  }

  const sepMatches = source.matchAll(new RegExp(`@([^@\\n${escapedSep}]+)${escapedSep}`, 'g'))
  for (const m of sepMatches) {
    addName(m[1])
  }

  // Backward compatibility: @name 형태도 함께 처리
  const legacyMatches = source.matchAll(/@([^\s@]+)/g)
  for (const m of legacyMatches) {
    addName(m[1])
  }

  return [...names]
}

async function notifyMentionedUsers(content, { channelId = '', postId = '', commentId = '', attachmentIds = [] } = {}) {
  const names = extractMentions(content)
  if (names.length === 0) return
  try {
    const configPath = path.resolve(__dirname, '../../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

    // 전역 텔레그램 봇이 비활성화되어 있으면 전송하지 않는다
    if (!config?.sns?.telegram?.enabled) return
    const botToken = config?.sns?.telegram?.httpApiToken?.trim()
    if (!botToken) return

    const siteUrl = String(config?.site_url || '').trim()
    const postLink = (channelId && postId) ? buildPostLink(channelId, postId, commentId, siteUrl) : ''
    // 게시물/댓글 알림에는 본문 앞 5줄을 함께 보낸다.
    const preview = buildPostNotifyPreview(content)
    const text = ['게시물이 등록되었습니다.', preview, postLink].filter(Boolean).join('\n\n')

    for (const name of names) {
      const r = await db.query(
        `SELECT telegram_id, use_sns_channel FROM users
         WHERE (
           LOWER(COALESCE(display_name, '')) = LOWER($1)
           OR LOWER(COALESCE(name, '')) = LOWER($1)
           OR LOWER(COALESCE(username, '')) = LOWER($1)
         )
           AND is_active = true
         LIMIT 1`,
        [name],
      )
      const user = r.rows[0]
      if (!user) continue
      if (String(user.use_sns_channel || '').trim() !== 'telegram') continue

      // 숫자형 telegram_id 가 등록된 사용자 = 텔레그램 활성화 상태
      const chatId = (user.telegram_id || '').trim()
      if (!/^-?[0-9]+$/.test(chatId)) continue

      await sendTelegramPostNotify(botToken, chatId, text, attachmentIds)
    }
  } catch (e) {
    console.error('[notifyMentionedUsers]', e)
  }
}

// 게시물/댓글 알림에 함께 보낼 본문 미리보기(앞 5줄).
//  - HTML 주석/캐리지리턴 정리, 앞뒤 빈 줄 제거 후 내용 있는 줄부터 최대 5줄
//  - 5줄을 넘거나 글자수 상한(기본 600자)을 넘으면 끝에 '…' 표시
function buildPostNotifyPreview(content = '', maxLines = 5, maxChars = 600) {
  const cleaned = String(content || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n?/g, '\n')
  const allLines = cleaned.split('\n')
  let start = 0
  while (start < allLines.length && allLines[start].trim() === '') start++
  const body = allLines.slice(start)
  while (body.length && body[body.length - 1].trim() === '') body.pop()
  if (body.length === 0) return ''
  const picked = body.slice(0, maxLines).map((l) => l.replace(/\s+$/, ''))
  let preview = picked.join('\n')
  let truncated = body.length > maxLines
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars).trimEnd()
    truncated = true
  }
  if (truncated) preview += ' …'
  return preview
}

function buildPostLink(channelId, postId, commentId = '', siteUrl = '') {
  const base = String(siteUrl || process.env.CLIENT_ORIGIN || 'http://localhost:5173').replace(/\/+$/, '')
  const params = new URLSearchParams({
    channelId: String(channelId || ''),
    postId: String(postId || ''),
  })
  if (commentId) params.set('commentId', String(commentId))
  return `${base}/?${params.toString()}`
}

// 알림에 함께 보낼 미리보기 파일을 찾는다.
//  - 이미지 첨부: 원본 이미지를 보냄(우선)
//  - 그 외(PPT·PDF·오피스 등): 생성된 썸네일 PNG(첫 페이지/슬라이드)를 보냄
//  - 보낼 미리보기가 없으면 null
async function resolveNotifyPreviewFile(attachmentIds = []) {
  const ids = (attachmentIds || [])
    .map((it) => (typeof it === 'object' ? it?.id : it))
    .filter(Boolean)
  let fallbackThumb = null
  for (const id of ids) {
    try {
      const r = await db.query(
        'SELECT filename, storage_path, content_type, thumbnail_path FROM attachments WHERE id = $1',
        [id],
      )
      const a = r.rows?.[0]
      if (!a) continue

      const isImage = String(a.content_type || '').toLowerCase().startsWith('image/')
        || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename || '')
      if (isImage && a.storage_path) {
        const full = path.join(STORAGE_BASE, a.storage_path)
        if (fs.existsSync(full)) return { full, filename: a.filename || 'image' } // 이미지 원본 우선
      }

      // 이미지가 아니어도 썸네일(PPT 첫 슬라이드/PDF 첫 페이지/오피스 등)이 있으면 후보로 저장
      if (!fallbackThumb && a.thumbnail_path) {
        const tfull = path.join(STORAGE_BASE, a.thumbnail_path)
        if (fs.existsSync(tfull)) {
          const base = (a.filename || 'preview').replace(/\.[^.]+$/, '')
          fallbackThumb = { full: tfull, filename: `${base}.png` }
        }
      }
    } catch (_) { /* 다음 첨부 시도 */ }
  }
  return fallbackThumb
}

// 텔레그램 게시물 알림 발송:
//  - 이미지 첨부가 있으면 sendPhoto 로 미리보기 이미지를 caption(링크 포함)과 함께 전송
//  - 이미지가 없거나 전송 실패(용량 초과 등) 시 sendMessage 로 폴백
async function sendTelegramPostNotify(botToken, chatId, text, attachmentIds = []) {
  try {
    const img = await resolveNotifyPreviewFile(attachmentIds)
    if (img) {
      const buf = await fs.promises.readFile(img.full)
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append('caption', text)
      form.append('photo', new Blob([buf]), img.filename)
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        body: form,
      })
      const data = await res.json().catch(() => ({}))
      if (data?.ok) return
    }
  } catch (_) { /* 텍스트 폴백 */ }
  fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {})
}

async function notifyAuthorTelegramPostRegistered({ authorId, channelId, postId, commentId = '', attachmentIds = [], content = '' }) {
  if (!authorId || !channelId || !postId) return
  try {
    const configPath = path.resolve(__dirname, '../../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (!config?.sns?.telegram?.enabled) return

    const botToken = String(config?.sns?.telegram?.httpApiToken || '').trim()
    if (!botToken) return

    const userRes = await db.query(
      `SELECT telegram_id, use_sns_channel, is_active
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [authorId],
    )
    const u = userRes.rows?.[0]
    if (!u?.is_active) return
    if (String(u.use_sns_channel || '').trim() !== 'telegram') return

    const chatId = String(u.telegram_id || '').trim()
    // 숫자형 chat_id가 등록된 경우를 "활성"으로 본다.
    if (!/^-?[0-9]+$/.test(chatId)) return

    const siteUrl = String(config?.site_url || '').trim()
    const postLink = buildPostLink(channelId, postId, commentId, siteUrl)
    // 게시물/댓글 알림에는 본문 앞 5줄을 함께 보낸다.
    const preview = buildPostNotifyPreview(content)
    const text = ['게시물이 등록되었습니다.', preview, postLink].filter(Boolean).join('\n\n')

    await sendTelegramPostNotify(botToken, chatId, text, attachmentIds)
  } catch (e) {
    console.error('[notifyAuthorTelegramPostRegistered]', e)
  }
}

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
async function fetchComments(postId, userContext = null, opts = {}) {
  const userId = typeof userContext === 'object' ? userContext?.id : userContext
  const currentUser = typeof userContext === 'object' ? userContext : null
  const deletedCommentIds = await getDeletedItemIdSet('comment', { postId })
  // 채널 단위 배치 컨텍스트(작성자 캐시 + 멤버십)를 상위에서 받거나 직접 생성한다.
  // 한 글의 댓글은 모두 같은 채널이므로 멤버십은 글당 1회만 계산하면 된다.
  const userCache = opts.userCache || makeUserCache()
  let permissionCtx = opts.permissionCtx || null
  // 한 글의 댓글은 모두 같은 채널이므로 멤버십은 글당 1회만 계산한다.
  // 댓글 행에 channel_id 가 있으면 그것을 쓰고, 없을 때만(레거시) 글에서 1회 보강한다.
  const ensurePermissionCtx = async (rows = []) => {
    if (permissionCtx || !currentUser) return permissionCtx
    const channelId = rows.find(r => r.channel_id)?.channel_id
      || await resolveChannelIdForPost(postId?.toString?.() || postId)
    permissionCtx = await buildChannelPermissionContext(currentUser, channelId)
    return permissionCtx
  }
  // ── Cassandra path ──────────────────────────────────────────
  if (isConnected()) {
    try {
      const result = await client.execute(
        'SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC',
        [postId], { prepare: true }
      )

      const visibleRows = (result.rows || []).filter(row => !deletedCommentIds.has(String(row.id)))
      const commentLikeMap = await getCommentLikeMap(visibleRows.map(row => row.id), userId)
      await ensurePermissionCtx(visibleRows)
      return Promise.all(visibleRows.map(async row => {
        const author = (await userCache.get(row.author_id))
          || { id: null, name: '알 수 없음', username: 'unknown', image_url: null }
        const avatarLetters = author.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
        const attachments = await enrichAttachments(row.attachments || [])

        const likeInfo = commentLikeMap.get(String(row.id)) || { likeCount: 0, likedByMe: false }
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
            image_url: compactListImageUrl(author.image_url),
          },
          createdAt: row.created_at,
          updatedAt: row.created_at, // Cassandra comments table doesn't have updated_at yet
          likeCount: likeInfo.likeCount || 0,
          likedByMe: Boolean(likeInfo.likedByMe),
          can_edit: currentUser ? canMutateWithContext(permissionCtx, author) : false,
          ...getTrainingStatus('comment', row.id),
        }
      }))
    } catch (err) {
      console.error('[Cassandra] 댓글 조회 오류:', err.message)
      // fallback to postgres
    }
  }

  // ── PostgreSQL fallback ─────────────────────────────────────
  const result = await db.query(`
    SELECT c.*, u.name AS author_name, u.username, u.image_url,
           u.role AS author_role, u.security_level AS author_security_level
    FROM comments c
    JOIN users u ON c.author_id = u.id
    WHERE c.post_id = $1
    ORDER BY c.created_at ASC
  `, [postId])

  const visibleRows = (result.rows || []).filter(row => !deletedCommentIds.has(String(row.id)))
  const commentLikeMap = await getCommentLikeMap(visibleRows.map(row => row.id), userId)
  await ensurePermissionCtx(visibleRows)
  return Promise.all(visibleRows.map(async row => {
    const avatarLetters = row.author_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    const attachments = await enrichAttachments(row.attachments || [])
    const likeInfo = commentLikeMap.get(String(row.id)) || { likeCount: 0, likedByMe: false }
    const authorRecord = {
      id: row.author_id,
      role: row.author_role,
      security_level: row.author_security_level,
    }
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
      likeCount: likeInfo.likeCount || 0,
      likedByMe: Boolean(likeInfo.likedByMe),
      can_edit: currentUser ? canMutateWithContext(permissionCtx, authorRecord) : false,
      ...getTrainingStatus('comment', row.id),
    }
  }))
}

function isAfterLastRead(createdAt, lastReadAt) {
  if (!createdAt) return false
  if (!lastReadAt) return true
  return new Date(createdAt).getTime() > new Date(lastReadAt).getTime()
}

function buildUnreadMeta({ postCreatedAt, postAuthorId, comments = [], userId, lastReadAt }) {
  const isOwnPost = String(postAuthorId) === String(userId)
  const unreadPost = !isOwnPost && isAfterLastRead(postCreatedAt, lastReadAt)
  const unreadComments = comments.filter(comment => (
    String(comment?.author?.id) !== String(userId)
    && isAfterLastRead(comment?.createdAt, lastReadAt)
  ))
  const unreadTimes = [
    unreadPost ? postCreatedAt : null,
    ...unreadComments.map(comment => comment.createdAt),
  ].filter(Boolean)
  const unreadActivityAt = unreadTimes.length > 0
    ? new Date(Math.max(...unreadTimes.map(value => new Date(value).getTime()))).toISOString()
    : null

  return {
    isUnread: unreadPost || unreadComments.length > 0,
    unreadPost,
    unreadCommentCount: unreadComments.length,
    unreadActivityAt,
  }
}

async function findPostLocator(postId) {
  const byId = await client.execute(
    'SELECT channel_id, created_at, author_id FROM posts_by_id WHERE id = ?',
    [postId], { prepare: true }
  )
  if (byId.rows.length > 0) return byId.rows[0]

  // Legacy data can exist in posts without posts_by_id lookup row.
  const legacy = await client.execute(
    'SELECT channel_id, created_at, author_id FROM posts WHERE id = ? ALLOW FILTERING',
    [postId], { prepare: true }
  )
  if (legacy.rows.length === 0) return null

  const row = legacy.rows[0]
  // Self-heal lookup row for future update/delete calls.
  await client.execute(
    'INSERT INTO posts_by_id (id, channel_id, created_at, author_id) VALUES (?, ?, ?, ?)',
    [postId, row.channel_id, row.created_at, row.author_id], { prepare: true }
  )
  return row
}

async function findCommentLocator(postId, commentId) {
  const byId = await client.execute(
    'SELECT post_id, created_at, author_id FROM comments_by_id WHERE id = ?',
    [commentId], { prepare: true }
  )
  if (byId.rows.length > 0) return byId.rows[0]

  // Legacy data can exist in comments without comments_by_id lookup row.
  const legacy = await client.execute(
    'SELECT post_id, created_at, author_id FROM comments WHERE post_id = ? AND id = ? ALLOW FILTERING',
    [postId, commentId], { prepare: true }
  )
  if (legacy.rows.length === 0) return null

  const row = legacy.rows[0]
  // Self-heal lookup row for future update/delete calls.
  await client.execute(
    'INSERT INTO comments_by_id (id, post_id, created_at, author_id) VALUES (?, ?, ?, ?)',
    [commentId, row.post_id, row.created_at, row.author_id], { prepare: true }
  )
  return row
}

// ─── 소프트 삭제(휴지통, 1분 내 복구) ─────────────────────────────
// 원본 행(Cassandra/PG)은 건드리지 않고 deleted_items 에만 "삭제 표시"를 기록한다.
//  · 라이브 조회(목록/댓글)는 deleted_items 를 참조해 숨긴다.
//  · 복구는 deleted_items 행만 지우면 원본이 그대로 다시 보인다.
//  · 1분이 지난 항목은 백그라운드 purge 가 기존 하드삭제 로직으로 영구 제거한다.
const RESTORE_WINDOW_MS = 1 * 60 * 1000

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

function buildPreview(content = '', max = 80) {
  return String(content || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

// 특정 범위에서 현재 소프트삭제(숨김) 상태인 항목 id 집합을 돌려준다.
async function getDeletedItemIdSet(itemType, { channelId = null, postId = null } = {}) {
  try {
    await ensureSoftDeleteSchema()
    let q
    let params
    if (postId != null) {
      q = 'SELECT item_id FROM deleted_items WHERE item_type = $1 AND post_id = $2'
      params = [itemType, String(postId)]
    } else if (channelId != null) {
      q = 'SELECT item_id FROM deleted_items WHERE item_type = $1 AND channel_id = $2'
      params = [itemType, String(channelId)]
    } else {
      q = 'SELECT item_id FROM deleted_items WHERE item_type = $1'
      params = [itemType]
    }
    const r = await db.query(q, params)
    return new Set((r.rows || []).map((x) => String(x.item_id)))
  } catch (_) {
    return new Set()
  }
}

async function resolveChannelIdForPost(postId) {
  if (isConnected()) {
    const locator = await findPostLocator(postId)
    return locator?.channel_id ? String(locator.channel_id) : ''
  }
  const row = await db.query('SELECT channel_id FROM posts WHERE id = $1', [postId])
  return row.rows[0]?.channel_id ? String(row.rows[0].channel_id) : ''
}

// ─── GET /api/posts/search ────────────────────────────────────
router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const { q } = req.query
    if (!q) return res.status(400).json({ error: 'Search query is required' })

    try {
      const results = await postSearchService.exactSearch({
        query: String(q),
        user: req.user,
        limit: req.query.limit || 50,
        currentChannelId: req.query.current_channel_id || '',
        currentTeamId: req.query.current_team_id || '',
      })
      return res.json(results)
    } catch (pgErr) {
      console.warn('[SearchIndex] PostgreSQL 검색 실패, Cassandra 검색으로 fallback:', pgErr.message)
    }

    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })

    const lower = q.toLowerCase()
    const currentChannelId = String(req.query.current_channel_id || '').trim()
    const currentTeamId = String(req.query.current_team_id || '').trim()
    const [allPostsResult, allCommentsResult] = await Promise.all([
      client.execute('SELECT * FROM posts ALLOW FILTERING', [], { prepare: true }),
      client.execute('SELECT * FROM comments ALLOW FILTERING', [], { prepare: true }),
    ])

    const matchedPostsRaw = allPostsResult.rows.filter(r => r.id != null && r.content && r.content.toLowerCase().includes(lower))
    const matchedCommentsRaw = allCommentsResult.rows.filter(r => r.id != null && r.content && r.content.toLowerCase().includes(lower))
    if (matchedPostsRaw.length === 0 && matchedCommentsRaw.length === 0) return res.json([])

    const postMap = new Map(allPostsResult.rows.filter(p => p.id != null).map(p => [p.id.toString(), p]))
    const channelIds = new Set([
      ...matchedPostsRaw.map(p => p.channel_id),
      ...matchedCommentsRaw.map(c => {
        const post = postMap.get(c.post_id.toString())
        return post ? post.channel_id : null
      }).filter(Boolean),
    ])
    const accessibleChannelIds = new Set(await getAccessibleChannelIds(db, req.user, [...channelIds]))
    const matchedPosts = matchedPostsRaw.filter(p => accessibleChannelIds.has(p.channel_id))
    const matchedComments = matchedCommentsRaw.filter(c => {
      const post = postMap.get(c.post_id.toString())
      return post && accessibleChannelIds.has(post.channel_id)
    })
    if (matchedPosts.length === 0 && matchedComments.length === 0) return res.json([])
    const authorIds = new Set([...matchedPosts.map(p => p.author_id), ...matchedComments.map(c => c.author_id)])
    const [channelsRes, usersRes] = await Promise.all([
      db.query(
        `SELECT c.id, c.name, c.team_id, t.name AS team_name
         FROM channels c JOIN teams t ON c.team_id = t.id
         WHERE c.id = ANY($1)`,
        [[...channelIds]]
      ),
      db.query('SELECT id, name, username, image_url FROM users WHERE id = ANY($1)', [[...authorIds]]),
    ])
    const channelMap = new Map(channelsRes.rows.map(c => [c.id, c]))
    const userMap = new Map(usersRes.rows.map(u => [u.id, u]))
    const makeAuthor = (authorId) => {
      const u = userMap.get(authorId) || { id: null, name: '알 수 없음', username: 'unknown', image_url: null }
      return { id: u.id, name: u.name, username: u.username, image_url: u.image_url }
    }
    const postResults = matchedPosts.map(row => {
      const ch = channelMap.get(row.channel_id) || {}
      return {
        type: 'post',
        id: row.id.toString(),
        postId: row.id.toString(),
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
      const ch = post ? (channelMap.get(post.channel_id) || {}) : {}
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
    const nowMs = Date.now()
    const priorityScore = (item) => {
      const createdMs = new Date(item.createdAt || 0).getTime()
      const ageDays = Number.isFinite(createdMs) && createdMs > 0 ? Math.max(0, (nowMs - createdMs) / 86400000) : 365
      const recentBonus = Math.exp(-ageDays / 30)
      const channelBonus = currentChannelId && item.channelId === currentChannelId ? 0.4 : 0
      const teamBonus = currentTeamId && (channelMap.get(item.channelId)?.team_id || '') === currentTeamId ? 0.2 : 0
      return recentBonus + channelBonus + teamBonus
    }
    res.json([...postResults, ...commentResults].sort((a, b) => priorityScore(b) - priorityScore(a)))
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/posts/search-index/rebuild ─────────────────────
router.post('/search-index/rebuild', requireAuth, async (req, res, next) => {
  try {
    if (req.user?.role !== 'site_admin') return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    await ensureSearchIndexSchema()
    await db.query("DELETE FROM search_documents WHERE source_type IN ('post', 'comment')")

    let indexedPosts = 0
    let indexedComments = 0

    if (isConnected()) {
      const [postsRes, commentsRes] = await Promise.all([
        client.execute('SELECT id, channel_id, author_id, content, security_level, created_at FROM posts ALLOW FILTERING', [], { prepare: true }),
        client.execute('SELECT id, post_id, author_id, content, security_level, created_at FROM comments ALLOW FILTERING', [], { prepare: true }),
      ])
      const postMap = new Map((postsRes.rows || []).filter(p => p.id).map(p => [String(p.id), p]))
      for (const row of postsRes.rows || []) {
        if (!row.id || !row.channel_id) continue
        await upsertSearchDocument({
          sourceType: 'post',
          sourceId: String(row.id),
          postId: String(row.id),
          channelId: String(row.channel_id),
          authorId: row.author_id,
          content: row.content || '',
          securityLevel: row.security_level ?? 0,
          createdAt: row.created_at || new Date(),
        })
        indexedPosts += 1
      }
      for (const row of commentsRes.rows || []) {
        const post = postMap.get(String(row.post_id || ''))
        if (!row.id || !post?.channel_id) continue
        await upsertSearchDocument({
          sourceType: 'comment',
          sourceId: String(row.id),
          postId: String(row.post_id),
          channelId: String(post.channel_id),
          authorId: row.author_id,
          content: row.content || '',
          securityLevel: row.security_level ?? 0,
          createdAt: row.created_at || new Date(),
        })
        indexedComments += 1
      }
    } else {
      const [postsRes, commentsRes] = await Promise.all([
        db.query('SELECT id, channel_id, author_id, content, security_level, created_at FROM posts'),
        db.query('SELECT id, post_id, channel_id, author_id, content, security_level, created_at FROM comments'),
      ])
      for (const row of postsRes.rows || []) {
        await upsertSearchDocument({
          sourceType: 'post',
          sourceId: row.id,
          postId: row.id,
          channelId: row.channel_id,
          authorId: row.author_id,
          content: row.content || '',
          securityLevel: row.security_level ?? 0,
          createdAt: row.created_at || new Date(),
        })
        indexedPosts += 1
      }
      for (const row of commentsRes.rows || []) {
        await upsertSearchDocument({
          sourceType: 'comment',
          sourceId: row.id,
          postId: row.post_id,
          channelId: row.channel_id,
          authorId: row.author_id,
          content: row.content || '',
          securityLevel: row.security_level ?? 0,
          createdAt: row.created_at || new Date(),
        })
        indexedComments += 1
      }
    }

    res.json({ success: true, indexedPosts, indexedComments })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/posts/search-index/rebuild-images ──────────────
router.post('/search-index/rebuild-images', requireAuth, async (req, res, next) => {
  try {
    if (req.user?.role !== 'site_admin') return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    await ensureSearchIndexSchema()
    await ensureAttachmentRefTable().catch(() => {})
    const requestedAttachmentId = String(req.body?.attachmentId || req.query?.attachmentId || '').trim()
    const requestedPostId = String(req.body?.postId || req.query?.postId || '').trim()
    const requestedCommentId = String(req.body?.commentId || req.query?.commentId || '').trim()
    const requestedLimit = Number.parseInt(req.body?.limit || req.query?.limit || '0', 10)
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 0
    const force = String(req.body?.force || req.query?.force || '').trim() === '1'

    const ownerByAttachmentId = new Map()
    if (isConnected()) {
      const [postsRes, commentsRes] = await Promise.all([
        client.execute('SELECT id, channel_id, author_id, security_level, created_at, attachments_1, attachments_2, attachments_3, attachments_4, attachments_5, attachments_6, attachments_7, attachments_8, attachments_9, attachments_10 FROM posts ALLOW FILTERING', [], { prepare: true }),
        client.execute('SELECT id, post_id, author_id, security_level, created_at, attachments FROM comments ALLOW FILTERING', [], { prepare: true }),
      ])
      const postMap = new Map((postsRes.rows || []).filter(p => p.id).map(p => [String(p.id), p]))
      for (const post of postsRes.rows || []) {
        const postId = String(post.id || '')
        if (!postId) continue
        for (const attachmentId of extractPostAttachmentIds(post)) {
          ownerByAttachmentId.set(attachmentId, {
            attachmentId,
            postId,
            commentId: '',
            channelId: String(post.channel_id || ''),
            authorId: post.author_id,
            securityLevel: post.security_level ?? 0,
            createdAt: post.created_at || new Date(),
          })
        }
      }
      for (const comment of commentsRes.rows || []) {
        const post = postMap.get(String(comment.post_id || ''))
        if (!post?.channel_id) continue
        for (const attachmentId of toAttachmentIdArray(comment.attachments || [])) {
          ownerByAttachmentId.set(attachmentId, {
            attachmentId,
            postId: String(comment.post_id || ''),
            commentId: String(comment.id || ''),
            channelId: String(post.channel_id || ''),
            authorId: comment.author_id,
            securityLevel: comment.security_level ?? 0,
            createdAt: comment.created_at || new Date(),
          })
        }
      }
    }

    const [pgPostsRes, pgCommentsRes] = await Promise.all([
      db.query(
        `SELECT id, channel_id, author_id, security_level, created_at,
                attachments_1, attachments_2, attachments_3, attachments_4, attachments_5,
                attachments_6, attachments_7, attachments_8, attachments_9, attachments_10
         FROM posts`,
      ).catch(() => ({ rows: [] })),
      db.query(
        `SELECT id, post_id, channel_id, author_id, security_level, created_at, attachments
         FROM comments`,
      ).catch(() => ({ rows: [] })),
    ])
    for (const post of pgPostsRes.rows || []) {
      const postId = String(post.id || '')
      if (!postId) continue
      for (const attachmentId of extractPostAttachmentIds(post)) {
        if (ownerByAttachmentId.has(attachmentId)) continue
        ownerByAttachmentId.set(attachmentId, {
          attachmentId,
          postId,
          commentId: '',
          channelId: String(post.channel_id || ''),
          authorId: post.author_id,
          securityLevel: post.security_level ?? 0,
          createdAt: post.created_at || new Date(),
        })
      }
    }
    for (const comment of pgCommentsRes.rows || []) {
      const attachmentIds = Array.isArray(comment.attachments)
        ? comment.attachments
        : (() => {
            try { return JSON.parse(comment.attachments || '[]') } catch (_) { return [] }
          })()
      for (const attachmentId of toAttachmentIdArray(attachmentIds || [])) {
        ownerByAttachmentId.set(attachmentId, {
          attachmentId,
          postId: String(comment.post_id || ''),
          commentId: String(comment.id || ''),
          channelId: String(comment.channel_id || ''),
          authorId: comment.author_id,
          securityLevel: comment.security_level ?? 0,
          createdAt: comment.created_at || new Date(),
        })
      }
    }

    const imageRes = await db.query(
      `SELECT id, post_id, comment_id, channel_id, uploader_id, filename, content_type, created_at
       FROM attachments
       WHERE status = 'COMPLETED'
         AND (
           LOWER(COALESCE(content_type, '')) LIKE 'image/%'
           OR filename ~* '\\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$'
         )
       ORDER BY created_at ASC`,
    )

    let indexed = 0
    let alreadyIndexed = 0
    const skipped = []
    for (const attachment of imageRes.rows || []) {
      if (requestedAttachmentId && String(attachment.id) !== requestedAttachmentId) continue
      const owner = ownerByAttachmentId.get(String(attachment.id)) || {
        attachmentId: attachment.id,
        postId: attachment.post_id || '',
        commentId: attachment.comment_id || '',
        channelId: attachment.channel_id || '',
        authorId: attachment.uploader_id,
        securityLevel: 0,
        createdAt: attachment.created_at || new Date(),
      }
      if (requestedPostId && String(owner.postId || '') !== requestedPostId) continue
      if (requestedCommentId && String(owner.commentId || '') !== requestedCommentId) continue
      if (limit && indexed >= limit) break
      if (!owner.postId || !owner.channelId) {
        skipped.push({ attachmentId: attachment.id, reason: 'OWNER_NOT_FOUND' })
        continue
      }
      if (owner.commentId) {
        await db.query('UPDATE attachments SET comment_id = $1 WHERE id = $2', [owner.commentId, attachment.id]).catch(() => {})
      }
      try {
        const result = await indexImageAttachmentForSearch({
          ...owner,
          skipExistingVision: !force,
        })
        if (result.indexed) indexed += 1
        else if (result.reason === 'VISION_EXISTS') alreadyIndexed += 1
        else skipped.push({ attachmentId: attachment.id, reason: result.reason || 'SKIPPED' })
      } catch (e) {
        skipped.push({ attachmentId: attachment.id, reason: e.message })
      }
    }

    res.json({ success: true, indexedImages: indexed, alreadyIndexed, totalImages: imageRes.rowCount, skipped })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/posts ───────────────────────────────────────────
// 댓글 본문 없이 목록을 빠르게 만들기 위한 댓글 메타(개수 + 최신 작성시각/작성자) 일괄 조회.
// PostgreSQL 미러에서 1쿼리로 가져오고, 소프트삭제된 댓글은 제외한다.
async function getCommentMetaMap(channelId, postIds = [], { userId = null, lastReadAt = null } = {}) {
  const ids = postIds.map(String).filter(Boolean)
  if (ids.length === 0) return new Map()
  const deleted = await getDeletedItemIdSet('comment', { channelId })
  let rows = []
  try {
    const r = await db.query(
      'SELECT post_id, id, author_id, created_at FROM comments WHERE post_id = ANY($1)',
      [ids],
    )
    rows = r.rows || []
  } catch (_) { rows = [] }
  const map = new Map()
  for (const row of rows) {
    if (deleted.has(String(row.id))) continue
    const key = String(row.post_id)
    const cur = map.get(key) || {
      count: 0,
      lastCommentAt: null,
      lastCommentAuthorId: null,
      lastUnreadCommentAt: null,
    }
    cur.count += 1
    if (!cur.lastCommentAt || new Date(row.created_at).getTime() > new Date(cur.lastCommentAt).getTime()) {
      cur.lastCommentAt = row.created_at
      cur.lastCommentAuthorId = row.author_id
    }
    if (
      String(row.author_id) !== String(userId)
      && isAfterLastRead(row.created_at, lastReadAt)
      && (!cur.lastUnreadCommentAt || new Date(row.created_at).getTime() > new Date(cur.lastUnreadCommentAt).getTime())
    ) {
      cur.lastUnreadCommentAt = row.created_at
    }
    map.set(key, cur)
  }
  return map
}

// 댓글을 로딩하지 않은 상태의 unread 메타 (게시글 시각 + 마지막 댓글 시각/작성자 기준).
// 정확한 안읽은 댓글 수는 게시글을 열 때(댓글 로딩) 보정된다.
function buildUnreadMetaLight({
  postCreatedAt,
  postAuthorId,
  userId,
  lastReadAt,
  lastCommentAt,
  lastCommentAuthorId,
  lastUnreadCommentAt,
}) {
  const isOwnPost = String(postAuthorId) === String(userId)
  const unreadPost = !isOwnPost && isAfterLastRead(postCreatedAt, lastReadAt)
  const hasUnreadComment = Boolean(lastUnreadCommentAt) || (Boolean(lastCommentAt)
    && String(lastCommentAuthorId) !== String(userId)
    && isAfterLastRead(lastCommentAt, lastReadAt))
  const unreadTimes = [
    unreadPost ? postCreatedAt : null,
    hasUnreadComment ? (lastUnreadCommentAt || lastCommentAt) : null,
  ].filter(Boolean)
  const unreadActivityAt = unreadTimes.length > 0
    ? new Date(Math.max(...unreadTimes.map(v => new Date(v).getTime()))).toISOString()
    : null
  return {
    isUnread: unreadPost || hasUnreadComment,
    unreadPost,
    unreadCommentCount: 0,
    unreadActivityAt,
  }
}

async function fetchCassandraPostRowById(postId) {
  const loc = await findPostLocator(postId)
  if (!loc?.channel_id || loc.created_at == null) return null
  const r = await client.execute(
    'SELECT * FROM posts WHERE channel_id = ? AND created_at = ?',
    [loc.channel_id, loc.created_at], { prepare: true },
  )
  return r.rows?.[0] || null
}

// GET /api/posts?channelId=&limit=&before=
//  · limit(기본 30): 최신순으로 그만큼만 (clustering DESC라 효율적)
//  · before(ISO): 해당 시각보다 오래된 글 (무한 스크롤 커서)
//  · 댓글은 포함하지 않음(comments:[], comment_count/last_comment_at만). 클릭 시 별도 로딩.
//  · 첫 페이지(before 없음)에는 고정(pinned) 글을 병합한다.
//  · 응답: { posts, hasMore, nextCursor }
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { channelId } = req.query
    if (!channelId) return res.status(400).json({ error: 'channelId is required' })
    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100)
    const before = req.query.before ? new Date(req.query.before) : null
    const includePinned = !before

    const lastReadRes = await db.query(
      'SELECT last_read_at FROM channel_last_read WHERE user_id = $1 AND channel_id = $2',
      [req.user.id, channelId],
    )
    const lastReadAt = lastReadRes.rows[0]?.last_read_at || null

    // ── Cassandra path ────────────────────────────────────────
    if (isConnected()) {
      const pinnedMap = await getPinnedMapByChannel(channelId)
      const deletedPostIds = await getDeletedItemIdSet('post', { channelId })

      // 최신순(clustering DESC)으로 limit+1건 — 다음 페이지 존재 여부 판단
      const cql = before
        ? 'SELECT * FROM posts WHERE channel_id = ? AND created_at < ? LIMIT ?'
        : 'SELECT * FROM posts WHERE channel_id = ? LIMIT ?'
      const params = before ? [channelId, before, limit + 1] : [channelId, limit + 1]
      const result = await client.execute(cql, params, { prepare: true })

      let newestFirst = result.rows.filter(row => row.id != null && !deletedPostIds.has(String(row.id)))
      const hasMore = newestFirst.length > limit
      if (hasMore) newestFirst = newestFirst.slice(0, limit)
      // 다음(더 오래된) 페이지 커서 = 현재 로딩분 중 가장 오래된 글의 시각
      const oldest = newestFirst.length ? newestFirst[newestFirst.length - 1].created_at : null
      const rows = newestFirst.slice().reverse() // 프론트 호환: created_at ASC

      // 첫 페이지: 창에 없는 고정 글 병합
      if (includePinned) {
        const pageIds = new Set(rows.map(r => String(r.id)))
        const missingPinned = [...pinnedMap.entries()]
          .filter(([id, info]) => info?.pinned && !pageIds.has(String(id)) && !deletedPostIds.has(String(id)))
          .map(([id]) => id)
        for (const pid of missingPinned) {
          const prow = await fetchCassandraPostRowById(pid).catch(() => null)
          if (prow?.id != null) rows.unshift(prow)
        }
      }

      const allIds = rows.map(r => r.id.toString())
      const postLikeMap = await getPostLikeMap(rows.map(r => r.id), req.user.id)
      const commentMeta = await getCommentMetaMap(channelId, allIds, { userId: req.user.id, lastReadAt })
      const userCache = makeUserCache()
      const permissionCtx = await buildChannelPermissionContext(req.user, channelId)

      const posts = await Promise.all(rows.map(async row => {
        const author = (await userCache.get(row.author_id))
          || { id: null, name: '알 수 없음', username: 'unknown', image_url: null }
        const avatarLetters = author.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
        const attachmentIds = [
          row.attachments_1, row.attachments_2, row.attachments_3, row.attachments_4, row.attachments_5,
          row.attachments_6, row.attachments_7, row.attachments_8, row.attachments_9, row.attachments_10
        ].filter(Boolean)
        const attachments = await enrichAttachments(attachmentIds)
        const pinInfo = pinnedMap.get(String(row.id)) || null
        const likeInfo = postLikeMap.get(String(row.id)) || { likeCount: 0, likedByMe: false }
        const meta = commentMeta.get(String(row.id)) || {
          count: 0,
          lastCommentAt: null,
          lastCommentAuthorId: null,
          lastUnreadCommentAt: null,
        }
        const unreadMeta = buildUnreadMetaLight({
          postCreatedAt: row.created_at,
          postAuthorId: row.author_id,
          userId: req.user.id,
          lastReadAt,
          lastCommentAt: meta.lastCommentAt,
          lastCommentAuthorId: meta.lastCommentAuthorId,
          lastUnreadCommentAt: meta.lastUnreadCommentAt,
        })
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
            image_url: compactListImageUrl(author.image_url),
          },
          createdAt: row.created_at,
          comments: [],
          commentsLoaded: false,
          comment_count: meta.count,
          last_comment_at: meta.lastCommentAt,
          last_comment_author_id: meta.lastCommentAuthorId,
          ...getTrainingStatus('post', row.id.toString()),
          likeCount: likeInfo.likeCount || 0,
          likedByMe: Boolean(likeInfo.likedByMe),
          security_level: row.security_level || 0,
          can_edit: canMutateWithContext(permissionCtx, author),
          tags: [],
          pinned: Boolean(pinInfo?.pinned),
          pinned_at: pinInfo?.pinned_at || null,
          pinned_by: pinInfo?.pinned_by || null,
          views: 0,
          ...unreadMeta,
        }
      }))

      return res.json({
        posts,
        hasMore,
        nextCursor: oldest ? new Date(oldest).toISOString() : null,
      })
    }

    // ── PostgreSQL fallback ───────────────────────────────────
    const pinnedMap = await getPinnedMapByChannel(channelId)
    const sql = before
      ? `SELECT p.*, u.id AS u_id, u.name AS author_name, u.username, u.image_url,
                u.role AS author_role, u.security_level AS author_security_level
         FROM posts p JOIN users u ON p.author_id = u.id
         WHERE p.channel_id = $1 AND p.created_at < $2
         ORDER BY p.created_at DESC LIMIT $3`
      : `SELECT p.*, u.id AS u_id, u.name AS author_name, u.username, u.image_url,
                u.role AS author_role, u.security_level AS author_security_level
         FROM posts p JOIN users u ON p.author_id = u.id
         WHERE p.channel_id = $1
         ORDER BY p.created_at DESC LIMIT $2`
    const sqlParams = before ? [channelId, before, limit + 1] : [channelId, limit + 1]
    const result = await db.query(sql, sqlParams)
    const deletedPostIdsPg = await getDeletedItemIdSet('post', { channelId })
    let newestFirstPg = result.rows.filter(row => !deletedPostIdsPg.has(String(row.id)))
    const hasMorePg = newestFirstPg.length > limit
    if (hasMorePg) newestFirstPg = newestFirstPg.slice(0, limit)
    const oldestPg = newestFirstPg.length ? newestFirstPg[newestFirstPg.length - 1].created_at : null
    const rowsPg = newestFirstPg.slice().reverse()

    if (includePinned) {
      const pageIds = new Set(rowsPg.map(r => String(r.id)))
      const missingPinned = [...pinnedMap.entries()]
        .filter(([id, info]) => info?.pinned && !pageIds.has(String(id)) && !deletedPostIdsPg.has(String(id)))
        .map(([id]) => id)
      for (const pid of missingPinned) {
        const pr = await db.query(
          `SELECT p.*, u.id AS u_id, u.name AS author_name, u.username, u.image_url,
                  u.role AS author_role, u.security_level AS author_security_level
           FROM posts p JOIN users u ON p.author_id = u.id WHERE p.id = $1`,
          [pid],
        ).catch(() => ({ rows: [] }))
        if (pr.rows?.[0]) rowsPg.unshift(pr.rows[0])
      }
    }

    const postLikeMap = await getPostLikeMap(rowsPg.map(row => row.id), req.user.id)
    const commentMetaPg = await getCommentMetaMap(channelId, rowsPg.map(r => String(r.id)), { userId: req.user.id, lastReadAt })
    const userCachePg = makeUserCache()
    const permissionCtxPg = await buildChannelPermissionContext(req.user, channelId)

    const posts = await Promise.all(rowsPg.map(async row => {
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
      const authorRecord = {
        id: row.author_id,
        name: row.author_name,
        username: row.username,
        image_url: row.image_url,
        role: row.author_role,
        security_level: row.author_security_level,
      }
      userCachePg.prime(row.author_id, authorRecord)
      const pinInfo = pinnedMap.get(String(row.id)) || null
      const likeInfo = postLikeMap.get(String(row.id)) || { likeCount: 0, likedByMe: false }
      const meta = commentMetaPg.get(String(row.id)) || {
        count: 0,
        lastCommentAt: null,
        lastCommentAuthorId: null,
        lastUnreadCommentAt: null,
      }
      const unreadMeta = buildUnreadMetaLight({
        postCreatedAt: row.created_at,
        postAuthorId: row.author_id,
        userId: req.user.id,
        lastReadAt,
        lastCommentAt: meta.lastCommentAt,
        lastCommentAuthorId: meta.lastCommentAuthorId,
        lastUnreadCommentAt: meta.lastUnreadCommentAt,
      })
      return {
        id: row.id,
        channel_id: row.channel_id,
        content: row.content,
        title: row.title || '',
        attachments,
        author: {
          id: row.author_id,
          name: row.author_name,
          username: row.username,
          avatar: avatarLetters,
          image_url: compactListImageUrl(row.image_url),
        },
        createdAt: row.created_at,
        comments: [],
        commentsLoaded: false,
        comment_count: meta.count,
        last_comment_at: meta.lastCommentAt,
        last_comment_author_id: meta.lastCommentAuthorId,
        ...getTrainingStatus('post', row.id),
        likeCount: likeInfo.likeCount || 0,
        likedByMe: Boolean(likeInfo.likedByMe),
        security_level: row.security_level || 0,
        can_edit: canMutateWithContext(permissionCtxPg, authorRecord),
        tags: [],
        pinned: Boolean(pinInfo?.pinned),
        pinned_at: pinInfo?.pinned_at || null,
        pinned_by: pinInfo?.pinned_by || null,
        views: row.views || 0,
        ...unreadMeta,
      }
    }))

    res.json({
      posts,
      hasMore: hasMorePg,
      nextCursor: oldestPg ? new Date(oldestPg).toISOString() : null,
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/posts/deleted (최근 삭제됨: 1분 내 복구 가능 목록) ────
router.get('/deleted', requireAuth, async (req, res, next) => {
  try {
    const { channelId } = req.query
    if (!channelId) return res.status(400).json({ error: 'channelId is required' })
    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    await ensureSoftDeleteSchema()
    const isSiteAdmin = req.user.role === 'site_admin'
    const params = [channelId]
    let scopeClause = ''
    if (!isSiteAdmin) {
      params.push(req.user.id)
      scopeClause = ` AND d.deleted_by = $${params.length}`
    }
    const r = await db.query(
      `SELECT d.item_type, d.item_id, d.post_id, d.preview, d.deleted_at, d.deleted_by, u.name AS deleted_by_name
       FROM deleted_items d
       LEFT JOIN users u ON u.id = d.deleted_by
       WHERE d.channel_id = $1 AND d.deleted_at > NOW() - INTERVAL '1 minute'${scopeClause}
       ORDER BY d.deleted_at DESC`,
      params,
    )
    const now = Date.now()
    const items = (r.rows || []).map((x) => ({
      type: x.item_type,
      id: String(x.item_id),
      postId: x.post_id ? String(x.post_id) : null,
      preview: x.preview || '',
      deletedAt: x.deleted_at,
      deletedByName: x.deleted_by_name || null,
      remainingMs: Math.max(0, RESTORE_WINDOW_MS - (now - new Date(x.deleted_at).getTime())),
    }))
    res.json(items)
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/posts ──────────────────────────────────────────
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { channelId, content, attachmentIds, security_level } = req.body
    if (!channelId || !content) return res.status(400).json({ error: 'channelId and content are required' })
    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    if (attachmentIds && attachmentIds.length > 10) {
      return res.status(400).json({ error: '첨부파일은 최대 10개까지만 가능합니다.' })
    }

    const isSiteAdmin = req.user.role === 'site_admin'
    const userLevel = isSiteAdmin ? 4 : (req.user.security_level ?? 0)
    const defaultLevel = Math.min(1, userLevel)
    const safePostLevel = Math.min(Math.max(parseInt(security_level ?? defaultLevel) || 0, 0), userLevel)

    const postId = randomUUID()
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

      // ── 새 포스트를 posts_by_id 룩업 테이블에도 기록 ──────────────────────
      await client.execute(
        'INSERT INTO posts_by_id (id, channel_id, created_at, author_id) VALUES (?, ?, ?, ?)',
        [postId, channelId, authoredAt, req.user.id], { prepare: true }
      )

      // ── 1. 이전 게시글의 Next Post ID 업데이트 (Cassandra) ─────────────────────
      if (prevPostId) {
        const prevRow = await client.execute(
          'SELECT channel_id, created_at FROM posts_by_id WHERE id = ?',
          [prevPostId], { prepare: true }
        )
        if (prevRow.rows.length > 0) {
          await client.execute(
            'UPDATE posts SET next_post_id = ? WHERE channel_id = ? AND created_at = ?',
            [postId, prevRow.rows[0].channel_id, prevRow.rows[0].created_at], { prepare: true }
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

    await db.query(
      `INSERT INTO posts (
         id, channel_id, author_id, content, created_at, updated_at,
         is_edited, prev_post_id, next_post_id, child_post_id, parent_id,
         attachments_1, attachments_2, attachments_3, attachments_4, attachments_5,
         attachments_6, attachments_7, attachments_8, attachments_9, attachments_10,
         security_level
       )
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, NULL, NULL, NULL, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (id)
       DO UPDATE SET
         channel_id = EXCLUDED.channel_id,
         author_id = EXCLUDED.author_id,
         content = EXCLUDED.content,
         updated_at = EXCLUDED.updated_at,
         security_level = EXCLUDED.security_level,
         attachments_1 = EXCLUDED.attachments_1,
         attachments_2 = EXCLUDED.attachments_2,
         attachments_3 = EXCLUDED.attachments_3,
         attachments_4 = EXCLUDED.attachments_4,
         attachments_5 = EXCLUDED.attachments_5,
         attachments_6 = EXCLUDED.attachments_6,
         attachments_7 = EXCLUDED.attachments_7,
         attachments_8 = EXCLUDED.attachments_8,
         attachments_9 = EXCLUDED.attachments_9,
         attachments_10 = EXCLUDED.attachments_10`,
      [postId, channelId, req.user.id, content, authoredAt, authoredAt, prevPostId, ...attCols, safePostLevel],
    ).catch(e => console.warn('[PostgresMirror] post upsert 실패:', e.message))
    await upsertSearchDocument({
      sourceType: 'post',
      sourceId: postId,
      postId,
      channelId,
      authorId: req.user.id,
      content,
      securityLevel: safePostLevel,
      createdAt: authoredAt,
    }).catch(e => console.warn('[SearchIndex] post upsert 실패:', e.message))
    indexImageAttachmentsForSearchAsync(ids.map(attachmentId => ({
      attachmentId,
      postId,
      channelId,
      authorId: req.user.id,
      securityLevel: safePostLevel,
      createdAt: authoredAt,
    })))

    // ── 2. 채널의 Root/Tail ID 업데이트 (PostgreSQL — 메타데이터 핵심 관리) ────────────
    if (!channelData?.root_post_id) {
      await db.query('UPDATE channels SET root_post_id = $1, tail_post_id = $1 WHERE id = $2', [postId, channelId])
    } else {
      await db.query('UPDATE channels SET tail_post_id = $1 WHERE id = $2', [postId, channelId])
    }

    await linkAttachments(postId, ids)
    await syncAttachmentRefs({
      ownerType: 'post',
      ownerId: postId,
      nextAttachmentIds: ids,
      actorUserId: req.user?.id,
    })

    // 업로드 즉시 LanceDB 임베딩 (비동기, 응답에 영향 없음)
    markTrainingStarted('post', postId)
    ;(async () => {
      const success = await trainPostImmediate({ id: postId, channel_id: channelId, content, created_at: authoredAt })
      if (success) markTrainingCompleted('post', postId)
      else clearTrainingStatus('post', postId)
    })()

    notifyMentionedUsers(content, {
      channelId,
      postId,
      attachmentIds: ids,
    })
    notifyAuthorTelegramPostRegistered({
      authorId: req.user.id,
      channelId,
      postId,
      attachmentIds: ids,
      content,
    })

    res.status(201).json({ id: postId, channelId, content, authoredAt })
  } catch (err) {
    next(err)
  }
})

// 게시글 영구 삭제(하드삭제). 소프트삭제 후 1분이 지난 항목을 purge 작업이 호출한다.
async function purgePostHard(id, actorUserId = null) {
  const row = isConnected() ? await findPostLocator(id) : null

  // Cassandra 행이 이미 없으면 PG mirror/검색만 정리하고 종료.
  if (!row) {
    await db.query('DELETE FROM comments WHERE post_id = $1', [id]).catch(() => {})
    await db.query('DELETE FROM post_likes WHERE post_id = $1', [id]).catch(() => {})
    await db.query('DELETE FROM posts WHERE id = $1', [id]).catch(() => {})
    await db.query('DELETE FROM search_documents WHERE post_id = $1', [id]).catch(() => {})
    return
  }

  // 삭제 대상 게시글/댓글의 첨부 ID를 먼저 수집한다.
  const postRowRes = await client.execute(
    'SELECT * FROM posts WHERE channel_id = ? AND created_at = ?',
    [row.channel_id, row.created_at], { prepare: true },
  )
  const postAttachmentIds = extractPostAttachmentIds(postRowRes.rows?.[0] || {})

  const cRows = await client.execute(
    'SELECT id, created_at, attachments FROM comments WHERE post_id = ?',
    [id], { prepare: true },
  )
  const commentAttachmentIds = (cRows.rows || []).flatMap((c) => toAttachmentIdArray(c.attachments || []))

  // Cassandra에 없고 PostgreSQL에만 남아 있는 첨부도 수집한다.
  const pgPostAttRes = await db.query(
    "SELECT id FROM attachments WHERE post_id = $1 AND delete_status != 'deleted'",
    [id],
  ).catch(() => ({ rows: [] }))
  const pgPostAttachmentIds = (pgPostAttRes.rows || []).map((r) => String(r.id))

  const pgCommentIdsRes = await db.query(
    'SELECT id FROM comments WHERE post_id = $1',
    [id],
  ).catch(() => ({ rows: [] }))
  const commentIds = [
    ...new Set([
      ...(cRows.rows || []).map((c) => String(c.id)).filter(Boolean),
      ...(pgCommentIdsRes.rows || []).map((c) => String(c.id)).filter(Boolean),
    ]),
  ]
  const pgCommentAttachmentIds = []
  if (commentIds.length > 0) {
    const pgCommentAttRes = await db.query(
      "SELECT id FROM attachments WHERE comment_id = ANY($1) AND delete_status != 'deleted'",
      [commentIds],
    ).catch(() => ({ rows: [] }))
    pgCommentAttachmentIds.push(...(pgCommentAttRes.rows || []).map((r) => String(r.id)))
  }

  const targetAttachmentIds = [
    ...new Set([...postAttachmentIds, ...commentAttachmentIds, ...pgPostAttachmentIds, ...pgCommentAttachmentIds]),
  ]

  await client.execute(
    'DELETE FROM posts WHERE channel_id = ? AND created_at = ?',
    [row.channel_id, row.created_at], { prepare: true }
  )
  await client.execute(
    'DELETE FROM posts_by_id WHERE id = ?',
    [id], { prepare: true }
  )

  // 해당 게시글의 댓글도 Cassandra에서 삭제
  await Promise.all(cRows.rows.map(c =>
    Promise.all([
      client.execute(
        'DELETE FROM comments WHERE post_id = ? AND created_at = ?',
        [id, c.created_at], { prepare: true }
      ),
      client.execute(
        'DELETE FROM comments_by_id WHERE id = ?',
        [c.id], { prepare: true }
      ),
    ])
  ))

  // PostgreSQL mirror 정리
  await ensureLikeTables().catch(() => {})
  if (commentIds.length > 0) {
    await db.query('DELETE FROM comment_likes WHERE comment_id = ANY($1)', [commentIds]).catch(() => {})
  }
  await db.query('DELETE FROM post_likes WHERE post_id = $1', [id]).catch(() => {})
  await db.query('DELETE FROM comments WHERE post_id = $1', [id])
  await db.query('DELETE FROM posts WHERE id = $1', [id])
  await db.query('DELETE FROM search_documents WHERE post_id = $1', [id]).catch(() => {})

  // STT 결과물 정리 (post 기준)
  await db.query('DELETE FROM stt_segments WHERE job_id IN (SELECT id FROM stt_jobs WHERE post_id = $1)', [id]).catch(() => {})
  await db.query('DELETE FROM stt_summaries WHERE job_id IN (SELECT id FROM stt_jobs WHERE post_id = $1)', [id]).catch(() => {})
  await db.query('DELETE FROM stt_jobs WHERE post_id = $1', [id]).catch(() => {})

  // 첨부파일/레코드 정리 (다른 글/댓글 참조 시 삭제하지 않음)
  await syncAttachmentRefs({
    ownerType: 'post',
    ownerId: id,
    nextAttachmentIds: [],
    actorUserId,
  })
  for (const c of cRows.rows || []) {
    await syncAttachmentRefs({
      ownerType: 'comment',
      ownerId: String(c.id || ''),
      nextAttachmentIds: [],
      actorUserId,
    })
  }
  for (const attId of targetAttachmentIds) {
    await deleteAttachmentPhysicalAndRecords(attId, { excludedPostId: id })
  }
}

// 댓글 영구 삭제(하드삭제).
async function purgeCommentHard(postId, commentId, actorUserId = null) {
  const row = isConnected() ? await findCommentLocator(postId, commentId) : null
  if (!row) {
    await db.query('DELETE FROM comment_likes WHERE comment_id = $1', [commentId]).catch(() => {})
    await db.query('DELETE FROM comments WHERE id = $1', [commentId]).catch(() => {})
    await db.query('DELETE FROM search_documents WHERE comment_id = $1', [commentId]).catch(() => {})
    return
  }
  const commentRowRes = await client.execute(
    'SELECT attachments FROM comments WHERE post_id = ? AND created_at = ?',
    [row.post_id, row.created_at], { prepare: true },
  )
  const targetAttachmentIds = toAttachmentIdArray(commentRowRes.rows?.[0]?.attachments || [])

  await client.execute(
    'DELETE FROM comments WHERE post_id = ? AND created_at = ?',
    [row.post_id, row.created_at], { prepare: true }
  )
  await client.execute(
    'DELETE FROM comments_by_id WHERE id = ?',
    [commentId], { prepare: true }
  )
  await ensureLikeTables().catch(() => {})
  await db.query('DELETE FROM comment_likes WHERE comment_id = $1', [commentId]).catch(() => {})
  await db.query('DELETE FROM comments WHERE id = $1', [commentId])
  await deleteSearchDocument('comment', commentId).catch(() => {})
  await db.query('DELETE FROM search_documents WHERE comment_id = $1', [commentId]).catch(() => {})
  await syncAttachmentRefs({
    ownerType: 'comment',
    ownerId: commentId,
    nextAttachmentIds: [],
    actorUserId,
  })
  for (const attId of targetAttachmentIds) {
    await deleteAttachmentPhysicalAndRecords(attId, { excludedPostId: postId, excludedCommentId: commentId })
  }
}

// 1분이 지난 소프트삭제 항목을 영구 삭제한다(백그라운드 주기 실행).
async function purgeExpiredDeletedItems() {
  try {
    await ensureSoftDeleteSchema()
    const r = await db.query(
      "SELECT item_type, item_id, post_id, deleted_by FROM deleted_items WHERE deleted_at <= NOW() - INTERVAL '1 minute' ORDER BY deleted_at ASC LIMIT 200",
    )
    const rows = r.rows || []
    for (const it of rows) {
      try {
        if (it.item_type === 'post') {
          await purgePostHard(String(it.item_id), it.deleted_by)
        } else if (it.item_type === 'comment') {
          await purgeCommentHard(String(it.post_id || ''), String(it.item_id), it.deleted_by)
        }
        await db.query('DELETE FROM deleted_items WHERE item_type = $1 AND item_id = $2', [it.item_type, it.item_id])
      } catch (e) {
        console.error('[휴지통] 영구삭제 실패:', it.item_type, it.item_id, e.message)
      }
    }
    if (rows.length > 0) console.log(`[휴지통] ${rows.length}건 영구 삭제 완료`)
  } catch (e) {
    console.error('[휴지통] purge 작업 오류:', e.message)
  }
}

function scheduleDeletedItemsPurge() {
  // 서버 기동 직후 한 번, 이후 1분 간격 (DM/학습상태 정리와 동일한 패턴)
  setTimeout(() => {
    purgeExpiredDeletedItems()
    setInterval(() => { purgeExpiredDeletedItems() }, 60 * 1000).unref?.()
  }, 30 * 1000).unref?.()
}
scheduleDeletedItemsPurge()

// ─── DELETE /api/posts/:id (소프트 삭제: 1분 내 복구 가능) ──────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params

    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })

    const row = await findPostLocator(id)
    if (!row) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })

    const isSiteAdmin = req.user.role === 'site_admin'
    if (!isSiteAdmin && String(row.author_id) !== String(req.user.id)) {
      return res.status(403).json({ error: '권한이 없습니다.' })
    }

    await ensureSoftDeleteSchema()
    const postRowRes = await client.execute(
      'SELECT content FROM posts WHERE channel_id = ? AND created_at = ?',
      [row.channel_id, row.created_at], { prepare: true },
    )
    const preview = buildPreview(postRowRes.rows?.[0]?.content || '')

    await db.query(
      `INSERT INTO deleted_items (item_type, item_id, channel_id, post_id, author_id, deleted_by, preview, deleted_at)
       VALUES ('post', $1, $2, NULL, $3, $4, $5, NOW())
       ON CONFLICT (item_type, item_id)
       DO UPDATE SET deleted_at = NOW(), deleted_by = EXCLUDED.deleted_by, preview = EXCLUDED.preview`,
      [String(id), row.channel_id, row.author_id, req.user.id, preview],
    )

    res.json({
      success: true,
      deleted: { type: 'post', id: String(id), channelId: row.channel_id, preview, restoreWindowMs: RESTORE_WINDOW_MS },
    })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/posts/:id/restore (소프트삭제 게시글 복구) ────────────
router.post('/:id/restore', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    await ensureSoftDeleteSchema()
    const r = await db.query("SELECT * FROM deleted_items WHERE item_type = 'post' AND item_id = $1", [String(id)])
    const item = r.rows[0]
    if (!item) return res.status(404).json({ error: '복구할 게시글을 찾을 수 없습니다.' })

    const isSiteAdmin = req.user.role === 'site_admin'
    if (!isSiteAdmin && String(item.deleted_by) !== String(req.user.id)) {
      return res.status(403).json({ error: '권한이 없습니다.' })
    }
    const ageMs = Date.now() - new Date(item.deleted_at).getTime()
    if (ageMs > RESTORE_WINDOW_MS) {
      return res.status(410).json({ error: '복구 가능 시간(1분)이 지났습니다.' })
    }

    await db.query("DELETE FROM deleted_items WHERE item_type = 'post' AND item_id = $1", [String(id)])
    res.json({ success: true, channelId: item.channel_id })
  } catch (err) {
    next(err)
  }
})

// ─── PUT /api/posts/:id ───────────────────────────────────────
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const { content, ragContent, security_level, attachments = [], waitForTraining = false } = req.body
    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })
    const row = await findPostLocator(id)
    if (!row) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })
    const allowedChannel = await canAccessChannel(db, req.user, row.channel_id)
    if (!allowedChannel) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    if (!(await canMutatePostRow(req.user, row))) return res.status(403).json({ error: '권한이 없습니다.' })
    const attachmentIds = uniqAttachmentIds(
      (Array.isArray(attachments) ? attachments : [])
        .map((item) => (typeof item === 'object' ? item.id : item)),
    )
    if (attachmentIds.length > 10) {
      return res.status(400).json({ error: '첨부파일은 최대 10개까지만 가능합니다.' })
    }
    const attCols = Array(10).fill(null)
    attachmentIds.forEach((v, i) => { attCols[i] = v })

    // security_level은 요청자의 레벨 이하만 허용
    const userLevel = securityLevelOf(req.user)
    const safeLevel = (security_level != null) ? Math.min(Math.max(parseInt(security_level) || 0, 0), userLevel) : undefined
    if (safeLevel !== undefined) {
      await client.execute(
        `UPDATE posts
         SET content = ?, security_level = ?,
             attachments_1 = ?, attachments_2 = ?, attachments_3 = ?, attachments_4 = ?, attachments_5 = ?,
             attachments_6 = ?, attachments_7 = ?, attachments_8 = ?, attachments_9 = ?, attachments_10 = ?
         WHERE channel_id = ? AND created_at = ?`,
        [content, safeLevel, ...attCols, row.channel_id, row.created_at], { prepare: true }
      )
    } else {
      await client.execute(
        `UPDATE posts
         SET content = ?,
             attachments_1 = ?, attachments_2 = ?, attachments_3 = ?, attachments_4 = ?, attachments_5 = ?,
             attachments_6 = ?, attachments_7 = ?, attachments_8 = ?, attachments_9 = ?, attachments_10 = ?
         WHERE channel_id = ? AND created_at = ?`,
        [content, ...attCols, row.channel_id, row.created_at], { prepare: true }
      )
    }
    await db.query(
      `UPDATE posts
       SET content = $1,
           security_level = COALESCE($2, security_level),
           attachments_1 = $3, attachments_2 = $4, attachments_3 = $5, attachments_4 = $6, attachments_5 = $7,
           attachments_6 = $8, attachments_7 = $9, attachments_8 = $10, attachments_9 = $11, attachments_10 = $12
       WHERE id = $13`,
      [content, safeLevel ?? null, ...attCols, id],
    ).catch(() => {})
    await upsertSearchDocument({
      sourceType: 'post',
      sourceId: id,
      postId: id,
      channelId: row.channel_id,
      authorId: row.author_id,
      content,
      securityLevel: safeLevel ?? 0,
      createdAt: row.created_at,
    }).catch(e => console.warn('[SearchIndex] post update 실패:', e.message))
    await linkAttachments(id, attachmentIds)
    await syncAttachmentRefs({
      ownerType: 'post',
      ownerId: id,
      nextAttachmentIds: attachmentIds,
      actorUserId: req.user?.id,
    })

    // 수정 즉시: 기존 벡터 삭제 후 재학습
    markTrainingStarted('post', id)
    const trainingContent = String(ragContent || '').trim() || content
    const trainUpdatedPost = async () => {
      const success = await retrainPostImmediate({ id, channel_id: row.channel_id, content: trainingContent })
      if (success) markTrainingCompleted('post', id)
      else clearTrainingStatus('post', id)
      return success
    }

    if (waitForTraining) {
      const success = await trainUpdatedPost()
      if (!success) return res.status(500).json({ error: 'RAG 학습에 실패했습니다.' })
      return res.json({ success: true, training_status: 'completed' })
    }

    trainUpdatedPost()

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── PUT /api/posts/:id/pin ──────────────────────────────────
router.put('/:id/pin', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const pinned = Boolean(req.body?.pinned)
    const row = await findPostLocator(id)
    if (!row) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })

    const allowedChannel = await canAccessChannel(db, req.user, row.channel_id)
    if (!allowedChannel) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    const role = String(req.user?.role || '')
    const isPrivilegedRole = ['site_admin', 'team_admin', 'channel_admin'].includes(role)
    const isAuthor = String(row.author_id) === String(req.user?.id)
    if (!isPrivilegedRole && !isAuthor) {
      return res.status(403).json({ error: '권한이 없습니다.' })
    }

    await ensurePostPinTable()

    if (pinned) {
      await db.query(
        `INSERT INTO post_pins (post_id, channel_id, pinned, pinned_at, pinned_by, updated_at)
         VALUES ($1, $2, true, NOW(), $3, NOW())
         ON CONFLICT (post_id)
         DO UPDATE SET
           channel_id = EXCLUDED.channel_id,
           pinned = true,
           pinned_at = NOW(),
           pinned_by = EXCLUDED.pinned_by,
           updated_at = NOW()`,
        [String(id), String(row.channel_id), String(req.user.id)],
      )
    } else {
      await db.query(
        `INSERT INTO post_pins (post_id, channel_id, pinned, pinned_at, pinned_by, updated_at)
         VALUES ($1, $2, false, NULL, NULL, NOW())
         ON CONFLICT (post_id)
         DO UPDATE SET
           channel_id = EXCLUDED.channel_id,
           pinned = false,
           pinned_at = NULL,
           pinned_by = NULL,
           updated_at = NOW()`,
        [String(id), String(row.channel_id)],
      )
    }

    return res.json({
      success: true,
      postId: String(id),
      channelId: String(row.channel_id),
      pinned,
    })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/posts/:id/like ────────────────────────────────
router.post('/:id/like', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const channelId = await resolveChannelIdForPost(id)
    if (!channelId) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })
    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    await ensureLikeTables()
    const existing = await db.query(
      'SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2 LIMIT 1',
      [String(id), req.user.id],
    )
    const liked = existing.rowCount === 0
    if (liked) {
      await db.query(
        `INSERT INTO post_likes (post_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (post_id, user_id) DO NOTHING`,
        [String(id), req.user.id],
      )
    } else {
      await db.query(
        'DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2',
        [String(id), req.user.id],
      )
    }

    const countRes = await db.query(
      'SELECT COUNT(*)::int AS like_count FROM post_likes WHERE post_id = $1',
      [String(id)],
    )
    return res.json({
      success: true,
      postId: String(id),
      channelId: String(channelId),
      liked,
      likeCount: Number(countRes.rows?.[0]?.like_count || 0),
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/posts/:id/likes ────────────────────────────────
router.get('/:id/likes', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const channelId = await resolveChannelIdForPost(id)
    if (!channelId) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })
    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    await ensureLikeTables()
    const result = await db.query(
      `SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.name, u.username) AS name
       FROM post_likes l
       JOIN users u ON u.id = l.user_id
       WHERE l.post_id = $1
       ORDER BY l.created_at ASC, u.name ASC`,
      [String(id)],
    )
    return res.json((result.rows || []).map(row => ({
      id: row.id,
      name: row.name || '사용자',
    })))
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/posts/:id/comments ─────────────────────────────
router.get('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const channelId = await resolveChannelIdForPost(req.params.id)
    if (!channelId) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })
    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    const comments = await fetchComments(req.params.id, req.user)
    res.json(comments)
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/posts/:postId/comments/:commentId/likes ─────────
router.get('/:postId/comments/:commentId/likes', requireAuth, async (req, res, next) => {
  try {
    const { postId, commentId } = req.params
    const channelId = await resolveChannelIdForPost(postId)
    if (!channelId) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })
    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    await ensureLikeTables()
    const result = await db.query(
      `SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.name, u.username) AS name
       FROM comment_likes l
       JOIN users u ON u.id = l.user_id
       WHERE l.comment_id = $1
       ORDER BY l.created_at ASC, u.name ASC`,
      [String(commentId)],
    )
    return res.json((result.rows || []).map(row => ({
      id: row.id,
      name: row.name || '사용자',
    })))
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/posts/:postId/comments/:commentId/like ─────────
router.post('/:postId/comments/:commentId/like', requireAuth, async (req, res, next) => {
  try {
    const { postId, commentId } = req.params
    const channelId = await resolveChannelIdForPost(postId)
    if (!channelId) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })
    const allowed = await canAccessChannel(db, req.user, channelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })

    let commentExists = false
    if (isConnected()) {
      const locator = await findCommentLocator(postId, commentId)
      commentExists = Boolean(locator)
    }
    if (!commentExists) {
      const pgComment = await db.query(
        'SELECT id FROM comments WHERE post_id = $1 AND id = $2 LIMIT 1',
        [String(postId), String(commentId)],
      )
      commentExists = pgComment.rowCount > 0
    }
    if (!commentExists) return res.status(404).json({ error: '댓글을 찾을 수 없습니다.' })

    await ensureLikeTables()
    const existing = await db.query(
      'SELECT 1 FROM comment_likes WHERE comment_id = $1 AND user_id = $2 LIMIT 1',
      [String(commentId), req.user.id],
    )
    const liked = existing.rowCount === 0
    if (liked) {
      await db.query(
        `INSERT INTO comment_likes (comment_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (comment_id, user_id) DO NOTHING`,
        [String(commentId), req.user.id],
      )
    } else {
      await db.query(
        'DELETE FROM comment_likes WHERE comment_id = $1 AND user_id = $2',
        [String(commentId), req.user.id],
      )
    }

    const countRes = await db.query(
      'SELECT COUNT(*)::int AS like_count FROM comment_likes WHERE comment_id = $1',
      [String(commentId)],
    )
    return res.json({
      success: true,
      postId: String(postId),
      commentId: String(commentId),
      channelId: String(channelId),
      liked,
      likeCount: Number(countRes.rows?.[0]?.like_count || 0),
    })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/posts/:id/comments ────────────────────────────
router.post('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const { id: postId } = req.params
    const { content, attachmentIds = [], channelId, security_level } = req.body
    const resolvedChannelId = channelId || (await resolveChannelIdForPost(postId))
    if (!resolvedChannelId) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' })
    const allowed = await canAccessChannel(db, req.user, resolvedChannelId)
    if (!allowed) return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    const safeContent = String(content || '').trim()
    const safeAttachmentIds = Array.isArray(attachmentIds) ? attachmentIds.filter(Boolean) : []
    if (!safeContent && safeAttachmentIds.length === 0) {
      return res.status(400).json({ error: 'content or attachment is required' })
    }
    if (safeAttachmentIds.length > 10) {
      return res.status(400).json({ error: '첨부파일은 최대 10개까지만 가능합니다.' })
    }

    const isSiteAdmin = req.user.role === 'site_admin'
    const userLevel = isSiteAdmin ? 4 : (req.user.security_level ?? 0)
    const defaultLevel = Math.min(1, userLevel)
    const safeCommentLevel = Math.min(Math.max(parseInt(security_level ?? defaultLevel) || 0, 0), userLevel)

    const commentId = `c-${randomUUID()}`
    const createdAt = new Date()

    // ── Cassandra write ───────────────────────────────────────
    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })
    await client.execute(
      `INSERT INTO comments (post_id, id, channel_id, author_id, content, attachments, security_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [postId, commentId, resolvedChannelId, req.user.id, safeContent, safeAttachmentIds, safeCommentLevel, createdAt],
      { prepare: true }
    )
    await db.query(
      `INSERT INTO comments (
         id, post_id, channel_id, author_id, content, attachments, security_level, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (id)
       DO UPDATE SET
         post_id = EXCLUDED.post_id,
         channel_id = EXCLUDED.channel_id,
         author_id = EXCLUDED.author_id,
         content = EXCLUDED.content,
         attachments = EXCLUDED.attachments,
         security_level = EXCLUDED.security_level,
         updated_at = NOW()`,
      [commentId, postId, resolvedChannelId, req.user.id, safeContent, JSON.stringify(safeAttachmentIds), safeCommentLevel, createdAt],
    ).catch(e => console.warn('[PostgresMirror] comment upsert 실패:', e.message))
    await upsertSearchDocument({
      sourceType: 'comment',
      sourceId: commentId,
      postId,
      channelId: resolvedChannelId,
      authorId: req.user.id,
      content: safeContent,
      securityLevel: safeCommentLevel,
      createdAt,
    }).catch(e => console.warn('[SearchIndex] comment upsert 실패:', e.message))
    if (safeAttachmentIds.length > 0) {
      await ensureAttachmentRefTable().catch(() => {})
      await db.query(
        'UPDATE attachments SET comment_id = $1 WHERE id = ANY($2)',
        [commentId, safeAttachmentIds],
      ).catch(e => console.warn('[PostgresMirror] attachment comment_id update 실패:', e.message))
    }
    indexImageAttachmentsForSearchAsync(safeAttachmentIds.map(attachmentId => ({
      attachmentId,
      postId,
      commentId,
      channelId: resolvedChannelId,
      authorId: req.user.id,
      securityLevel: safeCommentLevel,
      createdAt,
    })))
    await linkAttachments(postId, safeAttachmentIds)
    await syncAttachmentRefs({
      ownerType: 'comment',
      ownerId: commentId,
      nextAttachmentIds: safeAttachmentIds,
      actorUserId: req.user?.id,
    })

    // 새 댓글을 comments_by_id 룩업 테이블에도 기록
    await client.execute(
      'INSERT INTO comments_by_id (id, post_id, created_at, author_id) VALUES (?, ?, ?, ?)',
      [commentId, postId, createdAt, req.user.id], { prepare: true }
    )

    // 방금 등록한 댓글을 전체 정보와 함께 반환
    const comments = await fetchComments(postId, req.user)
    const newComment = comments.find(c => c.id === commentId)

    // 업로드 즉시 LanceDB 임베딩 (비동기, 응답에 영향 없음)
    markTrainingStarted('comment', commentId)
    ;(async () => {
      const success = await trainCommentImmediate({
        id: commentId,
        post_id: postId,
        channel_id: channelId || '',
        content: safeContent,
        attachmentIds: safeAttachmentIds,
      })
      if (success) markTrainingCompleted('comment', commentId)
      else clearTrainingStatus('comment', commentId)
    })()

    notifyMentionedUsers(safeContent, {
      channelId: channelId || (await findPostLocator(postId))?.channel_id || '',
      postId,
      commentId,
      attachmentIds: safeAttachmentIds,
    })
    notifyAuthorTelegramPostRegistered({
      authorId: req.user.id,
      channelId: channelId || (await findPostLocator(postId))?.channel_id || '',
      postId,
      commentId,
      attachmentIds: safeAttachmentIds,
      content: safeContent,
    })

    res.status(201).json(newComment)
  } catch (err) {
    next(err)
  }
})

// ─── PUT /api/posts/:postId/comments/:commentId ───────────────
router.put('/:postId/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const { postId, commentId } = req.params
    const { content, attachments = [], security_level } = req.body
    const attachmentIds = (Array.isArray(attachments) ? attachments : [])
      .map(item => (typeof item === 'object' ? item.id : item))
      .filter(Boolean)
    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })
    const row = await findCommentLocator(postId, commentId)
    if (!row) return res.status(404).json({ error: '댓글을 찾을 수 없습니다.' })
    const resolvedChannelId = await resolveChannelIdForPost(postId)
    if (!(await canMutateCommentRow(req.user, { ...row, channel_id: resolvedChannelId }))) {
      return res.status(403).json({ error: '권한이 없습니다.' })
    }
    const userLevel = securityLevelOf(req.user)
    const safeLevel = (security_level != null) ? Math.min(Math.max(parseInt(security_level) || 0, 0), userLevel) : undefined
    if (safeLevel !== undefined) {
      await client.execute(
        'UPDATE comments SET content = ?, attachments = ?, security_level = ? WHERE post_id = ? AND created_at = ?',
        [content, attachmentIds, safeLevel, row.post_id, row.created_at], { prepare: true }
      )
    } else {
      await client.execute(
        'UPDATE comments SET content = ?, attachments = ? WHERE post_id = ? AND created_at = ?',
        [content, attachmentIds, row.post_id, row.created_at], { prepare: true }
      )
    }
    await db.query(
      `UPDATE comments
       SET content = $1,
           attachments = $2,
           security_level = COALESCE($3, security_level),
           updated_at = NOW()
       WHERE id = $4`,
      [content, JSON.stringify(attachmentIds), safeLevel ?? null, commentId],
    ).catch(e => console.warn('[PostgresMirror] comment update 실패:', e.message))
    await upsertSearchDocument({
      sourceType: 'comment',
      sourceId: commentId,
      postId,
      channelId: resolvedChannelId,
      authorId: row.author_id,
      content,
      securityLevel: safeLevel ?? 0,
      createdAt: row.created_at,
    }).catch(e => console.warn('[SearchIndex] comment update 실패:', e.message))
    if (attachmentIds.length > 0) {
      await ensureAttachmentRefTable().catch(() => {})
      await db.query(
        'UPDATE attachments SET comment_id = $1 WHERE id = ANY($2)',
        [commentId, attachmentIds],
      ).catch(e => console.warn('[PostgresMirror] attachment comment_id update 실패:', e.message))
    }
    indexImageAttachmentsForSearchAsync(attachmentIds.map(attachmentId => ({
      attachmentId,
      postId,
      commentId,
      channelId: resolvedChannelId,
      authorId: row.author_id,
      securityLevel: safeLevel ?? 0,
      createdAt: row.created_at,
    })))
    await syncAttachmentRefs({
      ownerType: 'comment',
      ownerId: commentId,
      nextAttachmentIds: attachmentIds,
      actorUserId: req.user?.id,
    })
    await linkAttachments(postId, attachmentIds)

    // 수정 즉시: 기존 벡터 삭제 후 재학습 (비동기, 응답 비차단)
    markTrainingStarted('comment', commentId)
    ;(async () => {
      const success = await retrainCommentImmediate({
        id: commentId,
        post_id: postId,
        content,
        attachmentIds,
      })
      if (success) markTrainingCompleted('comment', commentId)
      else clearTrainingStatus('comment', commentId)
    })()

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /api/posts/:postId/comments/:commentId (소프트 삭제) ────
router.delete('/:postId/comments/:commentId', requireAuth, async (req, res, next) => {
  try {
    const { postId, commentId } = req.params

    if (!isConnected()) return res.status(503).json({ error: 'Cassandra 연결이 필요합니다.' })
    const row = await findCommentLocator(postId, commentId)
    if (!row) return res.status(404).json({ error: '댓글을 찾을 수 없습니다.' })
    const isSiteAdmin = req.user.role === 'site_admin'
    if (!isSiteAdmin && String(row.author_id) !== String(req.user.id)) {
      return res.status(403).json({ error: '권한이 없습니다.' })
    }

    await ensureSoftDeleteSchema()
    const commentRowRes = await client.execute(
      'SELECT content FROM comments WHERE post_id = ? AND created_at = ?',
      [row.post_id, row.created_at], { prepare: true },
    )
    const preview = buildPreview(commentRowRes.rows?.[0]?.content || '')
    const locator = await findPostLocator(String(row.post_id)).catch(() => null)
    const channelId = locator?.channel_id || null

    await db.query(
      `INSERT INTO deleted_items (item_type, item_id, channel_id, post_id, author_id, deleted_by, preview, deleted_at)
       VALUES ('comment', $1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (item_type, item_id)
       DO UPDATE SET deleted_at = NOW(), deleted_by = EXCLUDED.deleted_by, preview = EXCLUDED.preview`,
      [String(commentId), channelId, String(row.post_id), row.author_id, req.user.id, preview],
    )

    res.json({
      success: true,
      deleted: { type: 'comment', id: String(commentId), postId: String(row.post_id), channelId, preview, restoreWindowMs: RESTORE_WINDOW_MS },
    })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/posts/:postId/comments/:commentId/restore (댓글 복구) ─
router.post('/:postId/comments/:commentId/restore', requireAuth, async (req, res, next) => {
  try {
    const { commentId } = req.params
    await ensureSoftDeleteSchema()
    const r = await db.query("SELECT * FROM deleted_items WHERE item_type = 'comment' AND item_id = $1", [String(commentId)])
    const item = r.rows[0]
    if (!item) return res.status(404).json({ error: '복구할 댓글을 찾을 수 없습니다.' })

    const isSiteAdmin = req.user.role === 'site_admin'
    if (!isSiteAdmin && String(item.deleted_by) !== String(req.user.id)) {
      return res.status(403).json({ error: '권한이 없습니다.' })
    }
    const ageMs = Date.now() - new Date(item.deleted_at).getTime()
    if (ageMs > RESTORE_WINDOW_MS) {
      return res.status(410).json({ error: '복구 가능 시간(1분)이 지났습니다.' })
    }

    await db.query("DELETE FROM deleted_items WHERE item_type = 'comment' AND item_id = $1", [String(commentId)])
    res.json({ success: true, channelId: item.channel_id, postId: item.post_id })
  } catch (err) {
    next(err)
  }
})

module.exports = router
