const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const db = require('../db')
const requireAuth = require('../middleware/auth')

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
  catch (e) { return {} }
}

// ─── Python 검색 스크립트 호출 ────────────────────────────────
function callPythonSearch(payload) {
  return new Promise((resolve, reject) => {
    const script = path.resolve(__dirname, '../rag_search.py')
    const proc = spawn('python3', [script], { timeout: 60000 })
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

// ─── 참고문헌 정보 DB 조회 ────────────────────────────────────
async function enrichReferences(results) {
  const refs = []
  const seen = new Set()

  // Cassandra 클라이언트 (필요 시)
  let cassandraClient = null
  try {
    const cass = require('../cassandra')
    if (cass.isConnected()) cassandraClient = cass.client
  } catch (e) { }

  for (const r of results) {
    let { post_id, type, channel_id: metaChannelId, attachment_id, comment_id } = r.metadata
    if (!post_id || post_id === '') continue

    const key = `${post_id}:${type}:${attachment_id || ''}:${comment_id || ''}`
    if (seen.has(key)) continue
    seen.add(key)

    try {
      // ── channel_id가 메타데이터에 없으면 DB에서 찾기 (fallback) ──
      if (!metaChannelId) {
        // ... (existing fallback logic)
        const pRes = await db.query('SELECT channel_id FROM posts WHERE id = $1 LIMIT 1', [post_id])
        if (pRes.rowCount > 0) {
          metaChannelId = pRes.rows[0].channel_id
        } else {
          const aRes = await db.query('SELECT channel_id FROM attachments WHERE post_id = $1 LIMIT 1', [post_id])
          if (aRes.rowCount > 0) metaChannelId = aRes.rows[0].channel_id
        }
      }

      // ── 채널/팀 이름 조회 ──
      let channelName = '', teamName = ''
      if (metaChannelId) {
        const chRes = await db.query(
          `SELECT c.name AS channel_name, t.name AS team_name
           FROM channels c LEFT JOIN teams t ON t.id = c.team_id
           WHERE c.id = $1 LIMIT 1`,
          [metaChannelId]
        )
        if (chRes.rowCount > 0) {
          channelName = chRes.rows[0].channel_name || ''
          teamName = chRes.rows[0].team_name || ''
        }
      }

      const baseRef = {
        channel: channelName,
        channel_id: metaChannelId || '',
        team: teamName,
        post_id,
        attachment_id: attachment_id || '',
        comment_id: comment_id || ''
      }

      if (type === 'pdf') {
        const res = await db.query(
          `SELECT filename FROM attachments WHERE id = $1 LIMIT 1`,
          [attachment_id]
        )
        const label = res.rowCount > 0 ? res.rows[0].filename : '첨부 문서'
        refs.push({ ...baseRef, type: 'pdf', label })
      } else if (type === 'comment') {
        const preview = (r.text || '').slice(0, 60).replace(/\n/g, ' ')
        refs.push({ ...baseRef, type: 'comment', label: preview + ((r.text?.length ?? 0) > 60 ? '…' : '') })
      } else {
        // post / manual_text
        const preview = (r.text || '').slice(0, 60).replace(/\n/g, ' ')
        refs.push({ ...baseRef, type: 'post', label: preview + ((r.text?.length ?? 0) > 60 ? '…' : '') })
      }
    } catch (e) {
      console.error('[RAG] 참고문헌 조회 오류:', e.message)
    }
  }
  return refs
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
        lancedb_path: cfg['lancedb Database Path'] || '/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB',
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
