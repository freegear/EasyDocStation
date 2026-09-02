import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'

export default function MailNoteDialog({ message, onClose, onSaved, mt }) {
  const labels = mt.note || {}
  const [note, setNote] = useState(null)
  const [content, setContent] = useState('')
  const [initialContent, setInitialContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const textareaRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ tenantId: String(message.tenant_id) })
    apiFetch(`/mail/messages/${encodeURIComponent(message.id)}/note?${params.toString()}`)
      .then(data => {
        if (cancelled) return
        const value = String(data?.note?.content || '')
        setNote(data?.note || null)
        setContent(value)
        setInitialContent(value)
        window.setTimeout(() => textareaRef.current?.focus(), 0)
      })
      .catch(err => { if (!cancelled) setError(err.message || labels.loadFailed) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [message.id, message.tenant_id, labels.loadFailed])

  const closeSafely = () => {
    if (!saving && content !== initialContent && !window.confirm(labels.discardConfirm)) return
    onClose?.()
  }

  useEffect(() => {
    const onKeyDown = event => { if (event.key === 'Escape') closeSafely() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  async function save() {
    const value = content.trim()
    if (!value) { setError(labels.empty); return }
    setSaving(true)
    setError('')
    try {
      const params = new URLSearchParams({ tenantId: String(message.tenant_id) })
      const data = await apiFetch(`/mail/messages/${encodeURIComponent(message.id)}/note?${params.toString()}`, {
        method: 'PUT', body: JSON.stringify({ content: value }),
      })
      setNote(data.note)
      setContent(data.note.content)
      setInitialContent(data.note.content)
      onSaved?.(data.note, { deleted: false, ragIndexed: data.ragIndexed })
      if (!data.ragIndexed) setError(labels.ragFailed)
      else onClose?.()
    } catch (err) {
      setError(err.message || labels.saveFailed)
    } finally { setSaving(false) }
  }

  async function remove() {
    if (!note || !window.confirm(labels.deleteConfirm)) return
    setSaving(true)
    setError('')
    try {
      const params = new URLSearchParams({ tenantId: String(message.tenant_id) })
      await apiFetch(`/mail/messages/${encodeURIComponent(message.id)}/note?${params.toString()}`, { method: 'DELETE' })
      onSaved?.(null, { deleted: true, ragIndexed: true })
      onClose?.()
    } catch (err) {
      setError(err.message || labels.deleteFailed)
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 px-4 py-6" onClick={closeSafely}>
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
        <header className="flex items-center justify-between bg-indigo-600 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-extrabold text-white">{note ? labels.viewTitle : labels.addTitle}</h3>
            <p className="mt-1 truncate text-xs font-semibold text-indigo-100">{message.subject || mt.noSubject}</p>
          </div>
          <button type="button" onClick={closeSafely} className="rounded-full p-1 text-indigo-100 hover:bg-indigo-500" aria-label={mt.cancel}>✕</button>
        </header>
        <div className="p-5">
          {loading ? <p className="py-16 text-center text-sm font-bold text-gray-400">{labels.loading}</p> : (
            <textarea ref={textareaRef} value={content} maxLength={20000} onChange={event => setContent(event.target.value)} placeholder={labels.placeholder} className="h-64 w-full resize-y rounded-xl border border-gray-200 p-4 text-sm leading-6 text-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
          )}
          <div className="mt-1 text-right text-xs text-gray-400">{content.length.toLocaleString()} / 20,000</div>
          {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">{error}</p>}
          <p className="mt-3 text-xs text-gray-400">{labels.privateHint}</p>
        </div>
        <footer className="flex items-center justify-between border-t border-gray-100 px-5 py-4">
          <div>{note && <button type="button" disabled={saving} onClick={remove} className="rounded-lg px-3 py-2 text-sm font-bold text-red-600 hover:bg-red-50 disabled:opacity-50">{labels.delete}</button>}</div>
          <div className="flex gap-2">
            <button type="button" disabled={saving} onClick={closeSafely} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600">{mt.cancel}</button>
            <button type="button" disabled={loading || saving || !content.trim()} onClick={save} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-extrabold text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? labels.saving : labels.save}</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
