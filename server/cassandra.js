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
        channel_id text,
        id uuid,
        author_id int,
        content text,
        attachments list<text>,
        authored_at timestamp,
        PRIMARY KEY (channel_id, authored_at)
      ) WITH CLUSTERING ORDER BY (authored_at DESC)
    `)

    console.log('✅ Cassandra schema initialized')
  } catch (err) {
    connected = false
    console.warn('⚠️ Cassandra 미연결 — PostgreSQL fallback 사용')
    console.warn('   Cassandra를 시작하려면: brew install cassandra && brew services start cassandra')
  }
}

module.exports = { client, initCassandra, keyspace, isConnected }
