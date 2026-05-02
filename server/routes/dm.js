const express = require('express')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { getDatabasePath } = require('../databasePaths')

const router = express.Router()
router.use(requireAuth)

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')
const DM_EDIT_WINDOW_MS = 10 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

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

async function convertWithLibreOfficeToPdf(inputPath, outDir) {
  const ext = path.extname(inputPath).toLowerCase()
  const preferredFilter = (
    (ext === '.ppt' || ext === '.pptx') ? 'pdf:impress_pdf_Export' :
    (ext === '.doc' || ext === '.docx') ? 'pdf:writer_pdf_Export' :
    (ext === '.xls' || ext === '.xlsx') ? 'pdf:calc_pdf_Export' :
    'pdf'
  )
  const userProfileDir = fs.mkdtempSync(path.join(outDir, 'lo-profile-'))
  const baseArgs = [
    '--headless',
    '--nologo',
    '--nolockcheck',
    '--nodefault',
    '--norestore',
    `-env:UserInstallation=file://${userProfileDir}`,
  ]
  const convertArgsList = preferredFilter === 'pdf'
    ? [['--convert-to', 'pdf', '--outdir', outDir, inputPath]]
    : [
        ['--convert-to', preferredFilter, '--outdir', outDir, inputPath],
        ['--convert-to', 'pdf', '--outdir', outDir, inputPath],
      ]

  let lastErr = null
  for (const cmd of ['libreoffice', 'soffice']) {
    for (const convertArgs of convertArgsList) {
      try {
        await execFileAsync(cmd, [...baseArgs, ...convertArgs], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
        const expected = path.join(outDir, `${path.parse(inputPath).name}.pdf`)
        if (fs.existsSync(expected)) return expected
        const fallbackPdfName = fs.readdirSync(outDir).find(n => n.toLowerCase().endsWith('.pdf'))
        if (fallbackPdfName) return path.join(outDir, fallbackPdfName)
      } catch (err) {
        lastErr = err
      }
    }
  }
  const err = new Error('LibreOffice PDF conversion failed')
  err.cause = lastErr
  throw err
}

async function convertDmOfficeToPdf(storagePath, fullPath) {
  const ext = path.extname(fullPath).toLowerCase()
  const officeExts = new Set(['.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx'])
  if (!officeExts.has(ext)) return null

  const storageBase = getStorageBase()
  const previewBase = path.join(storageBase, 'previews', 'dm')
  if (!fs.existsSync(previewBase)) fs.mkdirSync(previewBase, { recursive: true })

  const key = crypto.createHash('sha1').update(String(storagePath || fullPath)).digest('hex')
  const previewPdfPath = path.join(previewBase, `${key}.pdf`)
  try {
    if (fs.existsSync(previewPdfPath)) {
      const sourceMtime = fs.statSync(fullPath).mtimeMs
      const previewMtime = fs.statSync(previewPdfPath).mtimeMs
      if (previewMtime >= sourceMtime) return previewPdfPath
    }
    const tmpDir = fs.mkdtempSync(path.join(previewBase, 'tmp-'))
    try {
      const sourcePdf = await convertWithLibreOfficeToPdf(fullPath, tmpDir)
      fs.copyFileSync(sourcePdf, previewPdfPath)
      return previewPdfPath
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  } catch (err) {
    console.error('[DM Preview] Office->PDF conversion failed:', err?.cause?.stderr || err?.stderr || err?.message || err)
    return null
  }
}

function getStorageBase() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return getDatabasePath(cfg, 'ObjectFile Path')
  } catch {
    return getDatabasePath({}, 'ObjectFile Path')
  }
}

function getDmRetentionConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const dm = cfg.DirectMessage || {}
    const unlimited = Boolean(dm['무제한보관'])
    const rawDays = Number.parseInt(dm['보존 기한'], 10)
    const retentionDays = Number.isFinite(rawDays) ? Math.min(90, Math.max(1, rawDays)) : 30
    return { unlimited, retentionDays }
  } catch {
    return { unlimited: false, retentionDays: 30 }
  }
}

