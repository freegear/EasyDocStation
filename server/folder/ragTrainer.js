// 폴더 업로드 문서의 RAG 학습/벡터 삭제 트리거
// - 활성 테이블이 schema_version >= 3(스코프 필드 보유)일 때만 실제로 학습/삭제한다.
//   그렇지 않으면 no-op(활성 v2 테이블을 오염/파괴하지 않기 위함, UploadFolder.md 23.4).
// - 학습/삭제는 기존 rag_train.py 파이프라인을 재사용한다.
//
// GPU 학습 스케줄링(MDfiles/GpuScheduling.md):
//  - 1단계: 학습을 파일 배치(train_yield_batch) 단위로 쪼개, 각 배치 시작 전 gpuGate 로 양보 판정.
//  - 4단계: broker_enabled 이면 spawn 직결 대신 ai:queue:training 으로 적재(브로커가 소비).
//  - 5단계: 기아 방지는 gpuGate.waitForTrainingSlot(max_yield_wait_sec) 가 담당.

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { getPythonExecutable } = require('../pythonRuntime')
const { getDatabasePath } = require('../databasePaths')
const gpuGate = require('../gpu/gpuGate')
const aiMetrics = require('../aiMetrics')
const { enqueueTask } = require('../aiQueue')
const { enqueueImageAttachments } = require('../image-rag')
const db = require('../db')

const CONFIG_PATH = path.resolve(__dirname, '../../config.json')
const STORAGE_BASE = getDatabasePath(readConfig(), 'ObjectFile Path')
const TRAINING_PAYLOAD_TTL_SEC = 24 * 60 * 60  // 학습 잡이 큐에서 오래 대기해도 payload 가 살아있게

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch (_) { return {} }
}

function ragConfig() {
  const cfg = readConfig()
  const rag = cfg.rag || {}
  const activeTable = rag.active_table || rag.table_name || 'my_rag_table'
  const schemaVersion = Number(rag.schema_version || 1)
  return {
    lancedb_path: getDatabasePath(cfg, 'lancedb Database Path'),
    table_name: activeTable,
    rag_table_name: activeTable,
    schema_version: schemaVersion,
    vector_size: rag.vectorSize ?? 1024,
    chunk_size: rag.chunk_size ?? 800,
    chunk_overlap: rag.chunk_overlap ?? 100,
    document_converter: rag.document_converter ?? 'docling',
    docling_shadow_compare: rag.docling_shadow_compare ?? false,
    docling_fallback_to_markitdown: rag.docling_fallback_to_markitdown ?? true,
    document_convert_max_file_size: rag.document_convert_max_file_size ?? 500 * 1024 * 1024,
  }
}

// 활성 테이블이 폴더 스코프를 지원하는지(재학습/마이그레이션 완료 여부)
function folderVectorsEnabled() {
  return ragConfig().schema_version >= 3
}

function runTrainer(payload) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(__dirname, '../rag_train.py')
    const proc = spawn(getPythonExecutable(), [scriptPath], { timeout: 30 * 60 * 1000 })
    let stderr = ''
    proc.stdin.write(JSON.stringify(payload))
    proc.stdin.end()
    proc.stdout.on('data', d => process.stdout.write(d))
    proc.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d) })
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(stderr || `rag_train.py exit ${code}`))))
    proc.on('error', reject)
  })
}

// folder_documents(DB 문서 배열)을 학습 payload 의 folder_documents 로 변환한다.
function toTrainerDocs(documents = []) {
  return documents.map(d => ({
    id: d.id,
    attachment_id: d.attachment_id,
    dataset_id: d.dataset_id,
    file_path: path.join(STORAGE_BASE, d.storage_path || ''),
    file_name: d.file_name,
    extension: d.extension,
    access_scope: d.access_scope,
    scope_team_id: d.scope_team_id || '',
    scope_channel_id: d.scope_channel_id || '',
    owner_id: d.owner_id != null ? String(d.owner_id) : '',
    effective_security_level: d.effective_security_level || 0,
    root_folder: d.root_folder || '',
    relative_path: d.relative_path || '',
    folder_path: d.folder_path || '',
    parent_folder: d.parent_folder || '',
    folder_group_id: d.folder_group_id || '',
    folder_keywords: Array.isArray(d.folder_keywords) ? d.folder_keywords : [],
  }))
}

function chunkArray(arr, size) {
  const out = []
  const step = Math.max(1, Number(size) || 1)
  for (let i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step))
  return out
}

async function setTrainingStatus(ids, status, errorMessage) {
  if (!ids.length) return
  try {
    if (errorMessage != null) {
      await db.query(
        `UPDATE folder_documents SET training_status=$2, training_error=$3 WHERE id = ANY($1)`,
        [ids, status, String(errorMessage).slice(0, 500)],
      )
    } else {
      await db.query(`UPDATE folder_documents SET training_status=$2 WHERE id = ANY($1)`, [ids, status])
    }
  } catch (_) { /* 상태 갱신 실패는 학습 결과에 영향 주지 않음 */ }
}

