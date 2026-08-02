import test from 'node:test'
import assert from 'node:assert/strict'

import { PRINT_STYLE, escapeHtml, truncatePrintTitle } from './printSelectedContent.js'

test('escapeHtml protects print window metadata markup', () => {
  assert.equal(
    escapeHtml('<문서 title="A&B">\'내용\'</문서>'),
    '&lt;문서 title=&quot;A&amp;B&quot;&gt;&#039;내용&#039;&lt;/문서&gt;',
  )
})

test('print CSS expands screen scroll containers for multi-page output', () => {
  assert.match(PRINT_STYLE, /\.overflow-y-auto/)
  assert.match(PRINT_STYLE, /max-height:\s*none\s*!important/)
  assert.match(PRINT_STYLE, /overflow:\s*visible\s*!important/)
  assert.match(PRINT_STYLE, /display:\s*table-header-group/)
})

test('print CSS uses reliable 1cm content padding and fonts scaled down by 20 percent', () => {
  assert.match(PRINT_STYLE, /@page\s*\{\s*size:\s*A4;\s*margin:\s*0;/)
  assert.match(PRINT_STYLE, /padding:\s*10mm/)
  assert.match(PRINT_STYLE, /box-decoration-break:\s*clone/)
  assert.match(PRINT_STYLE, /font-size:\s*8\.8pt/)
  assert.match(PRINT_STYLE, /font-size:\s*14\.4pt/)
})

test('print title is limited to 32 Unicode characters', () => {
  assert.equal(truncatePrintTitle('가'.repeat(40)), '가'.repeat(32))
  assert.equal(Array.from(truncatePrintTitle('😀'.repeat(40))).length, 32)
  assert.equal(truncatePrintTitle('  짧은 제목  '), '짧은 제목')
})
