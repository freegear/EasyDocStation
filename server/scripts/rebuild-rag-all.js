#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const { spawn } = require('child_process')

const ROOT_DIR = path.resolve(__dirname, '../..')
const SERVER_DIR = path.resolve(__dirname, '..')

try {
  require('dotenv').config({ path: path.join(SERVER_DIR, '.env') })
} catch (_) {}

const venvPython = path.join(ROOT_DIR, '.venv/bin/python3')
if (!process.env.PYTHON_BIN && fs.existsSync(venvPython)) {
  process.env.PYTHON_BIN = venvPython
}

const db = require('../db')
const { client, initCassandra, isConnected } = require('../cassandra')
const { getDatabasePath } = require('../databasePaths')
const { getPythonExecutable } = require('../pythonRuntime')

const CONFIG_PATH = path.join(ROOT_DIR, 'config.json')
const RAG_TRAIN_PATH = path.join(SERVER_DIR, 'rag_train.py')
const RAG_SERVER_PATH = path.join(SERVER_DIR, 'rag_server.py')
const RAG_SERVER_PORT = Number.parseInt(process.env.RAG_SERVER_PORT || '5001', 10) || 5001
const BATCH_SIZE = Math.max(1, Number.parseInt(process.env.FULL_REBUILD_BATCH_SIZE || '10', 10) || 10)
const KEEP_NO_DATA_ANSWERS = String(process.env.EASYDOC_RAG_KEEP_NO_DATA_ANSWERS || '').trim() === '1'
let ownedRagServer = null
let telegramChatIds = null
let telegramLastSentAt = 0
let trainingSummary = { posts: 0, comments: 0, attachments: 0 }
let trainingProgress = { postsDone: 0, commentsDone: 0, attachmentsDone: 0 }

