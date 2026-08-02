import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'

export default function UpdateHistoryPage({ onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    apiFetch('/config/update-history', { cache: 'no-store' })
      .then(result => setData(result))
      .catch(err => setError(err.message || '업데이트 내역을 불러오지 못했습니다.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let cancelled = false
    apiFetch('/config/update-history', { cache: 'no-store' })
      .then(result => { if (!cancelled) setData(result) })
      .catch(err => { if (!cancelled) setError(err.message || '업데이트 내역을 불러오지 못했습니다.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const releases = Array.isArray(data?.releases) ? data.releases : []

  return (
    <section className="fixed inset-0 z-[70] flex flex-col bg-gray-50" role="dialog" aria-modal="true" aria-labelledby="update-history-title">
      <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 shadow-sm md:px-8">
        <button type="button" onClick={onClose} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
          <span aria-hidden="true">←</span>
          돌아가기
        </button>
        <div className="text-right">
          <h1 id="update-history-title" className="text-lg font-extrabold tracking-tight text-gray-900">EasyStation</h1>
          <p className="text-xs font-bold text-indigo-600">Version {data?.currentVersion || ''}</p>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8 md:px-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 h-16 w-16 overflow-hidden rounded-2xl bg-white shadow-lg">
              <img src="/img/logo.png" alt="EasyStation 로고" className="h-full w-full object-contain" />
            </div>
            <h2 className="text-3xl font-black tracking-tight text-gray-900">EasyStation</h2>
            <p className="mt-2 text-sm text-gray-500">새롭게 추가되고 개선된 기능을 확인하세요.</p>
          </div>

          <h3 className="mb-4 text-xl font-extrabold text-gray-900">업데이트 내역</h3>

          {loading ? (
            <div className="rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm font-semibold text-gray-400">업데이트 내역을 불러오는 중…</div>
          ) : error || data?.available === false ? (
            <div className="rounded-2xl border border-red-200 bg-white p-8 text-center">
              <p className="text-sm font-bold text-red-600">{error || '업데이트 내역을 사용할 수 없습니다.'}</p>
              <button type="button" onClick={load} className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-500">다시 시도</button>
            </div>
          ) : releases.length === 0 ? (
            <div className="rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm font-semibold text-gray-400">등록된 업데이트 내역이 없습니다.</div>
          ) : (
            <div className="space-y-4">
              {releases.map(release => (
                <article key={release.version} className={`rounded-2xl border bg-white p-5 shadow-sm ${release.current ? 'border-indigo-300 ring-1 ring-indigo-100' : 'border-gray-200'}`}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h4 className="text-lg font-black text-gray-900">v{release.version}</h4>
                    {release.current && <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-[11px] font-extrabold text-indigo-700">현재 버전</span>}
                  </div>
                  {release.descriptionType === 'list' && Array.isArray(release.descriptionItems) ? (
                    <ul className="list-disc space-y-1.5 pl-5 text-sm leading-7 text-gray-700">
                      {release.descriptionItems.map((item, index) => (
                        <li key={`${release.version}-${index}`}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="whitespace-pre-line text-sm leading-7 text-gray-700">{release.description}</p>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </main>
    </section>
  )
}
