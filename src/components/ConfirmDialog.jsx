import { useEffect, useRef } from 'react'

export default function ConfirmDialog({
  title = '확인',
  message = '',
  confirmText = '확인',
  cancelText = '취소',
  danger = false,
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
        <h3 className="text-gray-900 font-bold text-base">{title}</h3>
        <p className="text-gray-600 text-sm mt-2 whitespace-pre-wrap leading-relaxed">{message}</p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent"
          >
            {cancelText}
          </button>
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
