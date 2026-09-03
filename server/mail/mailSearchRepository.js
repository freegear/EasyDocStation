const cm = require('./connectionManager')
const { buildMailSearchDocument } = require('./mailSearch')

async function query(tenantId, text, params) {
  const { pool } = await cm.resolveTenant(tenantId)
  return pool.query(text, params)
}

async function listPendingSearchDocuments({ tenantId, userId, limit = 200 }) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200))
  const { rows } = await query(tenantId, `
    SELECT mm.id, mm.tenant_id, mm.user_id, mm.subject, mm.from_email, mm.from_name,
           mm.to_json, mm.cc_json, mm.body_text_object_key, mm.body_html_object_key
      FROM mail_messages mm
      LEFT JOIN mail_message_search_documents sd ON sd.message_id = mm.id
     WHERE mm.tenant_id = $1
       AND mm.user_id = $2
       AND mm.deleted_at IS NULL
       AND (sd.message_id IS NULL OR sd.indexed_at < mm.updated_at)
     ORDER BY mm.updated_at ASC, mm.id ASC
     LIMIT ${safeLimit}`, [tenantId, userId])
  return rows
}

async function upsertSearchDocument({ tenantId, userId, message, bodyText, bodyHtml }) {
  const document = buildMailSearchDocument({
    subject: message.subject,
    fromEmail: message.from_email,
    fromName: message.from_name,
    to: message.to_json,
    cc: message.cc_json,
    bodyText,
    bodyHtml,
  })
  await query(tenantId, `
    INSERT INTO mail_message_search_documents (
      message_id, tenant_id, user_id, from_email, to_emails, cc_emails,
      subject_text, all_text, indexed_at
    ) VALUES ($1,$2,$3,$4,$5::text[],$6::text[],$7,$8,NOW())
    ON CONFLICT (message_id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      user_id = EXCLUDED.user_id,
      from_email = EXCLUDED.from_email,
      to_emails = EXCLUDED.to_emails,
      cc_emails = EXCLUDED.cc_emails,
      subject_text = EXCLUDED.subject_text,
      all_text = EXCLUDED.all_text,
      indexed_at = NOW()`, [
    message.id,
    tenantId,
    userId,
    document.fromEmail,
    document.toEmails,
    document.ccEmails,
    document.subjectText,
    document.allText,
  ])
}

function matchSql(field, parameter = '$6') {
  if (field === 'from') return `sd.from_email = ${parameter}`
  if (field === 'to') return `${parameter} = ANY(sd.to_emails)`
  if (field === 'cc') return `${parameter} = ANY(sd.cc_emails)`
  if (field === 'subject') return `sd.subject_text LIKE '%' || ${parameter} || '%'`
  if (field === 'file') {
    return `EXISTS (
      SELECT 1 FROM mail_attachments matt
       WHERE matt.message_id = mm.id
         AND matt.tenant_id = mm.tenant_id
         AND matt.user_id = mm.user_id
         AND LOWER(matt.filename) LIKE '%' || ${parameter} || '%'
    )`
  }
  return `sd.all_text LIKE '%' || ${parameter} || '%'`
}

async function searchMessages({ tenantId, userId, field, searchQuery, cursor, limit }) {
  const safeLimit = Math.min(101, Math.max(1, Number(limit) || 51))
  const cursorTime = cursor?.time || null
  const cursorTenantId = cursor?.tenantId || ''
  const cursorMessageId = cursor?.messageId || ''
  const condition = matchSql(field)
  const { rows } = await query(tenantId, `
    SELECT mm.id, mm.tenant_id, mm.user_id, mm.account_id,
           ma.provider, ma.email_address AS account_email,
           ma.display_name AS account_display_name,
           mm.provider_message_id, mm.folder_id,
           mf.name AS folder_name, mf.type AS folder_type,
           mm.subject, mm.from_email, mm.from_name, mm.to_json, mm.cc_json,
           mm.bcc_json, mm.snippet, mm.received_at, mm.sent_at,
           mm.is_read, mm.is_starred, mm.has_attachments, mm.size_bytes,
           mm.created_at, mm.updated_at,
           COALESCE(mm.received_at, mm.sent_at, mm.created_at) AS sort_at,
           true AS is_search_result
      FROM mail_messages mm
      JOIN mail_accounts ma ON ma.id = mm.account_id
      LEFT JOIN mail_folders mf ON mf.id = mm.folder_id
      JOIN mail_message_search_documents sd
        ON sd.message_id = mm.id AND sd.tenant_id = mm.tenant_id AND sd.user_id = mm.user_id
     WHERE mm.tenant_id = $1
       AND mm.user_id = $2
       AND mm.deleted_at IS NULL
       AND (
         $3::timestamptz IS NULL
         OR COALESCE(mm.received_at, mm.sent_at, mm.created_at) < $3::timestamptz
         OR (
           COALESCE(mm.received_at, mm.sent_at, mm.created_at) = $3::timestamptz
           AND (mm.tenant_id < $4 OR (mm.tenant_id = $4 AND mm.id < $5))
         )
       )
       AND (${condition})
     ORDER BY sort_at DESC, mm.tenant_id DESC, mm.id DESC
     LIMIT ${safeLimit}`, [tenantId, userId, cursorTime, cursorTenantId, cursorMessageId, searchQuery])
  return rows
}

async function countMessages({ tenantId, userId, field, searchQuery }) {
  const condition = matchSql(field, '$3')
  const { rows } = await query(tenantId, `
    SELECT COUNT(*)::bigint AS count
      FROM mail_messages mm
      JOIN mail_message_search_documents sd
        ON sd.message_id = mm.id AND sd.tenant_id = mm.tenant_id AND sd.user_id = mm.user_id
     WHERE mm.tenant_id = $1
       AND mm.user_id = $2
       AND mm.deleted_at IS NULL
       AND (${condition})`, [tenantId, userId, searchQuery])
  return Number(rows[0]?.count || 0)
}

module.exports = {
  listPendingSearchDocuments,
  upsertSearchDocument,
  searchMessages,
  countMessages,
}
