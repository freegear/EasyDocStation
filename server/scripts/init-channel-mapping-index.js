#!/usr/bin/env node
require('dotenv').config()

const { Pool } = require('pg')
const { getPostgresPoolOptions } = require('../runtimeDbConfig')
const { rebuildChannelMappingIndex } = require('../lib/channelMappingIndex')

const db = new Pool(getPostgresPoolOptions())

async function main() {
  const startedAt = Date.now()
  const result = await rebuildChannelMappingIndex(db)
  const elapsedMs = Date.now() - startedAt
  console.log(`✅ Channel mapping index initialized: ${result.channels} channels, ${result.terms} terms (${elapsedMs}ms)`)
}

main()
  .catch((err) => {
    console.error('❌ Channel mapping index initialization failed:', err.message)
    process.exitCode = 1
  })
  .finally(async () => {
    try { await db.end() } catch (_) {}
  })