const IMAGE_CONTENT_TYPES = new Set([
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
const IMAGE_FILE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i
const WORD_FILE_EXT_RE = /\.(doc|docx)$/i

function log(message) {
  const ts = new Date().toISOString()
  console.log(`[${ts}][RAG-REBUILD] ${message}`)
}

function parseChatIds(value = '') {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(v => /^-?[0-9]+$/.test(v))
}

async function resolveTelegramChatIds() {
  if (telegramChatIds) return telegramChatIds
  const envIds = parseChatIds(process.env.EASYDOC_REBUILD_TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
  if (envIds.length > 0) {
    telegramChatIds = [...new Set(envIds)]
    return telegramChatIds
  }
  try {
    const result = await db.query(`
      SELECT telegram_id
      FROM users
      WHERE is_active = true
        AND use_sns_channel = 'telegram'
        AND telegram_id IS NOT NULL
        AND telegram_id ~ '^-?[0-9]+$'
    `)
    telegramChatIds = [...new Set((result.rows || []).map(r => String(r.telegram_id || '').trim()).filter(Boolean))]
  } catch (e) {
    log(`텔레그램 수신자 조회 실패: ${e.message}`)
    telegramChatIds = []
  }
  return telegramChatIds
}

async function notifyTelegram(text, { force = false } = {}) {
  const cfg = readConfig()
  const telegramCfg = cfg?.sns?.telegram || {}
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || telegramCfg.httpApiToken || '').trim()
  const enabled = Boolean(telegramCfg.enabled) || String(process.env.EASYDOC_REBUILD_TELEGRAM_FORCE || '').trim() === '1'
  if (!botToken || !enabled) return

  const now = Date.now()
  const minIntervalMs = Math.max(0, Number.parseInt(process.env.EASYDOC_REBUILD_TELEGRAM_INTERVAL_SEC || '60', 10) || 60) * 1000
  if (!force && telegramLastSentAt && now - telegramLastSentAt < minIntervalMs) return
  telegramLastSentAt = now

  const chatIds = await resolveTelegramChatIds()
  if (chatIds.length === 0) return

  for (const chatId of chatIds) {
    try {
      await new Promise((resolve, reject) => {
        const body = JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        })
        const req = https.request({
          hostname: 'api.telegram.org',
          path: `/bot${botToken}/sendMessage`,
          method: 'POST',
          family: 4,
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, res => {
          let raw = ''
          res.on('data', chunk => { raw += chunk })
          res.on('end', () => {
            let parsed = {}
            try { parsed = raw ? JSON.parse(raw) : {} } catch (_) {}
            if ((res.statusCode || 500) >= 400 || parsed.ok === false) {
              reject(new Error(parsed.description || `HTTP ${res.statusCode}`))
            } else resolve(parsed)
          })
        })
        req.on('timeout', () => req.destroy(new Error('Telegram request timeout')))
        req.on('error', reject)
        req.write(body)
        req.end()
      })
    } catch (e) {
      log(`텔레그램 전송 오류: chat_id=${chatId} ${e.message}`)
    }
  }
}

function totalTrainingUnits() {
  return trainingSummary.posts + trainingSummary.comments + trainingSummary.attachments
}

function formatPercent(value) {
  return `${value.toFixed(2).replace(/\.?0+$/, '')}%`
}

function overallPercent(done = trainingProgress) {
  const total = totalTrainingUnits()
  if (total <= 0) return '0%'
  const current = Math.min(total, done.postsDone + done.commentsDone + done.attachmentsDone)
  return formatPercent((current / total) * 100)
}

function completedTrainingUnits(done = trainingProgress) {
  return Math.min(
    totalTrainingUnits(),
    done.postsDone + done.commentsDone + done.attachmentsDone,
  )
}

function progressSummaryText(done = trainingProgress) {
  return [
    `전체 학습 필요 데이터량: ${totalTrainingUnits()}건`,
    `학습 완료된 데이터량: ${completedTrainingUnits(done)}건`,
    `학습 진행률: ${overallPercent(done)}`,
    `완료 상세: 게시글 ${done.postsDone}/${trainingSummary.posts}, 댓글 ${done.commentsDone}/${trainingSummary.comments}, 첨부 ${done.attachmentsDone}/${trainingSummary.attachments}`,
  ].join('\n')
}

function countTrainerAttachments(items = []) {
  return items.reduce((n, item) => (
    n
    + (item.pdfs?.length || 0)
    + (item.words?.length || 0)
    + (item.txts?.length || 0)
    + (item.images?.length || 0)
    + (item.excels?.length || 0)
    + (item.presentations?.length || 0)
    + (item.markitdown_files?.length || 0)
    + (item.archives?.length || 0)
  ), 0)
}

function extractTrainerFileProgress(line = '') {
  const text = String(line || '').trim()
  const legacy = text.match(/\[RAG\]\s+(PDF|Word|TXT|이미지)\s+학습\s+(시작|완료):\s+(.+?)(?:\s+\(|$)/)
  if (legacy) {
    return { type: legacy[1], status: legacy[2], fileName: legacy[3].trim() }
  }
  const converterStart = text.match(/\[RAG\]\s+(docling|markitdown)\s+학습\s+시작:\s+(.+?)(?:\s+\(([^)]+)\)|$)/i)
  if (converterStart) {
    return { type: converterStart[3] || converterStart[1], status: '시작', fileName: converterStart[2].trim() }
  }
  const converterDone = text.match(/\[RAG\]\s+문서\s+학습\s+완료:\s+(.+?)(?:\s+\(([^,]+),|$)/)
  if (converterDone) {
    return { type: converterDone[2] || '문서', status: '완료', fileName: converterDone[1].trim() }
  }
  return null
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
}

function buildTrainerConfig(cfg, ragCfg) {
  const targetTable = process.env.EASYDOC_RAG_REBUILD_TABLE
    || ragCfg.rebuild_table
    || ragCfg.next_table
    || ragCfg.active_table
    || ragCfg.table_name
    || 'my_rag_table'
  const schemaVersion = Number(
    process.env.EASYDOC_RAG_REBUILD_SCHEMA_VERSION
    || ragCfg.rebuild_schema_version
    || ragCfg.schema_version
    || (String(targetTable).endsWith('_v2') ? 2 : 1)
  )
  return {
    lancedb_path: getDatabasePath(cfg, 'lancedb Database Path'),
    table_name: targetTable,
    rag_table_name: targetTable,
    active_table: ragCfg.active_table || ragCfg.table_name || 'my_rag_table',
    next_table: ragCfg.next_table || 'my_rag_table_v2',
    schema_version: schemaVersion,
    file_training_path: path.resolve(ROOT_DIR, 'Database/ObjectFile/FileTrainingData'),
    chunk_size: ragCfg.chunk_size ?? 800,
    chunk_overlap: ragCfg.chunk_overlap ?? 100,
    vector_size: ragCfg.vectorSize ?? 1024,
    trainer_timeout_sec: ragCfg.trainer_timeout_sec ?? 0,
    pdf_parse_strategy: ragCfg.pdf_parse_strategy ?? 'auto',
    pdf_parse_timeout_sec: ragCfg.pdf_parse_timeout_sec ?? 180,
    document_converter: ragCfg.document_converter ?? 'docling',
    docling_shadow_compare: ragCfg.docling_shadow_compare ?? false,
    docling_fallback_to_markitdown: ragCfg.docling_fallback_to_markitdown ?? true,
    document_convert_max_file_size: ragCfg.document_convert_max_file_size ?? 500 * 1024 * 1024,
  }
}

function normalizeTrainerTimeoutMs(ragCfg = {}) {
  if (String(process.env.EASYDOC_REBUILD_NO_TIMEOUT || '1').trim() === '1') return 0
  const envSec = Number(process.env.EASYDOC_REBUILD_TRAINER_TIMEOUT_SEC)
  const cfgSec = Number(ragCfg.trainer_timeout_sec)
  const sec = Number.isFinite(envSec) && envSec > 0 ? envSec : cfgSec
  if (!Number.isFinite(sec) || sec <= 0) return 0
  const safeSec = sec
  return Math.max(60, Math.floor(safeSec)) * 1000
}

function attachmentIdColumns(row) {
  const ids = []
  for (let i = 1; i <= 10; i += 1) {
    const v = row[`attachments_${i}`]
    if (v) ids.push(String(v))
  }
  return ids
}

function parseAttachmentList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(Boolean).map(String)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : []
    } catch (_) {
      return value ? [value] : []
    }
  }
  return []
}

