const express     = require('express')
const router      = express.Router()
const path        = require('path')
const fs          = require('fs')
const { spawn }   = require('child_process')
const db          = require('../db')
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
    const proc   = spawn('python3', [script], { timeout: 60000 })
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

  for (const r of results) {
    const { post_id, type, channel_id: metaChannelId } = r.metadata
    if (!post_id || post_id === '') continue

    const key = `${post_id}:${type}`
    if (seen.has(key)) continue
    seen.add(key)

    try {
      // ── 채널/팀 이름: channel_id가 메타데이터에 있으면 직접 조회 ──
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
          teamName    = chRes.rows[0].team_name    || ''
        }
      }

      if (type === 'pdf') {
        const res = await db.query(
          `SELECT filename FROM attachments
           WHERE post_id = $1 AND content_type = 'application/pdf'
           LIMIT 1`,
          [post_id]
        )
        if (res.rowCount > 0) {
          refs.push({
            type:       'pdf',
            label:      res.rows[0].filename,
            channel:    channelName,
            channel_id: metaChannelId || '',
            team:       teamName,
            post_id,
          })
        }
      } else if (type === 'comment') {
        const preview = (r.text || '').slice(0, 60).replace(/\n/g, ' ')
        refs.push({
          type:       'comment',
          label:      preview + ((r.text?.length ?? 0) > 60 ? '…' : ''),
          channel:    channelName,
          channel_id: metaChannelId || '',
          team:       teamName,
          post_id,
        })
      } else {
        // post / manual_text: PostgreSQL에서 내용 조회 (Cassandra 전용이면 r.text 사용)
        const res = await db.query(
          'SELECT content FROM posts WHERE id = $1 LIMIT 1',
          [post_id]
        )
        const content = res.rowCount > 0 ? (res.rows[0].content || '') : (r.text || '')
        const preview = content.slice(0, 60).replace(/\n/g, ' ')
        refs.push({
          type:       'post',
          label:      preview + (content.length > 60 ? '…' : ''),
          channel:    channelName,
          channel_id: metaChannelId || '',
          team:       teamName,
          post_id,
        })
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
        vector_size:  ragCfg.vectorSize ?? 1024,
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

    const context    = validResults.map(r => r.text).join('\n\n')
    const references = await enrichReferences(validResults)

    res.json({ context, references })
  } catch (err) {
    console.error('[RAG Search Error]', err.message)
    // 검색 실패 시 RAG 없이 진행할 수 있도록 빈 결과 반환
    res.json({ context: '', references: [] })
  }
})

module.exports = router
