const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { canAccessChannel, getAccessibleChannelIds } = require('./channelAccess')

const SERVER_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')

test('channel ACL keeps site_admin behind an active personal-space emergency grant', async () => {
  const calls = []
  const deniedDb = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [], rowCount: 0 }
    },
  }
  assert.equal(await canAccessChannel(deniedDb, { id: 1, role: 'site_admin' }, 'private-channel'), false)
  assert.match(calls[0].sql, /t\.visibility <> 'personal'/)
  assert.match(calls[0].sql, /personal_space_emergency_access/)
  assert.match(calls[0].sql, /t\.owner_id=\$2/)

  const ownerCalls = []
  const ownerDb = {
    async query(sql, params) {
      ownerCalls.push({ sql, params })
      return {
        rows: [{ team_id: 'owned-space', visibility: 'personal', owner_id: 1, emergency_access: false }],
        rowCount: 1,
      }
    },
  }
  assert.equal(await canAccessChannel(ownerDb, { id: 1, role: 'site_admin' }, 'owned-channel'), true)
  assert.equal(ownerCalls.length, 1)

  const auditedCalls = []
  const emergencyDb = {
    async query(sql, params) {
      auditedCalls.push({ sql, params })
      if (auditedCalls.length === 1) {
        return {
          rows: [{ team_id: 'private-space', visibility: 'personal', owner_id: 10, emergency_access: true }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 1 }
    },
  }
  assert.equal(await canAccessChannel(emergencyDb, { id: 1, role: 'site_admin' }, 'private-channel'), true)
  assert.equal(auditedCalls.length, 2)
  assert.match(auditedCalls[1].sql, /personal_space_audit_log/)
  assert.equal(auditedCalls[1].params[0], 'private-space')
})

test('accessible channel list SQL contains the same personal-space boundary', async () => {
  let capturedSql = ''
  const db = {
    async query(sql) {
      capturedSql = sql
      return { rows: [] }
    },
  }
  await getAccessibleChannelIds(db, { id: 1, role: 'site_admin', security_level: 4 })
  assert.match(capturedSql, /t\.visibility <> 'personal'/)
  assert.match(capturedSql, /t\.owner_id=\$2/)
  assert.match(capturedSql, /pea\.revoked_at IS NULL/)
  assert.match(capturedSql, /pea\.expires_at > NOW\(\)/)
})

test('Node RAG post-filter and cache key include authorized space scope', () => {
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'routes', 'rag.js'), 'utf8')
  assert.doesNotMatch(source, /if \(ctx\.is_site_admin\) return true/)
  assert.match(source, /getSearchAccessibleSpaceIds\(db, req\.user/)
  assert.match(source, /scope_fingerprint:\s*hashPayload\(\{[\s\S]*?team_ids:/)
  assert.match(source, /allowed_channel_ids_fingerprint/)
})

test('folder dataset listing has no blanket site_admin bypass', () => {
  const repository = fs.readFileSync(path.join(SERVER_ROOT, 'folder', 'repository.js'), 'utf8')
  const route = fs.readFileSync(path.join(SERVER_ROOT, 'routes', 'folderDatasets.js'), 'utf8')
  assert.doesNotMatch(repository, /\$5::boolean\s*=\s*true/)
  assert.doesNotMatch(route, /if \(user\.role === 'site_admin'\) return true/)
  assert.match(route, /getSearchAccessibleSpaceIds\(db, user/)
})

test('both Python RAG paths deny blanket site_admin scope and stay symmetric', () => {
  const script = String.raw`
import ast, json, sys
from pathlib import Path

wanted = {'normalize_id_list', 'sql_quote', 'build_acl_clause'}
outputs = []
for source_path in sys.argv[1:]:
    tree = ast.parse(Path(source_path).read_text(encoding='utf-8'), filename=source_path)
    module = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in wanted], type_ignores=[])
    scope = {}
    exec(compile(module, source_path, 'exec'), scope)
    build = scope['build_acl_clause']
    denied = build(['access_scope'], [], {
        'user_id': '1', 'team_ids': [], 'accessible_channel_ids': [],
        'security_level': 4, 'is_site_admin': True,
    })
    emergency = build(['access_scope'], [], {
        'user_id': '1', 'team_ids': ['private-space'], 'accessible_channel_ids': [],
        'security_level': 4, 'is_site_admin': True,
    })
    outputs.append({'denied': denied, 'emergency': emergency})
print(json.dumps(outputs))
`
  const result = spawnSync('python3', [
    '-c', script,
    path.join(SERVER_ROOT, 'rag_search.py'),
    path.join(SERVER_ROOT, 'rag_server.py'),
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const outputs = JSON.parse(result.stdout)
  assert.deepEqual(outputs[0], outputs[1])
  assert.doesNotMatch(outputs[0].denied, /access_scope <>/)
  assert.doesNotMatch(outputs[0].denied, /scope_team_id/)
  assert.match(outputs[0].emergency, /scope_team_id IN \('private-space'\)/)
})

test('emergency UI requires reason, expiry and the audited API endpoints', () => {
  const source = fs.readFileSync(
    path.join(PROJECT_ROOT, 'src', 'components', 'EmergencySpaceAccessModal.jsx'),
    'utf8',
  )
  assert.match(source, /safeReason\.length < 10/)
  assert.match(source, /min="1" max="60"/)
  assert.match(source, /\/teams\/\$\{encodeURIComponent\(id\)\}\/emergency-access/)
  assert.match(source, /\/teams\/emergency-access\/\$\{encodeURIComponent\(accessId\)\}/)
})

test('personal-space creation UI and API keep ownership single-user and immutable', () => {
  const modal = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'components', 'TeamManageModal.jsx'), 'utf8')
  const sidebar = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'components', 'Sidebar.jsx'), 'utf8')
  const channelModal = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'components', 'ChannelManageModal.jsx'), 'utf8')
  const teamsRoute = fs.readFileSync(path.join(SERVER_ROOT, 'routes', 'teams.js'), 'utf8')
  assert.match(modal, /visibility: isPersonal \? 'personal' : 'shared'/)
  assert.match(modal, /privacyToggleLocked = isEdit \|\| forcePersonal/)
  assert.doesNotMatch(modal, /privacyToggleLocked =[^\n]*isSiteAdmin/)
  assert.match(modal, /\{!isPersonal && <>/)
  assert.match(channelModal, /\{!isPersonalSpace && <>/)
  assert.match(teamsRoute, /const finalAdmins = isPersonal \? \[req\.user\.id\]/)
  assert.match(teamsRoute, /if \(!isPersonal && memberIds/)
  assert.match(teamsRoute, /VALUES \(\$1,\$2,'list_space'/)
  assert.doesNotMatch(teamsRoute, /site_admin은 개인스페이스를 생성/)
  assert.match(teamsRoute, /t\.owner_id=\$1/)
  assert.match(sidebar, /\{currentUser && currentUser\.role !== 'site_admin' && \(/)
  assert.doesNotMatch(sidebar, /setShowEmergencyAccessModal/)
})
