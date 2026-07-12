// 폴더 업로드 데이터셋 데이터 접근 계층
// SQL은 이 모듈에 모으고 라우트/UI에 흩뿌리지 않는다.
// 설계: MDfiles/UploadFolder.md (4.2 테이블, 4.4 소유권/보안, 17장 삭제, 23장 접근 범위)

const crypto = require('crypto')
const db = require('../db')

const REMOVED_STATUSES = ['removed', 'deleted']

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

// ── 폴더 경로 정규화 (UploadFolder.md 5장) ──
function normalizeFolderPath(relativePath = '') {
  const segments = String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .map(s => s.trim())
    .filter(Boolean)
  // 마지막 세그먼트는 파일명이므로 폴더 경로에서 제외
  const folderSegments = segments.slice(0, -1)
  return {
    segments,
    folderSegments,
    folderPath: folderSegments.join('/'),
    parentFolder: folderSegments[folderSegments.length - 1] || '',
    keywords: Array.from(new Set(folderSegments)),
  }
}

// folder_group_id = hash(dataset_id + normalized_folder_path) (UploadFolder.md 6장)
function makeFolderGroupId(datasetId, folderPath) {
  const h = crypto.createHash('sha256').update(`${datasetId}::${folderPath}`).digest('hex')
  return `foldergrp-${h.slice(0, 16)}`
}

// ── 데이터셋 ──
async function createDataset({
  ownerId, name, rootFolder, accessScope = 'personal',
  scopeTeamId = null, scopeChannelId = null, securityLevel = 0,
  sourceType = 'browser_upload',
}) {
  const id = makeId('dataset')
  await db.query(
    `INSERT INTO folder_datasets
       (id, owner_id, name, root_folder, access_scope, scope_team_id, scope_channel_id,
        security_level, source_type, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'uploading')`,
    [id, ownerId, name, rootFolder, accessScope, scopeTeamId, scopeChannelId, securityLevel, sourceType],
  )
  return id
}

async function updateDatasetStatus(datasetId, status) {
  await db.query(
    `UPDATE folder_datasets SET status=$2, updated_at=NOW() WHERE id=$1`,
    [datasetId, status],
  )
}

// 데이터셋 집계(파일 수/총 바이트)를 folder_documents 기준으로 재계산
async function refreshDatasetCounts(datasetId) {
  await db.query(
    `UPDATE folder_datasets d SET
        file_count  = sub.cnt,
        total_bytes = sub.bytes,
        updated_at  = NOW()
     FROM (
        SELECT COUNT(*)::int AS cnt, COALESCE(SUM(file_size),0)::bigint AS bytes
        FROM folder_documents
        WHERE dataset_id=$1 AND storage_status <> 'removed'
     ) sub
     WHERE d.id=$1`,
    [datasetId],
  )
}

// ── 배치 ──
async function createBatch({ datasetId, ownerId, fileCount = 0, totalBytes = 0 }) {
  const id = makeId('batch')
  await db.query(
    `INSERT INTO folder_upload_batches
       (id, dataset_id, owner_id, status, file_count, total_bytes, started_at)
     VALUES ($1,$2,$3,'uploading',$4,$5,NOW())`,
    [id, datasetId, ownerId, fileCount, totalBytes],
  )
  return id
}

async function finishBatch(batchId, { status, completedCount = 0, failedCount = 0, errorMessage = null }) {
  await db.query(
    `UPDATE folder_upload_batches
        SET status=$2, completed_count=$3, failed_count=$4, error_message=$5, finished_at=NOW()
      WHERE id=$1`,
    [batchId, status, completedCount, failedCount, errorMessage],
  )
}

// ── 첨부(원본 파일 기준 테이블) ──
// 폴더 업로드는 기존 게시글 첨부를 재사용하지 않고 전용 attachments를 새로 만든다(4.4).
async function createAttachment({ filename, contentType, size, storagePath, uploaderId, securityLevel = 0 }) {
  const id = crypto.randomUUID()
  await db.query(
    `INSERT INTO attachments
       (id, filename, content_type, size, status, storage_path, uploader_id, owner_id, security_level, created_at)
     VALUES ($1,$2,$3,$4,'COMPLETED',$5,$6,$6,$7,NOW())`,
    [id, filename, contentType, size, storagePath, uploaderId, securityLevel],
  )
  return id
}

