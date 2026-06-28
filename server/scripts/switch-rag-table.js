#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')

function usage() {
  console.log(`Usage:
  node server/scripts/switch-rag-table.js status
  node server/scripts/switch-rag-table.js switch <table_name> [schema_version]
  node server/scripts/switch-rag-table.js rollback`)
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
}

const cmd = process.argv[2]
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage()
  process.exit(cmd ? 0 : 1)
}

const cfg = readConfig()
cfg.rag = cfg.rag || {}

if (cmd === 'status') {
  console.log(JSON.stringify({
    active_table: cfg.rag.active_table || cfg.rag.table_name || 'my_rag_table',
    next_table: cfg.rag.next_table || 'my_rag_table_v2',
    previous_table: cfg.rag.previous_table || '',
    fallback_table: cfg.rag.fallback_table || cfg.rag.previous_table || '',
    search_fallback_enabled: cfg.rag.search_fallback_enabled !== false,
    schema_version: Number(cfg.rag.schema_version || 1),
    fallback_schema_version: Number(cfg.rag.fallback_schema_version || 1),
    rebuild_schema_version: Number(cfg.rag.rebuild_schema_version || 2),
  }, null, 2))
  process.exit(0)
}

if (cmd === 'switch') {
  const tableName = String(process.argv[3] || '').trim()
  if (!tableName) {
    usage()
    process.exit(1)
  }
  const schemaVersion = Number(process.argv[4] || (tableName.endsWith('_v2') ? 2 : 1))
  const current = cfg.rag.active_table || cfg.rag.table_name || 'my_rag_table'
  cfg.rag.previous_table = current
  cfg.rag.fallback_table = current
  cfg.rag.active_table = tableName
  cfg.rag.table_name = tableName
  cfg.rag.schema_version = Number.isFinite(schemaVersion) && schemaVersion > 0 ? schemaVersion : 1
  cfg.rag.fallback_schema_version = current.endsWith('_v2') ? 2 : 1
  cfg.rag.search_fallback_enabled = cfg.rag.search_fallback_enabled !== false
  if (tableName === cfg.rag.next_table) cfg.rag.next_table = current
  writeConfig(cfg)
  console.log(`RAG active table switched: ${current} -> ${tableName}`)
  process.exit(0)
}

if (cmd === 'rollback') {
  const previous = String(cfg.rag.previous_table || '').trim()
  if (!previous) {
    console.error('previous_table이 비어 있어 rollback 할 수 없습니다.')
    process.exit(1)
  }
  const current = cfg.rag.active_table || cfg.rag.table_name || 'my_rag_table'
  cfg.rag.active_table = previous
  cfg.rag.table_name = previous
  cfg.rag.previous_table = current
  cfg.rag.fallback_table = current
  cfg.rag.schema_version = previous.endsWith('_v2') ? 2 : 1
  cfg.rag.fallback_schema_version = current.endsWith('_v2') ? 2 : 1
  cfg.rag.search_fallback_enabled = cfg.rag.search_fallback_enabled !== false
  writeConfig(cfg)
  console.log(`RAG active table rolled back: ${current} -> ${previous}`)
  process.exit(0)
}

usage()
process.exit(1)
