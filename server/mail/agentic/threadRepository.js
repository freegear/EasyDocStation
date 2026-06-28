const repo = require('../repository')

async function listWatchTargets({ tenantId, userId, isSiteAdmin }) {
  const params = [tenantId, !!isSiteAdmin, userId]
  const { rows } = await repo.tenantQuery(
    tenantId,
    `SELECT *
     FROM mail_agentic_watch_targets
     WHERE tenant_id = $1
       AND ($2::boolean = true OR owner_user_id = $3)
     ORDER BY updated_at DESC`,
    params,
  )
  return rows
}

async function listEnabledWatchTargets({ tenantId }) {
  const { rows } = await repo.tenantQuery(
    tenantId,
    `SELECT *
     FROM mail_agentic_watch_targets
     WHERE tenant_id = $1 AND enabled = true
     ORDER BY updated_at DESC`,
    [tenantId],
  )
  return rows
}

async function createWatchTarget({ tenantId, ownerUserId, fields }) {
  const { rows } = await repo.tenantQuery(
    tenantId,
    `INSERT INTO mail_agentic_watch_targets (
       tenant_id, owner_user_id, target_type, account_id, email_address,
       account_conditions, keyword_conditions, subject_conditions,
       condition_match_type, subject_match_type, subject_pattern, sender_pattern,
       enabled, notify_telegram, auto_create_todos, rag_enabled, analysis_enabled
     )
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      tenantId,
      ownerUserId,
      fields.target_type,
      fields.account_id || null,
      fields.email_address || null,
      JSON.stringify(fields.account_conditions || []),
      JSON.stringify(fields.keyword_conditions || []),
      JSON.stringify(fields.subject_conditions || []),
      fields.condition_match_type || 'contains',
      fields.subject_match_type || null,
      fields.subject_pattern || null,
      fields.sender_pattern || null,
      fields.enabled !== false,
      fields.notify_telegram !== false,
      fields.auto_create_todos !== false,
      fields.rag_enabled !== false,
      fields.analysis_enabled !== false,
    ],
  )
  return rows[0]
}

async function updateWatchTarget({ tenantId, id, ownerUserId, isSiteAdmin, fields }) {
  const { rows } = await repo.tenantQuery(
    tenantId,
    `UPDATE mail_agentic_watch_targets
     SET target_type = $5,
         account_id = $6,
         email_address = $7,
         account_conditions = $8::jsonb,
         keyword_conditions = $9::jsonb,
         subject_conditions = $10::jsonb,
         condition_match_type = $11,
         subject_match_type = $12,
         subject_pattern = $13,
         sender_pattern = $14,
         enabled = $15,
         notify_telegram = $16,
         auto_create_todos = $17,
         rag_enabled = $18,
         analysis_enabled = $19,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND id = $2
       AND ($3::boolean = true OR owner_user_id = $4)
     RETURNING *`,
    [
      tenantId,
      id,
      !!isSiteAdmin,
      ownerUserId,
      fields.target_type,
      fields.account_id || null,
      fields.email_address || null,
      JSON.stringify(fields.account_conditions || []),
      JSON.stringify(fields.keyword_conditions || []),
      JSON.stringify(fields.subject_conditions || []),
      fields.condition_match_type || 'contains',
      fields.subject_match_type || null,
      fields.subject_pattern || null,
      fields.sender_pattern || null,
      fields.enabled !== false,
      fields.notify_telegram !== false,
      fields.auto_create_todos !== false,
      fields.rag_enabled !== false,
      fields.analysis_enabled !== false,
    ],
  )
  return rows[0] || null
}

async function deleteWatchTarget({ tenantId, id, ownerUserId, isSiteAdmin }) {
  const { rows } = await repo.tenantQuery(
    tenantId,
    `DELETE FROM mail_agentic_watch_targets
     WHERE tenant_id = $1 AND id = $2 AND ($3::boolean = true OR owner_user_id = $4)
     RETURNING id`,
    [tenantId, id, !!isSiteAdmin, ownerUserId],
  )
  return rows[0] || null
}

async function upsertThreadForMessage({ tenantId, target, message, agenticThreadId, normalizedSubject, participantFingerprint, direction, contentHash, attachmentHash }) {
  return repo.withTenantTx(tenantId, async (client) => {
    const at = message.received_at || message.sent_at || message.created_at || new Date()
    const threadResult = await client.query(
      `INSERT INTO mail_agentic_threads (
         id, tenant_id, watch_target_id, account_id, provider_thread_id,
         normalized_subject, participant_fingerprint, first_message_at, last_message_at, last_message_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         last_message_at = GREATEST(mail_agentic_threads.last_message_at, EXCLUDED.last_message_at),
         last_message_id = EXCLUDED.last_message_id,
         updated_at = NOW()
       RETURNING *`,
      [
        agenticThreadId,
        tenantId,
        target.id,
        message.account_id,
        message.provider_thread_id || null,
        normalizedSubject,
        participantFingerprint || null,
        at,
        message.id,
      ],
    )

    await client.query(
      `INSERT INTO mail_agentic_thread_messages (
         thread_id, message_id, tenant_id, account_id, direction, content_hash, attachment_hash, rag_status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
       ON CONFLICT (thread_id, message_id) DO UPDATE SET
         direction = EXCLUDED.direction,
         content_hash = EXCLUDED.content_hash,
         attachment_hash = EXCLUDED.attachment_hash,
         rag_status = CASE
           WHEN mail_agentic_thread_messages.content_hash IS DISTINCT FROM EXCLUDED.content_hash
             OR mail_agentic_thread_messages.attachment_hash IS DISTINCT FROM EXCLUDED.attachment_hash
           THEN 'pending'
           ELSE mail_agentic_thread_messages.rag_status
         END,
         updated_at = NOW()`,
      [agenticThreadId, message.id, tenantId, message.account_id, direction, contentHash, attachmentHash],
    )

    await client.query(
      `INSERT INTO mail_agentic_events (tenant_id, thread_id, message_id, event_type, payload)
       VALUES ($1,$2,$3,'rag_train_requested',$4::jsonb)`,
      [tenantId, agenticThreadId, message.id, JSON.stringify({ watch_target_id: target.id })],
    )
    return threadResult.rows[0]
  })
}

async function createEvent({ tenantId, threadId, messageId, eventType, payload = {} }) {
  const { rows } = await repo.tenantQuery(
    tenantId,
    `INSERT INTO mail_agentic_events (tenant_id, thread_id, message_id, event_type, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     RETURNING *`,
    [tenantId, threadId || null, messageId || null, eventType, JSON.stringify(payload)],
  )
  return rows[0]
}

async function listPendingEvents({ tenantId, limit = 20 }) {
  const { rows } = await repo.tenantQuery(
    tenantId,
    `SELECT *
     FROM mail_agentic_events
     WHERE tenant_id = $1 AND status = 'pending'
     ORDER BY created_at ASC
     LIMIT $2`,
    [tenantId, limit],
  )
  return rows
}

async function markEventDone({ tenantId, id }) {
  await repo.tenantQuery(
    tenantId,
    `UPDATE mail_agentic_events SET status = 'done', updated_at = NOW() WHERE id = $1`,
    [id],
  )
}

async function markEventFailed({ tenantId, id, error, maxRetry = 3 }) {
  await repo.tenantQuery(
    tenantId,
    `UPDATE mail_agentic_events
     SET retry_count = retry_count + 1,
         status = CASE WHEN retry_count + 1 >= $3 THEN 'failed' ELSE 'pending' END,
         error_message = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [id, String(error || '').slice(0, 1000), maxRetry],
  )
}

async function updateMessageRagStatus({ tenantId, threadId, messageId, status }) {
  await repo.tenantQuery(
    tenantId,
    `UPDATE mail_agentic_thread_messages
     SET rag_status = $4,
         rag_trained_at = CASE WHEN $4 = 'completed' THEN NOW() ELSE rag_trained_at END,
         updated_at = NOW()
     WHERE thread_id = $1 AND message_id = $2 AND tenant_id = $3`,
    [threadId, messageId, tenantId, status],
  )
  if (status === 'completed') {
    await repo.tenantQuery(
      tenantId,
      `UPDATE mail_agentic_threads SET last_rag_trained_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [threadId],
    )
  }
}

async function getThreadReport({ tenantId, threadId }) {
  const { rows } = await repo.tenantQuery(
    tenantId,
    `SELECT * FROM mail_agentic_thread_reports WHERE tenant_id = $1 AND thread_id = $2 LIMIT 1`,
    [tenantId, threadId],
  )
  return rows[0] || null
}

async function listThreadMessages({ tenantId, threadId, onlyUnanalyzed = false }) {
  const { rows } = await repo.tenantQuery(
    tenantId,
    `SELECT mtm.*, mm.subject, mm.from_email, mm.from_name, mm.to_json, mm.cc_json,
            mm.snippet, mm.received_at, mm.sent_at, mm.created_at
     FROM mail_agentic_thread_messages mtm
     JOIN mail_messages mm ON mm.id = mtm.message_id
     WHERE mtm.tenant_id = $1 AND mtm.thread_id = $2
       AND ($3::boolean = false OR mtm.analyzed = false)
     ORDER BY COALESCE(mm.received_at, mm.sent_at, mm.created_at) ASC`,
    [tenantId, threadId, !!onlyUnanalyzed],
  )
  return rows
}

async function upsertThreadReport({ tenantId, threadId, report }) {
  const { rows } = await repo.tenantQuery(
    tenantId,
    `INSERT INTO mail_agentic_thread_reports (
       thread_id, tenant_id, summary, important_issues, progress_summary,
       action_items, todo_items, decisions, risks, open_questions,
       last_message_id, learned_message_count, source_message_ids, analysis_version, updated_at
     )
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14,NOW())
     ON CONFLICT (thread_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       important_issues = EXCLUDED.important_issues,
       progress_summary = EXCLUDED.progress_summary,
       action_items = EXCLUDED.action_items,
       todo_items = EXCLUDED.todo_items,
       decisions = EXCLUDED.decisions,
       risks = EXCLUDED.risks,
       open_questions = EXCLUDED.open_questions,
       last_message_id = EXCLUDED.last_message_id,
       learned_message_count = EXCLUDED.learned_message_count,
       source_message_ids = EXCLUDED.source_message_ids,
       analysis_version = EXCLUDED.analysis_version,
       updated_at = NOW()
     RETURNING *`,
    [
      threadId,
      tenantId,
      report.summary || '',
      JSON.stringify(report.important_issues || []),
      JSON.stringify(report.progress_summary || []),
      JSON.stringify(report.action_items || []),
      JSON.stringify(report.todo_items || []),
      JSON.stringify(report.decisions || []),
      JSON.stringify(report.risks || []),
      JSON.stringify(report.open_questions || []),
      report.last_message_id || null,
      Number(report.learned_message_count || 0),
      JSON.stringify(report.source_message_ids || []),
      Number(report.analysis_version || 1),
    ],
  )
  return rows[0]
}

async function markMessagesAnalyzed({ tenantId, threadId, messageIds }) {
  if (!messageIds?.length) return
  await repo.tenantQuery(
    tenantId,
    `UPDATE mail_agentic_thread_messages
     SET analyzed = true, updated_at = NOW()
     WHERE tenant_id = $1 AND thread_id = $2 AND message_id = ANY($3)`,
    [tenantId, threadId, messageIds],
  )
  await repo.tenantQuery(
    tenantId,
    `UPDATE mail_agentic_threads SET last_analyzed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [threadId],
  )
}

async function listThreads({ tenantId, userId, isSiteAdmin }) {
  const { rows } = await repo.tenantQuery(
    tenantId,
    `SELECT t.*, wt.owner_user_id, wt.target_type, wt.notify_telegram, wt.auto_create_todos,
            r.summary, r.updated_at AS report_updated_at
     FROM mail_agentic_threads t
     JOIN mail_agentic_watch_targets wt ON wt.id = t.watch_target_id
     LEFT JOIN mail_agentic_thread_reports r ON r.thread_id = t.id
     WHERE t.tenant_id = $1 AND ($2::boolean = true OR wt.owner_user_id = $3)
     ORDER BY t.last_message_at DESC NULLS LAST, t.updated_at DESC`,
    [tenantId, !!isSiteAdmin, userId],
  )
  return rows
}

module.exports = {
  listWatchTargets,
  listEnabledWatchTargets,
  createWatchTarget,
  updateWatchTarget,
  deleteWatchTarget,
  upsertThreadForMessage,
  createEvent,
  listPendingEvents,
  markEventDone,
  markEventFailed,
  updateMessageRagStatus,
  getThreadReport,
  listThreadMessages,
  upsertThreadReport,
  markMessagesAnalyzed,
  listThreads,
}
