import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'

const emptyForm = { provider: 'APPLE', displayName: '', username: '', secret: '', discoveryUrl: '', authType: 'BASIC' }

export default function ContactBookPage({ onBackToMain }) {
  const [contacts, setContacts] = useState([])
  const [totalContacts, setTotalContacts] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [selected, setSelected] = useState(null)
  const [query, setQuery] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [showAccountForm, setShowAccountForm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [working, setWorking] = useState('')
  const contactLoadGeneration = useRef(0)
  const [error, setError] = useState(() => new URL(window.location.href).searchParams.get('contactbook_oauth') === 'error' ? 'Google 계정 연결에 실패했습니다. OAuth 설정과 권한을 확인해 주세요.' : '')
  const [notice, setNotice] = useState(() => new URL(window.location.href).searchParams.get('contactbook_oauth') === 'connected' ? 'Google 연락처 계정이 연결되었습니다. 지금 동기화를 실행해 주세요.' : '')

  const loadAccounts = useCallback(async () => setAccounts(await apiFetch('/contactbook/accounts')), [])
  const loadContacts = useCallback(async (q = '', options = {}) => {
    const generation = ++contactLoadGeneration.current
    const requestPage = offset => apiFetch(`/contactbook/contacts?q=${encodeURIComponent(q)}&limit=100&offset=${offset}`, options)
    try {
      const first = await requestPage(0)
      if (generation !== contactLoadGeneration.current) return
      let loaded = first.contacts || []
      const total = Number(first.total) || 0
      let more = Boolean(first.hasMore)
      setContacts(loaded)
      setTotalContacts(total)
      setHasMore(more)
      setLoading(false)
      setLoadingMore(more)

      while (more) {
        const page = await requestPage(loaded.length)
        if (generation !== contactLoadGeneration.current) return
        const next = page.contacts || []
        if (next.length === 0) break
        loaded = [...loaded, ...next]
        more = Boolean(page.hasMore) && loaded.length < total
        setContacts(loaded)
        setHasMore(more)
      }
    } finally {
      if (generation === contactLoadGeneration.current) setLoadingMore(false)
    }
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => {
      loadAccounts().catch(e => setError(e.message))
    }, 0)
    return () => clearTimeout(timer)
  }, [loadAccounts])
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => loadContacts(query, { signal: controller.signal }).catch(e => {
      if (e.name !== 'AbortError') setError(e.message)
    }), 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, loadContacts])
  useEffect(() => {
    const url = new URL(window.location.href)
    const status = url.searchParams.get('contactbook_oauth')
    if (status) {
      url.searchParams.delete('open')
      url.searchParams.delete('contactbook_oauth')
      url.searchParams.delete('contactbook_error')
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }, [])

  async function addAccount(event) {
    event.preventDefault(); setError(''); setWorking('add')
    try {
      await apiFetch('/contactbook/accounts', { method: 'POST', body: JSON.stringify(form) })
      setForm(emptyForm); setShowAccountForm(false); await loadAccounts()
    } catch (e) { setError(e.message) } finally { setWorking('') }
  }
  async function connectGoogle(accountId = null) {
    setError(''); setWorking(accountId || 'google')
    try {
      const data = await apiFetch('/contactbook/oauth/google/start', { method: 'POST', body: JSON.stringify(accountId ? { accountId } : {}) })
      if (!data.authUrl) throw new Error('Google 인증 주소를 받지 못했습니다.')
      window.location.assign(data.authUrl)
    } catch (e) { setError(e.message); setWorking('') }
  }
  async function sync(account) {
    setError(''); setWorking(account.id)
    try { await apiFetch(`/contactbook/accounts/${account.id}/sync`, { method: 'POST' }); await Promise.all([loadAccounts(), loadContacts(query)]) }
    catch (e) { setError(e.message) } finally { setWorking('') }
  }
  async function remove(account) {
    if (!window.confirm(`“${account.display_name}” 연결과 가져온 연락처를 삭제할까요?`)) return
    setWorking(account.id)
    try { await apiFetch(`/contactbook/accounts/${account.id}`, { method: 'DELETE' }); setSelected(null); await Promise.all([loadAccounts(), loadContacts(query)]) }
    catch (e) { setError(e.message) } finally { setWorking('') }
  }
  async function contactUpdated(contact) {
    setSelected(contact)
    await loadContacts(query)
  }

  return <div className="flex flex-1 min-w-0 bg-slate-50 text-slate-900">
    <aside className="w-64 flex-shrink-0 border-r border-slate-200 bg-white p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-5"><h1 className="text-lg font-bold">ContactBook</h1><button onClick={onBackToMain} className="text-xs text-indigo-600">메인으로</button></div>
      <button onClick={() => { setSelected(null); setQuery('') }} className="w-full rounded-lg bg-indigo-50 px-3 py-2 text-left text-sm font-semibold text-indigo-700">모든 연락처 <span className="float-right">{totalContacts}</span></button>
      <div className="mt-6 mb-2 flex items-center justify-between"><span className="text-xs font-bold uppercase tracking-wide text-slate-400">연결 계정</span><button onClick={() => setShowAccountForm(true)} className="text-xl leading-none text-indigo-600" title="계정 추가">+</button></div>
      {accounts.length === 0 && <p className="text-xs text-slate-400 py-3">연결된 주소록이 없습니다.</p>}
      {accounts.map(account => <div key={account.id} className="mb-2 rounded-lg border border-slate-200 p-2.5">
        <div className="flex items-center gap-2"><span>{account.provider === 'APPLE' ? '●' : account.provider === 'GOOGLE' ? 'G' : '◇'}</span><span className="min-w-0 flex-1 truncate text-sm font-medium">{account.display_name}</span></div>
        <div className={`mt-1 text-[11px] ${account.status === 'CONNECTED' ? 'text-emerald-600' : 'text-rose-600'}`}>{account.status === 'CONNECTED' ? '연결됨' : account.status === 'AUTH_REQUIRED' ? '인증 필요' : '동기화 오류'} · 주소록 {account.addressbook_count}</div>
        <div className="mt-2 flex gap-2">{account.provider === 'GOOGLE' && account.status === 'AUTH_REQUIRED' && <button disabled={working === account.id} onClick={() => connectGoogle(account.id)} className="text-xs text-amber-600 disabled:opacity-40">재인증</button>}<button disabled={working === account.id || account.status === 'AUTH_REQUIRED'} onClick={() => sync(account)} className="text-xs text-indigo-600 disabled:opacity-40">{working === account.id ? '동기화 중…' : '지금 동기화'}</button><button disabled={working === account.id} onClick={() => remove(account)} className="text-xs text-rose-500">삭제</button></div>
      </div>)}
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-slate-200 bg-white p-4"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="이름, 이메일, 전화번호, 회사 검색" className="w-full max-w-xl rounded-xl border border-slate-300 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-400" /></div>
      {error && <div className="m-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}<button onClick={() => setError('')} className="float-right">×</button></div>}
      {notice && <div className="m-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}<button onClick={() => setNotice('')} className="float-right">×</button></div>}
      <div className="flex min-h-0 flex-1">
        <section className="w-[42%] min-w-[300px] overflow-y-auto border-r border-slate-200 bg-white">
          {loading ? <p className="p-6 text-sm text-slate-400">불러오는 중…</p> : contacts.length === 0 ? <div className="p-10 text-center text-sm text-slate-400">연락처가 없습니다.<br/>왼쪽 + 버튼으로 CardDAV 계정을 연결하세요.</div> : contacts.map(contact => <button key={contact.id} onClick={() => setSelected(contact)} className={`flex w-full items-center gap-3 border-b border-slate-100 p-4 text-left hover:bg-slate-50 ${selected?.id === contact.id ? 'bg-indigo-50' : ''}`}>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 font-bold text-indigo-700">{(contact.display_name || '?').slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0"><div className="truncate font-semibold">{contact.display_name || '(이름 없음)'}</div><div className="truncate text-xs text-slate-500">{contact.emails?.[0]?.value || contact.phones?.[0]?.value || contact.organization || ''}</div><div className="mt-1 text-[10px] text-slate-400">{contact.account_name} · {contact.addressbook_name}</div></div>
          </button>)}
          {hasMore && <div className="w-full border-b border-slate-200 px-4 py-3 text-center text-sm font-semibold text-indigo-600">{loadingMore ? `백그라운드로 불러오는 중 (${contacts.length}/${totalContacts})` : `불러오기 대기 중 (${contacts.length}/${totalContacts})`}</div>}
        </section>
        <section className="flex-1 overflow-y-auto p-8">{selected ? <ContactDetail key={selected.id} contact={selected} onUpdated={contactUpdated} /> : <div className="flex h-full items-center justify-center text-sm text-slate-400">연락처를 선택하세요.</div>}</section>
      </div>
    </main>
    {showAccountForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"><form onSubmit={form.provider === 'GOOGLE' ? e => { e.preventDefault(); connectGoogle() } : addAccount} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
      <h2 className="mb-5 text-lg font-bold">CardDAV 계정 연결</h2>
      <label className="mb-3 block text-sm">공급자<select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} className="mt-1 w-full rounded-lg border p-2"><option value="APPLE">Apple iCloud</option><option value="GENERIC_CARDDAV">기타 CardDAV</option><option value="GOOGLE">Google Contacts</option></select></label>
      {form.provider === 'GOOGLE' ? <div className="mb-5 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-slate-600">Google 로그인 화면에서 연락처 접근 권한을 승인하면 계정이 안전하게 연결됩니다. Access token을 직접 입력할 필요가 없습니다.</div> : <>
        <label className="mb-3 block text-sm">표시 이름<input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} className="mt-1 w-full rounded-lg border p-2" placeholder="개인 iCloud" /></label>
        <label className="mb-3 block text-sm">계정<input required value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} className="mt-1 w-full rounded-lg border p-2" placeholder="name@example.com" /></label>
        {form.provider === 'GENERIC_CARDDAV' && <label className="mb-3 block text-sm">서버 주소<input required type="url" value={form.discoveryUrl} onChange={e => setForm({ ...form, discoveryUrl: e.target.value })} className="mt-1 w-full rounded-lg border p-2" placeholder="https://dav.example.com/.well-known/carddav" /></label>}
        <label className="mb-2 block text-sm">{form.provider === 'APPLE' ? '앱 전용 암호' : '암호 또는 앱 전용 암호'}<input required type="password" value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} className="mt-1 w-full rounded-lg border p-2" autoComplete="new-password" /></label>
        <p className="mb-5 text-xs text-slate-500">인증 정보는 암호화하여 저장하며 다시 화면에 표시하지 않습니다.</p>
      </>}
      <div className="flex justify-end gap-2"><button type="button" onClick={() => setShowAccountForm(false)} className="rounded-lg px-4 py-2 text-sm">취소</button><button disabled={working === 'add' || working === 'google'} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{working === 'add' || working === 'google' ? '연결 중…' : form.provider === 'GOOGLE' ? 'Google 계정으로 연결' : '연결'}</button></div>
    </form></div>}
  </div>
}

