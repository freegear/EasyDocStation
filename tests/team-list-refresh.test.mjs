import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildTeamList } from '../src/lib/teamList.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('space list enrichment does not require member-directory access', () => {
  const result = buildTeamList([
    { id: 'shared-unjoined', name: 'Shared', channels: [{ id: 'channel-1', unread: 0 }] },
    { id: 'personal-owned', name: 'Personal', visibility: 'personal', channels: null },
  ], { 'channel-1': 3 })

  assert.equal(result.length, 2)
  assert.equal(result[0].channels[0].unread, 3)
  assert.deepEqual(result[0].directMessages, [])
  assert.deepEqual(result[1].channels, [])
})

test('refreshTeams does not fetch every space member list', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'contexts', 'ChatContext.jsx'), 'utf8')

  assert.doesNotMatch(source, /apiFetch\(`\/teams\/\$\{[^}]+\}\/members`\)/)
  assert.match(source, /buildTeamList\(data, unreadCounts\)/)
  assert.match(source, /t\.sidebar\.loadFailed/)
})
