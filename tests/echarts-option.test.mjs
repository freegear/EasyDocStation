import test from 'node:test'
import assert from 'node:assert/strict'
import { isLikelyEchartsOption, parseEchartsOption } from '../src/lib/echartsOption.js'

test('does not classify ordinary knowledge JSON with a title as ECharts', () => {
  const knowledgeJson = JSON.stringify({
    schema_version: '1.0',
    title: '산업안전보건법 관련 건강진단 기준',
    content: { text: '해당 조항의 정제된 원문' },
  })
  assert.equal(isLikelyEchartsOption(knowledgeJson), false)
})

test('detects a JSON ECharts option with series', () => {
  const option = JSON.stringify({
    title: { text: '건강지표' },
    xAxis: { type: 'category', data: ['A', 'B'] },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', data: [10, 20] }],
  })
  assert.equal(isLikelyEchartsOption(option), true)
  assert.equal(parseEchartsOption(option).series[0].type, 'bar')
})

test('does not classify JSON with chart-like metadata but no series', () => {
  assert.equal(isLikelyEchartsOption(JSON.stringify({ title: '문서', legend: '범례', dataset: [] })), false)
})
