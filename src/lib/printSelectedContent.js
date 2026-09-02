const PRINT_STYLE = `
  @page { size: A4; margin: 0; }
  html { color-scheme: light; background: #fff; }
  body {
    margin: 0;
    padding: 10mm;
    box-sizing: border-box;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
    color: #111827;
    background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif;
    font-size: 8.8pt;
    line-height: 1.65;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
  .easy-print-header { margin-bottom: 8mm; padding-bottom: 4mm; border-bottom: 1px solid #d1d5db; }
  .easy-print-header h1 { margin: 0 0 2mm; font-size: 14.4pt; line-height: 1.35; }
  .easy-print-header p { margin: 0; color: #6b7280; font-size: 7.2pt; }
  .easy-print-content { width: 100%; height: auto !important; max-height: none !important; overflow: visible !important; }
  .easy-print-content * { max-width: 100%; box-sizing: border-box; }
  .easy-print-content p {
    margin: 0 0 0.65em;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .easy-print-content h1 { margin: 1.2em 0 0.45em; font-size: 16pt; }
  .easy-print-content h2 { margin: 1.1em 0 0.4em; font-size: 12.8pt; }
  .easy-print-content h3 { margin: 1em 0 0.35em; font-size: 10.4pt; }
  .easy-print-content ul, .easy-print-content ol { padding-left: 1.6em; }
  .easy-print-content .rounded-full { width: 40px; height: 40px; overflow: hidden; border-radius: 9999px; }
  .easy-print-content .rounded-full img { width: 40px !important; height: 40px !important; object-fit: cover; }
  .easy-print-content > *,
  .easy-print-content .eds-markdown,
  .easy-print-content .overflow-hidden,
  .easy-print-content .overflow-auto,
  .easy-print-content .overflow-y-auto,
  .easy-print-content .overflow-x-auto {
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
  }
  img, svg {
    width: auto !important;
    height: auto !important;
    max-width: 100% !important;
    max-height: 267mm !important;
    object-fit: contain;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  table { width: 100%; border-collapse: collapse; break-inside: auto; }
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  th, td { border: 1px solid #d1d5db; padding: 6px 8px; }
  p, li { orphans: 3; widows: 3; }
  h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
  pre, blockquote {
    margin: 0.8em 0;
    padding: 0.8em 1em;
    border: 1px solid #cbd5e1;
    border-radius: 5px;
    background: #f3f4f6 !important;
    color: #1f2937;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    break-inside: auto;
    page-break-inside: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    line-height: 1.55;
  }
  pre code {
    padding: 0;
    border: 0;
    background: transparent !important;
    color: inherit;
  }
  :not(pre) > code {
    padding: 0.12em 0.35em;
    border: 1px solid #d1d5db;
    border-radius: 3px;
    background: #f3f4f6 !important;
    color: #374151;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }
  a { color: inherit; text-decoration: underline; overflow-wrap: anywhere; }
  .easy-print-content ul[data-type="taskList"] { list-style: none; padding-left: 0; }
  .easy-print-content li[data-type="taskItem"] {
    display: flex;
    align-items: flex-start;
    gap: 0.5em;
    list-style: none;
  }
  .easy-print-content li[data-type="taskItem"] > label {
    display: inline-flex;
    align-items: center;
    min-height: 1.65em;
  }
  .easy-print-content li[data-type="taskItem"] > div { flex: 1 1 auto; min-width: 0; }
  .easy-print-content li[data-type="taskItem"] > div > p { margin-top: 0; }
  .easy-print-checkbox { display: inline-block; width: 1em; line-height: 1; }
  [data-print-exclude="true"], button, input, textarea, select, audio, video,
  [role="menu"], [role="dialog"] { display: none !important; }
  @media print { body { min-height: 0; } }
`

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function truncatePrintTitle(value = '', maxLength = 32) {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  return Array.from(normalized).slice(0, Math.max(1, maxLength)).join('')
}

