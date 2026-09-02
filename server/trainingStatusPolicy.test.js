const test = require('node:test')
const assert = require('node:assert/strict')
const { deriveCombinedTrainingStatus } = require('./trainingStatusPolicy')

test('이미지가 없으면 본문 RAG 완료가 전체 완료다', () => {
  assert.equal(deriveCombinedTrainingStatus({
    bodyStatus: 'completed',
    status: 'training',
    imageCount: 0,
  }), 'completed')
})

test('모든 이미지의 분석, DB, RAG 인덱싱이 집계 완료되어야 전체 완료다', () => {
  assert.equal(deriveCombinedTrainingStatus({
    bodyStatus: 'completed',
    status: 'training',
    imageCount: 2,
    completedImageCount: 1,
  }), 'training')

  assert.equal(deriveCombinedTrainingStatus({
    bodyStatus: 'completed',
    status: 'training',
    imageCount: 2,
    completedImageCount: 2,
  }), 'completed')
})

test('본문이 완료되지 않았으면 이미지가 완료되어도 전체 완료가 아니다', () => {
  assert.equal(deriveCombinedTrainingStatus({
    bodyStatus: 'training',
    status: 'training',
    imageCount: 1,
    completedImageCount: 1,
  }), 'training')
})

test('영구 오류로 분류된 이미지 실패는 전체 실패다', () => {
  assert.equal(deriveCombinedTrainingStatus({
    bodyStatus: 'completed',
    status: 'training',
    imageCount: 1,
    completedImageCount: 0,
    terminalFailedImageCount: 1,
  }), 'failed')
})

test('이미지 처리 중 시간초과 상태는 완료 조건 충족 전까지 유지된다', () => {
  assert.equal(deriveCombinedTrainingStatus({
    bodyStatus: 'completed',
    status: 'timed_out',
    imageCount: 1,
    completedImageCount: 0,
  }), 'timed_out')

  assert.equal(deriveCombinedTrainingStatus({
    bodyStatus: 'completed',
    status: 'timed_out',
    imageCount: 1,
    completedImageCount: 1,
  }), 'completed')
})
