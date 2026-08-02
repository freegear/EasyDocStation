const { ImapFlow } = require('imapflow')

function createImapClient(account, password) {
  return new ImapFlow({
    host: account.imap_host,
    port: Number(account.imap_port),
    secure: account.imap_security !== 'starttls' && account.imap_security !== 'none',
    auth: { user: account.username || account.email_address, pass: password },
    logger: false,
  })
}

function describeAccount(account) {
  return [
    `account=${account?.id || 'unknown'}`,
    `provider=${account?.provider || 'unknown'}`,
    `host=${account?.imap_host || 'unknown'}`,
  ].join(' ')
}

async function closeImapClient(client) {
  if (client.usable) {
    try {
      await client.logout()
      return
    } catch {
      // Ensure a failed logout cannot leave a live socket behind after the
      // final error listener is removed.
    }
  }
  client.close()
}

/**
 * Converts ImapFlow EventEmitter errors into a normal Promise rejection.
 * Without an `error` listener, Node.js terminates on post-connect socket errors.
 */
async function withImapClient(account, password, operation, options = {}) {
  const clientFactory = options.clientFactory || createImapClient
  const client = clientFactory(account, password)
  let rejectTerminalError
  let firstTerminalError = null

  const terminalError = new Promise((_, reject) => {
    rejectTerminalError = reject
  })
  const onError = (err) => {
    if (firstTerminalError) return
    firstTerminalError = err instanceof Error ? err : new Error(String(err || 'Unknown IMAP error'))
    console.error(`[Mail IMAP] ${describeAccount(account)}:`, firstTerminalError)
    rejectTerminalError(firstTerminalError)
  }

  // Install synchronously before connect() starts.
  client.on('error', onError)

  const operationPromise = (async () => {
    await client.connect()
    return operation(client)
  })()

  try {
    return await Promise.race([operationPromise, terminalError])
  } finally {
    // Keep the listener during teardown because ImapFlow may emit a late error.
    await closeImapClient(client)
    client.removeListener('error', onError)
  }
}

module.exports = {
  createImapClient,
  withImapClient,
}