function contactEditForm(contact) {
  return {
    displayName: contact.display_name || '', givenName: contact.given_name || '', familyName: contact.family_name || '',
    nickname: contact.nickname || '', organization: contact.organization || '', department: contact.department || '',
    jobTitle: contact.job_title || '', note: contact.note || '', primaryEmail: contact.emails?.[0]?.value || '',
    primaryPhone: contact.phones?.[0]?.value || '',
  }
}

function ContactDetail({ contact, onUpdated }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [editForm, setEditForm] = useState(() => contactEditForm(contact))
  const providerLabel = contact.provider === 'APPLE' ? 'iCloud' : 'Google'

  async function save(event) {
    event.preventDefault(); setSaving(true); setEditError('')
    try {
      const updated = await apiFetch(`/contactbook/contacts/${contact.id}`, {
        method: 'PATCH', body: JSON.stringify({ ...editForm, etag: contact.etag }),
      })
      setEditForm(contactEditForm(updated)); await onUpdated(updated); setEditing(false)
    } catch (error) {
      if (error.current) { setEditForm(contactEditForm(error.current)); await onUpdated(error.current) }
      setEditError(error.message)
    } finally { setSaving(false) }
  }

  if (editing) return <form onSubmit={save} className="mx-auto max-w-xl rounded-xl border border-indigo-200 bg-white p-6 shadow-sm">
    <div className="mb-5 flex items-center justify-between"><div><h2 className="text-xl font-bold">{providerLabel} 연락처 편집</h2><p className="mt-1 text-xs text-slate-500">저장하면 {providerLabel} 주소록과 EasyStation에 함께 반영됩니다.</p></div><button type="button" onClick={() => { setEditing(false); setEditForm(contactEditForm(contact)); setEditError('') }} className="text-sm text-slate-500">취소</button></div>
    {editError && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{editError}</div>}
    <div className="grid grid-cols-2 gap-4">
      <EditField label="표시 이름" required value={editForm.displayName} onChange={value => setEditForm({ ...editForm, displayName: value })} wide />
      <EditField label="성" value={editForm.familyName} onChange={value => setEditForm({ ...editForm, familyName: value })} />
      <EditField label="이름" value={editForm.givenName} onChange={value => setEditForm({ ...editForm, givenName: value })} />
      <EditField label="별칭" value={editForm.nickname} onChange={value => setEditForm({ ...editForm, nickname: value })} />
      <EditField label="전화번호" value={editForm.primaryPhone} onChange={value => setEditForm({ ...editForm, primaryPhone: value })} />
      <EditField label="이메일" type="email" value={editForm.primaryEmail} onChange={value => setEditForm({ ...editForm, primaryEmail: value })} wide />
      <EditField label="회사" value={editForm.organization} onChange={value => setEditForm({ ...editForm, organization: value })} />
      <EditField label="부서" value={editForm.department} onChange={value => setEditForm({ ...editForm, department: value })} />
      <EditField label="직책" value={editForm.jobTitle} onChange={value => setEditForm({ ...editForm, jobTitle: value })} wide />
      <label className="col-span-2 text-sm">메모<textarea value={editForm.note} onChange={event => setEditForm({ ...editForm, note: event.target.value })} rows={5} className="mt-1 w-full rounded-lg border border-slate-300 p-2 outline-none focus:ring-2 focus:ring-indigo-400" /></label>
    </div>
    <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={() => setEditing(false)} className="rounded-lg px-4 py-2 text-sm">취소</button><button disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? `${providerLabel}에 저장 중…` : `${providerLabel} 주소록에 저장`}</button></div>
  </form>

  const rows = [
    ['이메일', contact.emails], ['전화번호', contact.phones], ['주소', contact.addresses], ['웹사이트', contact.urls],
  ]
  return <div className="mx-auto max-w-xl"><div className="mb-8 flex items-center gap-5"><div className="flex h-20 w-20 items-center justify-center rounded-full bg-indigo-100 text-3xl font-bold text-indigo-700">{(contact.display_name || '?').slice(0, 1)}</div><div className="min-w-0 flex-1"><h2 className="text-2xl font-bold">{contact.display_name || '(이름 없음)'}</h2><p className="text-slate-500">{[contact.organization, contact.department, contact.job_title].filter(Boolean).join(' · ')}</p></div>{contact.editable && <button onClick={() => setEditing(true)} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">편집</button>}</div>
    <div className="rounded-xl border border-slate-200 bg-white p-5">{rows.map(([label, values]) => Array.isArray(values) && values.length > 0 && <div key={label} className="mb-4"><div className="mb-1 text-xs font-bold text-slate-400">{label}</div>{values.map((item, i) => <div key={`${item.value}-${i}`} className="text-sm">{item.value} {item.type && <span className="ml-1 text-xs text-slate-400">{item.type}</span>}</div>)}</div>)}
      {contact.birthday && <p className="mb-3 text-sm"><span className="mr-3 text-xs font-bold text-slate-400">생일</span>{contact.birthday}</p>}{contact.note && <div><div className="mb-1 text-xs font-bold text-slate-400">메모</div><p className="whitespace-pre-wrap text-sm">{contact.note}</p></div>}
      <div className="mt-5 border-t pt-3 text-xs text-slate-400">출처: {contact.account_name} / {contact.addressbook_name}</div></div></div>
}

function EditField({ label, value, onChange, required = false, type = 'text', wide = false }) {
  return <label className={`${wide ? 'col-span-2' : ''} text-sm`}>{label}<input type={type} required={required} value={value} onChange={event => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-2 outline-none focus:ring-2 focus:ring-indigo-400" /></label>
}
