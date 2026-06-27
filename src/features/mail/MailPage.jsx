import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../../lib/api'

function MailIcon({ className = 'w-4 h-4' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M3 8l8.2 5.47a1.5 1.5 0 001.6 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

function MenuIcon({ type }) {
  const paths = {
    all: 'M4 6h16M4 12h16M4 18h16',
    star: 'M11.48 3.5l2.12 4.3 4.74.69-3.43 3.34.81 4.72-4.24-2.23-4.24 2.23.81-4.72-3.43-3.34 4.74-.69 2.12-4.3z',
    draft: 'M5 4h9l5 5v11H5V4zM14 4v5h5M8 14h8M8 17h5',
    search: 'M11 5a6 6 0 104.24 10.24L20 20',
    sent: 'M4 12l16-8-5 16-3-7-8-1z',
    trash: 'M6 7h12M10 7V5h4v2m-6 0l1 13h6l1-13',
    todo: 'M5 13l4 4L19 7',
    inbox: 'M4 5h16v11l-3 3H7l-3-3V5zM4 14h5l1.5 2h3L15 14h5',
    folder: 'M3 6h7l2 2h9v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z',
    back: 'M15 6l-6 6 6 6',
    refresh: 'M4 4v6h6M20 20v-6h-6M5 15a7 7 0 0011.9 3.9M19 9A7 7 0 007.1 5.1',
    settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zM4 12h2m12 0h2M12 4v2m0 12v2m-5.66-13.66l1.42 1.42m8.48 8.48l1.42 1.42m0-11.32l-1.42 1.42m-8.48 8.48l-1.42 1.42',
    reply: 'M9 14l-5-5 5-5v3h6a5 5 0 015 5v2',
    forward: 'M15 14l5-5-5-5v3H9a5 5 0 00-5 5v2',
    archive: 'M4 7h16M5 7l1 13h12l1-13M9 11h6',
    ai: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.4 6.4L22 12l-6.6 2.6L13 21l-2.4-6.4L4 12l6.6-2.6L13 3z',
    chevronRight: 'M9 5l7 7-7 7',
    chevronDown: 'M6 9l6 6 6-6',
  }

  return (
    <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={paths[type] || paths.folder} />
    </svg>
  )
}

function ToolbarButton({ icon, label, primary = false, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-bold transition-all ${
        primary
          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500'
          : 'border border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900'
      }`}
    >
      <MenuIcon type={icon} />
      <span>{label}</span>
    </button>
  )
}

function EmptyMailList({ label }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center px-6 text-center">
      <MailIcon className="w-9 h-9 text-indigo-500" />
      <h2 className="mt-4 text-base font-extrabold text-gray-900">표시할 메일이 없습니다</h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-gray-500">
        {label}에 표시할 메일이 없습니다.
      </p>
    </div>
  )
}

function EmptyMailViewer() {
  return (
    <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-indigo-500">
        <MailIcon className="w-8 h-8" />
      </div>
      <h2 className="mt-4 text-lg font-extrabold text-gray-900">메일을 선택하세요</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-gray-500">
        선택한 메일의 제목, 보낸 사람, 첨부파일, 본문이 이 영역에 표시됩니다.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <ToolbarButton icon="reply" label="답장" />
        <ToolbarButton icon="forward" label="전달" />
        <ToolbarButton icon="ai" label="AgenticAI로 보내기" />
      </div>
    </div>
  )
}

function MailMenuButton({ active, icon, label, count, onClick, depth = 0 }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2.5 w-full rounded-lg text-sm text-left transition-all ${
        depth ? 'px-2 py-1.5' : 'px-2 py-2'
      } ${
        active
          ? 'bg-indigo-600 text-white shadow-lg'
          : 'text-gray-500 hover:bg-gray-200 hover:text-gray-900'
      }`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <MenuIcon type={icon} />
      <span className="flex-1 font-medium truncate">{label}</span>
      {Number(count) > 0 && (
        <span className={`text-xs rounded-full px-1.5 py-0.5 font-bold min-w-[18px] text-center ${
          active ? 'bg-white/20 text-white' : 'bg-gray-300 text-gray-700'
        }`}>
          {count}
        </span>
      )}
    </button>
  )
}

function ProviderLogo({ provider }) {
  if (provider === 'gmail') {
    return (
      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-white shadow-sm ring-1 ring-gray-200">
        <svg className="h-6 w-7" viewBox="0 0 28 22" aria-hidden="true">
          <path fill="#EA4335" d="M2.5 0h3L14 6.6 22.5 0h3v22h-5V8.5L14 13.5 7.5 8.5V22h-5V0z" />
          <path fill="#FBBC04" d="M2.5 0 14 8.9v4.6L2.5 4.6V0z" />
          <path fill="#34A853" d="M25.5 0 14 8.9v4.6L25.5 4.6V0z" />
          <path fill="#4285F4" d="M20.5 22V8.5l5-3.9V22h-5z" />
          <path fill="#C5221F" d="M2.5 22V4.6l5 3.9V22h-5z" />
        </svg>
      </span>
    )
  }
  if (provider === 'naver') {
    return (
      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[#03C75A] text-lg font-black text-white shadow-sm">
        N
      </span>
    )
  }
  if (provider === 'apple') {
    return (
      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gray-950 text-white shadow-sm">
        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M16.5 1.8c.1 1.3-.4 2.5-1.2 3.4-.8.9-2.1 1.6-3.3 1.5-.1-1.2.4-2.5 1.1-3.3.9-1 2.3-1.7 3.4-1.6zM20.4 17.1c-.5 1.1-.8 1.6-1.5 2.6-1 1.5-2.4 3.3-4.1 3.3-1.5 0-1.9-1-4-1s-2.6 1-4 1c-1.7 0-3-1.7-4-3.2-2.8-4.2-3.1-9.1-1.4-11.7 1.2-1.8 3-2.8 4.7-2.8 1.8 0 2.9 1 4.3 1 1.4 0 2.3-1 4.4-1 1.6 0 3.3.9 4.5 2.4-4 2.2-3.3 7.9.7 9.4z" />
        </svg>
      </span>
    )
  }
  return (
    <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-500 shadow-sm ring-1 ring-indigo-100">
      <MailIcon className="h-5 w-5" />
    </span>
  )
}

const NAVER_MAIL_DEFAULTS = {
  provider: 'naver',
  email_address: '',
  display_name: '',
  username: '',
  password: '',
  imap_host: 'imap.naver.com',
  imap_port: '993',
  imap_security: 'ssl',
  smtp_host: 'smtp.naver.com',
  smtp_port: '465',
  smtp_security: 'ssl',
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-gray-500">{label}</span>
      {children}
    </label>
  )
}

function MailInput(props) {
  return (
    <input
      {...props}
      className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
    />
  )
}

function MailSelect(props) {
  return (
    <select
      {...props}
      className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-bold text-gray-700 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
    />
  )
}

function MailAccountManageModal({ accounts, tenants = [], onClose, onAccountAdded }) {
  const [view, setView] = useState('main')
  const [gmailAuthLoading, setGmailAuthLoading] = useState(false)
  const [gmailAuthError, setGmailAuthError] = useState('')
  const [naverForm, setNaverForm] = useState(NAVER_MAIL_DEFAULTS)
  const [naverSaving, setNaverSaving] = useState(false)
  const [naverError, setNaverError] = useState('')
  const providers = [
    { key: 'gmail', label: 'Gmail 계정 추가', hint: 'Google OAuth 연결로 진행합니다.' },
    { key: 'naver', label: '네이버 계정 추가', hint: '네이버 메일 IMAP/SMTP 설정으로 진행합니다.' },
    { key: 'apple', label: 'Apple 메일 계정 추가', hint: 'iCloud 앱 암호 기반 설정으로 진행합니다.' },
    { key: 'other', label: '기타 계정 추가', hint: 'IMAP/SMTP 서버 정보를 직접 입력합니다.' },
  ]

  async function startGmailAuth() {
    setGmailAuthLoading(true)
    setGmailAuthError('')
    try {
      const data = await apiFetch('/mail/gmail/auth-url')
      if (!data?.authUrl) throw new Error('Google 인증 URL을 받지 못했습니다.')
      window.location.href = data.authUrl
    } catch (err) {
      setGmailAuthError(err.message || 'Google 인증을 시작하지 못했습니다.')
      setGmailAuthLoading(false)
    }
  }

  function updateNaverField(key, value) {
    setNaverForm(prev => {
      const next = { ...prev, [key]: value }
      if (key === 'email_address' && (!prev.username || prev.username === prev.email_address)) {
        next.username = value
      }
      return next
    })
  }

  async function saveNaverAccount(event) {
    event.preventDefault()
    setNaverSaving(true)
    setNaverError('')
    try {
      await apiFetch('/mail/accounts/imap', {
        method: 'POST',
        body: JSON.stringify({
          ...naverForm,
          tenantId: naverForm.tenantId || undefined,
          imap_port: Number(naverForm.imap_port),
          smtp_port: Number(naverForm.smtp_port),
        }),
      })
      if (onAccountAdded) await onAccountAdded()
      onClose()
    } catch (err) {
      setNaverError(err.message || '네이버 메일 계정을 저장하지 못했습니다.')
    } finally {
      setNaverSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-extrabold text-gray-900">메일 계정 관리</h2>
            <p className="mt-0.5 text-sm text-gray-400">
              {view === 'gmail' ? 'Google 계정 인증을 진행합니다.' : view === 'naver' ? '네이버 메일 클라이언트 정보를 입력하세요.' : view === 'add' ? '추가할 메일 서비스를 선택하세요.' : view === 'delete' ? '삭제할 계정을 선택하세요.' : '계정 추가 또는 삭제 작업을 선택하세요.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="닫기"
          >
            ×
          </button>
        </div>

        <div className="p-6">
          {view === 'main' && (
            <div className="grid gap-3">
              <button
                type="button"
                onClick={() => setView('add')}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
              >
                <span>
                  <span className="block text-sm font-extrabold text-gray-900">계정 추가</span>
                  <span className="mt-0.5 block text-xs text-gray-500">Gmail, 네이버, Apple 또는 기타 계정을 추가합니다.</span>
                </span>
                <MenuIcon type="chevronRight" />
              </button>
              <button
                type="button"
                onClick={() => setView('delete')}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-red-200 hover:bg-red-50"
              >
                <span>
                  <span className="block text-sm font-extrabold text-gray-900">계정 삭제</span>
                  <span className="mt-0.5 block text-xs text-gray-500">등록된 메일 계정을 삭제합니다.</span>
                </span>
                <MenuIcon type="chevronRight" />
              </button>
            </div>
          )}

          {view === 'add' && (
            <div className="grid gap-3">
              {providers.map(provider => (
                <button
                  key={provider.key}
                  type="button"
                  onClick={() => {
                    if (provider.key === 'gmail') setView('gmail')
                    if (provider.key === 'naver') setView('naver')
                  }}
                  className="flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
                >
                  <ProviderLogo provider={provider.key} />
                  <span className="min-w-0">
                    <span className="block text-sm font-extrabold text-gray-900">{provider.label}</span>
                    <span className="mt-0.5 block text-xs text-gray-500">{provider.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {view === 'naver' && (
            <form onSubmit={saveNaverAccount} className="grid gap-4">
              <div className="flex items-center gap-3 rounded-lg border border-[#03C75A]/20 bg-[#03C75A]/5 px-4 py-3">
                <ProviderLogo provider="naver" />
                <div className="min-w-0">
                  <h3 className="text-sm font-extrabold text-gray-900">네이버 메일 클라이언트 설정</h3>
                  <p className="mt-0.5 text-xs text-gray-500">IMAP/SMTP 서버 값이 기본으로 입력되어 있습니다.</p>
                </div>
              </div>

              {tenants.length > 1 && (
                <Field label="메일 공간">
                  <MailSelect
                    value={naverForm.tenantId || ''}
                    onChange={event => updateNaverField('tenantId', event.target.value)}
                  >
                    <option value="">개인 공간</option>
                    {tenants.map(tenant => (
                      <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                    ))}
                  </MailSelect>
                </Field>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="이메일">
                  <MailInput
                    type="email"
                    required
                    value={naverForm.email_address}
                    onChange={event => updateNaverField('email_address', event.target.value)}
                    placeholder="name@naver.com"
                  />
                </Field>
                <Field label="표시 이름">
                  <MailInput
                    value={naverForm.display_name}
                    onChange={event => updateNaverField('display_name', event.target.value)}
                    placeholder="홍길동"
                  />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="사용자 이름">
                  <MailInput
                    required
                    value={naverForm.username}
                    onChange={event => updateNaverField('username', event.target.value)}
                    placeholder="name@naver.com"
                  />
                </Field>
                <Field label="앱 비밀번호">
                  <MailInput
                    type="password"
                    required
                    value={naverForm.password}
                    onChange={event => updateNaverField('password', event.target.value)}
                    placeholder="네이버 앱 비밀번호"
                  />
                </Field>
              </div>

              <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_90px_120px]">
                  <Field label="IMAP 서버">
                    <MailInput
                      required
                      value={naverForm.imap_host}
                      onChange={event => updateNaverField('imap_host', event.target.value)}
                    />
                  </Field>
                  <Field label="포트">
                    <MailInput
                      required
                      type="number"
                      min="1"
                      value={naverForm.imap_port}
                      onChange={event => updateNaverField('imap_port', event.target.value)}
                    />
                  </Field>
                  <Field label="보안">
                    <MailSelect
                      value={naverForm.imap_security}
                      onChange={event => updateNaverField('imap_security', event.target.value)}
                    >
                      <option value="ssl">SSL</option>
                      <option value="starttls">STARTTLS</option>
                      <option value="none">없음</option>
                    </MailSelect>
                  </Field>
                </div>

                <div className="grid gap-3 sm:grid-cols-[1fr_90px_120px]">
                  <Field label="SMTP 서버">
                    <MailInput
                      required
                      value={naverForm.smtp_host}
                      onChange={event => updateNaverField('smtp_host', event.target.value)}
                    />
                  </Field>
                  <Field label="포트">
                    <MailInput
                      required
                      type="number"
                      min="1"
                      value={naverForm.smtp_port}
                      onChange={event => updateNaverField('smtp_port', event.target.value)}
                    />
                  </Field>
                  <Field label="보안">
                    <MailSelect
                      value={naverForm.smtp_security}
                      onChange={event => updateNaverField('smtp_security', event.target.value)}
                    >
                      <option value="ssl">SSL</option>
                      <option value="starttls">STARTTLS</option>
                      <option value="none">없음</option>
                    </MailSelect>
                  </Field>
                </div>
              </div>

              {naverError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">
                  {naverError}
                </p>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={naverSaving}
                  className="rounded-lg bg-[#03C75A] px-5 py-2 text-sm font-extrabold text-white shadow-lg shadow-green-100 hover:bg-[#02b351] disabled:opacity-60"
                >
                  {naverSaving ? '저장 중...' : '저장'}
                </button>
              </div>
            </form>
          )}

          {view === 'gmail' && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-6 py-8 text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-gray-200">
                <svg className="h-12 w-12" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
                  <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.6 8.3 6.3 14.7z" />
                  <path fill="#4CAF50" d="M24 44c5.1 0 9.8-2 13.3-5.2l-6.2-5.2C29.1 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                  <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.4-2.3 4.3-4.2 5.6l6.2 5.2C36.9 39.1 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
                </svg>
              </div>
              <h3 className="mt-6 text-2xl font-extrabold leading-tight text-gray-900">
                웹 브라우저 인증을 완료하세요
              </h3>
              <p className="mx-auto mt-4 max-w-sm text-base leading-7 text-gray-700">
                Google 계정으로 인증하려면 웹 브라우저에 표시되는 단계를 따라주세요.
                설정이 완료되면 EasyStation으로 다시 돌아옵니다.
              </p>
              {gmailAuthError && (
                <p className="mx-auto mt-4 max-w-sm rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">
                  {gmailAuthError}
                </p>
              )}
              <button
                type="button"
                onClick={startGmailAuth}
                disabled={gmailAuthLoading}
                className="mt-8 rounded-lg bg-blue-600 px-12 py-3 text-base font-extrabold text-white shadow-lg shadow-blue-200 hover:bg-blue-500"
              >
                {gmailAuthLoading ? '연결 중...' : '계속'}
              </button>
            </div>
          )}

          {view === 'delete' && (
            accounts.length > 0 ? (
              <div className="grid gap-2">
                {accounts.map(account => (
                  <button
                    key={account.id}
                    type="button"
                    className="flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-red-200 hover:bg-red-50"
                  >
                    <ProviderLogo provider={account.provider} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-extrabold text-gray-900">{account.email_address}</span>
                      <span className="mt-0.5 block truncate text-xs text-gray-500">{account.tenant_name || account.tenant_id}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center">
                <p className="text-sm font-bold text-gray-700">삭제할 수 있는 연결 계정이 없습니다.</p>
                <p className="mt-1 text-xs text-gray-500">Gmail, 네이버, Apple 또는 기타 계정을 먼저 추가하세요.</p>
              </div>
            )
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-6 py-4">
          {view === 'main' ? (
            <span className="text-xs text-gray-400">4.0.1 메일 계정 관리 메뉴</span>
          ) : (
            <button
              type="button"
              onClick={() => setView(view === 'gmail' || view === 'naver' ? 'add' : 'main')}
              className="text-sm font-bold text-gray-500 hover:text-gray-900"
            >
              뒤로
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500"
          >
            취소
          </button>
        </div>
      </div>
    </div>
  )
}

export default function MailPage({ onBackToMain }) {
  const [tenants, setTenants] = useState([])
  const [accounts, setAccounts] = useState([])
  const [mailMetaLoading, setMailMetaLoading] = useState(false)
  const [mailMetaError, setMailMetaError] = useState('')
  const [activeKey, setActiveKey] = useState('all')
  const [collapsedAccountIds, setCollapsedAccountIds] = useState(() => new Set())
  const [showAccountModal, setShowAccountModal] = useState(false)

  useEffect(() => {
    let cancelled = false
    setMailMetaLoading(true)
    setMailMetaError('')
    Promise.all([
      apiFetch('/mail/tenants'),
      apiFetch('/mail/accounts'),
    ])
      .then(([tenantRows, accountRows]) => {
        if (cancelled) return
        setTenants(Array.isArray(tenantRows) ? tenantRows : [])
        setAccounts(Array.isArray(accountRows) ? accountRows : [])
      })
      .catch(err => {
        if (cancelled) return
        setMailMetaError(err.message || '메일 구조 정보를 불러오지 못했습니다.')
      })
      .finally(() => {
        if (!cancelled) setMailMetaLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  async function reloadMailAccounts() {
    const accountRows = await apiFetch('/mail/accounts')
    setAccounts(Array.isArray(accountRows) ? accountRows : [])
  }

  function openAgenticPanel() {
    window.dispatchEvent(new CustomEvent('open-agentic-panel'))
  }

  function toggleAccount(accountId) {
    setCollapsedAccountIds(prev => {
      const next = new Set(prev)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      return next
    })
  }

  const mainMenus = [
    { key: 'all', label: '모든 편지함', icon: 'all' },
    { key: 'inbox', label: '받은 편지함', icon: 'inbox' },
    { key: 'starred', label: '별표됨', icon: 'star' },
    { key: 'drafts', label: '임시보관함', icon: 'draft' },
    { key: 'search', label: '검색', icon: 'search' },
    { key: 'sent', label: '보낸 메일', icon: 'sent' },
    { key: 'trash', label: '휴지통', icon: 'trash' },
  ]

  const activeLabel = mainMenus.find(item => item.key === activeKey)?.label
    || accounts.flatMap(account => (account.folders || []).map(folder => ({
      key: `${account.id}:${folder.id || folder.name}`,
      label: `${account.email_address} / ${folder.name}`,
    }))).find(item => item.key === activeKey)?.label
    || '메일'

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 min-w-0 overflow-hidden bg-gray-50">
      <aside className="w-full md:w-64 flex-shrink-0 bg-gray-200 flex flex-col h-auto md:h-full max-h-72 md:max-h-none border-b md:border-b-0 md:border-r border-gray-100">
        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-3 pb-2 mb-1 border-b border-gray-300">
            <div className="flex items-center gap-2.5 px-2 py-2 text-gray-900">
              <MailIcon className="w-5 h-5 text-indigo-600" />
              <span className="font-extrabold">메일</span>
            </div>
            <div className="flex flex-col gap-1 mt-1">
              {mainMenus.map(item => (
                <MailMenuButton
                  key={item.key}
                  active={activeKey === item.key}
                  icon={item.icon}
                  label={item.label}
                  onClick={() => setActiveKey(item.key)}
                />
              ))}
            </div>
          </div>

          <div className="px-3 pb-2">
            <div className="flex flex-col gap-2 mt-1">
              {accounts.map(account => {
                const collapsed = collapsedAccountIds.has(account.id)
                const folders = Array.isArray(account.folders) && account.folders.length > 0
                  ? account.folders
                  : [
                      { id: 'inbox', name: '받은 편지함', type: 'inbox' },
                      { id: 'sent', name: '보낸 메일', type: 'sent' },
                    ]
                return (
                  <div key={account.id}>
                    <button
                      type="button"
                      onClick={() => toggleAccount(account.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-bold text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
                      aria-expanded={!collapsed}
                    >
                      <MenuIcon type={collapsed ? 'chevronRight' : 'chevronDown'} />
                      <span className="truncate">{account.email_address}</span>
                    </button>
                    {!collapsed && (
                      <div className="flex flex-col gap-0.5">
                        {folders.map(folder => {
                          const key = `${account.id}:${folder.id || folder.name}`
                          return (
                            <MailMenuButton
                              key={key}
                              active={activeKey === key}
                              icon={folder.type === 'inbox' || folder.name === '받은 편지함' ? 'inbox' : 'folder'}
                              label={folder.name}
                              depth={1}
                              onClick={() => setActiveKey(key)}
                            />
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
              {accounts.length === 0 && (
                <div className="rounded-lg border border-dashed border-gray-300 px-3 py-3 text-xs text-gray-500">
                  {mailMetaLoading
                    ? '메일 계정 정보를 불러오는 중입니다.'
                    : mailMetaError || '연결된 메일 계정이 없습니다.'}
                  {tenants.length > 0 && !mailMetaLoading && !mailMetaError && (
                    <div className="mt-1 text-[11px] text-gray-400">
                      사용 가능한 tenant {tenants.length}개
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="px-3 py-2 border-t border-gray-100">
          <button
            type="button"
            onClick={onBackToMain}
            className="flex items-center gap-2.5 w-full px-2 py-2 rounded-lg text-sm text-left transition-all text-gray-500 hover:bg-gray-200 hover:text-gray-900"
          >
            <MenuIcon type="back" />
            <span className="font-medium">메인 메뉴로 이동</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-hidden flex flex-col bg-gray-50">
        <header className="flex-shrink-0 border-b border-gray-200 bg-white px-5 py-3 md:px-8">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-xl font-extrabold text-gray-900">{activeLabel} - 0개 메일</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ToolbarButton icon="refresh" label="새로고침" />
              <ToolbarButton icon="settings" label="계정 설정" onClick={() => setShowAccountModal(true)} />
              <ToolbarButton icon="draft" label="메일 작성" primary />
            </div>
          </div>
        </header>

        <section className="flex-1 min-h-0 overflow-hidden p-4 md:p-5">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white lg:flex-row">
            <div className="flex h-80 flex-shrink-0 flex-col border-b border-gray-200 lg:h-full lg:w-[360px] lg:border-b-0 lg:border-r">
              <div className="flex-shrink-0 border-b border-gray-100 p-3">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                    <MenuIcon type="search" />
                  </span>
                  <input
                    type="search"
                    placeholder="메일 검색..."
                    className="h-10 w-full rounded-lg border border-gray-200 bg-gray-50 pl-10 pr-3 text-sm text-gray-700 outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
                  <span className="font-bold">메일 목록</span>
                  <span>0개</span>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <EmptyMailList label={activeLabel} />
              </div>
            </div>

            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex-shrink-0 border-b border-gray-100 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ToolbarButton icon="archive" label="보관" />
                    <ToolbarButton icon="trash" label="삭제" />
                    <ToolbarButton icon="todo" label="할일목록에 추가" />
                    <ToolbarButton icon="ai" label="AgenticAI" onClick={openAgenticPanel} />
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <EmptyMailViewer />
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      {showAccountModal && (
        <MailAccountManageModal
          accounts={accounts}
          tenants={tenants}
          onClose={() => setShowAccountModal(false)}
          onAccountAdded={reloadMailAccounts}
        />
      )}
    </div>
  )
}
