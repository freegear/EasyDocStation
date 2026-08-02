import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeMermaidCodeBlocks,
  normalizeMermaidSource,
} from '../src/lib/mermaidSafety.js'

test('quotes unsafe flowchart labels and removes trailing semicolons', () => {
  const input = 'graph TD\nA[사용자 입력] --> B{분류};\nB --> C[조회 (EMR/가이드라인)];'
  assert.equal(
    normalizeMermaidSource(input),
    'graph TD\nA["사용자 입력"] --> B{"분류"}\nB --> C["조회 (EMR/가이드라인)"]',
  )
})

test('keeps already quoted labels stable', () => {
  const input = 'flowchart LR\nA["입력 (Input)"] --> B{"완료 여부"}'
  assert.equal(normalizeMermaidSource(input), input)
})

test('normalizes edge labels and quoted subgraph titles', () => {
  const input = 'graph TD\nsubgraph "처리 흐름 (Workflow)"\nA -- "검증 결과" --> B\nend'
  assert.equal(
    normalizeMermaidSource(input),
    'graph TD\nsubgraph eds_group_1["처리 흐름 (Workflow)"]\nA -->|검증 결과| B\nend',
  )
})

test('changes only complete mermaid fenced code blocks', () => {
  const input = [
    '본문 A[일반 문장]',
    '```mermaid',
    'graph TD',
    'A[입력] --> B[출력 (Output)];',
    '```',
    '```js',
    'const value = "A[그대로]";',
    '```',
  ].join('\n')
  const output = normalizeMermaidCodeBlocks(input)
  assert.match(output, /A\["입력"\] --> B\["출력 \(Output\)"\]/)
  assert.match(output, /const value = "A\[그대로\]";/)
  assert.match(output, /^본문 A\[일반 문장\]/)
})