function isImageAttachment(row = {}) {
  const ct = String(row.content_type || '').toLowerCase()
  const filename = String(row.filename || '')
  return IMAGE_CONTENT_TYPES.has(ct) || IMAGE_FILE_EXT_RE.test(filename)
}

function isWordAttachment(row = {}) {
  const ct = String(row.content_type || '').toLowerCase()
  const filename = String(row.filename || '')
  return ct === 'application/msword'
    || ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || WORD_FILE_EXT_RE.test(filename)
}

function isExcelAttachment(row = {}) {
  const ct = String(row.content_type || '').toLowerCase()
  const filename = String(row.filename || '').toLowerCase()
  return ct === 'application/vnd.ms-excel'
    || ct === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || filename.endsWith('.xls')
    || filename.endsWith('.xlsx')
}

function isPresentationAttachment(row = {}) {
  const ct = String(row.content_type || '').toLowerCase()
  const filename = String(row.filename || '').toLowerCase()
  return ct.includes('powerpoint')
    || ct.includes('presentation')
    || filename.endsWith('.ppt')
    || filename.endsWith('.pptx')
}

function isMarkItDownAttachment(row = {}) {
  const filename = String(row.filename || '').toLowerCase()
  return filename.endsWith('.xml') || filename.endsWith('.html') || filename.endsWith('.htm') || filename.endsWith('.csv')
}

function isZipAttachment(row = {}) {
  const ct = String(row.content_type || '').toLowerCase()
  const filename = String(row.filename || '').toLowerCase()
  return ct === 'application/zip' || ct === 'application/x-zip-compressed' || filename.endsWith('.zip')
}

function isTextAttachment(row = {}) {
  const ct = String(row.content_type || '').toLowerCase()
  const filename = String(row.filename || '').toLowerCase()
  return ct === 'text/plain' || filename.endsWith('.txt') || filename.endsWith('.md') || filename.endsWith('.csv') || filename.endsWith('.log') || filename.endsWith('.json')
}

function toTrainerAttachment(row, storageBase) {
  return {
    id: String(row.id || ''),
    path: path.join(storageBase, row.storage_path || ''),
    file_name: row.filename || '',
  }
}

