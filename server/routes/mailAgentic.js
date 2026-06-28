const express = require('express')
const requireAuth = require('../middleware/auth')
const mailRepo = require('../mail/repository')
const threadRepo = require('../mail/agentic/threadRepository')
const watchTargets = require('../mail/agentic/watchTargets')
const worker = require('../mail/agentic/worker')
const { renderReportMarkdown } = require('../mail/agentic/reportRenderer')

const router = express.Router()

function isSiteAdmin(req) {
  return req.user?.role === 'site_admin'
}

async function requireTenantAccess(req, res, tenantId) {
  if (!tenantId) {
    res.status(400).json({ error: 'tenantId가 필요합니다.' })
    return false
  }
  const ok = await mailRepo.canAccessTenant({
    userId: req.user.id,
    tenantId,
    isSiteAdmin: isSiteAdmin(req),
  })
  if (!ok) res.status(403).json({ error: '메일 tenant 접근 권한이 없습니다.' })
  return ok
}

router.use(requireAuth)

router.get('/watch-targets', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || '').trim()
    if (!(await requireTenantAccess(req, res, tenantId))) return
    res.json(await threadRepo.listWatchTargets({
      tenantId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    }))
  } catch (err) {
    next(err)
  }
})

router.post('/watch-targets', async (req, res, next) => {
  try {
    const tenantId = String(req.body?.tenantId || req.query.tenantId || '').trim()
    if (!(await requireTenantAccess(req, res, tenantId))) return
    const created = await watchTargets.createWatchTarget({
      tenantId,
      ownerUserId: req.user.id,
      input: req.body || {},
    })
    const messageId = String(req.body?.message_id || '').trim()
    if (messageId) {
      await worker.enqueueMessageSynced({ tenantId, messageId })
      await worker.processPendingForTenant(tenantId, 10).catch(() => {})
    }
    res.json(created)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.put('/watch-targets/:id', async (req, res, next) => {
  try {
    const tenantId = String(req.body?.tenantId || req.query.tenantId || '').trim()
    if (!(await requireTenantAccess(req, res, tenantId))) return
    const updated = await watchTargets.updateWatchTarget({
      tenantId,
      id: String(req.params.id || '').trim(),
      ownerUserId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
      input: req.body || {},
    })
    if (!updated) return res.status(404).json({ error: 'watch target을 찾을 수 없습니다.' })
    res.json(updated)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.delete('/watch-targets/:id', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    if (!(await requireTenantAccess(req, res, tenantId))) return
    const deleted = await threadRepo.deleteWatchTarget({
      tenantId,
      id: String(req.params.id || '').trim(),
      ownerUserId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    })
    if (!deleted) return res.status(404).json({ error: 'watch target을 찾을 수 없습니다.' })
    res.json({ ok: true, id: deleted.id })
  } catch (err) {
    next(err)
  }
})

router.get('/threads', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || '').trim()
    if (!(await requireTenantAccess(req, res, tenantId))) return
    res.json(await threadRepo.listThreads({
      tenantId,
      userId: req.user.id,
      isSiteAdmin: isSiteAdmin(req),
    }))
  } catch (err) {
    next(err)
  }
})

router.get('/threads/:threadId/report', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || '').trim()
    if (!(await requireTenantAccess(req, res, tenantId))) return
    const reports = await threadRepo.listThreads({ tenantId, userId: req.user.id, isSiteAdmin: isSiteAdmin(req) })
    const thread = reports.find(item => item.id === req.params.threadId)
    if (!thread) return res.status(404).json({ error: '메일 타래를 찾을 수 없습니다.' })
    const report = await threadRepo.getThreadReport({ tenantId, threadId: req.params.threadId })
    if (!report) return res.status(404).json({ error: '보고서가 아직 없습니다.' })
    res.json({ ...report, report_md: renderReportMarkdown({ thread, report }) })
  } catch (err) {
    next(err)
  }
})

router.post('/threads/:threadId/reanalyze', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    if (!(await requireTenantAccess(req, res, tenantId))) return
    await threadRepo.createEvent({
      tenantId,
      threadId: req.params.threadId,
      eventType: 'analysis_requested',
      payload: { manual: true },
    })
    await worker.processPendingForTenant(tenantId, 10)
    const report = await threadRepo.getThreadReport({ tenantId, threadId: req.params.threadId })
    res.json({ ok: true, report })
  } catch (err) {
    next(err)
  }
})

router.post('/threads/:threadId/retrain', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || req.body?.tenantId || '').trim()
    if (!(await requireTenantAccess(req, res, tenantId))) return
    const messages = await threadRepo.listThreadMessages({ tenantId, threadId: req.params.threadId })
    for (const message of messages) {
      await threadRepo.updateMessageRagStatus({
        tenantId,
        threadId: req.params.threadId,
        messageId: message.message_id,
        status: 'pending',
      })
      await threadRepo.createEvent({
        tenantId,
        threadId: req.params.threadId,
        messageId: message.message_id,
        eventType: 'rag_train_requested',
        payload: { manual_retrain: true },
      })
    }
    await worker.processPendingForTenant(tenantId, Math.max(10, messages.length * 2))
    res.json({ ok: true, queued: messages.length })
  } catch (err) {
    next(err)
  }
})

router.post('/threads/:threadId/watch', async (req, res, next) => {
  try {
    const tenantId = String(req.body?.tenantId || req.query.tenantId || '').trim()
    if (!(await requireTenantAccess(req, res, tenantId))) return
    const created = await watchTargets.createWatchTarget({
      tenantId,
      ownerUserId: req.user.id,
      input: {
        ...req.body,
        target_type: 'condition_group',
        account_conditions: req.body?.account_conditions || [req.body?.email_address, req.body?.account_id].filter(Boolean),
        subject_conditions: req.body?.subject_conditions || [req.body?.subject].filter(Boolean),
      },
    })
    if (req.body?.message_id) {
      await worker.enqueueMessageSynced({ tenantId, messageId: String(req.body.message_id) })
      await worker.processPendingForTenant(tenantId, 10).catch(() => {})
    }
    res.json(created)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

module.exports = router