async function cleanupExpiredDmMessages() {
  const { unlimited, retentionDays } = getDmRetentionConfig()
  if (unlimited) return

  try {
    const { rows: expired } = await db.query(
      `SELECT id, conversation_id
       FROM dm_messages
       WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [retentionDays]
    )
    if (!expired.length) return

    const storageBase = getStorageBase()
    for (const msg of expired) {
      const msgFolder = path.join(storageBase, 'DirectMessage', msg.conversation_id, msg.id)
      try { fs.rmSync(msgFolder, { recursive: true, force: true }) } catch {}
    }

    const ids = expired.map(r => r.id)
    await db.query('DELETE FROM dm_messages WHERE id = ANY($1::varchar[])', [ids])
    console.log(`[DM] Retention cleanup complete: ${ids.length} messages removed.`)
  } catch (err) {
    console.error('[DM] Retention cleanup error:', err)
  }
}

async function telegramPost(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

function pickSubjectParticle(name = '') {
  const text = String(name || '').trim()
  if (!text) return '이'
  const lastChar = text[text.length - 1]
  const code = lastChar.charCodeAt(0)
  // Hangul syllables: AC00-D7A3, final consonant exists when (code - AC00) % 28 !== 0
  if (code >= 0xac00 && code <= 0xd7a3) {
    return ((code - 0xac00) % 28) === 0 ? '가' : '이'
  }
  return '이'
}

async function notifyDmToTelegram({ conversationId, senderId }) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const telegramCfg = config?.sns?.telegram || {}
    if (!telegramCfg.enabled) return
    const botToken = String(telegramCfg.httpApiToken || '').trim()
    if (!botToken) return

    const { rows: senderRows } = await db.query(
      'SELECT username, name, display_name FROM users WHERE id = $1',
      [senderId]
    )
    const sender = senderRows[0] || {}
    const senderName = sender.display_name || sender.name || sender.username || `${senderId}`
    const particle = pickSubjectParticle(senderName)
    const text = `@${senderName} ${particle} 메시지를 보냈습니다.`

    const { rows: targetRows } = await db.query(
      `SELECT DISTINCT u.telegram_id
       FROM dm_conversations c
       JOIN users u ON u.id = ANY(SELECT (jsonb_array_elements(c.participants)::int))
       WHERE c.id = $1
         AND u.id <> $2
         AND u.telegram_id IS NOT NULL
         AND u.telegram_id ~ '^-?[0-9]+$'`,
      [conversationId, senderId]
    )

    for (const row of targetRows) {
      const chatId = String(row.telegram_id || '').trim()
      if (!chatId) continue
      const tg = await telegramPost(botToken, 'sendMessage', { chat_id: chatId, text })
      if (!tg?.ok) {
        console.warn('[DM->Telegram] sendMessage failed:', tg?.description || 'unknown error', { conversationId, chatId })
      }
    }
  } catch (err) {
    console.warn('[DM->Telegram] notify error:', err?.message || err)
  }
}

function scheduleDailyDmRetentionCleanup() {
  const now = new Date()
  const nextMidnight = new Date(now)
  nextMidnight.setHours(24, 0, 0, 0)
  const waitMs = Math.max(1000, nextMidnight.getTime() - now.getTime())

  setTimeout(async () => {
    await cleanupExpiredDmMessages()
    setInterval(() => { cleanupExpiredDmMessages() }, ONE_DAY_MS)
  }, waitMs)
}

scheduleDailyDmRetentionCleanup()

// 참여자 배열에 내가 포함된 모든 대화 반환
// GET /api/dm/conversations
router.get('/conversations', async (req, res) => {
  const userId = req.user.id
  try {
    const { rows } = await db.query(
      `SELECT c.*,
         (SELECT json_agg(json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name, 'image_url', u.image_url))
            FROM users u WHERE u.id = ANY(
              SELECT (jsonb_array_elements(c.participants)::int)
            )
         ) AS participant_details,
         (SELECT COUNT(*) FROM dm_messages m WHERE m.conversation_id = c.id) AS message_count,
         (SELECT COUNT(*)
            FROM dm_messages m
           WHERE m.conversation_id = c.id
             AND m.sender_id <> $2
             AND NOT (m.read_by @> $3::jsonb)
         ) AS unread_count
       FROM dm_conversations c
       WHERE c.participants @> $1::jsonb
       ORDER BY c.updated_at DESC`,
      [JSON.stringify([userId]), userId, JSON.stringify([userId])]
    )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류' })
  }
})

// 새 대화 생성 (참여자 목록 + 초기 이름)
// POST /api/dm/conversations
router.post('/conversations', async (req, res) => {
  const userId = req.user.id
  let { name, participants } = req.body // participants: [userId, ...]

  if (!Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: '참여자를 선택해주세요.' })
  }
  // 최대 10명
  const allParticipants = [...new Set([userId, ...participants])].slice(0, 10)

  // 기본 이름: 첫 번째 상대방 이름 (날짜 없이)
  if (!name || !name.trim()) {
    try {
      const { rows } = await db.query('SELECT username, display_name FROM users WHERE id = $1', [participants[0]])
      name = rows[0]?.display_name || rows[0]?.username || '알 수 없음'
    } catch { name = '대화' }
  }

  // 중복 이름 체크 — 이미 있으면 해당 대화를 그대로 반환 (기존 창 열기)
  const { rows: dup } = await db.query(
    `SELECT c.*,
       (SELECT json_agg(json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name, 'image_url', u.image_url))
          FROM users u WHERE u.id = ANY(SELECT (jsonb_array_elements(c.participants)::int))
       ) AS participant_details
     FROM dm_conversations c
     WHERE c.name = $1 AND c.participants @> $2::jsonb`,
    [name.trim(), JSON.stringify([userId])]
  )
  if (dup.length > 0) {
    return res.status(200).json({ ...dup[0], _existing: true })
  }

  try {
    const id = crypto.randomUUID()
    const { rows } = await db.query(
      `INSERT INTO dm_conversations (id, name, created_by, participants)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, name.trim(), userId, JSON.stringify(allParticipants)]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류' })
  }
})

