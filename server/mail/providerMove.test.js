const test = require('node:test')
const assert = require('node:assert/strict')

const { resolveMailboxPath, findImapMessageAcrossMailboxes } = require('./providerMove')

test('Special-Use 속성으로 IMAP 휴지통을 찾는다', () => {
  const mailboxes = [{ path: 'Deleted', specialUse: '\\Trash' }]
  assert.equal(resolveMailboxPath(mailboxes, { type: 'trash', provider_folder_id: 'TRASH' }), 'Deleted')
})

test('flags Set의 Special-Use로 IMAP 휴지통을 찾는다', () => {
  const mailboxes = [{ path: 'Bin', flags: new Set(['\\Trash']) }]
  assert.equal(resolveMailboxPath(mailboxes, { type: 'trash', provider_folder_id: 'TRASH' }), 'Bin')
})

test('중첩된 휴지통 경로의 마지막 이름을 인식한다', () => {
  const mailboxes = [{ path: 'INBOX/Deleted Messages', delimiter: '/' }]
  assert.equal(resolveMailboxPath(mailboxes, { type: 'trash', provider_folder_id: 'TRASH' }), 'INBOX/Deleted Messages')
})

test('서버 목록에 없는 오래된 경로는 사용하지 않는다', () => {
  const mailboxes = [{ path: 'INBOX' }]
  assert.equal(resolveMailboxPath(mailboxes, { type: 'custom', provider_folder_id: 'Old/Folder' }), null)
})

test('이미 이동된 메일 복구 시 Gmail 휴지통을 전체보관함보다 우선 검색한다', async () => {
  let selected = ''
  const visited = []
  const client = {
    async getMailboxLock(path) {
      selected = path
      visited.push(path)
      return { release() {} }
    },
    async search() {
      if (selected === '[Gmail]/Trash') return [901]
      if (selected === '[Gmail]/All Mail') return [701]
      return []
    },
  }
  const mailboxes = [
    { path: '[Gmail]/All Mail' },
    { path: '[Gmail]/Trash', specialUse: '\\Trash' },
    { path: 'INBOX' },
  ]
  const found = await findImapMessageAcrossMailboxes(client, mailboxes, '<same@gmail.com>', {
    includeTrash: true,
    preferredMailbox: '[Gmail]/Trash',
  })
  assert.deepEqual(found, { mailbox: '[Gmail]/Trash', uid: 901 })
  assert.deepEqual(visited, ['[Gmail]/Trash'])
})

test('기본 전체 메일함 복구에서는 휴지통을 제외한다', async () => {
  let selected = ''
  const client = {
    async getMailboxLock(path) { selected = path; return { release() {} } },
    async search() { return selected === '[Gmail]/Trash' ? [901] : [] },
  }
  const found = await findImapMessageAcrossMailboxes(client, [
    { path: '[Gmail]/Trash', specialUse: '\\Trash' },
    { path: 'INBOX' },
  ], '<trash-only@gmail.com>')
  assert.equal(found, null)
})
