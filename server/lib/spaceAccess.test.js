const test = require('node:test')
const assert = require('node:assert/strict')
const { decideSpaceAccess, authorizeSpace, getSearchAccessibleSpaceIds, grantEmergencyAccess, revokeEmergencyAccess } = require('./spaceAccess')

const personal = (overrides = {}) => ({
  id: 'space-private', visibility: 'personal', owner_id: 10,
  is_admin: false, is_member: false, emergency_id: null, emergency_reason: null,
  ...overrides,
})

test('personal space denies site_admin without emergency access', () => {
  assert.deepEqual(
    decideSpaceAccess(personal(), { id: 1, role: 'site_admin' }),
    { allowed: false, via: 'private_denied' },
  )
})

test('personal space allows site_admin when it is the explicit owner', () => {
  assert.deepEqual(
    decideSpaceAccess(personal(), { id: 10, role: 'site_admin' }),
    { allowed: true, via: 'space_owner' },
  )
})

test('personal space allows only its space administrator normally', () => {
  assert.deepEqual(
    decideSpaceAccess(personal({ owner_id: 99, is_admin: true }), { id: 10, role: 'team_admin' }),
    { allowed: true, via: 'space_admin' },
  )
  assert.equal(
    decideSpaceAccess(personal({ is_member: true }), { id: 11, role: 'user' }).allowed,
    false,
  )
})

test('shared space keeps existing site admin/member behavior', () => {
  const shared = { visibility: 'shared', is_admin: false, is_member: true }
  assert.equal(decideSpaceAccess(shared, { id: 1, role: 'site_admin' }).allowed, true)
  assert.equal(decideSpaceAccess(shared, { id: 2, role: 'user' }).allowed, true)
  assert.equal(decideSpaceAccess(shared, { id: 2, role: 'user' }, { manage: true }).allowed, false)
})

test('emergency access is site_admin-only and writes an audit event', async () => {
  const calls = []
  const db = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes('FROM teams t')) {
        return { rows: [personal({ emergency_id: 7, emergency_reason: '장애 복구를 위한 긴급 확인' })] }
      }
      return { rows: [], rowCount: 1 }
    },
  }
  const result = await authorizeSpace(db, { id: 1, role: 'site_admin' }, 'space-private', {
    auditAction: 'view_posts', details: { requestId: 'req-1' },
  })
  assert.equal(result.allowed, true)
  assert.equal(result.via, 'emergency')
  assert.equal(calls.length, 2)
  assert.match(calls[1].sql, /personal_space_audit_log/)
  assert.equal(calls[1].params[2], 'view_posts')
})

test('normal space admin access does not create emergency audit rows', async () => {
  const calls = []
  const db = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [personal({ is_admin: true })] }
    },
  }
  const result = await authorizeSpace(db, { id: 10, role: 'team_admin' }, 'space-private', {
    auditAction: 'view_posts',
  })
  assert.equal(result.allowed, true)
  assert.equal(calls.length, 1)
})

test('emergency access grant validates role, reason and duration', async () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) }
  await assert.rejects(grantEmergencyAccess(db, { id: 2, role: 'user' }, 'p', { reason: '충분한 긴급 접근 사유입니다', durationMinutes: 15 }), e => e.status === 403)
  await assert.rejects(grantEmergencyAccess(db, { id: 1, role: 'site_admin' }, 'p', { reason: '짧음', durationMinutes: 15 }), e => e.status === 400)
  await assert.rejects(grantEmergencyAccess(db, { id: 1, role: 'site_admin' }, 'p', { reason: '충분한 긴급 접근 사유입니다', durationMinutes: 61 }), e => e.status === 400)
})

test('site_admin cannot grant emergency access to their own personal space', async () => {
  const calls = []
  const db = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ id: 'space-private', owner_id: 1 }], rowCount: 1 }
    },
  }
  await assert.rejects(
    grantEmergencyAccess(db, { id: 1, role: 'site_admin' }, 'space-private', { reason: '자기 개인 공간 복구 확인 사유', durationMinutes: 15 }),
    error => error.status === 400 && /필요하지 않습니다/.test(error.message),
  )
  assert.equal(calls.length, 1)
})

test('emergency access revoke requires site_admin and a sufficient reason', async () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) }
  await assert.rejects(revokeEmergencyAccess(db, { id: 2, role: 'user' }, 1, '충분한 긴급 접근 해제 사유'), e => e.status === 403)
  await assert.rejects(revokeEmergencyAccess(db, { id: 1, role: 'site_admin' }, 1, '짧음'), e => e.status === 400)
})

test('site_admin remains denied even if accidentally assigned as personal-space admin', () => {
  const result = decideSpaceAccess(personal({ is_admin: true }), { id: 1, role: 'site_admin' })
  assert.equal(result.allowed, false)
  assert.equal(result.via, 'private_denied')
})

test('search scope keeps personal spaces out of site_admin membership bypasses', async () => {
  const calls = []
  const db = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ id: 'shared-1', visibility: 'shared', emergency_reason: null }] }
    },
  }
  const ids = await getSearchAccessibleSpaceIds(db, { id: 1, role: 'site_admin' })
  assert.deepEqual(ids, ['shared-1'])
  assert.equal(calls[0].params[1], true)
  assert.match(calls[0].sql, /personal_space_emergency_access/)
  assert.match(calls[0].sql, /visibility <>/)
  assert.match(calls[0].sql, /t\.owner_id=\$1/)
})

test('emergency search scope is isolated and audited', async () => {
  const calls = []
  const db = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (calls.length === 1) {
        return {
          rows: [
            { id: 'shared-1', visibility: 'shared', owner_id: null, emergency_reason: null },
            { id: 'private-owned', visibility: 'personal', owner_id: 1, emergency_reason: null },
            { id: 'private-1', visibility: 'personal', owner_id: 10, emergency_reason: '장애 복구를 위한 긴급 검색 확인' },
          ],
        }
      }
      return { rows: [], rowCount: 1 }
    },
  }
  const ids = await getSearchAccessibleSpaceIds(db, { id: 1, role: 'site_admin' }, {
    auditAction: 'rag_search',
    details: { requestId: 'req-search-1' },
  })
  assert.deepEqual(ids, ['shared-1', 'private-owned', 'private-1'])
  assert.equal(calls.length, 2)
  assert.match(calls[1].sql, /personal_space_audit_log/)
  assert.equal(calls[1].params[0], 'private-1')
  assert.equal(calls[1].params[2], 'rag_search')
})
