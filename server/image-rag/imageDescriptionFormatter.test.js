const test = require('node:test')
const assert = require('node:assert/strict')

const {
  extractJsonObject,
  normalizeAnalysis,
  buildSearchContent,
  retryDelayMs,
} = require('./imageDescriptionFormatter')
const { normalizeImageRagConfig } = require('./config')

test('비전 모델의 fenced JSON을 구조화 결과로 정규화한다', () => {
  const raw = '```json\n{"summary":"서울역 승강장","description":"스크린도어와 점자블록이 보인다.","visible_text":["서울역","6-3"],"keywords":["지하철","스크린도어"]}\n```'
  assert.equal(extractJsonObject(raw).summary, '서울역 승강장')
  const result = normalizeAnalysis(raw, { ocrText: '서울역\n6-3', fileName: 'station.jpg' })
  assert.equal(result.parsed, true)
  assert.equal(result.analysis.summary, '서울역 승강장')
  assert.deepEqual(result.analysis.visible_text, ['서울역', '6-3'])
})

test('JSON이 깨져도 OCR과 파일명으로 안전한 fallback 설명을 만든다', () => {
  const result = normalizeAnalysis('설명만 있는 잘못된 응답', {
    ocrText: 'MODEL-X100',
    fileName: 'product.jpg',
  })
  assert.equal(result.parsed, false)
  assert.match(result.analysis.summary, /product\.jpg/)
  assert.deepEqual(result.analysis.visible_text, ['MODEL-X100'])
})

test('DB와 RAG가 공유할 표준 검색 텍스트를 생성한다', () => {
  const content = buildSearchContent({
    summary: '현대적인 지하철 승강장',
    description: '플랫폼 스크린도어가 길게 설치되어 있다.',
    objects: ['스크린도어', '점자블록'],
    keywords: ['서울역', '지하철'],
  }, '서울역\n6-3')
  assert.match(content, /\[IMAGE_SUMMARY\]/)
  assert.match(content, /\[EXACT_VISIBLE_TEXT\]\n서울역\n6-3/)
  assert.match(content, /\[SEARCH_KEYWORDS\]\n서울역, 지하철/)
})

test('재시도 가능한 실패는 시도 횟수와 무관하게 2시간 뒤 재시도한다', () => {
  assert.equal(retryDelayMs(1), 2 * 60 * 60_000)
  assert.equal(retryDelayMs(5), 2 * 60 * 60_000)
  assert.equal(retryDelayMs(999), 2 * 60 * 60_000)
})

test('Image2RAG 설정은 안전한 범위로 정규화되고 환경변수가 우선한다', () => {
  const config = normalizeImageRagConfig({
    rag: { image_description: { worker_concurrency: 999, model: 'base' } },
  }, { EASYDOC_IMAGE_RAG_MODEL: 'override-model', EASYDOC_IMAGE_RAG_ENABLED: '0' })
  assert.equal(config.enabled, false)
  assert.equal(config.model, 'override-model')
  assert.equal(config.workerConcurrency, 4)
})
