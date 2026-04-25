import { useEffect, useRef } from 'react'

export default function ConfirmDialog({
  title = '확인',
  message = '',
  highlightItems = [],
  confirmText = '확인',
  cancelText = '취소',
  hideCancel = false,
  danger = false,
  titleTone = 'default',
  loading = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null)

  useEffect(() => {
    confirmRef.current?.focus()
    function onKeyDown(e) {
      if (e.key === 'Escape' && !loading) onCancel?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, loading])

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white border border-gray-200 shadow-2xl p-5">
        {titleTone === 'blue' ? (
          <div className="-mx-5 -mt-5 mb-4 rounded-t-2xl border-b border-indigo-100 bg-indigo-50 px-5 py-3">
            <h3 className="text-indigo-700 font-bold text-base text-center">{title}</h3>
          </div>
        ) : (
          <h3 className="text-gray-900 font-bold text-base">{title}</h3>
        )}
        {message ? (
          <p className="text-gray-600 text-sm mt-2 whitespace-pre-wrap leading-relaxed">{message}</p>
        ) : null}
        {highlightItems.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {highlightItems.map((item, idx) => (
              <li key={`${item}-${idx}`} className="text-sm font-bold text-red-600 break-all">
                {item}
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2 mt-5">
          {!hideCancel && (
            <button
              onClick={onCancel}
              disabled={loading}
              className="px-4 py-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent"
            >
              {cancelText}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 rounded-xl text-sm text-white disabled:opacity-60 ${
              danger ? 'bg-red-500 hover:bg-red-600' : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            {loading ? '처리 중...' : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