function classifyAttachments(rows, storageBase) {
  const docs = { pdfs: [], words: [], txts: [], images: [], excels: [], presentations: [], markitdown_files: [], archives: [] }
  for (const row of rows || []) {
    if (!row || !row.storage_path) continue
    const item = toTrainerAttachment(row, storageBase)
    if (!fs.existsSync(item.path)) {
      log(`첨부 파일 없음, 건너뜀: ${item.file_name || row.id} (${item.path})`)
      continue
    }
    const ct = String(row.content_type || '').toLowerCase()
    const filename = String(row.filename || '').toLowerCase()
    if (ct === 'application/pdf' || filename.endsWith('.pdf')) docs.pdfs.push(item)
    else if (isTextAttachment(row)) docs.txts.push(item)
    else if (isImageAttachment(row)) docs.images.push(item)
    else if (isExcelAttachment(row)) docs.excels.push(item)
    else if (isPresentationAttachment(row)) docs.presentations.push(item)
    else if (isMarkItDownAttachment(row)) {
      const ext = path.extname(row.filename || '').replace('.', '').toLowerCase()
      docs.markitdown_files.push({
        ...item,
        doc_type: ext === 'csv' ? 'table' : (ext === 'xml' ? 'structured_xml' : 'html'),
      })
    }
    else if (isZipAttachment(row)) docs.archives.push(item)
    else if (isWordAttachment(row)) docs.words.push(item)
    else {
      log(`파싱 미지원 첨부 형식, 메타데이터만 본문에 포함 예정: ${row.filename || row.id} (${row.content_type || 'unknown'})`)
    }
  }
  return docs
}

function isNoDataAnswer(content = '') {
  if (KEEP_NO_DATA_ANSWERS) return false
  const text = String(content || '')
  return (
    (text.includes('제공된 [참고 정보] 내에서는') && text.includes('찾을 수 없습니다')) ||
    text.includes('RAG 데이터베이스에 해당 질문과 관련된 정보가 없습니다') ||
    text.includes('There is no information related to your question in the RAG database')
  )
}

async function queryAllPosts() {
  if (isConnected()) {
    const result = await client.execute(`
      SELECT id, channel_id, author_id, content, created_at,
             attachments_1, attachments_2, attachments_3, attachments_4, attachments_5,
             attachments_6, attachments_7, attachments_8, attachments_9, attachments_10
      FROM posts ALLOW FILTERING
    `, [], { prepare: true })
    return (result.rows || []).map(row => ({
      id: String(row.id || ''),
      channel_id: row.channel_id || '',
      author_id: row.author_id,
      content: row.content || '',
      created_at: row.created_at || null,
      attachmentIds: attachmentIdColumns(row),
    }))
  }

  const result = await db.query(`
    SELECT id, channel_id, author_id, content, created_at,
           attachments_1, attachments_2, attachments_3, attachments_4, attachments_5,
           attachments_6, attachments_7, attachments_8, attachments_9, attachments_10
    FROM posts
    ORDER BY created_at ASC
  `)
  return (result.rows || []).map(row => ({
    id: String(row.id || ''),
    channel_id: row.channel_id || '',
    author_id: row.author_id,
    content: row.content || '',
    created_at: row.created_at || null,
    attachmentIds: attachmentIdColumns(row),
  }))
}

async function queryAllComments(postChannelMap) {
  if (isConnected()) {
    const result = await client.execute(`
      SELECT id, post_id, author_id, content, attachments, created_at
      FROM comments ALLOW FILTERING
    `, [], { prepare: true })
    return (result.rows || []).map(row => ({
      id: String(row.id || ''),
      post_id: row.post_id ? String(row.post_id) : '',
      channel_id: postChannelMap.get(row.post_id ? String(row.post_id) : '') || '',
      author_id: row.author_id,
      content: row.content || '',
      created_at: row.created_at || null,
      attachmentIds: parseAttachmentList(row.attachments),
    }))
  }

  const result = await db.query(`
    SELECT id, post_id, author_id, content, attachments, created_at
    FROM comments
    ORDER BY created_at ASC
  `)
  return (result.rows || []).map(row => ({
    id: String(row.id || ''),
    post_id: row.post_id ? String(row.post_id) : '',
    channel_id: postChannelMap.get(row.post_id ? String(row.post_id) : '') || '',
    author_id: row.author_id,
    content: row.content || '',
    created_at: row.created_at || null,
    attachmentIds: parseAttachmentList(row.attachments),
  }))
}

