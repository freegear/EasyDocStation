import test from 'node:test'
import assert from 'node:assert/strict'
import { extractHeadingOutline } from '../src/components/chat/md-page/navigation/headingOutline.js'

function documentWith(nodes) {
  return {
    descendants(visitor) {
      nodes.forEach(({ pos, ...node }) => visitor(node, pos))
    },
  }
}

test('extracts H1, H2, and H3 in document order', () => {
  const outline = extractHeadingOutline(documentWith([
    { pos: 0, type: { name: 'heading' }, attrs: { level: 1 }, textContent: '제목 1' },
    { pos: 8, type: { name: 'paragraph' }, attrs: {}, textContent: '본문' },
    { pos: 13, type: { name: 'heading' }, attrs: { level: 2 }, textContent: '제목 2' },
    { pos: 22, type: { name: 'heading' }, attrs: { level: 3 }, textContent: '제목 3' },
  ]))

  assert.deepEqual(outline.map(({ level, title, index }) => ({ level, title, index })), [
    { level: 1, title: '제목 1', index: 0 },
    { level: 2, title: '제목 2', index: 1 },
    { level: 3, title: '제목 3', index: 2 },
  ])
})

test('ignores empty headings and headings deeper than H3', () => {
  const outline = extractHeadingOutline(documentWith([
    { pos: 0, type: { name: 'heading' }, attrs: { level: 2 }, textContent: '   ' },
    { pos: 4, type: { name: 'heading' }, attrs: { level: 4 }, textContent: '제목 4' },
  ]))
  assert.deepEqual(outline, [])
})
