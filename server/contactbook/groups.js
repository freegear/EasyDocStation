function normalizeMemberUid(reference) {
  const value = String(reference || '').trim()
  if (!value || /^mailto:/i.test(value)) return ''
  return value.replace(/^urn:uuid:/i, '').replace(/^uuid:/i, '').trim().toLowerCase()
}

async function resolveAddressbookGroups(client, { tenantId, userId, addressbookId }) {
  const { rows: groups } = await client.query(`SELECT g.id,g.contact_resource_id,r.raw_vcard_encrypted
    FROM contact_groups g JOIN contact_resources r ON r.id=g.contact_resource_id
    WHERE g.tenant_id=$1 AND g.user_id=$2 AND g.addressbook_id=$3 AND g.deleted_at IS NULL AND r.deleted_at IS NULL`,
  [tenantId, userId, addressbookId])
  const { decryptSecret } = require('../lib/secrets')
  const { parseVCard } = require('./vcard')
  for (const group of groups) {
    const parsed = parseVCard(decryptSecret(group.raw_vcard_encrypted))
    await client.query('DELETE FROM contact_group_members WHERE group_id=$1 AND user_id=$2', [group.id, userId])
    for (const [index, reference] of parsed.members.entries()) {
      const normalized = normalizeMemberUid(reference)
      let resource = null
      if (normalized) {
        const found = await client.query(`SELECT r.id,CASE WHEN child.id IS NULL THEN 'CONTACT' ELSE 'GROUP' END AS member_kind
          FROM contact_resources r LEFT JOIN contact_groups child ON child.contact_resource_id=r.id AND child.deleted_at IS NULL
          WHERE r.tenant_id=$1 AND r.user_id=$2 AND r.addressbook_id=$3 AND r.deleted_at IS NULL
            AND LOWER(REGEXP_REPLACE(COALESCE(r.remote_uid,''),'^(urn:uuid:|uuid:)','','i'))=$4 LIMIT 1`,
        [tenantId, userId, addressbookId, normalized])
        resource = found.rows[0] || null
      }
      const external = /^mailto:/i.test(reference)
      await client.query(`INSERT INTO contact_group_members
        (tenant_id,user_id,group_id,member_resource_id,member_kind,member_reference_raw,member_uid_normalized,resolution_status,sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [tenantId, userId, group.id, resource?.id || null,
        resource?.member_kind || (external ? 'EXTERNAL' : 'CONTACT'), reference, normalized || null,
        resource ? 'RESOLVED' : external ? 'EXTERNAL' : 'MISSING', index])
    }
  }
}

module.exports = { normalizeMemberUid, resolveAddressbookGroups }
