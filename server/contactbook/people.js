function normalizePhone(raw, defaultCountry = 'KR') {
  let value = String(raw || '').trim().replace(/^tel:/i, '')
  const extensionMatch = value.match(/(?:ext\.?|x|내선)\s*(\d+)\s*$/i)
  const extension = extensionMatch?.[1] || ''
  if (extensionMatch) value = value.slice(0, extensionMatch.index)
  value = value.replace(/[^\d+]/g, '')
  if (value.startsWith('00')) value = `+${value.slice(2)}`
  if (!value.startsWith('+')) {
    const digits = value.replace(/\D/g, '')
    if (defaultCountry === 'KR' && digits.startsWith('0')) value = `+82${digits.slice(1)}`
    else if (defaultCountry === 'KR' && digits.startsWith('82')) value = `+${digits}`
    else value = digits
  }
  const digits = value.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) return { normalized: '', extension }
  return { normalized: value.startsWith('+') ? `+${digits}` : digits, extension }
}

function normalizeEmail(raw) {
  const value = String(raw || '').trim().toLowerCase()
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1 || value.includes(' ') || value.includes('\n') || value.includes('\r')) return ''
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  if (!local || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return ''
  return `${local}@${domain}`
}

async function mergePeople(client, { userId, targetPersonId, sourcePersonId }) {
  if (!sourcePersonId || sourcePersonId === targetPersonId) return
  const target = await client.query('SELECT primary_photo_id FROM people WHERE id=$1 AND user_id=$2 FOR UPDATE', [targetPersonId, userId])
  const source = await client.query('SELECT primary_photo_id FROM people WHERE id=$1 AND user_id=$2 FOR UPDATE', [sourcePersonId, userId])
  if (!target.rows[0] || !source.rows[0]) return
  if (target.rows[0].primary_photo_id && source.rows[0].primary_photo_id) {
    await client.query('UPDATE person_photos SET is_primary=false,updated_at=NOW() WHERE id=$1 AND user_id=$2', [source.rows[0].primary_photo_id, userId])
  }
  await client.query('UPDATE person_photos SET person_id=$1,updated_at=NOW() WHERE person_id=$2 AND user_id=$3', [targetPersonId, sourcePersonId, userId])
  await client.query('UPDATE person_contact_links SET person_id=$1,updated_at=NOW() WHERE person_id=$2 AND user_id=$3', [targetPersonId, sourcePersonId, userId])
  if (!target.rows[0].primary_photo_id && source.rows[0].primary_photo_id) {
    await client.query('UPDATE people SET primary_photo_id=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3', [source.rows[0].primary_photo_id, targetPersonId, userId])
  }
  await client.query('DELETE FROM people WHERE id=$1 AND user_id=$2', [sourcePersonId, userId])
}