// ── 문서(폴더 파생 메타데이터) ──
async function createDocument(doc) {
  const id = makeId('doc')
  await db.query(
    `INSERT INTO folder_documents (
        id, dataset_id, batch_id, attachment_id, owner_id,
        access_scope, scope_team_id, scope_channel_id, security_level, effective_security_level,
        file_name, extension, file_size, content_type, hash, hash_algorithm,
        upload_status, storage_status, storage_path,
        root_folder, relative_path, folder_path, parent_folder,
        folder_keywords, folder_group_id, sibling_files,
        modified_at_original, uploaded_at, training_status)
     VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,
        $17,$18,$19,
        $20,$21,$22,$23,
        $24,$25,$26,
        $27, NOW(), 'pending')`,
    [
      id, doc.datasetId, doc.batchId, doc.attachmentId, doc.ownerId,
      doc.accessScope, doc.scopeTeamId, doc.scopeChannelId, doc.securityLevel, doc.effectiveSecurityLevel,
      doc.fileName, doc.extension, doc.fileSize, doc.contentType, doc.hash, doc.hashAlgorithm || 'sha256',
      doc.uploadStatus || 'uploaded', doc.storageStatus || 'committed', doc.storagePath,
      doc.rootFolder, doc.relativePath, doc.folderPath, doc.parentFolder,
      JSON.stringify(doc.folderKeywords || []), doc.folderGroupId, JSON.stringify(doc.siblingFiles || []),
      doc.modifiedAtOriginal || null,
    ],
  )
  return id
}

// ── 중복 감지 (16장): 같은 dataset + relative_path + hash ──
async function findDuplicate(datasetId, relativePath, hash) {
  const { rows } = await db.query(
    `SELECT id, attachment_id, storage_path FROM folder_documents
      WHERE dataset_id=$1 AND relative_path=$2 AND hash=$3 AND storage_status <> 'removed'
      LIMIT 1`,
    [datasetId, relativePath, hash],
  )
  return rows[0] || null
}

// ── 참조 수 (17.4): 활성 folder_documents + posts.attachments_1..10 슬롯 ──
async function countAttachmentReferences(attachmentId, { excludeDatasetId = null } = {}) {
  const { rows: fd } = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM folder_documents
      WHERE attachment_id=$1 AND storage_status <> 'removed'
        AND ($2::text IS NULL OR dataset_id <> $2)`,
    [attachmentId, excludeDatasetId],
  )
  const { rows: pr } = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM posts
      WHERE $1 IN (attachments_1,attachments_2,attachments_3,attachments_4,attachments_5,
                   attachments_6,attachments_7,attachments_8,attachments_9,attachments_10)`,
    [attachmentId],
  )
  return (fd[0]?.cnt || 0) + (pr[0]?.cnt || 0)
}

// ── 접근 범위 기반 목록 (23.1) ──
// accessibleChannelIds / teamIds 는 라우트에서 계산해 전달한다.
async function listAccessibleDatasets({ userId, isSiteAdmin = false, accessibleChannelIds = [], teamIds = [] }) {
  const { rows } = await db.query(
    `SELECT * FROM folder_datasets d
      WHERE d.status <> ALL($4::text[])
        AND (
          $5::boolean = true
          OR d.access_scope = 'all'
          OR (d.access_scope = 'personal' AND d.owner_id = $1)
          OR (d.access_scope = 'team'    AND d.scope_team_id = ANY($2))
          OR (d.access_scope = 'channel' AND d.scope_channel_id = ANY($3))
        )
      ORDER BY d.created_at DESC`,
    [userId, teamIds, accessibleChannelIds, REMOVED_STATUSES, isSiteAdmin],
  )
  return rows
}

async function getDataset(datasetId) {
  const { rows } = await db.query(`SELECT * FROM folder_datasets WHERE id=$1`, [datasetId])
  return rows[0] || null
}

async function getDatasetDocuments(datasetId) {
  const { rows } = await db.query(
    `SELECT * FROM folder_documents
      WHERE dataset_id=$1 AND storage_status <> 'removed'
      ORDER BY relative_path`,
    [datasetId],
  )
  return rows
}

// 같은 folder_group_id 형제 파일명 목록(같은 배치 내에서 계산)
function computeSiblingMap(files) {
  const byGroup = new Map()
  for (const f of files) {
    if (!byGroup.has(f.folderGroupId)) byGroup.set(f.folderGroupId, [])
    byGroup.get(f.folderGroupId).push(f.fileName)
  }
  return byGroup
}

module.exports = {
  makeId,
  normalizeFolderPath,
  makeFolderGroupId,
  createDataset,
  updateDatasetStatus,
  refreshDatasetCounts,
  createBatch,
  finishBatch,
  createAttachment,
  createDocument,
  findDuplicate,
  countAttachmentReferences,
  listAccessibleDatasets,
  getDataset,
  getDatasetDocuments,
  computeSiblingMap,
  REMOVED_STATUSES,
}
