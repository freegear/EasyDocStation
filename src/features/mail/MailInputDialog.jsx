import { useEffect, useRef, useState } from 'react'

function MailInputDialog({
  title,
  message,
  initialValue = '',
  confirmText = '확인',
  cancelText = '취소',
  loading = false,
  onConfirm,
  onCancel,
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef(null)
  const onCancelRef = useRef(onCancel)

  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])

  useEffect(() => {
    window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }, [])

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape' && !loading) onCancelRef.current?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [loading])

  const cleanValue = value.trim()

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 px-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl">
        <h3 className="text-base font-extrabold text-gray-950">{title}</h3>
        {message ? (
          <p className="mt-3 text-sm font-semibold leading-6 text-gray-600">{message}</p>
        ) : null}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && cleanValue && !loading) onConfirm?.(cleanValue)
          }}
          disabled={loading}
          className="mt-4 h-11 w-full rounded-lg border border-indigo-200 px-3 text-sm font-bold text-gray-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-50 disabled:text-gray-400"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition hover:bg-gray-100 disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={() => cleanValue && onConfirm?.(cleanValue)}
            disabled={loading || !cleanValue}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? '처리 중...' : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default MailInputDialog