// 대화 이름 변경
// PUT /api/dm/conversations/:id
router.put('/conversations/:id', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params
  const { name } = req.body

  if (!name || !name.trim()) return res.status(400).json({ error: '이름을 입력해주세요.' })

  // 본인 참여 확인
  const { rows: conv } = await db.query(
    'SELECT * FROM dm_conversations WHERE id = $1 AND participants @> $2::jsonb',
    [id, JSON.stringify([userId])]
  )
  if (!conv[0]) return res.status(404).json({ error: '대화를 찾을 수 없습니다.' })

  // 중복 이름 체크 (자신 제외)
  const { rows: dup } = await db.query(
    `SELECT id FROM dm_conversations WHERE name = $1 AND participants @> $2::jsonb AND id != $3`,
    [name.trim(), JSON.stringify([userId]), id]
  )
  if (dup.length > 0) {
    return res.status(409).json({ error: '같은 이름의 다이렉트 메세지 창 이름이 있습니다.' })
  }

  const { rows } = await db.query(
    'UPDATE dm_conversations SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [name.trim(), id]
  )
  res.json(rows[0])
})

// 대화(창) 삭제
// DELETE /api/dm/conversations/:id
router.delete('/conversations/:id', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  try {
    const { rows: conv } = await db.query(
      'SELECT id, created_by FROM dm_conversations WHERE id = $1 AND participants @> $2::jsonb',
      [id, JSON.stringify([userId])]
    )
    if (!conv[0]) return res.status(404).json({ error: '대화를 찾을 수 없습니다.' })

    if (conv[0].created_by !== userId) {
      return res.status(403).json({ error: '창 삭제는 방장만 할 수 있습니다.' })
    }

    const storageBase = getStorageBase()
    const convFolder = path.join(storageBase, 'DirectMessage', id)
    try { fs.rmSync(convFolder, { recursive: true, force: true }) } catch {}

    await db.query('DELETE FROM dm_conversations WHERE id = $1', [id])
    return res.json({ success: true, id })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '서버 오류' })
  }
})

// 대화 참여자 추가
// POST /api/dm/conversations/:id/participants
router.post('/conversations/:id/participants', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params
  const { participantId } = req.body

  const { rows: conv } = await db.query(
    'SELECT * FROM dm_conversations WHERE id = $1 AND participants @> $2::jsonb',
    [id, JSON.stringify([userId])]
  )
  if (!conv[0]) return res.status(404).json({ error: '대화를 찾을 수 없습니다.' })

  const current = conv[0].participants || []
  if (current.length >= 10) return res.status(400).json({ error: '최대 10명까지 추가할 수 있습니다.' })
  if (current.includes(participantId)) return res.status(400).json({ error: '이미 참여 중인 사용자입니다.' })

  const updated = [...current, participantId]
  await db.query(
    'UPDATE dm_conversations SET participants=$1, updated_at=NOW() WHERE id=$2',
    [JSON.stringify(updated), id]
  )

  // participant_details 포함하여 반환 (헤더 이름 즉시 반영용)
  const { rows: full } = await db.query(
    `SELECT c.*,
       (SELECT json_agg(json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name, 'image_url', u.image_url))
          FROM users u WHERE u.id = ANY(SELECT (jsonb_array_elements(c.participants)::int))
       ) AS participant_details
     FROM dm_conversations c WHERE c.id = $1`,
    [id]
  )
  res.json(full[0])
})

