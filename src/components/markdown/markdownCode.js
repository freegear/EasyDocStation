export function normalizeMarkdownCodeSource(children) {
  return String(children ?? '').replace(/\n$/, '')
}

export function getMarkdownCodeLanguage(className = '') {
  const match = /(?:^|\s)language-([^\s]+)/i.exec(String(className || ''))
  return match?.[1]?.toLowerCase() || ''
}

export function isMermaidCodeElement(child) {
  return Boolean(child?.props && getMarkdownCodeLanguage(child.props.className) === 'mermaid')
}

export function getCodeElementSource(child) {
  return normalizeMarkdownCodeSource(child?.props?.children)
}
