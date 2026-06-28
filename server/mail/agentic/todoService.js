const repo = require('../repository')

function normalizeTitle(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

async function syncTodosFromReport({ tenantId, threadId, ownerUserId, report }) {
  const items = Array.isArray(report?.todo_items) ? report.todo_items : []
  let created = 0
  for (const item of items) {
    const title = String(item.title || '').trim()
    if (!title) continue
    const actionItemId = item.action_item_id || `title:${normalizeTitle(title)}`
    const { rowCount } = await repo.tenantQuery(
      tenantId,
      `INSERT INTO mail_agentic_todos (
         tenant_id, thread_id, action_item_id, owner_user_id, title,
         description, due_at, priority, status, source_message_id, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,NOW())
       ON CONFLICT (thread_id, action_item_id) WHERE action_item_id IS NOT NULL
       DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         due_at = EXCLUDED.due_at,
         priority = EXCLUDED.priority,
         updated_at = NOW()`,
      [
        tenantId,
        threadId,
        actionItemId,
        ownerUserId || null,
        title,
        item.description || null,
        item.due_at || null,
        item.priority || 'normal',
        item.source_message_id || null,
      ],
    )
    created += rowCount
  }
  return created
}

module.exports = { syncTodosFromReport }
