const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { withImapClient } = require('./imapClient')

class FakeImapClient extends EventEmitter {
  constructor() {
    super()
    this.usable = false
    this.closed = false
    this.loggedOut = false
  }

  async connect() {
    this.usable = true
  }

  async logout() {
    this.loggedOut = true
    this.usable = false
  }

  close() {
    this.closed = true
    this.usable = false
  }
}

const account = {
  id: 'test-account',
  provider: 'imap',
  imap_host: 'imap.example.test',
}

test('returns a successful IMAP operation and logs out cleanly', async () => {
  const client = new FakeImapClient()
  const result = await withImapClient(
    account,
    'secret',
    async () => 'ok',
    { clientFactory: () => client },
  )

  assert.equal(result, 'ok')
  assert.equal(client.loggedOut, true)
  assert.equal(client.listenerCount('error'), 0)
})

test('turns an ImapFlow error event into a rejected operation without throwing globally', async () => {
  const client = new FakeImapClient()
  const originalConsoleError = console.error
  console.error = () => {}

  try {
    await assert.rejects(
      withImapClient(
        account,
        'secret',
        async currentClient => {
          currentClient.usable = false
          queueMicrotask(() => {
            currentClient.emit('error', Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' }))
          })
          return new Promise(() => {})
        },
        { clientFactory: () => client },
      ),
      err => err?.code === 'ETIMEOUT',
    )
  } finally {
    console.error = originalConsoleError
  }

  assert.equal(client.closed, true)
  assert.equal(client.listenerCount('error'), 0)
})