function waitForImages(doc, timeoutMs = 3000) {
  const pending = [...doc.images]
    .filter(image => !image.complete)
    .map(image => new Promise(resolve => {
      image.addEventListener('load', resolve, { once: true })
      image.addEventListener('error', resolve, { once: true })
    }))
  if (pending.length === 0) return Promise.resolve()
  return Promise.race([
    Promise.allSettled(pending),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ])
}

function waitForStylesheets(doc, timeoutMs = 3000) {
  const pending = [...doc.querySelectorAll('link[rel="stylesheet"]')]
    .filter(link => !link.sheet)
    .map(link => new Promise(resolve => {
      link.addEventListener('load', resolve, { once: true })
      link.addEventListener('error', resolve, { once: true })
    }))
  if (pending.length === 0) return Promise.resolve()
  return Promise.race([
    Promise.allSettled(pending),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ])
}

export async function printSelectedContent({ type = 'post', title = '', channelName = '', author = '', username = '', createdAt = '', contentNode = null, includeComments = false, includeHeader = true, preserveTaskCheckboxes = false, popupBlockedMessage = '', failedMessage = '' } = {}) {
  if (!contentNode) throw new Error('인쇄할 콘텐츠를 찾을 수 없습니다.')

  const printWindow = window.open('', '_blank')
  if (!printWindow) {
    throw new Error(popupBlockedMessage || '인쇄 창을 열 수 없습니다. 이 사이트의 팝업을 허용해 주세요.')
  }

  try {
    const safeTitle = truncatePrintTitle(title || (type === 'comment' ? '댓글' : '게시글'))
    printWindow.document.open()
    printWindow.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(safeTitle)}</title></head><body><p>인쇄 준비 중...</p></body></html>`)
    printWindow.document.close()

    const style = printWindow.document.createElement('style')
    style.textContent = PRINT_STYLE
    printWindow.document.head.appendChild(style)

    const clone = contentNode.cloneNode(true)
    if (preserveTaskCheckboxes) {
      clone.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        const marker = input.ownerDocument.createElement('span')
        marker.className = 'easy-print-checkbox'
        marker.textContent = input.checked ? '☑' : '☐'
        marker.setAttribute('aria-hidden', 'true')
        input.replaceWith(marker)
      })
    }
    if (includeComments) {
      clone.querySelectorAll('[data-print-comments="true"]').forEach(node => node.removeAttribute('data-print-exclude'))
    }
    clone.querySelectorAll('[data-print-exclude="true"], button, input, textarea, select, audio, video, [role="menu"], [role="dialog"]').forEach(node => node.remove())
    ;[clone, ...clone.querySelectorAll('*')].forEach(node => {
      if (!(node instanceof HTMLElement)) return
      node.style.removeProperty('height')
      node.style.removeProperty('max-height')
      node.style.removeProperty('min-height')
      node.style.removeProperty('overflow')
      node.style.removeProperty('overflow-x')
      node.style.removeProperty('overflow-y')
      node.style.removeProperty('position')
      node.removeAttribute('contenteditable')
    })
    clone.classList.add('easy-print-content')

    const meta = [channelName, author, username ? `@${String(username).replace(/^@/, '')}` : '', createdAt]
      .filter(Boolean)
      .map(escapeHtml)
      .join(' · ')
    printWindow.document.body.innerHTML = includeHeader
      ? `<header class="easy-print-header"><h1>${escapeHtml(safeTitle)}</h1><p>${meta}</p></header>`
      : ''
    printWindow.document.body.appendChild(clone)

    await waitForImages(printWindow.document)
    if (printWindow.document.fonts?.ready) await printWindow.document.fonts.ready
    await new Promise(resolve => printWindow.requestAnimationFrame(() => printWindow.requestAnimationFrame(resolve)))

    printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true })
    printWindow.focus()
    printWindow.print()
  } catch (error) {
    try { printWindow.close() } catch { /* noop */ }
    throw new Error(failedMessage || error?.message || '인쇄 준비 중 오류가 발생했습니다.')
  }
}

export { PRINT_STYLE, escapeHtml, truncatePrintTitle, waitForImages, waitForStylesheets }