// 대화 참여자 삭제
// DELETE /api/dm/conversations/:id/participants/:participantId
router.delete('/conversations/:id/participants/:participantId', async (req, res) => {
  const userId = req.user.id
  const { id, participantId } = req.params
  const removeId = parseInt(participantId, 10)

  const { rows: conv } = await db.query(
    'SELECT * FROM dm_conversations WHERE id = $1 AND participants @> $2::jsonb',
    [id, JSON.stringify([userId])]
  )
  if (!conv[0]) return res.status(404).json({ error: '대화를 찾을 수 없습니다.' })
  if (conv[0].created_by !== userId) {
    return res.status(403).json({ error: '참여자 삭제는 방장만 할 수 있습니다.' })
  }

  const current = conv[0].participants || []
  if (!current.includes(removeId)) return res.status(400).json({ error: '참여 중이지 않은 사용자입니다.' })
  if (removeId === conv[0].created_by) {
    return res.status(400).json({ error: '방장은 삭제할 수 없습니다.' })
  }
  if (current.length <= 2) return res.status(400).json({ error: '최소 2명이 있어야 합니다.' })

  const updated = current.filter(p => p !== removeId)
  await db.query(
    'UPDATE dm_conversations SET participants=$1, updated_at=NOW() WHERE id=$2',
    [JSON.stringify(updated), id]
  )

  const { rows: full } = await db.query(
    `SELECT c.*,
       (SELECT json_agg(json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name, 'image_url', u.image_url))
          FROM users u WHERE u.id = ANY(SELECT (jsonb_array_elements(c.participants)::int))
       ) AS participant_details
     FROM dm_conversations c WHERE c.id = $1`,
    [id]
  )
  res.json(full[0])
})

// 메시지 목록 조회
// GET /api/dm/conversations/:id/messages
router.get('/conversations/:id/messages', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  const { rows: conv } = await db.query(
    'SELECT id FROM dm_conversations WHERE id = $1 AND participants @> $2::jsonb',
    [id, JSON.stringify([userId])]
  )
  if (!conv[0]) return res.status(404).json({ error: '대화를 찾을 수 없습니다.' })

  try {
    const { rows } = await db.query(
      `SELECT m.*,
         json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name, 'image_url', u.image_url) AS sender
       FROM dm_messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC`,
      [id]
    )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류' })
  }
})

// 읽음 처리 — 대화의 내 미읽 메시지 전체를 읽음으로 표시
// POST /api/dm/conversations/:id/read
router.post('/conversations/:id/read', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params

  const { rows: conv } = await db.query(
    'SELECT id FROM dm_conversations WHERE id = $1 AND participants @> $2::jsonb',
    [id, JSON.stringify([userId])]
  )
  if (!conv[0]) return res.status(404).json({ error: '대화를 찾을 수 없습니다.' })

  // 본인이 아직 read_by에 없는 메시지만 업데이트
  await db.query(
    `UPDATE dm_messages
     SET read_by = read_by || $1::jsonb
     WHERE conversation_id = $2
       AND NOT (read_by @> $1::jsonb)`,
    [JSON.stringify([userId]), id]
  )
  res.json({ success: true })
})

