export async function copyTextWithFallback(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return false

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(normalized)
      return true
    }
  } catch {
    // Clipboard API may be blocked on non-secure origins or embedded browsers.
  }

  if (typeof document === 'undefined') return false

  let textarea = null
  try {
    textarea = document.createElement('textarea')
    textarea.value = normalized
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '0'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    if (textarea?.parentNode) textarea.parentNode.removeChild(textarea)
  }
}