// 학습 1단위(파일 배치)를 실제 실행한다. 직접 경로와 브로커가 공유한다.
// 실행 전 gpuGate 로 양보 판정하고 관측 메트릭을 남긴다(3단계).
// folder_documents.training_status 는 이 함수가 배치 단위로 소유한다
// (직접·브로커 경로 모두 정확한 완료/실패 시점을 반영하기 위함).
async function trainBatchDirect(documents = []) {
  if (!folderVectorsEnabled() || documents.length === 0) {
    return { trained: false, reason: folderVectorsEnabled() ? 'no_documents' : 'schema_below_v3' }
  }
  const imageDocuments = documents.filter(d => /^(png|jpe?g|gif|webp|bmp)$/i.test(String(d.extension || '')))
  const otherDocuments = documents.filter(d => !imageDocuments.includes(d))
  if (imageDocuments.length > 0) {
    await enqueueImageAttachments(imageDocuments.map(d => ({
      attachmentId: d.attachment_id,
      ownerId: d.owner_id,
      securityLevel: d.effective_security_level || 0,
      scopeMetadata: {
        access_scope: d.access_scope || '',
        scope_team_id: d.scope_team_id || '',
        scope_channel_id: d.scope_channel_id || '',
        dataset_id: d.dataset_id || '',
        folder_document_id: d.id || '',
        relative_path: d.relative_path || '',
        folder_path: d.folder_path || '',
        parent_folder: d.parent_folder || '',
        folder_group_id: d.folder_group_id || '',
        folder_keywords_text: Array.isArray(d.folder_keywords) ? d.folder_keywords.join(' ') : String(d.folder_keywords || ''),
      },
    })))
  }
  if (otherDocuments.length === 0) {
    return { trained: true, count: documents.length, queuedImages: imageDocuments.length }
  }
  const ids = otherDocuments.map(d => d.id).filter(Boolean)
  const slot = await gpuGate.waitForTrainingSlot({
    onWait: (waited) => {
      if (waited === 0) console.log('[GPU] 학습 양보: 대화형/GPU 사용 중, 대기...')
    },
  })
  try {
    aiMetrics.setGpuStatus(await gpuGate.getGpuStatus())
  } catch (_) {}
  if (slot.forced) {
    console.warn(`[GPU] 기아 방지: 대기 상한 초과로 학습 강제 진행(waited=${slot.waitedMs}ms)`)
  }
  try {
    await runTrainer({ config: ragConfig(), folder_documents: toTrainerDocs(otherDocuments) })
  } catch (err) {
    await setTrainingStatus(ids, 'failed', err.message)
    throw err
  }
  aiMetrics.recordTrainingSlot(slot)
  await setTrainingStatus(ids, 'completed')
  return { trained: true, count: documents.length, wait: slot }
}

// folder_documents 배열을 학습한다.
// - broker_enabled 이면 파일 배치 단위로 ai:queue:training 에 적재(브로커가 소비).
// - 아니면 파일 배치 단위로 직접 게이트 학습.
async function trainFolderDocuments(documents = []) {
  if (!folderVectorsEnabled() || documents.length === 0) {
    return { trained: false, reason: folderVectorsEnabled() ? 'no_documents' : 'schema_below_v3' }
  }
  const cfg = gpuGate.gpuConfig()
  const batches = chunkArray(documents, cfg.train_yield_batch)

  if (cfg.broker_enabled) {
    let queued = 0
    for (const batch of batches) {
      const r = await enqueueTask('training', { documents: batch }, {
        priority: 'batch',
        routeKey: 'folder_training',
        payloadTtlSec: TRAINING_PAYLOAD_TTL_SEC,
      })
      if (r.queued) queued += 1
      else {
        // 큐 비활성/실패 시 직접 경로로 폴백(학습이 멈추지 않게).
        await trainBatchDirect(batch).catch(e => console.error('[GPU] 직접 학습 폴백 실패:', e.message))
      }
    }
    return { trained: true, mode: 'broker', batches: batches.length, queued }
  }

  let trained = 0
  for (const batch of batches) {
    try {
      const r = await trainBatchDirect(batch)
      if (r.trained) trained += r.count
    } catch (e) {
      console.error('[GPU] 폴더 학습 배치 실패:', e.message)
    }
  }
  return { trained: true, mode: 'direct', batches: batches.length, count: trained }
}

// 데이터셋/첨부 기준 벡터 청크 삭제 (UploadFolder.md 17.5, 23.2)
async function deleteVectors({ datasetIds = [], attachmentIds = [] } = {}) {
  if (!folderVectorsEnabled()) return { deleted: false, reason: 'schema_below_v3' }
  if (datasetIds.length === 0 && attachmentIds.length === 0) return { deleted: false, reason: 'no_targets' }
  await runTrainer({
    config: ragConfig(),
    delete_dataset_ids: datasetIds,
    delete_attachment_ids: attachmentIds,
  })
  return { deleted: true }
}

module.exports = {
  trainFolderDocuments,
  trainBatchDirect,
  deleteVectors,
  folderVectorsEnabled,
}