// 메시지 전송 (텍스트 + 첨부파일 메타데이터)
// POST /api/dm/conversations/:id/messages
router.post('/conversations/:id/messages', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params
  // msgId: 클라이언트가 미리 생성한 UUID (첨부 파일 폴더 ID와 일치)
  const { content, attachments, msgId: clientMsgId } = req.body

  const { rows: conv } = await db.query(
    'SELECT id FROM dm_conversations WHERE id = $1 AND participants @> $2::jsonb',
    [id, JSON.stringify([userId])]
  )
  if (!conv[0]) return res.status(404).json({ error: '대화를 찾을 수 없습니다.' })

  if (!content?.trim() && (!attachments || attachments.length === 0)) {
    return res.status(400).json({ error: '내용 또는 첨부파일을 입력해주세요.' })
  }

  const atts = (attachments || []).slice(0, 10)

  // 클라이언트 제공 msgId 검증 (UUID 형식이면 사용, 아니면 새로 생성)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const msgId = (clientMsgId && UUID_RE.test(clientMsgId)) ? clientMsgId : crypto.randomUUID()

  try {
    // 발신자는 보낸 즉시 읽음 처리
    const { rows } = await db.query(
      `INSERT INTO dm_messages (id, conversation_id, sender_id, content, attachments, read_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [msgId, id, userId, content?.trim() || '', JSON.stringify(atts), JSON.stringify([userId])]
    )
    await db.query('UPDATE dm_conversations SET updated_at=NOW() WHERE id=$1', [id])

    // sender 정보 포함해서 반환
    const { rows: full } = await db.query(
      `SELECT m.*,
         json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name, 'image_url', u.image_url) AS sender
       FROM dm_messages m JOIN users u ON u.id = m.sender_id
       WHERE m.id = $1`,
      [msgId]
    )

    // DM 전송 성공 후 수신자들에게 Telegram 알림 전송 (실패해도 DM 전송은 유지)
    notifyDmToTelegram({ conversationId: id, senderId: userId }).catch(() => {})

    res.status(201).json(full[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류' })
  }
})

// 메시지 수정
// PUT /api/dm/conversations/:convId/messages/:msgId
router.put('/conversations/:convId/messages/:msgId', async (req, res) => {
  const userId = req.user.id
  const { convId, msgId } = req.params
  const { content } = req.body

  const { rows } = await db.query(
    'SELECT * FROM dm_messages WHERE id=$1 AND conversation_id=$2 AND sender_id=$3',
    [msgId, convId, userId]
  )
  if (!rows[0]) return res.status(404).json({ error: '메시지를 찾을 수 없습니다.' })
  if (rows[0].is_deleted) return res.status(400).json({ error: '삭제된 메시지는 수정할 수 없습니다.' })
  const createdAtMs = new Date(rows[0].created_at).getTime()
  if (Date.now() - createdAtMs > DM_EDIT_WINDOW_MS) {
    return res.status(403).json({ error: '메시지 수정은 발신 후 10분 이내에만 가능합니다.' })
  }

  const { rows: updated } = await db.query(
    `UPDATE dm_messages SET content=$1, is_edited=true, updated_at=NOW()
     WHERE id=$2 RETURNING *`,
    [content?.trim() || '', msgId]
  )
  res.json(updated[0])
})

// 메시지 삭제
// DELETE /api/dm/conversations/:convId/messages/:msgId
router.delete('/conversations/:convId/messages/:msgId', async (req, res) => {
  const userId = req.user.id
  const { convId, msgId } = req.params

  const { rows } = await db.query(
    'SELECT * FROM dm_messages WHERE id=$1 AND conversation_id=$2 AND sender_id=$3',
    [msgId, convId, userId]
  )
  if (!rows[0]) return res.status(404).json({ error: '메시지를 찾을 수 없습니다.' })
  if (rows[0].is_deleted) return res.status(400).json({ error: '이미 삭제된 메시지입니다.' })

  // 첨부 파일 폴더 삭제 — 메시지 폴더 전체 삭제
  // 경로: ObjectFiles/DirectMessage/{conv_id}/{msg_id}/
  const storageBase = getStorageBase()
  const msgFolder = path.join(storageBase, 'DirectMessage', convId, msgId)
  try { fs.rmSync(msgFolder, { recursive: true, force: true }) } catch {}

  const { rows: updated } = await db.query(
    `UPDATE dm_messages
     SET content = '',
         attachments = '[]'::jsonb,
         is_deleted = true,
         deleted_at = NOW(),
         deleted_by = $1,
         is_edited = false,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [userId, msgId]
  )

  const { rows: full } = await db.query(
    `SELECT m.*,
       json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name, 'image_url', u.image_url) AS sender
     FROM dm_messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.id = $1`,
    [updated[0].id]
  )
  res.json(full[0])
})

