const cassandra = require('cassandra-driver')
const { getCassandraConfig } = require('./runtimeDbConfig')

const cassandraConfig = getCassandraConfig()
const contactPoints = cassandraConfig.contactPoints
const localDataCenter = cassandraConfig.localDataCenter
const keyspace = cassandraConfig.keyspace
const username = String(cassandraConfig.username || '').trim()
const password = String(cassandraConfig.password || '').trim()

const clientOptions = {
  contactPoints,
  localDataCenter,
  queryOptions: { prepare: true },
}
if (username && password) {
  clientOptions.authProvider = new cassandra.auth.PlainTextAuthProvider(username, password)
}

const client = new cassandra.Client(clientOptions)

let connected = false
let reconnectTimer = null

function isConnected() { return connected }
function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    console.log('🔄 Cassandra 재연결 시도...')
    try {
      if (client.controlConnection && client.controlConnection.isShuttingDown) return
      await initCassandra()
    } catch (_) {}
  }, 30000)
}

function logCassandraError(phase, err) {
  const code = err?.code || err?.name || 'UNKNOWN'
  const message = err?.message || String(err || '')
  console.warn(`⚠️ Cassandra ${phase} 실패 (${code}): ${message}`)
  if (Array.isArray(err?.innerErrors) && err.innerErrors.length > 0) {
    const details = err.innerErrors.map((e) => `${e?.code || e?.name || 'UNKNOWN'}:${e?.message || ''}`).join(' | ')
    console.warn(`   innerErrors: ${details}`)
  }
  if (err?.stack) {
    const firstLine = String(err.stack).split('\n').slice(0, 2).join(' | ')
    console.warn(`   stack: ${firstLine}`)
  }
}

async function initSchema() {
  await client.execute(`
    CREATE KEYSPACE IF NOT EXISTS ${keyspace}
    WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
  `)

  await client.execute(`USE ${keyspace}`)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS posts (
      id text,
      channel_id text,
      prev_post_id text,
      next_post_id text,
      child_post_id text,
      author_id int,
      parent_id text,
      content text,
      is_edited boolean,
      created_at timestamp,
      updated_at timestamp,
      attachments_1 text,
      attachments_2 text,
      attachments_3 text,
      attachments_4 text,
      attachments_5 text,
      attachments_6 text,
      attachments_7 text,
      attachments_8 text,
      attachments_9 text,
      attachments_10 text,
      security_level int,
      PRIMARY KEY (channel_id, created_at)
    ) WITH CLUSTERING ORDER BY (created_at DESC)
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS comments (
      id text,
      post_id text,
      author_id int,
      content text,
      attachments list<text>,
      security_level int,
      created_at timestamp,
      PRIMARY KEY (post_id, created_at)
    ) WITH CLUSTERING ORDER BY (created_at ASC)
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS attachments (
      id text PRIMARY KEY,
      post_id text,
      channel_id text,
      uploader_id int,
      filename text,
      storage_path text,
      content_type text,
      size bigint,
      status text,
      thumbnail_path text,
      created_at timestamp
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      owner_id      int,
      id            text,
      title         text,
      color         text,
      all_day       boolean,
      start_dt      text,
      end_dt        text,
      repeat        text,
      invitees      text,
      memo          text,
      security_level int,
      remind_dt     text,
      remind_repeat text,
      series_id     text,
      created_at    timestamp,
      updated_at    timestamp,
      PRIMARY KEY (owner_id, id)
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS calendar_invitations (
      invitee_id int,
      event_id   text,
      owner_id   int,
      PRIMARY KEY (invitee_id, event_id)
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS expense_posts (
      post_id         text PRIMARY KEY,
      channel_id      text,
      author_id       int,
      security_level  int,
      first_attachment_id text,
      is_edited       boolean,
      prev_post_id    text,
      next_post_id    text,
      parent_id       text,
      created_at      timestamp,
      updated_at      timestamp
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS expense_attachments (
      attachment_id      text PRIMARY KEY,
      post_id            text,
      file_url           text,
      file_name          text,
      order_index        int,
      next_attachment_id text,
      created_at         timestamp
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS posts_by_id (
      id text PRIMARY KEY,
      channel_id text,
      created_at timestamp,
      author_id int
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS comments_by_id (
      id text PRIMARY KEY,
      post_id text,
      created_at timestamp,
      author_id int
    )
  `)

  const migrations = [
    `ALTER TABLE ${keyspace}.posts ADD security_level int`,
    `ALTER TABLE ${keyspace}.comments ADD security_level int`,
    `ALTER TABLE ${keyspace}.expense_posts ADD form_data text`,
    `ALTER TABLE ${keyspace}.expense_posts ADD department text`,
  ]
  for (const cql of migrations) {
    try { await client.execute(cql) } catch (_) { /* 이미 존재하면 무시 */ }
  }
}

async function initCassandra() {
  try {
    await client.connect()
    connected = true
    console.log('✅ Cassandra connected')
    try {
      await initSchema()
      console.log('✅ Cassandra schema initialized')
    } catch (schemaErr) {
      // 연결은 성공했으므로 fallback으로 내리지 않고 에러만 기록
      logCassandraError('schema 초기화', schemaErr)
      console.warn('⚠️ Cassandra 연결은 유지되며, 일부 스키마 작업만 실패했습니다.')
    }
  } catch (err) {
    connected = false
    console.warn('⚠️ Cassandra 미연결 — PostgreSQL fallback 사용')
    console.warn(`   Cassandra 설정: contactPoints=${contactPoints.join(', ')} localDataCenter=${localDataCenter} keyspace=${keyspace} auth=${username ? 'enabled' : 'disabled'}`)
    logCassandraError('연결', err)
    scheduleReconnect()
  }
}

module.exports = { client, initCassandra, keyspace, isConnected }
