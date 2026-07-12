const test = require('node:test')
const assert = require('node:assert/strict')

const { resolveMailboxPath } = require('./providerMove')

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