// 파일 업로드 URL 발급 (DM 첨부용)
// POST /api/dm/conversations/:id/upload-url
router.post('/conversations/:id/upload-url', async (req, res) => {
  const userId = req.user.id
  const { id } = req.params
  // msgId: 클라이언트가 메시지 전송 전 미리 생성한 UUID
  // 같은 메시지의 모든 첨부파일은 동일 msgId 폴더에 저장됨
  const { filename, contentType, msgId: clientMsgId } = req.body

  const { rows: conv } = await db.query(
    'SELECT id FROM dm_conversations WHERE id = $1 AND participants @> $2::jsonb',
    [id, JSON.stringify([userId])]
  )
  if (!conv[0]) return res.status(404).json({ error: '대화를 찾을 수 없습니다.' })

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const msgId = (clientMsgId && UUID_RE.test(clientMsgId)) ? clientMsgId : crypto.randomUUID()

  const storageBase = getStorageBase()
  // 경로: ObjectFiles/DirectMessage/{conv_id}/{msg_id}/{filename}
  const relPath = path.join('DirectMessage', id, msgId, filename)
  const fullPath = path.join(storageBase, relPath)

  fs.mkdirSync(path.dirname(fullPath), { recursive: true })

  res.json({ uploadId: msgId, storagePath: relPath })
})

// 파일 업로드 (multipart 없이 raw body)
// POST /api/dm/conversations/:id/upload/:uploadId
router.post('/conversations/:id/upload/:uploadId', express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
  const userId = req.user.id
  const { id } = req.params
  const { storagePath } = req.query
  if (!storagePath) return res.status(400).json({ error: 'storagePath 필요' })

  // 참여자 확인
  const { rows: conv } = await db.query(
    'SELECT id FROM dm_conversations WHERE id = $1 AND participants @> $2::jsonb',
    [id, JSON.stringify([userId])]
  )
  if (!conv[0]) return res.status(403).json({ error: '권한이 없습니다.' })

  // 파일 크기 제한 확인 (config.json MaxAttachmentFileSize, MB 단위)
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const maxMB = cfg['MaxAttachmentFileSize'] ?? 100
    if (req.body.length > maxMB * 1024 * 1024) {
      return res.status(413).json({ error: `파일 크기가 최대 허용 용량(${maxMB}MB)을 초과합니다.` })
    }
  } catch {}

  // storagePath가 DirectMessage/{conv_id}/... 범위인지 확인 (경로 탈출 방지)
  const storageBase = getStorageBase()
  const fullPath = path.resolve(storageBase, storagePath)
  if (!fullPath.startsWith(path.resolve(storageBase))) {
    return res.status(400).json({ error: '잘못된 경로입니다.' })
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, req.body)
  res.json({ success: true, size: req.body.length })
})

// 파일 다운로드
// GET /api/dm/files?storagePath=...&filename=...
router.get('/files', async (req, res) => {
  const { storagePath, filename } = req.query
  if (!storagePath) return res.status(400).json({ error: 'storagePath 필요' })

  const storageBase = getStorageBase()
  const fullPath = path.resolve(storageBase, storagePath)

  // 경로 탈출 방지: storageBase 범위를 벗어나는 경로 차단
  if (!fullPath.startsWith(path.resolve(storageBase) + path.sep) &&
      fullPath !== path.resolve(storageBase)) {
    return res.status(400).json({ error: '잘못된 경로입니다.' })
  }

  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' })
  const originalName = filename || path.basename(fullPath)
  const originalExt = path.extname(originalName || '').toLowerCase()

  if (req.query.preview === 'pdf') {
    let previewPath = fullPath
    if (originalExt === '.pdf') {
      // keep original PDF
    } else if (['.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx'].includes(originalExt)) {
      const convertedPdfPath = await convertDmOfficeToPdf(storagePath, fullPath)
      if (!convertedPdfPath) {
        return res.status(500).send('미리보기 PDF 변환에 실패했습니다.')
      }
      previewPath = convertedPdfPath
    } else {
      return res.status(400).send('미리보기를 지원하지 않는 파일 형식입니다.')
    }

    if (!fs.existsSync(previewPath)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' })
    const stat = fs.statSync(previewPath)
    const safePdfName = String(originalName || 'preview').replace(/\.(pptx|ppt|docx|doc|xlsx|xls)$/i, '.pdf')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', String(stat.size))
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(safePdfName)}"`)
    fs.createReadStream(previewPath).pipe(res)
    return
  }

  if (String(req.query.download || '') === '1') {
    return res.download(fullPath, originalName)
  }

  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(originalName)}"`)
  return res.sendFile(fullPath)
})

module.exports = router
