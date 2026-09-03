import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useT } from '../../i18n/useT'

const LABELS = {
  ko: { from: '보낸사람', to: '받는사람', cc: '참조', subject: '제목', all: '모든', file: '파일', placeholder: '메일 검색...', invalid: '정확한 이메일 주소를 입력해주세요.' },
  en: { from: 'From', to: 'To', cc: 'Cc', subject: 'Subject', all: 'All', file: 'File', placeholder: 'Search mail...', invalid: 'Enter a complete email address.' },
  ja: { from: '差出人', to: '宛先', cc: 'Cc', subject: '件名', all: 'すべて', file: 'ファイル', placeholder: 'メール検索...', invalid: '完全なメールアドレスを入力してください。' },
}

export default function MailSearchBar() {
  const { language } = useAuth()
  const labels = LABELS[language] || LABELS.ko
  const t = useT()
  const [field, setField] = useState('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')

  function submit(event) {
    event.preventDefault()
    const cleanQuery = query.trim()
    if (!cleanQuery) return
    if (['from', 'to', 'cc'].includes(field) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanQuery)) {
      setError(labels.invalid)
      return
    }
    setError('')
    window.dispatchEvent(new CustomEvent('easy-mail-search', {
      detail: { field, query: cleanQuery, requestId: Date.now() },
    }))
  }

  return (
    <form onSubmit={submit} className="relative flex min-w-0 flex-1 items-center gap-2 md:max-w-2xl">
      <select
        value={field}
        onChange={event => { setField(event.target.value); setError('') }}
        aria-label="메일 검색 범위"
        className="h-10 flex-shrink-0 rounded-xl border border-gray-300 bg-white px-2 text-xs font-bold text-gray-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 md:text-sm"
      >
        {['from', 'to', 'cc', 'subject', 'all', 'file'].map(value => (
          <option key={value} value={value}>{labels[value]}</option>
        ))}
      </select>
      <div className="relative min-w-0 flex-1">
        <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type={['from', 'to', 'cc'].includes(field) ? 'email' : 'search'}
          value={query}
          onChange={event => { setQuery(event.target.value); setError('') }}
          placeholder={labels.placeholder}
          aria-invalid={!!error}
          title={error || undefined}
          className={`h-10 w-full rounded-xl border bg-white pl-9 pr-3 text-sm outline-none focus:ring-2 ${error ? 'border-red-400 focus:ring-red-100' : 'border-gray-300 focus:border-indigo-500 focus:ring-indigo-100'}`}
        />
      </div>
      <button type="submit" className="h-10 flex-shrink-0 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-700">
        {t.common?.search || '검색'}
      </button>
    </form>
  )
}
