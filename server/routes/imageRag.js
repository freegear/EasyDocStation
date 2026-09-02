const express = require('express')
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { canAccessChannel, ACCESS_DENIED_MESSAGE } = require('../lib/channelAccess')
const { getSearchAccessibleSpaceIds } = require('../lib/spaceAccess')
const {
  getImageDescription,
  retryImageAttachment,
  reindexImageAttachment,
} = require('../image-rag')

const router = express.Router()

async function findAttachment(attachmentId) {
  const result = await db.query(
    `SELECT id, channel_id, uploader_id, owner_id, status, deleted_at
     FROM attachments WHERE id=$1 LIMIT 1`,
    [attachmentId],
  ).catch(async error => {
    if (error?.code !== '42703') throw error
    return db.query(
      `SELECT id, channel_id, uploader_id, NULL::integer AS owner_id, status, NULL::timestamptz AS deleted_at
       FROM attachments WHERE id=$1 LIMIT 1`,
      [attachmentId],
    )
  })
  return result.rows?.[0] || null
}

async function canAccessAttachment(user, attachment) {
  if (!attachment || attachment.deleted_at) return false
  if (attachment.channel_id) return canAccessChannel(db, user, attachment.channel_id)
  const folderResult = await db.query(
    `SELECT d.access_scope, d.scope_team_id, d.scope_channel_id, d.owner_id
     FROM folder_documents d
     WHERE d.attachment_id=$1 AND d.storage_status <> 'removed'
     LIMIT 1`,
    [attachment.id],
  ).catch(() => ({ rows: [] }))
  const folder = folderResult.rows?.[0]
  if (!folder) return Number(attachment.owner_id || attachment.uploader_id) === Number(user?.id)
  if (folder.access_scope === 'all') return true
  if (folder.access_scope === 'personal') return Number(folder.owner_id) === Number(user?.id)
  if (folder.access_scope === 'channel') return canAccessChannel(db, user, folder.scope_channel_id)
  if (folder.access_scope === 'team') {
    const ids = await getSearchAccessibleSpaceIds(db, user)
    return ids.includes(folder.scope_team_id)
  }
  return Number(folder.owner_id) === Number(user?.id)
}

router.get('/:id/image-description', requireAuth, async (req, res, next) => {
  try {
    const attachment = await findAttachment(req.params.id)
    if (!attachment) return res.status(404).json({ error: '이미지 첨부를 찾을 수 없습니다.' })
    if (!await canAccessAttachment(req.user, attachment)) {
      return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    }
    const description = await getImageDescription(attachment.id)
    if (!description) return res.status(404).json({ error: '이미지 설명이 아직 생성되지 않았습니다.' })
    res.json({ item: description })
  } catch (error) {
    next(error)
  }
})

router.post('/:id/image-description/retry', requireAuth, async (req, res, next) => {
  try {
    const attachment = await findAttachment(req.params.id)
    if (!attachment) return res.status(404).json({ error: '이미지 첨부를 찾을 수 없습니다.' })
    if (!await canAccessAttachment(req.user, attachment)) {
      return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    }
    res.status(202).json(await retryImageAttachment(attachment.id))
  } catch (error) {
    next(error)
  }
})

router.post('/:id/image-description/reindex', requireAuth, async (req, res, next) => {
  try {
    const attachment = await findAttachment(req.params.id)
    if (!attachment) return res.status(404).json({ error: '이미지 첨부를 찾을 수 없습니다.' })
    if (!await canAccessAttachment(req.user, attachment)) {
      return res.status(403).json({ error: ACCESS_DENIED_MESSAGE })
    }
    res.status(202).json(await reindexImageAttachment(attachment.id))
  } catch (error) {
    next(error)
  }
})

module.exports = router