async function getPostAttachments(postId, storageBase) {
  const result = await db.query(
    `SELECT id, storage_path, content_type, filename
     FROM attachments
     WHERE post_id = $1 AND status = 'COMPLETED'
     ORDER BY created_at ASC`,
    [postId]
  )
  return classifyAttachments(result.rows || [], storageBase)
}

async function getCommentAttachments(comment, storageBase) {
  const byId = comment.attachmentIds || []
  const rows = []
  if (byId.length > 0) {
    const placeholders = byId.map((_, i) => `$${i + 1}`).join(', ')
    const result = await db.query(
      `SELECT id, storage_path, content_type, filename
       FROM attachments
       WHERE id IN (${placeholders}) AND status = 'COMPLETED'
       ORDER BY created_at ASC`,
      byId
    )
    rows.push(...(result.rows || []))
  }

  if (comment.id) {
    const result = await db.query(
      `SELECT id, storage_path, content_type, filename
       FROM attachments
       WHERE comment_id = $1 AND status = 'COMPLETED'
       ORDER BY created_at ASC`,
      [comment.id]
    )
    const seen = new Set(rows.map(r => String(r.id)))
    for (const row of result.rows || []) {
      if (!seen.has(String(row.id))) rows.push(row)
    }
  }

  return classifyAttachments(rows, storageBase)
}

function appendUnsupportedAttachmentNotice(content, docs, allAttachmentCount) {
  const knownCount = docs.pdfs.length + docs.words.length + docs.txts.length + docs.images.length
    + docs.excels.length + docs.presentations.length + docs.markitdown_files.length + docs.archives.length
  if (allAttachmentCount <= knownCount) return content || ''
  const suffix = `[RAG 재학습 참고] 파싱 미지원 첨부 ${allAttachmentCount - knownCount}개가 있어 원문 대신 파일 메타데이터만 확인되었습니다.`
  return [content || '', suffix].filter(Boolean).join('\n\n')
}

async function buildTrainerPosts(posts, storageBase) {
  const out = []
  let excludedNoData = 0
  for (const post of posts) {
    if (!post.id) continue
    if (isNoDataAnswer(post.content)) {
      excludedNoData += 1
      continue
    }
    const docs = await getPostAttachments(post.id, storageBase)
    out.push({
      id: post.id,
      channel_id: post.channel_id || '',
      content: appendUnsupportedAttachmentNotice(post.content || '', docs, post.attachmentIds?.length || 0),
      source: 'post',
      ...docs,
    })
  }
  if (excludedNoData) log(`이전 AI 실패 답변 게시글 제외: ${excludedNoData}건`)
  return out
}

async function buildTrainerComments(comments, storageBase) {
  const out = []
  let excludedNoData = 0
  for (const comment of comments) {
    if (!comment.id) continue
    if (isNoDataAnswer(comment.content)) {
      excludedNoData += 1
      continue
    }
    const docs = await getCommentAttachments(comment, storageBase)
    out.push({
      id: comment.id,
      post_id: comment.post_id || '',
      channel_id: comment.channel_id || '',
      content: appendUnsupportedAttachmentNotice(comment.content || '', docs, comment.attachmentIds?.length || 0),
      ...docs,
    })
  }
  if (excludedNoData) log(`이전 AI 실패 답변 댓글 제외: ${excludedNoData}건`)
  return out
}

