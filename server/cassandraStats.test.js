const test = require('node:test')
const assert = require('node:assert/strict')

const { parseFirstDataDirectory } = require('./cassandraStats')

test('parseFirstDataDirectory reads the first Cassandra data directory', () => {
  const yaml = `
cluster_name: EasyDocStation
data_file_directories:
    - /var/lib/cassandra/data
    - /mnt/cassandra/data
commitlog_directory: /var/lib/cassandra/commitlog
`

  assert.equal(parseFirstDataDirectory(yaml), '/var/lib/cassandra/data')
})

test('parseFirstDataDirectory ignores comments and supports quoted paths', () => {
  const yaml = `
data_file_directories:
  # primary data volume
  - "/srv/cassandra data" # Cassandra files
`

  assert.equal(parseFirstDataDirectory(yaml), '/srv/cassandra data')
})
