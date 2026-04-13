const cassandra = require('cassandra-driver')

const contactPoints = ['127.0.0.1']
const localDataCenter = 'datacenter1'
const keyspace = 'easydocstation'

const client = new cassandra.Client({
  contactPoints,
  localDataCenter,
  queryOptions: { prepare: true }
})

let connected = false

function isConnected() { return connected }

async function initCassandra() {
  try {
    await client.connect()
    connected = true
    console.log('✅ Cassandra connected')

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

    // 기존 테이블에 누락된 컬럼 추가 (마이그레이션)
    const migrations = [
      `ALTER TABLE ${keyspace}.posts ADD security_level int`,
      `ALTER TABLE ${keyspace}.comments ADD security_level int`,
    ]
    for (const cql of migrations) {
      try { await client.execute(cql) } catch (_) { /* 이미 존재하면 무시 */ }
    }

    console.log('✅ Cassandra schema initialized')
  } catch (err) {
    connected = false
    console.warn('⚠️ Cassandra 미연결 — PostgreSQL fallback 사용')
    console.warn('   Cassandra를 시작하려면: brew install cassandra && brew services start cassandra')
  }
}

module.exports = { client, initCassandra, keyspace, isConnected }
