import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'
import ConfirmDialog from '../../components/ConfirmDialog'

const emptyForm = { provider: 'APPLE', displayName: '', username: '', secret: '', discoveryUrl: '', authType: 'BASIC' }

function googleOAuthResult() {
  const params = new URL(window.location.href).searchParams
  return { status: params.get('contactbook_oauth') || '', error: params.get('contactbook_error') || '', accountId: params.get('contactbook_account') || '' }
}

function googleOAuthErrorMessage(code) {
  const messages = {
    access_denied: 'Google 연락처 권한 승인이 취소되었습니다. 연결하려면 권한을 승인해 주세요.',
    scope_missing: 'Google 연락처 접근 권한이 승인되지 않았습니다. 다시 연결해 권한을 승인해 주세요.',
    permission_denied: '이 Google 계정에서는 연락처 접근이 허용되지 않습니다. Workspace 조직 정책도 확인해 주세요.',
    authorization_expired: 'Google 인증 요청이 만료되었습니다. 다시 연결해 주세요.',
    invalid_state: 'Google 연결 요청이 만료되었거나 이미 사용되었습니다. 다시 연결해 주세요.',
  }
  return messages[code] || 'Google 계정 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.'
}

export default function ContactBookPage({ onBackToMain }) {
  const [oauthResult] = useState(googleOAuthResult)
  const automaticSyncStarted = useRef(false)
  const [contacts, setContacts] = useState([])
  const [totalContacts, setTotalContacts] = useState(0)
  const [allContactsTotal, setAllContactsTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [groups, setGroups] = useState([])
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [expandedGroupAccounts, setExpandedGroupAccounts] = useState(() => new Set())
  const [selected, setSelected] = useState(null)
  const [query, setQuery] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [showAccountForm, setShowAccountForm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [working, setWorking] = useState('')
  const contactLoadGeneration = useRef(0)
  const [error, setError] = useState(() => oauthResult.status === 'error' ? googleOAuthErrorMessage(oauthResult.error) : '')
  const [notice, setNotice] = useState(() => oauthResult.status === 'connected' ? 'Google 계정이 연결되었습니다. 연락처를 자동으로 동기화합니다.' : '')

  const loadAccounts = useCallback(async () => {
    const loaded = await apiFetch('/contactbook/accounts')
    setAccounts(loaded)
    return loaded
  }, [])
  const loadGroups = useCallback(async () => {
    const loaded = await apiFetch('/contactbook/groups')
    setGroups(loaded)
    return loaded
  }, [])
  const loadContacts = useCallback(async (q = '', options = {}) => {
    const generation = ++contactLoadGeneration.current
    const groupParam = selectedGroupId ? `&groupId=${encodeURIComponent(selectedGroupId)}` : ''
    const requestPage = offset => apiFetch(`/contactbook/contacts?q=${encodeURIComponent(q)}${groupParam}&limit=100&offset=${offset}`, options)
    try {
      const first = await requestPage(0)
      if (generation !== contactLoadGeneration.current) return
      let loaded = first.contacts || []
      const total = Number(first.total) || 0
      let more = Boolean(first.hasMore)
      setContacts(loaded)
      setTotalContacts(total)
      if (!selectedGroupId) setAllContactsTotal(total)
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
  }, [selectedGroupId])
  useEffect(() => {
    const timer = setTimeout(() => {
      loadAccounts().then(async loaded => {
        const accountId = oauthResult.status === 'connected' ? oauthResult.accountId : ''
        if (!accountId || automaticSyncStarted.current) return
        automaticSyncStarted.current = true
        const account = loaded.find(item => item.id === accountId && item.provider === 'GOOGLE')
        if (!account) throw new Error('연결된 Google 계정을 찾지 못했습니다. 계정 목록을 새로고침해 주세요.')
        setWorking(account.id)
        await apiFetch(`/contactbook/accounts/${account.id}/sync`, { method: 'POST' })
        await Promise.all([loadAccounts(), loadGroups(), loadContacts('')])
        setNotice('Google 계정 연결과 최초 연락처 동기화가 완료되었습니다.')
      }).catch(e => setError(e.message)).finally(() => setWorking(''))
    }, 0)
    return () => clearTimeout(timer)
  }, [loadAccounts, loadContacts, loadGroups, oauthResult])
  useEffect(() => {
    const timer = setTimeout(() => loadGroups().catch(e => setError(e.message)), 0)
    return () => clearTimeout(timer)
  }, [loadGroups])
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
      url.searchParams.delete('contactbook_account')
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
    try { await apiFetch(`/contactbook/accounts/${account.id}/sync`, { method: 'POST' }); await Promise.all([loadAccounts(), loadGroups(), loadContacts(query)]) }
    catch (e) { setError(e.message) } finally { setWorking('') }
  }
  async function remove(account) {
    if (!window.confirm(`“${account.display_name}” 연결과 가져온 연락처를 삭제할까요?`)) return
    setWorking(account.id)
    try { await apiFetch(`/contactbook/accounts/${account.id}`, { method: 'DELETE' }); setSelected(null); setSelectedGroupId(''); await Promise.all([loadAccounts(), loadGroups(), loadContacts(query)]) }
    catch (e) { setError(e.message) } finally { setWorking('') }
  }
  async function contactUpdated(contact) {
    setSelected(contact)
    await loadContacts(query)
  }
  async function contactDeleted() {
    setSelected(null)
    await loadContacts(query)
  }
  function showAllContacts() {
    setSelected(null)
    setSelectedGroupId('')
    setQuery('')
  }
  function toggleAccountGroups(accountId) {
    setExpandedGroupAccounts(current => {
      const next = new Set(current)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      return next
    })
  }

  return <div className="flex flex-1 min-w-0 bg-slate-50 text-slate-900">
    <aside className="w-64 flex-shrink-0 border-r border-slate-200 bg-white p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-5"><h1 className="text-lg font-bold">ContactBook</h1><button onClick={onBackToMain} className="text-xs text-indigo-600">메인으로</button></div>
      <button onClick={showAllContacts} className={`w-full rounded-lg px-3 py-2 text-left text-sm font-semibold ${!selectedGroupId ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'}`}>전체 보기 <span className="float-right">{allContactsTotal}</span></button>
      <div className="mt-6 mb-2 flex items-center justify-between"><span className="text-xs font-bold uppercase tracking-wide text-slate-400">연결 계정</span><button onClick={() => setShowAccountForm(true)} className="text-xl leading-none text-indigo-600" title="계정 추가">+</button></div>
      {accounts.length === 0 && <p className="text-xs text-slate-400 py-3">연결된 주소록이 없습니다.</p>}
      {accounts.map(account => { const accountGroups = groups.filter(group => group.account_id === account.id); const groupsExpanded = expandedGroupAccounts.has(account.id); const supportsGroups = account.provider === 'APPLE' || account.provider === 'GOOGLE'; return <div key={account.id} className="mb-2 rounded-lg border border-slate-200 p-2.5">
        <div className="flex items-center gap-2"><span>{account.provider === 'APPLE' ? '●' : account.provider === 'GOOGLE' ? 'G' : '◇'}</span><span className="min-w-0 flex-1 truncate text-sm font-medium">{account.display_name}</span></div>
        <div className={`mt-1 text-[11px] ${account.status === 'CONNECTED' ? 'text-emerald-600' : 'text-rose-600'}`}>{account.status === 'CONNECTED' ? '연결됨' : account.status === 'AUTH_REQUIRED' ? '인증 필요' : '동기화 오류'} · 주소록 {account.addressbook_count}</div>
        <div className="mt-2 flex gap-2">{account.provider === 'GOOGLE' && account.status === 'AUTH_REQUIRED' && <button disabled={working === account.id} onClick={() => connectGoogle(account.id)} className="text-xs text-amber-600 disabled:opacity-40">재인증</button>}<button disabled={working === account.id || account.status === 'AUTH_REQUIRED'} onClick={() => sync(account)} className="text-xs text-indigo-600 disabled:opacity-40">{working === account.id ? '동기화 중…' : '지금 동기화'}</button><button disabled={working === account.id} onClick={() => remove(account)} className="text-xs text-rose-500">삭제</button></div>
        {supportsGroups && <div className="mt-3 border-t border-slate-100 pt-2">
          <button type="button" onClick={showAllContacts} className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs font-semibold ${!selectedGroupId ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'}`}><span>전체 보기</span><span className="text-[10px] text-slate-400">{allContactsTotal}</span></button>
          <button type="button" aria-expanded={groupsExpanded} onClick={() => toggleAccountGroups(account.id)} className="mt-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"><span>{groupsExpanded ? '그룹 접기' : '그룹 펼치기'}</span><span className="text-[10px] text-slate-400">{accountGroups.length}</span></button>
          {groupsExpanded && (accountGroups.length > 0
            ? <GroupTree groups={accountGroups} selectedGroupId={selectedGroupId} onSelect={groupId => { setSelected(null); setSelectedGroupId(groupId); setQuery('') }} />
            : <p className="mt-2 rounded-md bg-slate-50 px-2 py-2 text-center text-[11px] text-slate-400">동기화된 그룹이 없습니다.</p>)}
        </div>}
      </div>})}
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-slate-200 bg-white p-4"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="이름, 이메일, 전화번호, 회사 검색" className="w-full max-w-xl rounded-xl border border-slate-300 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-400" /></div>
      {error && <div className="m-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}<button onClick={() => setError('')} className="float-right">×</button></div>}
      {notice && <div className="m-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}<button onClick={() => setNotice('')} className="float-right">×</button></div>}
      <div className="flex min-h-0 flex-1">
        <section className="w-[42%] min-w-[300px] overflow-y-auto border-r border-slate-200 bg-white">
          {loading ? <p className="p-6 text-sm text-slate-400">불러오는 중…</p> : contacts.length === 0 ? <div className="p-10 text-center text-sm text-slate-400">연락처가 없습니다.<br/>왼쪽 + 버튼으로 CardDAV 계정을 연결하세요.</div> : contacts.map(contact => <button key={contact.id} onClick={() => setSelected(contact)} className={`flex w-full items-center gap-3 border-b border-slate-100 p-4 text-left hover:bg-slate-50 ${selected?.id === contact.id ? 'bg-indigo-50' : ''}`}>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-indigo-100 font-bold text-indigo-700">{contact.primary_photo_url ? <img src={contact.primary_photo_url} alt="" className="h-full w-full object-cover" /> : (contact.display_name || '?').slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0"><div className="truncate font-semibold">{contact.display_name || '(이름 없음)'}</div><div className="truncate text-xs text-slate-500">{contact.emails?.[0]?.value || contact.phones?.[0]?.value || contact.organization || ''}</div><div className="mt-1 text-[10px] text-slate-400">{contact.account_name} · {contact.addressbook_name}</div></div>
          </button>)}
          {hasMore && <div className="w-full border-b border-slate-200 px-4 py-3 text-center text-sm font-semibold text-indigo-600">{loadingMore ? `백그라운드로 불러오는 중 (${contacts.length}/${totalContacts})` : `불러오기 대기 중 (${contacts.length}/${totalContacts})`}</div>}
        </section>
        <section className="flex-1 overflow-y-auto p-8">{selected ? <ContactDetail key={selected.id} contact={selected} onUpdated={contactUpdated} onDeleted={contactDeleted} /> : <div className="flex h-full items-center justify-center text-sm text-slate-400">연락처를 선택하세요.</div>}</section>
      </div>
    </main>
    {showAccountForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"><form onSubmit={form.provider === 'GOOGLE' ? e => { e.preventDefault(); connectGoogle() } : addAccount} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
      <h2 className="mb-5 text-lg font-bold">CardDAV 계정 연결</h2>
      <label className="mb-3 block text-sm">공급자<select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} className="mt-1 w-full rounded-lg border p-2"><option value="APPLE">Apple iCloud</option><option value="GENERIC_CARDDAV">기타 CardDAV</option><option value="GOOGLE">Google Contacts</option></select></label>
      {form.provider === 'GOOGLE' ? <div className="mb-5 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-slate-600">자신의 Google 계정으로 로그인하고 연락처 접근 권한을 승인하면 자동으로 연결·동기화됩니다. 운영 OAuth 앱 게시가 완료되면 EasyStation 관리자에게 Google 이메일을 별도로 등록할 필요가 없습니다. Workspace 계정은 조직 정책에 따라 관리자 승인이 필요할 수 있습니다.</div> : <>
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

function GroupTree({ groups, selectedGroupId, onSelect }) {
  if (!groups.length) return null
  const byId = new Map(groups.map(group => [group.id, group]))
  const children = new Map()
  for (const group of groups) {
    const parents = (group.parent_group_ids || []).filter(id => byId.has(id) && id !== group.id)
    for (const parentId of parents) children.set(parentId, [...(children.get(parentId) || []), group])
  }
  let roots = groups.filter(group => !(group.parent_group_ids || []).some(id => byId.has(id) && id !== group.id))
  if (!roots.length) roots = groups
  const visited = new Set()
  const render = (group, depth = 0) => {
    if (visited.has(group.id)) return null
    visited.add(group.id)
    return <div key={group.id}><button type="button" onClick={() => onSelect(group.id)} style={{ paddingLeft: `${8 + depth * 12}px` }} className={`mt-1 flex w-full items-center rounded-md py-1.5 pr-2 text-left text-xs ${selectedGroupId === group.id ? 'bg-indigo-100 font-bold text-indigo-700' : 'text-slate-600 hover:bg-slate-50'}`}><span className="mr-1.5">{depth ? '└' : '▸'}</span><span className="min-w-0 flex-1 truncate">{group.display_name}</span><span className="ml-2 text-[10px] text-slate-400">{group.member_count}</span></button>{(children.get(group.id) || []).map(child => render(child, depth + 1))}</div>
  }
  return <div className="mt-2 border-t border-slate-100 pt-1">{roots.map(group => render(group))}{groups.filter(group => !visited.has(group.id)).map(group => render(group))}</div>
}

function contactEditForm(contact) {
  return {
    displayName: contact.display_name || '', givenName: contact.given_name || '', familyName: contact.family_name || '',
    nickname: contact.nickname || '', organization: contact.organization || '', department: contact.department || '',
    jobTitle: contact.job_title || '', note: contact.note || '', primaryEmail: contact.emails?.[0]?.value || '',
    primaryPhone: contact.phones?.[0]?.value || '',
  }
}

function ContactDetail({ contact, onUpdated, onDeleted }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
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

  async function removeContact() {
    setDeleting(true); setEditError('')
    try {
      await apiFetch(`/contactbook/contacts/${contact.id}`, { method: 'DELETE', body: JSON.stringify({ etag: contact.etag }) })
      setShowDeleteDialog(false)
      await onDeleted(contact)
    } catch (error) { setEditError(error.message) } finally { setDeleting(false) }
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
  const provider = contact.provider === 'APPLE' ? 'iCloud' : 'Google'
  return <div className="mx-auto max-w-xl">{editError && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{editError}</div>}<div className="mb-8 flex items-center gap-5"><div className="flex h-20 w-20 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-indigo-100 text-3xl font-bold text-indigo-700">{contact.primary_photo_url ? <img src={contact.primary_photo_url} alt="" className="h-full w-full object-cover" /> : (contact.display_name || '?').slice(0, 1)}</div><div className="min-w-0 flex-1"><h2 className="text-2xl font-bold">{contact.display_name || '(이름 없음)'}</h2><p className="text-slate-500">{[contact.organization, contact.department, contact.job_title].filter(Boolean).join(' · ')}</p></div>{contact.editable && <div className="flex gap-2"><button disabled={deleting} onClick={() => setEditing(true)} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">편집</button><button disabled={deleting} onClick={() => { setEditError(''); setShowDeleteDialog(true) }} className="rounded-lg border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">삭제</button></div>}</div>
    <div className="rounded-xl border border-slate-200 bg-white p-5">{rows.map(([label, values]) => Array.isArray(values) && values.length > 0 && <div key={label} className="mb-4"><div className="mb-1 text-xs font-bold text-slate-400">{label}</div>{values.map((item, i) => <div key={`${item.value}-${i}`} className="text-sm">{item.value} {item.type && <span className="ml-1 text-xs text-slate-400">{item.type}</span>}</div>)}</div>)}
      {contact.birthday && <p className="mb-3 text-sm"><span className="mr-3 text-xs font-bold text-slate-400">생일</span>{contact.birthday}</p>}{contact.note && <div><div className="mb-1 text-xs font-bold text-slate-400">메모</div><p className="whitespace-pre-wrap text-sm">{contact.note}</p></div>}
      <div className="mt-5 border-t pt-3 text-xs text-slate-400">출처: {contact.account_name} / {contact.addressbook_name}</div></div>
    <PhotoGallery contact={contact} onChanged={onUpdated} />
    {showDeleteDialog && <ConfirmDialog
      title="연락처 삭제"
      message={`이 연락처를 ${provider} 주소록에서도 삭제합니다.\n삭제한 연락처는 복구하기 어려울 수 있습니다.`}
      detailItems={[
        contact.display_name || '(이름 없음)',
        `${contact.account_name || provider} / ${contact.addressbook_name || 'Address Book'}`,
      ]}
      confirmText="삭제"
      cancelText="취소"
      danger
      loading={deleting}
      onConfirm={removeContact}
      onCancel={() => { if (!deleting) setShowDeleteDialog(false) }}
    />}
  </div>
}

function PhotoGallery({ contact, onChanged }) {
  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef(null)

  const load = useCallback(async () => {
    const data = await apiFetch(`/contactbook/contacts/${contact.id}/photos`)
    setPhotos(data.photos || [])
  }, [contact.id])

  useEffect(() => {
    let active = true
    apiFetch(`/contactbook/contacts/${contact.id}/photos`).then(data => {
      if (active) setPhotos(data.photos || [])
    }).catch(e => {
      if (active) setError(e.message)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [contact.id])

  async function upload(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setWorking('upload'); setError('')
    try {
      const form = new FormData(); form.append('photo', file)
      const response = await fetch(`/api/contactbook/contacts/${contact.id}/photos`, { method: 'POST', body: form, credentials: 'include' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `사진 업로드 실패 (${response.status})`)
      await load()
    } catch (e) { setError(e.message) } finally { setWorking('') }
  }

  async function makePrimary(photo) {
    setWorking(photo.id); setError('')
    try { await apiFetch(`/contactbook/photos/${photo.id}/primary`, { method: 'PATCH', body: '{}' }); await load(); await onChanged({ ...contact, primary_photo_url: photo.url, primary_photo_id: photo.id }) }
    catch (e) { setError(e.message) } finally { setWorking('') }
  }

  async function remove(photo) {
    if (!window.confirm('이 사진을 삭제할까요?')) return
    setWorking(photo.id); setError('')
    try { await apiFetch(`/contactbook/photos/${photo.id}`, { method: 'DELETE' }); await load(); await onChanged({ ...contact, primary_photo_url: photo.is_primary ? null : contact.primary_photo_url, primary_photo_id: photo.is_primary ? null : contact.primary_photo_id }) }
    catch (e) { setError(e.message) } finally { setWorking('') }
  }

  return <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
    <div className="mb-4 flex items-center justify-between"><div><h3 className="font-bold">사진</h3><p className="text-xs text-slate-500">같은 전화번호 또는 이메일로 연결된 iCloud·Google 연락처가 함께 사용합니다.</p></div><><input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={upload} className="hidden" /><button disabled={working === 'upload'} onClick={() => fileRef.current?.click()} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{working === 'upload' ? '업로드 중…' : '사진 추가'}</button></></div>
    {error && <div className="mb-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
    {loading ? <p className="text-sm text-slate-400">사진을 불러오는 중…</p> : photos.length === 0 ? <p className="rounded-lg bg-slate-50 p-5 text-center text-sm text-slate-400">등록된 사진이 없습니다.</p> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{photos.map(photo => <div key={photo.id} className={`overflow-hidden rounded-xl border ${photo.is_primary ? 'border-indigo-500 ring-2 ring-indigo-100' : 'border-slate-200'}`}><div className="aspect-square bg-slate-100"><img src={photo.url} alt="연락처 사진" className="h-full w-full object-cover" /></div><div className="flex items-center justify-between gap-1 p-2"><button disabled={working === photo.id || photo.is_primary} onClick={() => makePrimary(photo)} className="text-xs font-semibold text-indigo-600 disabled:text-slate-400">{photo.is_primary ? '대표 사진' : '대표 지정'}</button><button disabled={working === photo.id} onClick={() => remove(photo)} className="text-xs text-rose-500 disabled:opacity-40">삭제</button></div></div>)}</div>}
  </div>
}

function EditField({ label, value, onChange, required = false, type = 'text', wide = false }) {
  return <label className={`${wide ? 'col-span-2' : ''} text-sm`}>{label}<input type={type} required={required} value={value} onChange={event => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-2 outline-none focus:ring-2 focus:ring-indigo-400" /></label>
}
