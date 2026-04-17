const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const http = require('http')
const { spawn } = require('child_process')
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { getDatabasePath } = require('../databasePaths')
const { getPythonExecutable } = require('../pythonRuntime')

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')
const RAG_SERVER_PORT = 5001

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
  catch (e) { return {} }
}

// ─── 영구 Python RAG 서버 관리 ────────────────────────────────
let ragServerReady = false
let ragServerProc  = null
let ragServerDisabled = false
let ragServerDisableReason = ''

function startRagServer() {
  if (ragServerDisabled) return
  const script = path.resolve(__dirname, '../rag_server.py')
  let fatalImportError = false
  ragServerProc = spawn(getPythonExecutable(), [script, String(RAG_SERVER_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  ragServerProc.stdout.on('data', d => {
    const msg = d.toString()
    process.stdout.write(`[RAG Server] ${msg}`)
    if (msg.includes('시작됨')) ragServerReady = true
  })
  ragServerProc.stderr.on('data', d => {
    const msg = d.toString()
    // 모델 초기화 과정의 정상 stderr 메시지는 억제
    const IGNORE_PATTERNS = [
      'huggingface', 'tokenizer', 'Batches',
      'HF Hub', 'HF_TOKEN', 'unauthenticated',   // HF Hub 인증 경고 (정상)
      'rate limits', 'faster downloads',           // HF Hub 속도 안내 (정상)
      'Loading weights', 'FutureWarning',          // 모델 로드 경고 (정상)
      'UserWarning', 'DeprecationWarning',         // Python 라이브러리 경고 (정상)
      'warnings.warn',
    ]
    const isNoise = IGNORE_PATTERNS.some(p => msg.includes(p))
    if (msg.includes("ModuleNotFoundError: No module named 'torch'")) {
      fatalImportError = true
      ragServerDisabled = true
      ragServerDisableReason = "python module 'torch' is missing"
    }
    if (!isNoise) {
      process.stderr.write(`[RAG Server ERR] ${msg}`)
    }
  })
  ragServerProc.on('close', code => {
    ragServerReady = false
    ragServerProc = null
    if (fatalImportError) {
      console.warn(`[RAG Server] 비활성화됨: ${ragServerDisableReason}. RAG 검색은 subprocess fallback으로 동작합니다.`)
      return
    }
    if (code !== null) {  // 의도적 종료가 아닐 때만 재시작
      console.log(`[RAG Server] 프로세스 종료 (code=${code}), 5초 후 재시작...`)
      setTimeout(startRagServer, 5000)
    }
  })
}

startRagServer()

// ─── 영구 서버 HTTP 호출 ──────────────────────────────────────
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
      res.on('data', d => data += d)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('검색 결과 파싱 실패')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('RAG 서버 타임아웃')) })
    req.write(body)
    req.end()
  })
}

// ─── fallback: 서버 미준비 시 직접 subprocess 호출 ────────────
function callPythonSearchDirect(payload) {
  return new Promise((resolve, reject) => {
    const script = path.resolve(__dirname, '../rag_search.py')
    const proc = spawn(getPythonExecutable(), [script], { timeout: 60000 })
    let out = '', err = ''
    proc.stdin.write(JSON.stringify(payload))
    proc.stdin.end()
    proc.stdout.on('data', d => out += d)
    proc.stderr.on('data', d => err += d)
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err || `exit ${code}`))
      try { resolve(JSON.parse(out)) }
      catch (e) { reject(new Error('검색 결과 파싱 실패')) }
    })
    proc.on('error', reject)
  })
}

function callPythonSearch(payload) {
  if (ragServerReady) return callRagServer(payload)
  return callPythonSearchDirect(payload)
}

