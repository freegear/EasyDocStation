const db = require('../db')
const { normalizeImageRagConfig } = require('./config')
const { ImageAnalysisRepository } = require('./ImageAnalysisRepository')
const { ImageAnalysisService } = require('./ImageAnalysisService')
const { ImageAnalysisWorker } = require('./ImageAnalysisWorker')

const config = normalizeImageRagConfig()
const repository = new ImageAnalysisRepository(db)
const analysisService = new ImageAnalysisService({ config })
const worker = new ImageAnalysisWorker({ repository, analysisService, config })

async function enqueueImageAttachments(items, options = {}) {
  if (!config.enabled) return []
  const result = await repository.enqueueMany(items, config, options)
  worker.poke()
  return result
}

async function retryImageAttachment(attachmentId) {
  const current = await repository.getByAttachmentId(attachmentId)
  const source = await repository.getSource(attachmentId)
  if (!source) return { queued: false, reason: 'NOT_FOUND' }
  const result = await repository.enqueue({
    attachmentId,
    postId: source.post_id,
    commentId: source.comment_id,
    channelId: source.channel_id,
    ownerId: source.uploader_id,
    securityLevel: current?.security_level || 0,
  }, config, { forceAnalysis: true, source: 'retry' })
  worker.poke()
  return result
}

async function reindexImageAttachment(attachmentId) {
  const current = await repository.getByAttachmentId(attachmentId)
  const source = await repository.getSource(attachmentId)
  if (!source) return { queued: false, reason: 'NOT_FOUND' }
  const result = await repository.enqueue({
    attachmentId,
    postId: source.post_id,
    commentId: source.comment_id,
    channelId: source.channel_id,
    ownerId: source.uploader_id,
    securityLevel: current?.security_level ?? source.source_security_level ?? 0,
  }, config, { resetAttempts: true, source: 'retry' })
  worker.poke()
  return result
}

async function deleteImageAttachmentIndexes(attachmentId) {
  await worker.deleteAttachment(String(attachmentId || '').trim())
}

module.exports = {
  config,
  repository,
  worker,
  startImageRagWorker: () => worker.start(),
  stopImageRagWorker: () => worker.stop(),
  enqueueImageAttachments,
  retryImageAttachment,
  reindexImageAttachment,
  deleteImageAttachmentIndexes,
  getImageDescription: attachmentId => repository.getByAttachmentId(attachmentId),
}
