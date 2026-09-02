const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const serverRoot = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(serverRoot, relative), 'utf8')

test('통합 완료 집계는 이미지의 세 상태를 모두 요구한다', () => {
  const source = read('trainingStatus.js')
  assert.match(source, /d\.analysis_status='completed'/)
  assert.match(source, /d\.db_index_status='indexed'/)
  assert.match(source, /d\.rag_index_status='indexed'/)
  assert.match(source, /deriveCombinedTrainingStatus/)
})

test('이미지 워커는 성공과 실패 뒤 원본의 통합 상태를 갱신한다', () => {
  const source = read('image-rag/ImageAnalysisWorker.js')
  assert.match(source, /finally\s*\{[\s\S]*refreshOwnerTrainingStatus/)
  assert.match(source, /refreshTrainingStatus\('comment'/)
  assert.match(source, /refreshTrainingStatus\('post'/)
})

test('본문 완료 상태는 별도 body_status로 보존된다', () => {
  const runtime = read('trainingStatus.js')
  const schema = read('schema.sql')
  assert.match(runtime, /body_status/)
  assert.match(schema, /body_status\s+VARCHAR\(20\)/)
})
