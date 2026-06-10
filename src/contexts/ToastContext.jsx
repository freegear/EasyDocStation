import { createContext, useContext, useState, useCallback, useRef } from 'react'

const ToastContext = createContext(null)

let _toastSeq = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timersRef = useRef(new Map())

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  // showToast({ message, actionLabel?, onAction?, duration?, tone? }) → id
  const showToast = useCallback((opts = {}) => {
    const id = ++_toastSeq
    const { message = '', actionLabel = null, onAction = null, duration = 7000, tone = 'default' } = opts
    setToasts((prev) => [...prev, { id, message, actionLabel, onAction, tone }])
    if (duration > 0) {
      const timer = setTimeout(() => dismissToast(id), duration)
      timersRef.current.set(id, timer)
    }
    return id
  }, [dismissToast])

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] flex flex-col items-center gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-center gap-3 max-w-[92vw] rounded-2xl bg-gray-900 text-white shadow-2xl border border-white/10 pl-4 pr-2 py-2.5"
          >
            <span className="text-sm leading-snug whitespace-pre-wrap break-words">{t.message}</span>
            {t.actionLabel && (
              <button
                onClick={() => {
                  try { t.onAction?.() } finally { dismissToast(t.id) }
                }}
                className="shrink-0 px-3 py-1 rounded-xl text-xs font-semibold bg-indigo-500 hover:bg-indigo-400 transition-colors"
              >
                {t.actionLabel}
              </button>
            )}
            <button
              onClick={() => dismissToast(t.id)}
              aria-label="닫기"
              className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // Provider 밖에서 호출돼도 앱이 죽지 않도록 no-op 폴백 제공
    return { showToast: () => null, dismissToast: () => {} }
  }
  return ctx
}
