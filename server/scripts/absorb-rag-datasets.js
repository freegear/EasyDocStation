#!/usr/bin/env node
// 기존 JSON 인덱스 기반 RAG 데이터셋(Database/RAGTrainingData/index.json)을
// 새 Postgres 폴더 데이터셋 모델(folder_datasets/folder_documents)로 흡수한다.
//
// 정책:
//  - 원본 파일은 이동하지 않고 복사한다 → 기존 /api/rag/datasets 기능은 그대로 동작한다.
//  - 재실행 안전(idempotent): 같은 (dataset, relative_path, hash) 문서가 있으면 건너뛴다.
//  - 흡수 대상은 단일 데이터셋 'dataset-legacy-rag-import'(access_scope='all')로 모은다.
//
// 실행: node server/scripts/absorb-rag-datasets.js

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })

const db = require('../db')
const { getDatabasePath } = require('../databasePaths')
const repo = require('../folder/repository')

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch (_) { return {} }
}
const STORAGE_BASE = getDatabasePath(readConfig(), 'ObjectFile Path')
const RAG_DATA_DIR = path.resolve(__dirname, '../../Database/RAGTrainingData')
const RAG_INDEX = path.join(RAG_DATA_DIR, 'index.json')

const LEGACY_DATASET_ID = 'dataset-legacy-rag-import'

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}
function safeSegment(seg = '') {
  const cleaned = String(seg).normalize('NFC').replace(/[\/\\]/g, '_').replace(/[\u0000-\u001F\u007F]/g, '').trim()
  return cleaned || `file-${Date.now()}`
}

async function ensureLegacyDataset() {
  await db.query(
    `INSERT INTO folder_datasets (id, owner_id, name, root_folder, access_scope, security_level, source_type, status)
     VALUES ($1, NULL, '이전된 RAG 데이터셋', '', 'all', 0, 'browser_upload', 'completed')
     ON CONFLICT (id) DO NOTHING`,
    [LEGACY_DATASET_ID],
  )
}

async function main() {
  if (!fs.existsSync(RAG_INDEX)) {
    console.log('index.json 이 없어 흡수할 데이터가 없습니다.')
    process.exit(0)
  }
  const records = JSON.parse(fs.readFileSync(RAG_INDEX, 'utf8'))
  if (!Array.isArray(records) || records.length === 0) {
    console.log('흡수할 레코드가 없습니다.')
    process.exit(0)
  }

  await ensureLegacyDataset()
  const batchId = await repo.createBatch({ datasetId: LEGACY_DATASET_ID, ownerId: null, fileCount: records.length })

  let imported = 0, skipped = 0, missing = 0
  for (const rec of records) {
    const src = path.join(RAG_DATA_DIR, rec.storage_path || '')
    if (!rec.storage_path || !fs.existsSync(src)) { missing += 1; continue }

    const fileName = rec.original_filename || rec.filename || path.basename(src)
    const relativePath = fileName // 기존 데이터셋은 flat 구조
    const hash = sha256(src)

    const dup = await repo.findDuplicate(LEGACY_DATASET_ID, relativePath, hash)
    if (dup) { skipped += 1; continue }

    const attachmentId = await repo.createAttachment({
      filename: fileName,
      contentType: rec.content_type || 'application/octet-stream',
      size: rec.size || fs.statSync(src).size,
      storagePath: 'PENDING',
      uploaderId: null,
      securityLevel: 0,
    })
    const storageKey = path.join('folder-datasets', LEGACY_DATASET_ID, attachmentId, safeSegment(fileName))
    const dst = path.join(STORAGE_BASE, storageKey)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    await db.query(`UPDATE attachments SET storage_path=$2 WHERE id=$1`, [attachmentId, storageKey])

    const docId = await repo.createDocument({
      datasetId: LEGACY_DATASET_ID, batchId, attachmentId, ownerId: null,
      accessScope: 'all', scopeTeamId: null, scopeChannelId: null,
      securityLevel: 0, effectiveSecurityLevel: 0,
      fileName, extension: (rec.ext || path.extname(fileName).replace('.', '')).toLowerCase(),
      fileSize: rec.size || 0, contentType: rec.content_type || 'application/octet-stream',
      hash, hashAlgorithm: 'sha256',
      uploadStatus: 'uploaded', storageStatus: 'committed', storagePath: storageKey,
      rootFolder: '', relativePath, folderPath: '', parentFolder: '',
      folderKeywords: [], folderGroupId: repo.makeFolderGroupId(LEGACY_DATASET_ID, ''), siblingFiles: [],
    })
    // 기존에 학습된 파일은 training_status를 completed로 표시(참고용)
    if (rec.status === 'trained') {
      await db.query(`UPDATE folder_documents SET training_status='completed' WHERE id=$1`, [docId])
    }
    imported += 1
  }

  await repo.finishBatch(batchId, { status: 'completed', completedCount: imported, failedCount: missing })
  await repo.refreshDatasetCounts(LEGACY_DATASET_ID)
  console.log(`흡수 완료: imported=${imported}, skipped(중복)=${skipped}, missing(원본없음)=${missing}`)
  process.exit(0)
}

main().catch(e => { console.error('흡수 실패:', e.message); process.exit(1) })
