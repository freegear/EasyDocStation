const DEBUG_FLAG_KEY = '__EDS_SELECTION_DEBUG__'

function isSelectionDebugEnabled() {
  if (typeof window === 'undefined') return false
  return (
    Boolean(window[DEBUG_FLAG_KEY]) ||
    import.meta.env.VITE_DEBUG_TEXT_SELECTION === '1'
  )
}

/**
 * Structured debug logger for text-selection event flow.
 * Enable by setting `window.__EDS_SELECTION_DEBUG__ = true`
 * or `VITE_DEBUG_TEXT_SELECTION=1`.
 * @param {string} scope
 * @param {string} eventName
 * @param {Record<string, unknown>} [payload]
 */
export function logSelectionDebug(scope, eventName, payload = {}) {
  if (!isSelectionDebugEnabled()) return
  const stamp = new Date().toISOString()
  const entry = {
    ts: stamp,
    scope,
    event: eventName,
    ...payload,
  }
  // Structured log for deterministic debugging in Electron/Chrome.
  console.debug('[selection-debug]', entry)
}
