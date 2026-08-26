export function extractHeadingOutline(doc) {
  const headings = []
  if (!doc || typeof doc.descendants !== 'function') return headings

  doc.descendants((node, pos) => {
    if (node?.type?.name !== 'heading') return
    const level = Number(node.attrs?.level)
    if (level < 1 || level > 3) return
    const title = String(node.textContent || '').trim()
    if (!title) return
    headings.push({
      id: `heading-${pos}`,
      index: headings.length,
      level,
      pos,
      title,
    })
  })

  return headings
}
