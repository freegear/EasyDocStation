export function normalizeBrokenOrderedListItems(markdown = '') {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let inFence = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }

    if (!inFence && /^(\s*)(\d+)\.\s*$/.test(line)) {
      let next = i + 1
      while (next < lines.length && lines[next].trim() === '') next += 1

      const nextLine = lines[next] || ''
      const itemMatch = line.match(/^(\s*)(\d+)\.\s*$/)
      const bodyMatch = nextLine.match(/^(\s*)(\S.*)$/)
      const markerIndent = itemMatch?.[1] || ''
      const bodyIndent = bodyMatch?.[1] || ''
      const body = bodyMatch && bodyIndent.length >= markerIndent.length
        ? nextLine.slice(markerIndent.length).trimStart()
        : ''
      const looksLikeNestedBlock = /^([-*+]|\d+\.|```|~~~|#{1,6}\s|\||>|<table\b|<pre\b)/i.test(body)

      if (itemMatch && bodyMatch && !looksLikeNestedBlock) {
        out.push(`${markerIndent}${itemMatch[2]}. ${body}`)
        i = next
        continue
      }
    }

    out.push(line)
  }

  return out.join('\n')
}