function callPythonTrainer(payload, timeoutMs, onStdoutLine) {
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd: SERVER_DIR,
      env: process.env,
    }
    if (timeoutMs > 0) spawnOptions.timeout = timeoutMs

    const proc = spawn(getPythonExecutable(), [RAG_TRAIN_PATH], spawnOptions)
    let stderr = ''
    let stdoutBuffer = ''
    proc.stdout.on('data', d => {
      const chunk = d.toString()
      process.stdout.write(chunk)
      if (!onStdoutLine) return
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) onStdoutLine(line)
    })
    proc.stderr.on('data', d => {
      stderr += d.toString()
      process.stderr.write(d)
    })
    proc.on('close', (code, signal) => {
      if (onStdoutLine && stdoutBuffer.trim()) onStdoutLine(stdoutBuffer)
      if (code === 0) resolve()
      else {
        const reason = [
          `rag_train.py 실패`,
          `exit code=${code ?? 'none'}`,
          `signal=${signal || 'none'}`,
          `timeout=${timeoutMs > 0 ? `${Math.round(timeoutMs / 1000)}초` : '없음'}`,
        ].join(' / ')
        const detail = stderr.trim()
        reject(new Error(detail ? `${reason}\n\nstderr:\n${detail}` : reason))
      }
    })
    proc.on('error', reject)
    proc.stdin.write(JSON.stringify(payload))
    proc.stdin.end()
  })
}

function probeRagServer(timeoutMs = 700) {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: RAG_SERVER_PORT,
      path: '/',
      method: 'GET',
      timeout: timeoutMs,
    }, res => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

async function waitForRagServer(timeoutMs = 120000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await probeRagServer(1000)) return true
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return false
}

