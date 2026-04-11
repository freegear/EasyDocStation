const cassandra = require('cassandra-driver')

const contactPoints = ['127.0.0.1']
const localDataCenter = 'datacenter1'
const keyspace = 'easydocstation'

const client = new cassandra.Client({
  contactPoints,
  localDataCenter,
  queryOptions: { prepare: true }
})

async function initCassandra() {
  try {
    await client.connect()
    console.log('✅ Cassandra connected')

    // Create Keyspace
    await client.execute(`
      CREATE KEYSPACE IF NOT EXISTS ${keyspace}
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
    `)

    await client.execute(`USE ${keyspace}`)

    // Create Posts Table
    // Partition by channel_id, cluster by authored_at DESC
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
    console.warn('⚠️ Cassandra connection failed. Ensure Cassandra is running on localhost:9042')
    console.warn(err.message)
    // We don't exit(1) to allow the rest of the app to at least start, 
    // though post features will fail.
  }
}

module.exports = { client, initCassandra, keyspace }
