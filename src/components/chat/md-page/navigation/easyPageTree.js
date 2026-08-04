function isEasyPageContent(content = '') {
  return String(content || '').trimStart().startsWith('<!--md-page-->')
}

function getEasyPageTitle(content = '') {
  const withoutMarker = String(content || '').replace(/^\s*<!--md-page-->\s*/, '')
  const heading = withoutMarker.match(/^\s*#\s+(.+)$/m)?.[1]?.trim()
  return heading || '제목 없는 EasyPage'
}

export function extractEasyPagePostLinks(content = '', baseOrigin = 'http://easydoc.local') {
  const links = []
  const seen = new Set()
  const text = String(content || '').replace(/&amp;/g, '&')
  // Markdown 제목에 '?'가 있어도 URL 시작으로 오인하지 않도록 href를 우선
  // 추출하고, 일반 URL 후보에서는 Markdown label 경계인 []를 제외한다.
  const markdownCandidates = Array.from(
    text.matchAll(/\]\(\s*(\/?\?[^)\s"'<>]+)\s*\)/g),
    match => match[1],
  )
  const htmlCandidates = Array.from(
    text.matchAll(/\bhref\s*=\s*["'](\/?\?[^"']+)["']/gi),
    match => match[1],
  )
  const plainCandidates = text.match(/\/?\?[^)\s"'<>[\]]+/g) || []
  const candidates = [...markdownCandidates, ...htmlCandidates, ...plainCandidates]
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, baseOrigin)
      const channelId = url.searchParams.get('channelId') || url.searchParams.get('channelid')
      const postId = url.searchParams.get('postId') || url.searchParams.get('postid')
      const key = `${channelId}:${postId}`
      if (!channelId || !postId || seen.has(key)) continue
      seen.add(key)
      links.push({ channelId: String(channelId), postId: String(postId) })
    } catch {
      // Ignore malformed link-like content.
    }
  }
  return links
}

export function buildEasyPageTree({ channelId, currentPostId, channelPosts = [] }) {
  const targetChannelId = String(channelId || '')
  const pages = channelPosts
    .filter(post => post?.id && isEasyPageContent(post.content))
    .map(post => ({
      post,
      postId: String(post.id),
      channelId: String(post.channelId || post.channel_id || targetChannelId),
      title: getEasyPageTitle(post.content),
    }))
    .filter(page => page.channelId === targetChannelId)
  const pageById = new Map(pages.map(page => [page.postId, page]))
  const childIdsByParent = new Map(pages.map(page => [page.postId, []]))
  const parentIdByChild = new Map()

  for (const page of pages) {
    for (const link of extractEasyPagePostLinks(page.post.content)) {
      const childId = String(link.postId)
      if (link.channelId !== targetChannelId || childId === page.postId || !pageById.has(childId)) continue
      if (!parentIdByChild.has(childId)) parentIdByChild.set(childId, page.postId)
      if (parentIdByChild.get(childId) !== page.postId) continue
      const children = childIdsByParent.get(page.postId)
      if (!children.includes(childId)) children.push(childId)
    }
  }

  const currentId = String(currentPostId || '')
  let rootId = pageById.has(currentId) ? currentId : pages[0]?.postId || ''
  const ancestorGuard = new Set()
  while (rootId && parentIdByChild.has(rootId) && !ancestorGuard.has(rootId)) {
    ancestorGuard.add(rootId)
    rootId = parentIdByChild.get(rootId)
  }

  const visited = new Set()
  function makeNode(postId, depth = 0) {
    if (!pageById.has(postId) || visited.has(postId)) return null
    visited.add(postId)
    const page = pageById.get(postId)
    const children = (childIdsByParent.get(postId) || [])
      .map(childId => makeNode(childId, depth + 1))
      .filter(Boolean)
    return { ...page, depth, children }
  }

  const root = rootId ? makeNode(rootId) : null
  return {
    root,
    rootId,
    pageById,
    parentIdByChild,
    childIdsByParent,
    directChildIds: childIdsByParent.get(currentId) || [],
  }
}

export function collectEasyPageSubtreeIds(tree, postId) {
  const result = []
  const visited = new Set()
  const visit = (id) => {
    const value = String(id || '')
    if (!value || visited.has(value)) return
    visited.add(value)
    result.push(value)
    for (const childId of tree.childIdsByParent.get(value) || []) visit(childId)
  }
  visit(postId)
  return result
}

export function removeEasyPageLink(content = '', targetPostId = '') {
  const target = String(targetPostId)
  return String(content || '').replace(/\[([^\]]*)\]\(([^)]+)\)/g, (whole, label, href) => {
    const matched = extractEasyPagePostLinks(href)
      .some(link => link.postId === target)
    return matched ? label : whole
  })
}

export function appendEasyPageLinks(content = '', pages = [], channelId = '') {
  const existing = new Set(extractEasyPagePostLinks(content).map(link => link.postId))
  const lines = pages
    .filter(page => page?.postId && !existing.has(String(page.postId)))
    .map(page => `- [${String(page.title || '제목 없는 EasyPage').replaceAll('[', '\\[').replaceAll(']', '\\]')}](/?channelId=${encodeURIComponent(channelId)}&postId=${encodeURIComponent(page.postId)})`)
  return lines.length > 0 ? `${String(content || '').trimEnd()}\n\n${lines.join('\n')}\n` : String(content || '')
}
