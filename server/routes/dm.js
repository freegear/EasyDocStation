const express = require('express')
const fs = require('fs')
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const db = require('../db')
const requireAuth = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')

function getStorageBase() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return cfg['ObjectFile Path'] || path.resolve(__dirname, '../../Database/ObjectFile')
  } catch { return path.resolve(__dirname, '../../Database/ObjectFile') }
}

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
         (SELECT COUNT(*) FROM dm_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM dm_conversations c
       WHERE c.participants @> $1::jsonb
       ORDER BY c.updated_at DESC`,
      [JSON.stringify([userId])]
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
    const id = uuidv4()
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

  const current = conv[0].participants || []
  if (!current.includes(removeId)) return res.status(400).json({ error: '참여 중이지 않은 사용자입니다.' })
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
  const msgId = (clientMsgId && UUID_RE.test(clientMsgId)) ? clientMsgId : uuidv4()

  try {
    const { rows } = await db.query(
      `INSERT INTO dm_messages (id, conversation_id, sender_id, content, attachments)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [msgId, id, userId, content?.trim() || '', JSON.stringify(atts)]
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

  // 첨부 파일 폴더 삭제 — 메시지 폴더 전체 삭제
  // 경로: ObjectFiles/DirectMessage/{conv_id}/{msg_id}/
  const storageBase = getStorageBase()
  const msgFolder = path.join(storageBase, 'DirectMessage', convId, msgId)
  try { fs.rmSync(msgFolder, { recursive: true, force: true }) } catch {}

  await db.query('DELETE FROM dm_messages WHERE id=$1', [msgId])
  res.json({ success: true })
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
  const msgId = (clientMsgId && UUID_RE.test(clientMsgId)) ? clientMsgId : uuidv4()

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

  res.download(fullPath, filename || path.basename(fullPath))
})

module.exports = router
