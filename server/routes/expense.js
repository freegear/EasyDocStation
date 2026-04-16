const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const { randomUUID } = require('crypto')
const { client: cassClient, keyspace, isConnected } = require('../cassandra')
const requireAuth = require('../middleware/auth')
const { trainExpenseImmediate, retrainExpenseImmediate } = require('../rag')
const db = require('../db')

// ── 파일 저장 경로 (기존 ObjectFile 하위 expense/ 폴더) ───────────
const configPath = path.resolve(__dirname, '../../config.json')
let config = {}
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch (_) {}
const STORAGE_BASE = config['ObjectFile Path'] || path.join(__dirname, '../../Database/ObjectFile')
const EXPENSE_DIR = path.join(STORAGE_BASE, 'expense')
if (!fs.existsSync(EXPENSE_DIR)) fs.mkdirSync(EXPENSE_DIR, { recursive: true })

// ── {YYYYMM}-{postId} 폴더 경로 생성 헬퍼 ──────────────────────
function resolveSubDir(postId) {
  const now = new Date()
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  const safeId = (postId || 'UNKNOWN').replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 64)
  const folderName = `${yyyymm}-${safeId}`
  const subDir = path.join(EXPENSE_DIR, folderName)
  if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true })
  return { subDir, folderName }
}

// ── GET /api/expense/next-doc-no ─ 날짜별 순번 문서번호 발급 ──
router.get('/next-doc-no', requireAuth, async (req, res) => {
  try {
    const now = new Date()
    const dateKey = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const result = await db.query(
      `INSERT INTO expense_doc_counter (date_key, last_seq) VALUES ($1, 1)
       ON CONFLICT (date_key) DO UPDATE SET last_seq = expense_doc_counter.last_seq + 1
       RETURNING last_seq`,
      [dateKey]
    )
    const seq = result.rows[0].last_seq
    const docNo = `EXP-${dateKey}-${String(seq).padStart(3, '0')}`
    res.json({ docNo })
  } catch (err) {
    console.error('[Expense DocNo Error]', err.message)
    res.status(500).json({ error: '문서번호 생성 실패: ' + err.message })
  }
})

// ── GET /api/expense/load?postId=xxx ─ 저장된 첨부파일 목록 반환 ─
router.get('/load', requireAuth, async (req, res) => {
  const { postId } = req.query
  if (!postId) return res.json({ attachments: [] })
  if (!isConnected()) return res.json({ attachments: [] })

  try {
    const postRes = await cassClient.execute(
      `SELECT first_attachment_id, form_data FROM ${keyspace}.expense_posts WHERE post_id = ?`,
      [postId], { prepare: true }
    )
    if (postRes.rows.length === 0) return res.json({ attachments: [], formData: null })

    let formData = null
    try { formData = postRes.rows[0].form_data ? JSON.parse(postRes.rows[0].form_data) : null } catch (_) {}

    if (!postRes.rows[0].first_attachment_id) {
      return res.json({ attachments: [], formData })
    }

    // 체인 순회 (무한 루프 방지용 visited set)
    const attachments = []
    let currentId = postRes.rows[0].first_attachment_id
    const visited = new Set()

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const attRes = await cassClient.execute(
        `SELECT attachment_id, file_url, file_name, order_index, next_attachment_id
         FROM ${keyspace}.expense_attachments WHERE attachment_id = ?`,
        [currentId], { prepare: true }
      )
      if (attRes.rows.length === 0) break
      const row = attRes.rows[0]
      attachments.push({
        attachmentId: row.attachment_id,
        url: row.file_url,
        fileName: row.file_name,
        orderIndex: row.order_index ?? 0,
      })
      currentId = row.next_attachment_id || null
    }

    attachments.sort((a, b) => a.orderIndex - b.orderIndex)
    res.json({ attachments, formData })
  } catch (err) {
    console.error('[Expense Load Error]', err.message)
    res.json({ attachments: [] })
  }
})

