import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'

const emptyForm = { provider: 'APPLE', displayName: '', username: '', secret: '', discoveryUrl: '', authType: 'BASIC' }

export default function ContactBookPage({ onBackToMain }) {
  const [contacts, setContacts] = useState([])
  const [accounts, setAccounts] = useState([])
  const [selected, setSelected] = useState(null)
  const [query, setQuery] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [showAccountForm, setShowAccountForm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')

  const loadAccounts = useCallback(async () => setAccounts(await apiFetch('/contactbook/accounts')), [])
  const loadContacts = useCallback(async (q = '') => {
    const data = await apiFetch(`/contactbook/contacts?q=${encodeURIComponent(q)}&limit=100`)
    setContacts(data.contacts || [])
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => {
      Promise.all([loadAccounts(), loadContacts()]).catch(e => setError(e.message)).finally(() => setLoading(false))
    }, 0)
    return () => clearTimeout(timer)
  }, [loadAccounts, loadContacts])
  useEffect(() => {
    const timer = setTimeout(() => loadContacts(query).catch(e => setError(e.message)), 250)
    return () => clearTimeout(timer)
  }, [query, loadContacts])

  async function addAccount(event) {
    event.preventDefault(); setError(''); setWorking('add')
    try {
      await apiFetch('/contactbook/accounts', { method: 'POST', body: JSON.stringify(form) })
      setForm(emptyForm); setShowAccountForm(false); await loadAccounts()
    } catch (e) { setError(e.message) } finally { setWorking('') }
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

  return <div className="flex flex-1 min-w-0 bg-slate-50 text-slate-900">
    <aside className="w-64 flex-shrink-0 border-r border-slate-200 bg-white p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-5"><h1 className="text-lg font-bold">ContactBook</h1><button onClick={onBackToMain} className="text-xs text-indigo-600">메인으로</button></div>
      <button onClick={() => { setSelected(null); setQuery('') }} className="w-full rounded-lg bg-indigo-50 px-3 py-2 text-left text-sm font-semibold text-indigo-700">모든 연락처 <span className="float-right">{contacts.length}</span></button>
      <div className="mt-6 mb-2 flex items-center justify-between"><span className="text-xs font-bold uppercase tracking-wide text-slate-400">연결 계정</span><button onClick={() => setShowAccountForm(true)} className="text-xl leading-none text-indigo-600" title="계정 추가">+</button></div>
      {accounts.length === 0 && <p className="text-xs text-slate-400 py-3">연결된 주소록이 없습니다.</p>}
      {accounts.map(account => <div key={account.id} className="mb-2 rounded-lg border border-slate-200 p-2.5">
        <div className="flex items-center gap-2"><span>{account.provider === 'APPLE' ? '●' : account.provider === 'GOOGLE' ? 'G' : '◇'}</span><span className="min-w-0 flex-1 truncate text-sm font-medium">{account.display_name}</span></div>
        <div className={`mt-1 text-[11px] ${account.status === 'CONNECTED' ? 'text-emerald-600' : 'text-rose-600'}`}>{account.status === 'CONNECTED' ? '연결됨' : '동기화 오류'} · 주소록 {account.addressbook_count}</div>
        <div className="mt-2 flex gap-2"><button disabled={working === account.id} onClick={() => sync(account)} className="text-xs text-indigo-600 disabled:opacity-40">{working === account.id ? '동기화 중…' : '지금 동기화'}</button><button disabled={working === account.id} onClick={() => remove(account)} className="text-xs text-rose-500">삭제</button></div>
      </div>)}
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-slate-200 bg-white p-4"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="이름, 이메일, 전화번호, 회사 검색" className="w-full max-w-xl rounded-xl border border-slate-300 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-400" /></div>
      {error && <div className="m-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}<button onClick={() => setError('')} className="float-right">×</button></div>}
      <div className="flex min-h-0 flex-1">
        <section className="w-[42%] min-w-[300px] overflow-y-auto border-r border-slate-200 bg-white">
          {loading ? <p className="p-6 text-sm text-slate-400">불러오는 중…</p> : contacts.length === 0 ? <div className="p-10 text-center text-sm text-slate-400">연락처가 없습니다.<br/>왼쪽 + 버튼으로 CardDAV 계정을 연결하세요.</div> : contacts.map(contact => <button key={contact.id} onClick={() => setSelected(contact)} className={`flex w-full items-center gap-3 border-b border-slate-100 p-4 text-left hover:bg-slate-50 ${selected?.id === contact.id ? 'bg-indigo-50' : ''}`}>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 font-bold text-indigo-700">{(contact.display_name || '?').slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0"><div className="truncate font-semibold">{contact.display_name || '(이름 없음)'}</div><div className="truncate text-xs text-slate-500">{contact.emails?.[0]?.value || contact.phones?.[0]?.value || contact.organization || ''}</div><div className="mt-1 text-[10px] text-slate-400">{contact.account_name} · {contact.addressbook_name}</div></div>
          </button>)}
        </section>
        <section className="flex-1 overflow-y-auto p-8">{selected ? <ContactDetail contact={selected} /> : <div className="flex h-full items-center justify-center text-sm text-slate-400">연락처를 선택하세요.</div>}</section>
      </div>
    </main>
    {showAccountForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"><form onSubmit={addAccount} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
      <h2 className="mb-5 text-lg font-bold">CardDAV 계정 연결</h2>
      <label className="mb-3 block text-sm">공급자<select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} className="mt-1 w-full rounded-lg border p-2"><option value="APPLE">Apple iCloud</option><option value="GENERIC_CARDDAV">기타 CardDAV</option><option value="GOOGLE">Google (OAuth access token)</option></select></label>
      <label className="mb-3 block text-sm">표시 이름<input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} className="mt-1 w-full rounded-lg border p-2" placeholder="개인 iCloud" /></label>
      <label className="mb-3 block text-sm">계정<input required value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} className="mt-1 w-full rounded-lg border p-2" placeholder="name@example.com" /></label>
      {form.provider === 'GENERIC_CARDDAV' && <label className="mb-3 block text-sm">서버 주소<input required type="url" value={form.discoveryUrl} onChange={e => setForm({ ...form, discoveryUrl: e.target.value })} className="mt-1 w-full rounded-lg border p-2" placeholder="https://dav.example.com/.well-known/carddav" /></label>}
      <label className="mb-2 block text-sm">{form.provider === 'APPLE' ? '앱 전용 암호' : form.provider === 'GOOGLE' ? 'OAuth access token' : '암호 또는 앱 전용 암호'}<input required type="password" value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} className="mt-1 w-full rounded-lg border p-2" autoComplete="new-password" /></label>
      <p className="mb-5 text-xs text-slate-500">인증 정보는 암호화하여 저장하며 다시 화면에 표시하지 않습니다.</p>
      <div className="flex justify-end gap-2"><button type="button" onClick={() => setShowAccountForm(false)} className="rounded-lg px-4 py-2 text-sm">취소</button><button disabled={working === 'add'} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{working === 'add' ? '연결 확인 중…' : '연결'}</button></div>
    </form></div>}
  </div>
}