// ─── 참고문헌 정보 DB 조회 (병렬 처리) ──────────────────────
async function enrichReferences(results) {
  const seen = new Set()
  const unique = []
  for (const r of results) {
    const { post_id, type, channel_id: metaChannelId, attachment_id, comment_id } = r.metadata
    if (!post_id || post_id === '') continue
    const key = `${post_id}:${type}:${attachment_id || ''}:${comment_id || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ r, post_id, type, metaChannelId, attachment_id, comment_id })
  }

  const settled = await Promise.all(unique.map(async ({ r, post_id, type, metaChannelId, attachment_id, comment_id }) => {
    try {
      // ── channel_id가 메타데이터에 없으면 DB에서 조회 ──
      let channelId = metaChannelId
      if (!channelId) {
        try {
          const cass = require('../cassandra')
          if (cass.isConnected()) {
            const pRes = await cass.client.execute(
              'SELECT channel_id FROM posts WHERE id = ? ALLOW FILTERING',
              [post_id], { prepare: true }
            )
            if (pRes.rows.length > 0) channelId = pRes.rows[0].channel_id
          }
        } catch (_) {}
        if (!channelId) {
          const aRes = await db.query('SELECT channel_id FROM attachments WHERE post_id = $1 LIMIT 1', [post_id])
          if (aRes.rowCount > 0) channelId = aRes.rows[0].channel_id
        }
      }

      // ── 채널/팀 이름 + 첨부파일 이름을 병렬 조회 ──
      const [chRes, fileRes] = await Promise.all([
        channelId
          ? db.query(
              `SELECT c.name AS channel_name, t.name AS team_name
               FROM channels c LEFT JOIN teams t ON t.id = c.team_id
               WHERE c.id = $1 LIMIT 1`,
              [channelId]
            )
          : Promise.resolve({ rowCount: 0, rows: [] }),
        type === 'pdf' && attachment_id
          ? db.query(`SELECT filename FROM attachments WHERE id = $1 LIMIT 1`, [attachment_id])
          : Promise.resolve({ rowCount: 0, rows: [] }),
      ])

      const channelName = chRes.rowCount > 0 ? (chRes.rows[0].channel_name || '') : ''
      const teamName    = chRes.rowCount > 0 ? (chRes.rows[0].team_name    || '') : ''

      const baseRef = {
        channel: channelName,
        channel_id: channelId || '',
        team: teamName,
        post_id,
        attachment_id: attachment_id || '',
        comment_id: comment_id || '',
      }

      if (type === 'pdf') {
        const label = fileRes.rowCount > 0 ? fileRes.rows[0].filename : '첨부 문서'
        return { ...baseRef, type: 'pdf', label }
      } else if (type === 'comment') {
        const preview = (r.text || '').slice(0, 60).replace(/\n/g, ' ')
        return { ...baseRef, type: 'comment', label: preview + ((r.text?.length ?? 0) > 60 ? '…' : '') }
      } else {
        const preview = (r.text || '').slice(0, 60).replace(/\n/g, ' ')
        return { ...baseRef, type: 'post', label: preview + ((r.text?.length ?? 0) > 60 ? '…' : '') }
      }
    } catch (e) {
      console.error('[RAG] 참고문헌 조회 오류:', e.message)
      return null
    }
  }))

  return settled.filter(Boolean)
}

// ─── POST /api/rag/search ─────────────────────────────────────
router.post('/search', requireAuth, async (req, res) => {
  try {
    const { query, limit = 3 } = req.body
    if (!query?.trim()) return res.json({ context: '', references: [] })

    const cfg = readConfig()
    const ragCfg = cfg.rag || {}

    const payload = {
      config: {
        lancedb_path: getDatabasePath(cfg, 'lancedb Database Path'),
        vector_size: ragCfg.vectorSize ?? 1024,
      },
      query,
      limit,
    }

    const results = await callPythonSearch(payload)

    if (!Array.isArray(results) || results.length === 0) {
      return res.json({ context: '', references: [] })
    }

    // init 레코드 제외
    const validResults = results.filter(r => r.text !== '__init__')
    if (validResults.length === 0) {
      return res.json({ context: '', references: [] })
    }

    const context = validResults.map(r => r.text).join('\n\n')
    const references = await enrichReferences(validResults)

    res.json({ context, references })
  } catch (err) {
    console.error('[RAG Search Error]', err.message)
    // 검색 실패 시 RAG 없이 진행할 수 있도록 빈 결과 반환
    res.json({ context: '', references: [] })
  }
})

module.exports = router
