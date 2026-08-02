const MERMAID_FENCE_PATTERN = /(```mermaid[^\n]*\n)([\s\S]*?)(```)/gi

function quoteLabel(label = '') {
  const trimmed = String(label || '').trim()
  if (!trimmed || /^(["']).*\1$/s.test(trimmed)) return trimmed
  return `"${trimmed.replaceAll('"', "'")}"`
}

export function normalizeMermaidSource(source = '') {
  let subgraphSequence = 0
  return String(source || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const commentIndex = line.indexOf('%%')
      if (commentIndex >= 0 && line.slice(0, commentIndex).trim() === '') return line

      let normalized = line
        // Parentheses and punctuation inside unquoted labels can be parsed as shape syntax.
        .replace(/\b([A-Za-z_][\w-]*)\[([^\]\n]*)\]/g, (_, id, label) => `${id}[${quoteLabel(label)}]`)
        .replace(/\b([A-Za-z_][\w-]*)\{([^}\n]*)\}/g, (_, id, label) => `${id}{${quoteLabel(label)}}`)
        // Pipe-delimited edge labels are stable across Mermaid flowchart parser versions.
        .replace(/--\s*"([^"\n]+)"\s*-->/g, '-->|$1|')

      normalized = normalized.replace(/^(\s*)subgraph\s+"([^"]+)"\s*$/i, (_, indent, title) => {
        subgraphSequence += 1
        return `${indent}subgraph eds_group_${subgraphSequence}["${title.replaceAll('"', "'")}"]`
      })

      return normalized.replace(/;\s*$/, '')
    })
    .join('\n')
}

export function normalizeMermaidCodeBlocks(markdown = '') {
  return String(markdown || '').replace(
    MERMAID_FENCE_PATTERN,
    (_, openingFence, source, closingFence) => (
      `${openingFence}${normalizeMermaidSource(source)}${closingFence}`
    ),
  )
}

export const MERMAID_GENERATION_RULES = `
Mermaid 다이어그램을 생성할 때는 다음 규칙을 반드시 지키세요.
- Mermaid는 반드시 \`\`\`mermaid fenced code block 하나에 넣으세요.
- flowchart/graph 노드의 표시 문구는 예외 없이 큰따옴표로 감싸세요. 예: A["표시 문구"], B{"조건 문구"}
- 연결선 문구는 반드시 파이프 문법을 사용하세요. 예: A -->|설명| B
- subgraph는 영문 ID와 인용된 제목을 함께 사용하세요. 예: subgraph group1["표시 제목"]
- 노드 ID와 subgraph ID에는 영문자, 숫자, 밑줄만 사용하세요.
- LaTeX, HTML, 세미콜론 및 \`-- "문구" -->\` 형식은 Mermaid 코드 안에서 사용하지 마세요.
- 같은 노드와 연결선을 subgraph 안팎에서 중복 선언하지 마세요.
- 답변을 내기 전에 괄호, 대괄호, 중괄호, 따옴표가 모두 닫혔는지 스스로 검사하세요.`.trim()

