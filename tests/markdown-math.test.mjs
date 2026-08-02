import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeLatexDelimiters } from '../src/lib/markdownMath.js'

test('normalizes LaTeX display and inline delimiters', () => {
  assert.equal(
    normalizeLatexDelimiters('계산: \\(x+1\\)\n\\[\nMDD = \\min_t(x_t)\n\\]다음 문장'),
    '계산: $x+1$\n$$\nMDD = \\min_t(x_t)\n$$\n다음 문장',
  )
})

test('does not normalize delimiters inside code', () => {
  const source = '`\\(inline\\)`\n```tex\n\\[block\\]\n```'
  assert.equal(normalizeLatexDelimiters(source), source)
})