async function ensureRagServerForEmbedding() {
  if (await probeRagServer(1000)) {
    log(`기존 RAG 임베딩 서버 사용: 127.0.0.1:${RAG_SERVER_PORT}`)
    return
  }

  log(`임시 RAG 임베딩 서버 시작: 127.0.0.1:${RAG_SERVER_PORT}`)
  ownedRagServer = spawn(getPythonExecutable(), [RAG_SERVER_PATH, String(RAG_SERVER_PORT)], {
    cwd: SERVER_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  ownedRagServer.stdout.on('data', d => process.stdout.write(`[RAG-EMBED] ${d}`))
  ownedRagServer.stderr.on('data', d => process.stderr.write(`[RAG-EMBED-ERR] ${d}`))
  ownedRagServer.on('close', code => {
    if (ownedRagServer) log(`임시 RAG 임베딩 서버 종료: code=${code}`)
    ownedRagServer = null
  })

  const ready = await waitForRagServer()
  if (!ready) {
    throw new Error(`RAG 임베딩 서버가 준비되지 않았습니다: 127.0.0.1:${RAG_SERVER_PORT}`)
  }
}

function stopOwnedRagServer() {
  if (!ownedRagServer) return
  const proc = ownedRagServer
  ownedRagServer = null
  try { proc.kill('SIGTERM') } catch (_) {}
}

function batches(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function trainInBatches({ posts, comments, trainerConfig, timeoutMs }) {
  const postBatches = batches(posts, BATCH_SIZE)
  const commentBatches = batches(comments, BATCH_SIZE)

  for (let i = 0; i < postBatches.length; i += 1) {
    const batch = postBatches[i]
    const start = trainingProgress.postsDone + 1
    const end = trainingProgress.postsDone + batch.length
    const batchAttachmentCount = countTrainerAttachments(batch)
    const attachmentsBeforeBatch = trainingProgress.attachmentsDone
    const currentPercent = overallPercent({
      ...trainingProgress,
      postsDone: end,
    })
    log(`게시글 배치 학습 ${i + 1}/${postBatches.length}: ${batch.length}건`)
    await notifyTelegram(`EasyDocStation RAG 재학습 진행 중

단계: 게시글 학습
게시글: 총 ${trainingSummary.posts}건 중 ${start}-${end}건 학습 중
이번 배치: 게시글 ${batch.length}건, 첨부 ${batchAttachmentCount}건
예상 진행률(현재 배치 포함): ${currentPercent}

${progressSummaryText()}

전체 대상: 게시글 ${trainingSummary.posts}건, 댓글 ${trainingSummary.comments}건, 첨부 ${trainingSummary.attachments}건`, { force: true })
    await callPythonTrainer({ config: trainerConfig, posts: batch, comments: [] }, timeoutMs, line => {
      const fileProgress = extractTrainerFileProgress(line)
      if (!fileProgress) return
      if (fileProgress.status === '완료') {
        trainingProgress.attachmentsDone = Math.min(trainingSummary.attachments, trainingProgress.attachmentsDone + 1)
      }
      notifyTelegram(`EasyDocStation RAG 파일 학습 ${fileProgress.status}

단계: 게시글 첨부
파일: ${fileProgress.fileName}
형식: ${fileProgress.type}
첨부: 총 ${trainingSummary.attachments}건 중 ${Math.min(trainingProgress.attachmentsDone + (fileProgress.status === '시작' ? 1 : 0), trainingSummary.attachments)}건 처리 중
${progressSummaryText()}`, { force: false }).catch(() => {})
    })
    // 파일별 로그가 없는 빈/미지원 문서도 배치가 성공하면 처리 완료로 계산한다.
    trainingProgress.attachmentsDone = Math.min(
      trainingSummary.attachments,
      Math.max(trainingProgress.attachmentsDone, attachmentsBeforeBatch + batchAttachmentCount),
    )
    trainingProgress.postsDone = end
    await notifyTelegram(`EasyDocStation RAG 게시글 배치 완료

게시글: 총 ${trainingSummary.posts}건 중 ${trainingProgress.postsDone}건 완료
${progressSummaryText()}`, { force: true })
  }

  for (let i = 0; i < commentBatches.length; i += 1) {
    const batch = commentBatches[i]
    const start = trainingProgress.commentsDone + 1
    const end = trainingProgress.commentsDone + batch.length
    const batchAttachmentCount = countTrainerAttachments(batch)
    const attachmentsBeforeBatch = trainingProgress.attachmentsDone
    const currentPercent = overallPercent({
      ...trainingProgress,
      commentsDone: end,
    })
    log(`댓글 배치 학습 ${i + 1}/${commentBatches.length}: ${batch.length}건`)
    await notifyTelegram(`EasyDocStation RAG 재학습 진행 중

단계: 댓글 학습
댓글: 총 ${trainingSummary.comments}건 중 ${start}-${end}건 학습 중
이번 배치: 댓글 ${batch.length}건, 첨부 ${batchAttachmentCount}건
예상 진행률(현재 배치 포함): ${currentPercent}

${progressSummaryText()}

전체 대상: 게시글 ${trainingSummary.posts}건, 댓글 ${trainingSummary.comments}건, 첨부 ${trainingSummary.attachments}건`, { force: true })
    await callPythonTrainer({ config: trainerConfig, posts: [], comments: batch }, timeoutMs, line => {
      const fileProgress = extractTrainerFileProgress(line)
      if (!fileProgress) return
      if (fileProgress.status === '완료') {
        trainingProgress.attachmentsDone = Math.min(trainingSummary.attachments, trainingProgress.attachmentsDone + 1)
      }
      notifyTelegram(`EasyDocStation RAG 파일 학습 ${fileProgress.status}

단계: 댓글 첨부
파일: ${fileProgress.fileName}
형식: ${fileProgress.type}
첨부: 총 ${trainingSummary.attachments}건 중 ${Math.min(trainingProgress.attachmentsDone + (fileProgress.status === '시작' ? 1 : 0), trainingSummary.attachments)}건 처리 중
${progressSummaryText()}`, { force: false }).catch(() => {})
    })
    trainingProgress.attachmentsDone = Math.min(
      trainingSummary.attachments,
      Math.max(trainingProgress.attachmentsDone, attachmentsBeforeBatch + batchAttachmentCount),
    )
    trainingProgress.commentsDone = end
    await notifyTelegram(`EasyDocStation RAG 댓글 배치 완료

댓글: 총 ${trainingSummary.comments}건 중 ${trainingProgress.commentsDone}건 완료
${progressSummaryText()}`, { force: true })
  }
}

async function main() {
  log(`Python: ${getPythonExecutable()}`)
  log(`배치 크기: ${BATCH_SIZE}`)
  await notifyTelegram(`EasyDocStation RAG 전체 재학습 워커가 시작되었습니다.

Python: ${getPythonExecutable()}
배치 크기: ${BATCH_SIZE}`, { force: true })
  if (!KEEP_NO_DATA_ANSWERS) {
    log('"찾을 수 없습니다"류의 이전 AI 실패 답변은 RAG 오염 방지를 위해 제외합니다.')
  }

  await initCassandra()

  const cfg = readConfig()
  const ragCfg = cfg.rag || {}
  const trainerConfig = buildTrainerConfig(cfg, ragCfg)
  const timeoutMs = normalizeTrainerTimeoutMs(ragCfg)
  const storageBase = getDatabasePath(cfg, 'ObjectFile Path')

  log(`ObjectFile Path: ${storageBase}`)
  log(`LanceDB Path: ${trainerConfig.lancedb_path}`)
  log(`RAG target table: ${trainerConfig.table_name} (schema=${trainerConfig.schema_version})`)
  log(`배치 학습 시간 제한: ${timeoutMs > 0 ? `${Math.round(timeoutMs / 1000)}초` : '없음'}`)

  await ensureRagServerForEmbedding()

  const activeTable = ragCfg.active_table || ragCfg.table_name || 'my_rag_table'
  if (
    trainerConfig.table_name === activeTable
    && String(process.env.EASYDOC_RAG_REBUILD_ALLOW_ACTIVE_TABLE || '').trim() !== '1'
  ) {
    throw new Error(`활성 RAG 테이블 재학습 차단: target=${trainerConfig.table_name}. 별도 버전 테이블을 지정하세요.`)
  }

  if (String(process.env.EASYDOC_RAG_REBUILD_RESET_TABLE || '1') !== '0') {
    log(`RAG 대상 테이블 초기화: ${trainerConfig.table_name}`)
    await callPythonTrainer({
      config: { ...trainerConfig, reset_table: true },
      reset_table: true,
      posts: [],
      comments: [],
    }, timeoutMs, null)
  }

  const rawPosts = await queryAllPosts()
  const postChannelMap = new Map(rawPosts.map(p => [String(p.id), String(p.channel_id || '')]))
  const rawComments = await queryAllComments(postChannelMap)

  log(`조회 완료: 게시글 ${rawPosts.length}건, 댓글 ${rawComments.length}건`)

  const posts = await buildTrainerPosts(rawPosts, storageBase)
  const comments = await buildTrainerComments(rawComments, storageBase)

  const countAttachments = item => (
    item.pdfs.length + item.words.length + item.txts.length + item.images.length
    + item.excels.length + item.presentations.length + item.markitdown_files.length + item.archives.length
  )
  const postAttachmentCount = posts.reduce((n, p) => n + countAttachments(p), 0)
  const commentAttachmentCount = comments.reduce((n, c) => n + countAttachments(c), 0)
  trainingSummary = {
    posts: posts.length,
    comments: comments.length,
    attachments: postAttachmentCount + commentAttachmentCount,
  }
  trainingProgress = { postsDone: 0, commentsDone: 0, attachmentsDone: 0 }
  log(`학습 대상: 게시글 ${posts.length}건, 댓글 ${comments.length}건, 첨부 ${postAttachmentCount + commentAttachmentCount}건`)
  await notifyTelegram(`EasyDocStation RAG 재학습 대상 조회 완료

게시글: ${posts.length}건
댓글: ${comments.length}건
첨부: ${postAttachmentCount + commentAttachmentCount}건`, { force: true })

  await notifyTelegram(`EasyDocStation RAG 전체 재학습 진행률

${progressSummaryText()}`, { force: true })

  await trainInBatches({ posts, comments, trainerConfig, timeoutMs })
  trainingProgress = { ...trainingSummary, postsDone: trainingSummary.posts, commentsDone: trainingSummary.comments, attachmentsDone: trainingSummary.attachments }
  log('전체 RAG 재학습 워커 완료')
  await notifyTelegram(`EasyDocStation RAG 전체 재학습 워커 완료

게시글: ${trainingSummary.posts}건
댓글: ${trainingSummary.comments}건
첨부: ${trainingSummary.attachments}건

${progressSummaryText()}`, { force: true })
}

main()
  .catch(err => {
    console.error(`[${new Date().toISOString()}][RAG-REBUILD] 실패:`, err)
    notifyTelegram(`EasyDocStation RAG 전체 재학습 워커 실패

오류: ${err?.message || err}`, { force: true }).catch(() => {})
    process.exitCode = 1
  })
  .finally(async () => {
    stopOwnedRagServer()
    try { await db.end() } catch (_) {}
    try { await client.shutdown() } catch (_) {}
  })
