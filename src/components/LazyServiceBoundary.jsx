import { Component, Suspense, lazy } from 'react'

export const LazyMailPage = lazy(() => import('../features/mail/MailPage'))
export const LazyCalendarView = lazy(() => import('./CalendarView'))
export const LazySiteAdminPage = lazy(() => import('./SiteAdminPage'))
export const LazyContactBookPage = lazy(() => import('../features/contactbook/ContactBookPage'))

function ServiceLoadingFallback() {
  return (
    <div className="flex h-full min-h-[240px] w-full items-center justify-center bg-gray-50" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-sm font-semibold text-gray-500">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
        화면을 불러오는 중입니다.
      </div>
    </div>
  )
}

class LazyLoadErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full min-h-[240px] w-full items-center justify-center bg-gray-50 px-6" role="alert">
        <div className="max-w-sm rounded-xl border border-red-100 bg-white p-5 text-center shadow-sm">
          <p className="font-bold text-gray-900">화면을 불러오지 못했습니다.</p>
          <p className="mt-2 text-sm text-gray-500">새 버전이 배포되었거나 네트워크 연결이 일시적으로 끊겼을 수 있습니다.</p>
          <button
            type="button"
            className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-500"
            onClick={() => window.location.reload()}
          >
            다시 불러오기
          </button>
        </div>
      </div>
    )
  }
}

export default function LazyServiceBoundary({ children }) {
  return (
    <LazyLoadErrorBoundary>
      <Suspense fallback={<ServiceLoadingFallback />}>
        {children}
      </Suspense>
    </LazyLoadErrorBoundary>
  )
}