function ContactDetail({ contact }) {
  const rows = [
    ['이메일', contact.emails], ['전화번호', contact.phones], ['주소', contact.addresses], ['웹사이트', contact.urls],
  ]
  return <div className="mx-auto max-w-xl"><div className="mb-8 flex items-center gap-5"><div className="flex h-20 w-20 items-center justify-center rounded-full bg-indigo-100 text-3xl font-bold text-indigo-700">{(contact.display_name || '?').slice(0, 1)}</div><div><h2 className="text-2xl font-bold">{contact.display_name || '(이름 없음)'}</h2><p className="text-slate-500">{[contact.organization, contact.department, contact.job_title].filter(Boolean).join(' · ')}</p></div></div>
    <div className="rounded-xl border border-slate-200 bg-white p-5">{rows.map(([label, values]) => Array.isArray(values) && values.length > 0 && <div key={label} className="mb-4"><div className="mb-1 text-xs font-bold text-slate-400">{label}</div>{values.map((item, i) => <div key={`${item.value}-${i}`} className="text-sm">{item.value} {item.type && <span className="ml-1 text-xs text-slate-400">{item.type}</span>}</div>)}</div>)}
      {contact.birthday && <p className="mb-3 text-sm"><span className="mr-3 text-xs font-bold text-slate-400">생일</span>{contact.birthday}</p>}{contact.note && <div><div className="mb-1 text-xs font-bold text-slate-400">메모</div><p className="whitespace-pre-wrap text-sm">{contact.note}</p></div>}
      <div className="mt-5 border-t pt-3 text-xs text-slate-400">출처: {contact.account_name} / {contact.addressbook_name}</div></div></div>
}
