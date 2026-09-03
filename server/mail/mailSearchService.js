const repo = require('./repository')
const searchRepo = require('./mailSearchRepository')
const { getMailStorage } = require('./storage')
const { validateMailSearchInput } = require('./mailSearch')

const INDEX_BATCH_SIZE = 200

function encodeCursor(row) {
  if (!row) return null
  return Buffer.from(JSON.stringify({
    time: row.sort_at,
    tenantId: row.tenant_id,
    messageId: row.id,
  }), 'utf8').toString('base64url')
}

function decodeCursor(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (!parsed.time || !parsed.tenantId || !parsed.messageId || Number.isNaN(Date.parse(parsed.time))) throw new Error('invalid')
    return { time: parsed.time, tenantId: String(parsed.tenantId), messageId: String(parsed.messageId) }
  } catch {
    const error = new Error('검색 커서가 올바르지 않습니다.')
    error.status = 400
    error.code = 'INVALID_MAIL_SEARCH_CURSOR'
    throw error
  }
}

async function readTextObject(storage, key) {
  if (!key) return ''
  return (await storage.getObject(key)).toString('utf8')
}

async function ensureUserSearchIndex({ tenantId, userId }) {
  const storage = getMailStorage()
  while (true) {
    const pending = await searchRepo.listPendingSearchDocuments({ tenantId, userId, limit: INDEX_BATCH_SIZE })
    if (pending.length === 0) return
    for (const message of pending) {
      try {
        const [bodyText, bodyHtml] = await Promise.all([
          readTextObject(storage, message.body_text_object_key),
          readTextObject(storage, message.body_html_object_key),
        ])
        await searchRepo.upsertSearchDocument({ tenantId, userId, message, bodyText, bodyHtml })
      } catch (cause) {
        const error = new Error('메일 본문 검색 인덱스를 완성하지 못했습니다. 잠시 후 다시 시도해주세요.')
        error.status = 503
        error.code = 'MAIL_SEARCH_INDEX_INCOMPLETE'
        error.cause = cause
        throw error
      }
    }
  }
}

function compareRows(left, right) {
  const timeDiff = Date.parse(right.sort_at) - Date.parse(left.sort_at)
  if (timeDiff) return timeDiff
  const tenantDiff = String(right.tenant_id).localeCompare(String(left.tenant_id))
  if (tenantDiff) return tenantDiff
  return String(right.id).localeCompare(String(left.id))
}

async function searchAllUserMail({ userId, field, query, cursor: cursorValue, limit = 50 }) {
  const normalized = validateMailSearchInput(field, query)
  const cursor = decodeCursor(cursorValue)
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50))

  await repo.ensurePersonalTenant(userId)
  await repo.syncTeamTenantsForUser(userId)
  // 의도적으로 isSiteAdmin=false: 일반 검색에서는 관리자도 자신의 tenant 멤버십만 사용한다.
  const tenants = await repo.listTenantsForUser({ userId, isSiteAdmin: false })

  const candidates = []
  let total = 0
  for (const tenant of tenants) {
    await ensureUserSearchIndex({ tenantId: tenant.id, userId })
    const [rows, count] = await Promise.all([
      searchRepo.searchMessages({
        tenantId: tenant.id,
        userId,
        field: normalized.field,
        searchQuery: normalized.query,
        cursor,
        limit: safeLimit + 1,
      }),
      searchRepo.countMessages({
        tenantId: tenant.id,
        userId,
        field: normalized.field,
        searchQuery: normalized.query,
      }),
    ])
    candidates.push(...rows)
    total += count
  }

  candidates.sort(compareRows)
  const hasMore = candidates.length > safeLimit
  const items = candidates.slice(0, safeLimit)
  return {
    items,
    total,
    hasMore,
    nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
    field: normalized.field,
    query: normalized.query,
  }
}

module.exports = {
  decodeCursor,
  encodeCursor,
  ensureUserSearchIndex,
  searchAllUserMail,
}
