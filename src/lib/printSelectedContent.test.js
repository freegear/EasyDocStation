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

test('print CSS keeps images on one A4 page without enlarging small images', () => {
  assert.match(PRINT_STYLE, /img,\s*svg\s*\{/)
  assert.match(PRINT_STYLE, /width:\s*auto\s*!important/)
  assert.match(PRINT_STYLE, /height:\s*auto\s*!important/)
  assert.match(PRINT_STYLE, /max-width:\s*100%\s*!important/)
  assert.match(PRINT_STYLE, /max-height:\s*267mm\s*!important/)
  assert.match(PRINT_STYLE, /object-fit:\s*contain/)
  assert.match(PRINT_STYLE, /page-break-inside:\s*avoid/)
})

test('print CSS visually separates code and text blocks', () => {
  assert.match(PRINT_STYLE, /pre,\s*blockquote\s*\{/)
  assert.match(PRINT_STYLE, /border:\s*1px solid #cbd5e1/)
  assert.match(PRINT_STYLE, /background:\s*#f3f4f6\s*!important/)
  assert.match(PRINT_STYLE, /:not\(pre\) > code/)
  assert.match(PRINT_STYLE, /pre code\s*\{[\s\S]*background:\s*transparent\s*!important/)
  assert.match(PRINT_STYLE, /page-break-inside:\s*auto/)
})

test('print CSS preserves explicit line breaks in normal paragraphs', () => {
  assert.match(PRINT_STYLE, /\.easy-print-content p\s*\{[\s\S]*white-space:\s*pre-wrap/)
  assert.match(PRINT_STYLE, /\.easy-print-content p\s*\{[\s\S]*overflow-wrap:\s*anywhere/)
})

test('print CSS excludes elements marked as print-only UI decorations', () => {
  assert.match(PRINT_STYLE, /\[data-print-exclude="true"\][\s\S]*display:\s*none\s*!important/)
})

test('print CSS preserves Easy Page task-list alignment', () => {
  assert.match(PRINT_STYLE, /ul\[data-type="taskList"\]/)
  assert.match(PRINT_STYLE, /li\[data-type="taskItem"\][\s\S]*display:\s*flex/)
  assert.match(PRINT_STYLE, /\.easy-print-checkbox/)
})
