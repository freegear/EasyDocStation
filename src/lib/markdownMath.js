/**
 * remark-math understands $...$ and $$...$$, while many AI responses use
 * LaTeX's \(...\) and \[...\] delimiters. Convert only prose regions so
 * examples inside fenced/inline code remain byte-for-byte unchanged.
 */
export function normalizeLatexDelimiters(markdown = '') {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  let fence = null

  return lines.map((line) => {
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) fence = { char: marker[0], length: marker.length }
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null
      return line
    }
    return fence ? line : normalizeProseLine(line)
  }).join('\n')
    .replace(/\n{2,}(\$\$)/g, '\n$1')
    .replace(/(\$\$)\n{2,}/g, '$1\n')
}

function normalizeProseLine(line) {
  const codeSpans = []
  const protectedLine = line.replace(/(`+)([^`]*?)\1/g, (match) => {
    const token = `\uE000${codeSpans.length}\uE001`
    codeSpans.push(match)
    return token
  })

  return protectedLine
    .replace(/\\\[/g, () => '\n$$\n')
    .replace(/\\\]/g, () => '\n$$\n')
    .replace(/\\\(/g, '$')
    .replace(/\\\)/g, '$')
    .replace(/\uE000(\d+)\uE001/g, (_, index) => codeSpans[Number(index)])
}