async function reconcileContactPerson(client, { tenantId, userId, contactId, displayName, phones, emails }) {
  await client.query('SELECT pg_advisory_xact_lock($1,$2)', [Number(userId), 4342])
  await client.query('DELETE FROM contact_phone_numbers WHERE contact_id=$1 AND user_id=$2', [contactId, userId])
  const normalized = []
  for (const [index, phone] of (Array.isArray(phones) ? phones : []).entries()) {
    const raw = String(phone?.value || '').trim()
    const parsed = normalizePhone(raw)
    if (!parsed.normalized || normalized.includes(parsed.normalized)) continue
    normalized.push(parsed.normalized)
    await client.query(`INSERT INTO contact_phone_numbers
      (tenant_id,user_id,contact_id,raw_number,normalized_number,country_code,extension,type,is_primary)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [tenantId, userId, contactId, raw, parsed.normalized,
      parsed.normalized.startsWith('+82') ? 'KR' : null, parsed.extension || null, String(phone?.type || ''), index === 0])
  }

  await client.query('DELETE FROM contact_email_addresses WHERE contact_id=$1 AND user_id=$2', [contactId, userId])
  const normalizedEmails = []
  for (const [index, email] of (Array.isArray(emails) ? emails : []).entries()) {
    const raw = String(email?.value || '').trim()
    const normalized = normalizeEmail(raw)
    if (!normalized || normalizedEmails.includes(normalized)) continue
    normalizedEmails.push(normalized)
    await client.query(`INSERT INTO contact_email_addresses
      (tenant_id,user_id,contact_id,raw_email,normalized_email,type,is_primary)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, userId, contactId, raw, normalized, String(email?.type || ''), index === 0])
  }

  const current = await client.query('SELECT * FROM person_contact_links WHERE contact_id=$1 AND user_id=$2', [contactId, userId])
  if (current.rows[0]?.link_type === 'MANUAL') {
    await client.query('UPDATE contacts SET identity_indexed_at=NOW() WHERE id=$1 AND user_id=$2', [contactId, userId])
    return current.rows[0].person_id
  }
  let personId = current.rows[0]?.person_id || null
  let matchedPhone = current.rows[0]?.matched_phone || null
  let matchedEmail = current.rows[0]?.matched_email || null
  const candidates = await client.query(`SELECT DISTINCT person_id,matched_phone,matched_email FROM (
      SELECT l.person_id,pn.normalized_number AS matched_phone,NULL::text AS matched_email
      FROM contact_phone_numbers pn JOIN person_contact_links l ON l.contact_id=pn.contact_id AND l.match_status='CONFIRMED'
      WHERE pn.tenant_id=$1 AND pn.user_id=$2 AND pn.contact_id<>$3 AND pn.normalized_number=ANY($4::text[])
      UNION ALL
      SELECT l.person_id,NULL::text AS matched_phone,ea.normalized_email AS matched_email
      FROM contact_email_addresses ea JOIN person_contact_links l ON l.contact_id=ea.contact_id AND l.match_status='CONFIRMED'
      WHERE ea.tenant_id=$1 AND ea.user_id=$2 AND ea.contact_id<>$3 AND ea.normalized_email=ANY($5::text[])
    ) matches`, [tenantId, userId, contactId, normalized, normalizedEmails])
  const candidateIds = [...new Set(candidates.rows.map(row => row.person_id))]
  if (!personId && candidateIds.length) personId = candidateIds[0]
  for (const candidateId of candidateIds) {
    if (personId && candidateId !== personId) await mergePeople(client, { userId, targetPersonId: personId, sourcePersonId: candidateId })
  }
  matchedPhone = candidates.rows.find(row => row.matched_phone)?.matched_phone || matchedPhone
  matchedEmail = candidates.rows.find(row => row.matched_email)?.matched_email || matchedEmail
  if (!personId) {
    const created = await client.query(`INSERT INTO people (tenant_id,user_id,display_name) VALUES ($1,$2,$3) RETURNING id`,
      [tenantId, userId, String(displayName || '')])
    personId = created.rows[0].id
  } else if (displayName) {
    await client.query(`UPDATE people SET display_name=CASE WHEN display_name='' THEN $1 ELSE display_name END,updated_at=NOW()
      WHERE id=$2 AND user_id=$3`, [displayName, personId, userId])
  }
  await client.query(`INSERT INTO person_contact_links
    (tenant_id,user_id,person_id,contact_id,link_type,matched_phone,matched_email,match_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'CONFIRMED')
    ON CONFLICT (contact_id) DO UPDATE SET person_id=EXCLUDED.person_id,link_type=EXCLUDED.link_type,
      matched_phone=EXCLUDED.matched_phone,matched_email=EXCLUDED.matched_email,
      match_status='CONFIRMED',updated_at=NOW()`, [tenantId, userId, personId, contactId,
      matchedPhone ? 'AUTO_PHONE' : matchedEmail ? 'AUTO_EMAIL' : 'AUTO_PHONE', matchedPhone, matchedEmail])
  await client.query('UPDATE contacts SET identity_indexed_at=NOW() WHERE id=$1 AND user_id=$2', [contactId, userId])
  return personId
}

async function ensurePeopleForUser(db, { tenantId, userId }) {
  const { rows } = await db.query(`SELECT c.id,c.display_name,c.phones,c.emails FROM contacts c
    JOIN contact_resources r ON r.id=c.contact_resource_id AND r.deleted_at IS NULL
    LEFT JOIN person_contact_links l ON l.contact_id=c.id
    WHERE c.tenant_id=$1 AND c.user_id=$2 AND (l.id IS NULL OR c.identity_indexed_at IS NULL)
    ORDER BY c.created_at`, [tenantId, userId])
  if (!rows.length) return
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    for (const row of rows) await reconcileContactPerson(client, { tenantId, userId, contactId: row.id, displayName: row.display_name, phones: row.phones, emails: row.emails })
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

module.exports = { normalizePhone, normalizeEmail, reconcileContactPerson, ensurePeopleForUser }
