#!/usr/bin/env node
// 아직 학습되지 않은(또는 실패한) 폴더 문서를 RAG 벡터로 학습한다.
// 활성 테이블이 schema_version >= 3 일 때만 동작한다(스코프 필드 필요).
//
// 용도:
//  - 기존 흡수된 legacy 문서 및 마이그레이션 이전에 업로드되어 pending 상태인 문서 일괄 학습.
//  - 업로드 라우트는 신규 업로드를 자동 학습하므로, 이 스크립트는 백필/재시도용이다.
//
// 실행: node server/scripts/train-folder-datasets.js

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), override: true })

const db = require('../db')
const ragTrainer = require('../folder/ragTrainer')

async function main() {
  if (!ragTrainer.folderVectorsEnabled()) {
    console.log('활성 테이블이 schema_version < 3 입니다. 마이그레이션(스코프 스키마 전환) 후 다시 실행하세요.')
    process.exit(0)
  }

  const { rows } = await db.query(
    `SELECT id, attachment_id, dataset_id, storage_path, file_name, extension,
            access_scope, scope_team_id, scope_channel_id, owner_id, effective_security_level,
            root_folder, relative_path, folder_path, parent_folder, folder_group_id, folder_keywords
       FROM folder_documents
      WHERE storage_status = 'committed' AND training_status IN ('pending','failed')
      ORDER BY dataset_id`,
  )
  if (rows.length === 0) {
    console.log('학습할 폴더 문서가 없습니다.')
    process.exit(0)
  }

  const ids = rows.map(r => r.id)
  await db.query(`UPDATE folder_documents SET training_status='training' WHERE id = ANY($1)`, [ids])
  try {
    const res = await ragTrainer.trainFolderDocuments(rows.map(r => ({
      ...r,
      folder_keywords: Array.isArray(r.folder_keywords) ? r.folder_keywords : [],
    })))
    await db.query(`UPDATE folder_documents SET training_status='completed' WHERE id = ANY($1)`, [ids])
    console.log(`학습 완료: ${res.count || rows.length}개 문서`)
  } catch (e) {
    await db.query(`UPDATE folder_documents SET training_status='failed', training_error=$2 WHERE id = ANY($1)`,
      [ids, String(e.message).slice(0, 500)])
    console.error('학습 실패:', e.message)
    process.exit(1)
  }
  process.exit(0)
}

main().catch(e => { console.error(e.message); process.exit(1) })