// ── GET /api/expense/image/:folder/:filename ─ 첨부 이미지 서빙 ──
router.get('/image/:folder/:filename', (req, res) => {
  const safeFolder = path.basename(req.params.folder)
  const safeFile   = path.basename(req.params.filename)
  const fullPath = path.join(EXPENSE_DIR, safeFolder, safeFile)
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' })
  res.sendFile(fullPath)
})

// ── POST /api/expense/save ─ 지출결의서 저장 ─────────────────────
router.post('/save', requireAuth, async (req, res) => {
  try {
    const { postId, channelId, securityLevel, docNo, formData, attachments } = req.body
    const department = formData?.department || ''
    if (!postId) return res.status(400).json({ error: 'postId는 필수입니다.' })
    if (!isConnected()) return res.status(503).json({ error: 'Cassandra가 연결되어 있지 않습니다.' })

    const now = new Date()
    const { subDir, folderName } = resolveSubDir(postId)

    // ── 첨부 이미지 저장 + expense_attachments 체인 생성 ──────────
    const attNodes = []
    if (Array.isArray(attachments) && attachments.length > 0) {
      for (let i = 0; i < attachments.length; i++) {
        const { fileName, base64, mimeType } = attachments[i]
        if (!base64) continue

        const attId = randomUUID()
        const rawExt = (fileName || 'jpg').split('.').pop().replace(/[^a-zA-Z0-9]/g, '') || 'jpg'
        const diskName = `${attId}.${rawExt}`
        const diskPath = path.join(subDir, diskName)

        fs.writeFileSync(diskPath, Buffer.from(base64, 'base64'))

        attNodes.push({
          attId,
          fileName: fileName || `영수증_${i + 1}.jpg`,
          fileUrl: `/api/expense/image/${folderName}/${diskName}`,
        })
      }

      // 체인 INSERT (next_attachment_id = 다음 노드의 ID)
      for (let i = 0; i < attNodes.length; i++) {
        const nextId = i + 1 < attNodes.length ? attNodes[i + 1].attId : null
        await cassClient.execute(
          `INSERT INTO ${keyspace}.expense_attachments
           (attachment_id, post_id, file_url, file_name, order_index, next_attachment_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [attNodes[i].attId, postId, attNodes[i].fileUrl, attNodes[i].fileName, i, nextId, now],
          { prepare: true }
        )
      }
    }

    const firstAttId = attNodes.length > 0 ? attNodes[0].attId : null

    // ── expense_posts INSERT or UPDATE ────────────────────────────
    const existing = await cassClient.execute(
      `SELECT post_id FROM ${keyspace}.expense_posts WHERE post_id = ?`,
      [postId], { prepare: true }
    )

    const formDataJson = formData ? JSON.stringify(formData) : null

    const isUpdate = existing.rows.length > 0

    if (isUpdate) {
      await cassClient.execute(
        `UPDATE ${keyspace}.expense_posts
         SET first_attachment_id = ?, form_data = ?, department = ?, is_edited = true, updated_at = ?
         WHERE post_id = ?`,
        [firstAttId, formDataJson, department, now, postId], { prepare: true }
      )
    } else {
      await cassClient.execute(
        `INSERT INTO ${keyspace}.expense_posts
         (post_id, channel_id, author_id, security_level, first_attachment_id,
          form_data, department, is_edited, prev_post_id, next_post_id, parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, false, null, null, null, ?, ?)`,
        [postId, channelId || '', req.user.id, securityLevel ?? 1, firstAttId,
         formDataJson, department, now, now],
        { prepare: true }
      )
    }

    // RAG 학습 (비동기 — 응답 블로킹 없음)
    if (isUpdate) {
      retrainExpenseImmediate(postId, formData).catch(() => {})
    } else {
      trainExpenseImmediate(postId, formData).catch(() => {})
    }

    res.json({ success: true, attachmentCount: attNodes.length, firstAttachmentId: firstAttId })
  } catch (err) {
    console.error('[Expense Save Error]', err.message)
    res.status(500).json({ error: '저장 중 오류가 발생했습니다: ' + err.message })
  }
})

module.exports = router
