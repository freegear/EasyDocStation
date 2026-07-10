import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import { MenuIcon } from './mailIcons'
import { ProviderLogo } from './MailProviderLogo'
import { getAccountLabel } from './mailAccountUtils'
import { getMailFolderLabel, isMailTrashFolder } from './mailFolderUtils'

const DEFAULT_MAILCLAW_TRASH_RULE_NAME = 'MailClaw 휴지통 이동'

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

// Gmail/iCloud는 OAuth 대신 기존 IMAP+앱비밀번호 경로(네이버와 동일)로 연결한다.
// provider는 백엔드 동기화 라우팅상 절대 'gmail'을 쓰면 안 됨(=OAuth로 잘못 라우팅).
// Gmail은 'other', iCloud는 'apple'(이미 IMAP provider로 허용됨)로 저장한다.
const GMAIL_IMAP_DEFAULTS = {
  provider: 'other',
  email_address: '',
  display_name: '',
  username: '',
  password: '',
  imap_host: 'imap.gmail.com',
  imap_port: '993',
  imap_security: 'ssl',
  smtp_host: 'smtp.gmail.com',
  smtp_port: '465',
  smtp_security: 'ssl',
}

const ICLOUD_MAIL_DEFAULTS = {
  provider: 'apple',
  email_address: '',
  display_name: '',
  username: '',
  password: '',
  imap_host: 'imap.mail.me.com',
  imap_port: '993',
  imap_security: 'ssl',
  smtp_host: 'smtp.mail.me.com',
  smtp_port: '587',
  smtp_security: 'starttls',
}

const OTHER_MAIL_DEFAULTS = {
  provider: 'imap',
  email_address: '',
  display_name: '',
  username: '',
  password: '',
  imap_host: '',
  imap_port: '993',
  imap_security: 'ssl',
  smtp_host: '',
  smtp_port: '587',
  smtp_security: 'starttls',
}

const MAIL_PRESETS = {
  naver: NAVER_MAIL_DEFAULTS,
  gmail: GMAIL_IMAP_DEFAULTS,
  apple: ICLOUD_MAIL_DEFAULTS,
  other: OTHER_MAIL_DEFAULTS,
}

const MAIL_PRESET_META = {
  naver: {
    title: '네이버 메일 클라이언트 설정',
    emailPlaceholder: 'name@naver.com',
    appPwLabel: '',
    appPwUrl: '',
    help: '네이버 메일 환경설정에서 IMAP/SMTP 사용을 켜고 앱 비밀번호를 입력하세요.',
  },
  gmail: {
    title: 'Gmail IMAP/SMTP 설정',
    emailPlaceholder: 'name@gmail.com',
    appPwLabel: 'Google 앱 비밀번호 발급',
    appPwUrl: 'https://myaccount.google.com/apppasswords',
    help: '2단계 인증을 켠 뒤 16자리 앱 비밀번호를 발급해 입력하세요. (계정 로그인 비밀번호가 아닙니다)',
  },
  apple: {
    title: 'iCloud 메일 설정',
    emailPlaceholder: 'name@icloud.com',
    appPwLabel: 'Apple 앱 암호 발급',
    appPwUrl: 'https://account.apple.com',
    help: 'account.apple.com → 로그인 및 보안 → 앱 암호에서 발급해 입력하세요.',
  },
  other: {
    title: 'IMAP/SMTP 직접 설정',
    emailPlaceholder: 'name@example.com',
    appPwLabel: '',
    appPwUrl: '',
    help: '메일 제공자의 IMAP/SMTP 서버 정보와 (필요 시) 앱 비밀번호를 입력하세요.',
  },
}

const IMAP_PROVIDER_KEYS = ['naver', 'apple', 'imap', 'other']

function isImapAccount(account) {
  return IMAP_PROVIDER_KEYS.includes(account?.provider)
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

function SlideToggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-gray-200'}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  )
}

function DetailValue({ label, value }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
      <span className="block text-[11px] font-bold text-gray-400">{label}</span>
      <span className="mt-1 block truncate text-sm font-bold text-gray-800">{value || '-'}</span>
    </div>
  )
}

function formatSecurity(value) {
  if (value === 'ssl') return 'SSL'
  if (value === 'starttls') return 'STARTTLS'
  if (value === 'none') return '없음'
  return value || '-'
}

const EMPTY_MAILCLAW_FORM = {
  name: '',
  enabled: true,
  sender_check_enabled: false,
  sender_conditions_text: '',
  cc_check_enabled: false,
  cc_conditions_text: '',
  keyword_check_enabled: false,
  keyword_conditions_text: '',
  ai_analysis_enabled: true,
  important_mail_enabled: false,
  forward_enabled: false,
  forward_addresses_text: '',
  move_folder_enabled: false,
  target_folder_id: '',
  tag_smart_folder_enabled: false,
  tag_smart_folder_id: '',
  tag_archive_enabled: false,
}

function splitLines(value) {
  return String(value || '')
    .split(/[,\n;]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function joinLines(value) {
  return Array.isArray(value) ? value.join('\n') : ''
}

function mailClawRuleToForm(rule) {
  if (!rule) return { ...EMPTY_MAILCLAW_FORM }
  return {
    name: rule.name || '',
    enabled: rule.enabled !== false,
    sender_check_enabled: !!rule.sender_check_enabled,
    sender_conditions_text: joinLines(rule.sender_conditions),
    cc_check_enabled: !!rule.cc_check_enabled,
    cc_conditions_text: joinLines(rule.cc_conditions),
    keyword_check_enabled: !!rule.keyword_check_enabled,
    keyword_conditions_text: joinLines(rule.keyword_conditions),
    ai_analysis_enabled: !!rule.ai_analysis_enabled,
    important_mail_enabled: !!rule.important_mail_enabled,
    forward_enabled: !!rule.forward_enabled,
    forward_addresses_text: joinLines(rule.forward_addresses),
    move_folder_enabled: !!rule.move_folder_enabled,
    target_folder_id: rule.target_folder_id || '',
    tag_smart_folder_enabled: !!rule.tag_smart_folder_enabled,
    tag_smart_folder_id: rule.tag_smart_folder_id || '',
    tag_archive_enabled: !!rule.tag_archive_enabled,
  }
}

function mailClawFormToPayload(form, tenantId) {
  return {
    tenantId,
    name: String(form.name || '').trim() || 'MailClaw',
    enabled: form.enabled !== false,
    sender_check_enabled: !!form.sender_check_enabled,
    sender_conditions: splitLines(form.sender_conditions_text),
    cc_check_enabled: !!form.cc_check_enabled,
    cc_conditions: splitLines(form.cc_conditions_text),
    keyword_check_enabled: !!form.keyword_check_enabled,
    keyword_conditions: splitLines(form.keyword_conditions_text),
    ai_analysis_enabled: !!form.ai_analysis_enabled,
    important_mail_enabled: !!form.important_mail_enabled,
    forward_enabled: !!form.forward_enabled,
    forward_addresses: splitLines(form.forward_addresses_text),
    move_folder_enabled: !!form.move_folder_enabled,
    target_folder_id: form.target_folder_id || null,
    tag_smart_folder_enabled: !!form.tag_smart_folder_enabled,
    tag_smart_folder_id: form.tag_smart_folder_id || null,
    tag_archive_enabled: !!form.tag_archive_enabled,
  }
}

function MailAccountManageModal({ accounts, tenants = [], activeFolder, activeUnified, currentTenantId, initialMailClawRegistration, onClose, onAccountAdded, onMailDataChanged }) {
  const [view, setView] = useState('main')
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [accountEditMode, setAccountEditMode] = useState(false)
  const [accountEditForm, setAccountEditForm] = useState(null)
  const [accountSaving, setAccountSaving] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [gmailAuthLoading, setGmailAuthLoading] = useState(false)
  const [gmailAuthError, setGmailAuthError] = useState('')
  // naverForm/imapBrand는 네이버 전용이 아니라 공용 IMAP 폼 상태로 재사용한다.
  const [naverForm, setNaverForm] = useState(NAVER_MAIL_DEFAULTS)
  const [imapBrand, setImapBrand] = useState('naver')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [naverSaving, setNaverSaving] = useState(false)
  const [naverError, setNaverError] = useState('')
  const [mailClawTenantId, setMailClawTenantId] = useState(accounts[0]?.tenant_id || tenants[0]?.id || '')
  const [mailClawRules, setMailClawRules] = useState([])
  const [mailClawSmartFolders, setMailClawSmartFolders] = useState([])
  const [mailClawLogs, setMailClawLogs] = useState([])
  const [mailClawSelectedRule, setMailClawSelectedRule] = useState(null)
  const [mailClawForm, setMailClawForm] = useState({ ...EMPTY_MAILCLAW_FORM })
  const [mailClawLoading, setMailClawLoading] = useState(false)
  const [mailClawSaving, setMailClawSaving] = useState(false)
  const [mailClawApplying, setMailClawApplying] = useState(false)
  const [mailClawApplyProgress, setMailClawApplyProgress] = useState(null)
  const [mailClawError, setMailClawError] = useState('')
  // 첨부파일 정책 (MailService.md 10.8) — 편집은 사이트 관리자만.
  const { currentUser } = useAuth()
  const isSiteAdmin = currentUser?.role === 'site_admin'
  const [attachPolicyForm, setAttachPolicyForm] = useState(null)
  const [attachPolicyLoading, setAttachPolicyLoading] = useState(false)
  const [attachPolicySaving, setAttachPolicySaving] = useState(false)
  const [attachPolicyError, setAttachPolicyError] = useState('')
  const [attachPolicyStatus, setAttachPolicyStatus] = useState('')
  const providers = [
    { key: 'gmail', label: 'Gmail 계정 추가', hint: 'IMAP + 앱 비밀번호로 연결합니다.' },
    { key: 'naver', label: '네이버 계정 추가', hint: '네이버 메일 IMAP/SMTP 설정으로 진행합니다.' },
    { key: 'apple', label: 'Apple iCloud 계정 추가', hint: 'iCloud 앱 암호 + IMAP으로 연결합니다.' },
    { key: 'other', label: '기타 계정 추가', hint: 'IMAP/SMTP 서버 정보를 직접 입력합니다.' },
  ]

  function openImapPreset(key) {
    const presetKey = MAIL_PRESETS[key] ? key : 'other'
    setImapBrand(presetKey)
    setNaverForm({ ...MAIL_PRESETS[presetKey] })
    setNaverError('')
    setShowAdvanced(false)
    setView('imap')
  }

  // Gmail/iCloud/네이버는 서버값이 프리셋으로 채워져 있어 기본 화면에서 숨긴다(고급 설정에서만 노출).
  // 기타(other)는 서버를 직접 입력해야 하므로 항상 노출한다.
  const hasPresetServers = imapBrand !== 'other' && Boolean(naverForm.imap_host && naverForm.smtp_host)

  const mailClawActiveTenantId = activeFolder?.account?.tenant_id || currentTenantId || ''
  const mailClawTenantAccounts = accounts
    .filter(account => !mailClawTenantId || account.tenant_id === mailClawTenantId)
  const mailClawTrashFolders = mailClawTenantAccounts
    .flatMap(account => (account.folders || []).filter(isMailTrashFolder))
    .filter(folder => folder.id)
  const mailClawSelectedTrashFolder = mailClawTrashFolders
    .find(folder => folder.id === mailClawForm.target_folder_id)
  const mailClawGenericTrashFolder = mailClawSelectedTrashFolder || mailClawTrashFolders[0] || null
  const mailClawFolders = [
    ...(mailClawGenericTrashFolder ? [{ id: mailClawGenericTrashFolder.id, label: '휴지통' }] : []),
    ...mailClawTenantAccounts.flatMap(account => (account.folders || [])
      .filter(folder => !isMailTrashFolder(folder))
      .map(folder => ({
        id: folder.id,
        label: `${getAccountLabel(account)} / ${getMailFolderLabel(folder)}`,
      }))),
  ]
    .filter(folder => folder.id)
  const mailClawActiveScopeLabel = activeFolder?.folder?.id
    ? `${getAccountLabel(activeFolder.account)} / ${getMailFolderLabel(activeFolder.folder)}`
    : activeUnified?.label || ''
  const hasMailClawActiveScope = Boolean(activeFolder?.folder?.id || activeUnified?.key)

  useEffect(() => {
    if (mailClawTenantId || !accounts[0]?.tenant_id) return undefined
    const timer = window.setTimeout(() => setMailClawTenantId(accounts[0].tenant_id), 0)
    return () => window.clearTimeout(timer)
  }, [accounts, mailClawTenantId])

  async function loadMailClawData(tenantId = mailClawTenantId) {
    if (!tenantId) return
    setMailClawLoading(true)
    setMailClawError('')
    try {
      const params = new URLSearchParams({ tenantId })
      const [rules, logs, smart] = await Promise.all([
        apiFetch(`/mail/mailclaw/rules?${params.toString()}`),
        apiFetch(`/mail/mailclaw/logs?${params.toString()}&limit=20`),
        apiFetch(`/mail/smart-folders?${params.toString()}`).catch(() => []),
      ])
      setMailClawRules(Array.isArray(rules) ? rules : [])
      setMailClawLogs(Array.isArray(logs) ? logs : [])
      setMailClawSmartFolders(Array.isArray(smart) ? smart : [])
    } catch (err) {
      setMailClawError(err.message || 'MailClaw 정보를 불러오지 못했습니다.')
    } finally {
      setMailClawLoading(false)
    }
  }

  useEffect(() => {
    if (!initialMailClawRegistration?.senderEmail) return
    const tenantId = initialMailClawRegistration.tenantId || mailClawTenantId || accounts[0]?.tenant_id || tenants[0]?.id || ''
    const senderEmail = initialMailClawRegistration.senderEmail
    const timer = window.setTimeout(() => {
      setMailClawTenantId(tenantId)
      if (initialMailClawRegistration.rule) {
        setMailClawSelectedRule(initialMailClawRegistration.rule)
        setMailClawForm(mailClawRuleToForm(initialMailClawRegistration.rule))
      } else {
        setMailClawSelectedRule(null)
        setMailClawForm({
          ...EMPTY_MAILCLAW_FORM,
          name: `MailClaw ${senderEmail}`,
          sender_check_enabled: true,
          sender_conditions_text: senderEmail,
        })
      }
      setMailClawApplyProgress(null)
      setMailClawError('')
      setView('mailclawEdit')
      if (tenantId) loadMailClawData(tenantId)
    }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMailClawRegistration?.id])

  function openMailClaw() {
    const tenantId = mailClawTenantId || accounts[0]?.tenant_id || tenants[0]?.id || ''
    setMailClawTenantId(tenantId)
    setMailClawSelectedRule(null)
    setMailClawForm({ ...EMPTY_MAILCLAW_FORM })
    setMailClawApplyProgress(null)
    setView('mailclaw')
    if (tenantId) loadMailClawData(tenantId)
  }

  // 첨부파일 정책 (MailService.md 10.8)
  async function openAttachPolicy() {
    setView('attachPolicy')
    setAttachPolicyError('')
    setAttachPolicyStatus('')
    setAttachPolicyLoading(true)
    try {
      const p = await apiFetch('/mail/attachment-policy')
      setAttachPolicyForm({
        max_file_mb: p?.max_file_mb ?? 25,
        max_total_mb: p?.max_total_mb ?? 25,
        max_files: p?.max_files ?? 20,
        blocked_extensions: Array.isArray(p?.blocked_extensions) ? p.blocked_extensions.join(', ') : '',
      })
    } catch (err) {
      setAttachPolicyError(err.message || '첨부파일 정책을 불러오지 못했습니다.')
    } finally {
      setAttachPolicyLoading(false)
    }
  }

  async function saveAttachPolicy(event) {
    event.preventDefault()
    if (!isSiteAdmin || !attachPolicyForm) return
    setAttachPolicySaving(true)
    setAttachPolicyError('')
    setAttachPolicyStatus('')
    try {
      const saved = await apiFetch('/mail/attachment-policy', {
        method: 'PUT',
        body: JSON.stringify({
          max_file_mb: Number(attachPolicyForm.max_file_mb),
          max_total_mb: Number(attachPolicyForm.max_total_mb),
          max_files: Number(attachPolicyForm.max_files),
          blocked_extensions: attachPolicyForm.blocked_extensions,
        }),
      })
      setAttachPolicyForm({
        max_file_mb: saved.max_file_mb,
        max_total_mb: saved.max_total_mb,
        max_files: saved.max_files,
        blocked_extensions: (saved.blocked_extensions || []).join(', '),
      })
      setAttachPolicyStatus('첨부파일 정책을 저장했습니다.')
    } catch (err) {
      setAttachPolicyError(err.message || '첨부파일 정책을 저장하지 못했습니다.')
    } finally {
      setAttachPolicySaving(false)
    }
  }

  function editMailClawRule(rule) {
    setMailClawSelectedRule(rule)
    setMailClawForm(mailClawRuleToForm(rule))
    setMailClawApplyProgress(null)
    setView('mailclawEdit')
  }

  function newMailClawRule() {
    setMailClawSelectedRule(null)
    setMailClawForm({ ...EMPTY_MAILCLAW_FORM, name: `MailClaw #${mailClawRules.length + 1}` })
    setMailClawApplyProgress(null)
    setView('mailclawEdit')
  }

  function updateMailClawField(key, value) {
    setMailClawForm(prev => ({ ...prev, [key]: value }))
  }

  function validateMailClawPayload(payload) {
    if (payload.sender_check_enabled && payload.sender_conditions.length === 0) throw new Error('발신자 조건을 입력해주세요.')
    if (payload.cc_check_enabled && payload.cc_conditions.length === 0) throw new Error('참조자 조건을 입력해주세요.')
    if (payload.keyword_check_enabled && payload.keyword_conditions.length === 0) throw new Error('키워드 조건을 입력해주세요.')
    if (payload.forward_enabled && payload.forward_addresses.length === 0) throw new Error('전달할 메일 주소를 입력해주세요.')
    if (payload.move_folder_enabled && !payload.target_folder_id) throw new Error('이동할 폴더를 선택해주세요.')
    if (payload.move_folder_enabled && !mailClawFolders.some(folder => folder.id === payload.target_folder_id)) throw new Error('이동할 폴더를 선택해주세요.')
    if (payload.tag_smart_folder_enabled && !payload.tag_smart_folder_id) throw new Error('태그할 스마트 폴더를 선택해주세요.')
  }

  async function persistMailClawRule() {
    if (!mailClawTenantId) {
      throw new Error('MailClaw를 저장할 메일 공간을 선택해주세요.')
    }
    const payload = mailClawFormToPayload(mailClawForm, mailClawTenantId)
    validateMailClawPayload(payload)
    const url = mailClawSelectedRule
      ? `/mail/mailclaw/rules/${mailClawSelectedRule.id}`
      : '/mail/mailclaw/rules'
    const rule = await apiFetch(url, {
      method: mailClawSelectedRule ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    setMailClawSelectedRule(rule)
    return rule
  }

  async function saveMailClawRule(event) {
    event.preventDefault()
    setMailClawSaving(true)
    setMailClawError('')
    try {
      await persistMailClawRule()
      await loadMailClawData(mailClawTenantId)
      setView('mailclaw')
    } catch (err) {
      setMailClawError(err.message || 'MailClaw 규칙을 저장하지 못했습니다.')
    } finally {
      setMailClawSaving(false)
    }
  }

  async function deleteMailClawRule(rule) {
    if (!rule || !mailClawTenantId) return
    if (!window.confirm(`'${rule.name}' MailClaw 규칙을 삭제할까요?`)) return
    setMailClawSaving(true)
    setMailClawError('')
    try {
      const params = new URLSearchParams({ tenantId: mailClawTenantId })
      await apiFetch(`/mail/mailclaw/rules/${rule.id}?${params.toString()}`, { method: 'DELETE' })
      await loadMailClawData(mailClawTenantId)
    } catch (err) {
      setMailClawError(err.message || 'MailClaw 규칙을 삭제하지 못했습니다.')
    } finally {
      setMailClawSaving(false)
    }
  }

  async function fetchCurrentFolderMessageIds() {
    if (!activeFolder?.folder?.id && !activeUnified?.key) return []
    const ids = []
    const pageSize = 200
    let offset = 0
    while (true) {
      const params = activeFolder?.folder?.id
        ? new URLSearchParams({
            tenantId: activeFolder.account.tenant_id,
            accountId: activeFolder.account.id,
            folderId: activeFolder.folder.id,
            limit: String(pageSize),
            offset: String(offset),
          })
        : new URLSearchParams({
            tenantId: mailClawActiveTenantId,
            scope: 'unified',
            unifiedKey: activeUnified.key,
            folderType: activeUnified.type || '',
            folderName: activeUnified.folderName || '',
            limit: String(pageSize),
            offset: String(offset),
          })
      const rows = await apiFetch(`/mail/messages?${params.toString()}`)
      const list = Array.isArray(rows) ? rows : []
      ids.push(...list.map(item => item.id).filter(Boolean))
      if (list.length < pageSize) break
      offset += pageSize
    }
    return [...new Set(ids)]
  }

  async function applySelectedMailClawToCurrentFolder() {
    if (!hasMailClawActiveScope || !mailClawActiveTenantId) {
      setMailClawError('현재 선택된 폴더가 없습니다.')
      return
    }
    if (mailClawTenantId !== mailClawActiveTenantId) {
      setMailClawError('선택된 MailClaw와 현재 폴더의 메일 공간이 다릅니다.')
      return
    }
    setMailClawApplying(true)
    setMailClawError('')
    setMailClawApplyProgress({
      phase: 'collecting',
      total: 0,
      done: 0,
      matched: 0,
      skipped: 0,
      failed: 0,
      current: '현재 폴더의 메일을 확인하는 중...',
    })
    try {
      setMailClawApplyProgress(prev => ({
        ...(prev || {}),
        current: mailClawSelectedRule?.id ? 'MailClaw 적용 준비 중...' : 'MailClaw를 먼저 저장하는 중...',
      }))
      const rule = await persistMailClawRule()
      const ruleId = rule?.id || mailClawSelectedRule?.id
      if (!ruleId) throw new Error('MailClaw 규칙을 저장하지 못했습니다.')
      const messageIds = await fetchCurrentFolderMessageIds()
      setMailClawApplyProgress(prev => ({
        ...(prev || {}),
        phase: 'applying',
        total: messageIds.length,
        done: 0,
        current: messageIds.length ? 'MailClaw 적용을 시작합니다.' : '적용할 메일이 없습니다.',
      }))

      if (messageIds.length > 0) {
        // 폴더 전체를 서버측 배치 엔드포인트로 한 번에 처리하고, 진행 상황을
        // NDJSON 스트림으로 받아 표시한다. (건당 왕복 → 스트림 1회)
        const res = await fetch(`/api/mail/mailclaw/rules/${ruleId}/apply-messages`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId: mailClawActiveTenantId,
            messageIds,
            force: true,
          }),
        })
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const applyProgress = (evt) => {
          if (!evt || typeof evt !== 'object') return
          if (evt.type === 'error') throw new Error(evt.error || 'MailClaw 적용 중 오류가 발생했습니다.')
          const total = evt.total ?? messageIds.length
          const done = evt.done ?? 0
          setMailClawApplyProgress(prev => ({
            ...(prev || {}),
            phase: evt.type === 'done' ? 'done' : 'applying',
            total,
            done,
            matched: evt.matched ?? prev?.matched ?? 0,
            skipped: evt.skipped ?? prev?.skipped ?? 0,
            failed: evt.failed ?? prev?.failed ?? 0,
            current: evt.type === 'done'
              ? '현재 폴더 적용 완료'
              : `${done} / ${total} 처리 중`,
          }))
        }
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let newlineIndex
          while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newlineIndex).trim()
            buffer = buffer.slice(newlineIndex + 1)
            if (line) applyProgress(JSON.parse(line))
          }
        }
        const tail = buffer.trim()
        if (tail) applyProgress(JSON.parse(tail))
      }
      setMailClawApplyProgress(prev => ({
        ...(prev || {}),
        phase: 'done',
        current: '현재 폴더 적용 완료',
      }))
      await loadMailClawData(mailClawTenantId)
      setMailClawSelectedRule(prev => prev?.id === ruleId ? prev : rule)
      if (onMailDataChanged) await onMailDataChanged()
    } catch (err) {
      setMailClawError(err.message || '현재 폴더에 MailClaw를 적용하지 못했습니다.')
      setMailClawApplyProgress(prev => ({
        ...(prev || {}),
        phase: 'failed',
        current: '적용 실패',
      }))
    } finally {
      setMailClawApplying(false)
    }
  }

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

  function accountToEditForm(account) {
    return {
      email_address: account.email_address || '',
      display_name: account.display_name || '',
      username: account.username || account.email_address || '',
      password: '',
      imap_host: account.imap_host || NAVER_MAIL_DEFAULTS.imap_host,
      imap_port: String(account.imap_port || NAVER_MAIL_DEFAULTS.imap_port),
      imap_security: account.imap_security || NAVER_MAIL_DEFAULTS.imap_security,
      smtp_host: account.smtp_host || NAVER_MAIL_DEFAULTS.smtp_host,
      smtp_port: String(account.smtp_port || NAVER_MAIL_DEFAULTS.smtp_port),
      smtp_security: account.smtp_security || NAVER_MAIL_DEFAULTS.smtp_security,
    }
  }

  function openAccountDetail(account) {
    setSelectedAccount(account)
    setAccountEditMode(false)
    setAccountEditForm(accountToEditForm(account))
    setAccountError('')
    setView('accountDetail')
  }

  function updateAccountEditField(key, value) {
    setAccountEditForm(prev => ({ ...(prev || {}), [key]: value }))
  }

  async function saveAccountEdit(event) {
    event.preventDefault()
    if (!selectedAccount || !accountEditForm) return
    setAccountSaving(true)
    setAccountError('')
    try {
      // Gmail/iCloud(호스트로 판별)는 인증 username을 항상 이메일로 강제. 앱비번 공백 제거.
      const editHost = String(accountEditForm.imap_host || '').toLowerCase()
      const forceEmailUser = editHost.includes('gmail') || editHost.includes('icloud') || editHost.includes('me.com')
      const data = await apiFetch(`/mail/accounts/${selectedAccount.id}/imap`, {
        method: 'PUT',
        body: JSON.stringify({
          ...accountEditForm,
          username: forceEmailUser ? accountEditForm.email_address : accountEditForm.username,
          password: (accountEditForm.password || '').replace(/\s+/g, ''),
          tenantId: selectedAccount.tenant_id,
          imap_port: Number(accountEditForm.imap_port),
          smtp_port: Number(accountEditForm.smtp_port),
        }),
      })
      const updatedAccount = {
        ...selectedAccount,
        ...(data.account || {}),
        tenant_name: selectedAccount.tenant_name,
      }
      setSelectedAccount(updatedAccount)
      setAccountEditForm(accountToEditForm(updatedAccount))
      setAccountEditMode(false)
      if (onAccountAdded) await onAccountAdded()
    } catch (err) {
      setAccountError(err.message || '메일 계정 설정을 저장하지 못했습니다.')
    } finally {
      setAccountSaving(false)
    }
  }

  async function saveNaverAccount(event) {
    event.preventDefault()
    setNaverSaving(true)
    setNaverError('')
    try {
      // Gmail/iCloud는 IMAP 인증 username이 반드시 전체 이메일이어야 한다.
      // 사용자가 입력하는 이름은 표시용(display_name, 왼쪽 탭 라벨)일 뿐 인증에는 쓰지 않는다.
      // 앱 비밀번호는 표시 포맷의 공백을 제거해 보낸다.
      const usernameForAuth = (imapBrand === 'gmail' || imapBrand === 'apple')
        ? naverForm.email_address
        : naverForm.username
      await apiFetch('/mail/accounts/imap', {
        method: 'POST',
        body: JSON.stringify({
          ...naverForm,
          username: usernameForAuth,
          password: (naverForm.password || '').replace(/\s+/g, ''),
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

  async function deleteAccount() {
    if (!selectedAccount) return
    const label = getAccountLabel(selectedAccount) || selectedAccount.email_address
    const ok = window.confirm(`'${label}' 계정 연동을 해제할까요?\n동기화된 받은메일·보낸메일·첨부 등 이 계정의 모든 데이터가 삭제됩니다.`)
    if (!ok) return
    setAccountSaving(true)
    setAccountError('')
    try {
      const params = new URLSearchParams({ tenantId: selectedAccount.tenant_id })
      await apiFetch(`/mail/accounts/${selectedAccount.id}?${params.toString()}`, { method: 'DELETE' })
      if (onAccountAdded) await onAccountAdded()
      setSelectedAccount(null)
      setView('manage')
    } catch (err) {
      setAccountError(err.message || '계정 연동 해제에 실패했습니다.')
    } finally {
      setAccountSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-5xl overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-extrabold text-gray-900">메일 계정 관리</h2>
            <p className="mt-0.5 text-sm text-gray-400">
              {view === 'imap' ? '메일 클라이언트(IMAP/SMTP) 정보를 입력하세요.' : view === 'accountDetail' ? '메일 계정 설정 정보를 확인하세요.' : view === 'add' ? '추가할 메일 서비스를 선택하세요.' : view === 'manage' ? '관리할 계정을 선택하세요.' : view === 'mailclaw' || view === 'mailclawEdit' ? '수신 메일 자동화 조건과 동작을 관리하세요.' : view === 'attachPolicy' ? '첨부 용량·개수 상한과 차단 확장자를 설정하세요.' : '계정 추가 또는 관리 작업을 선택하세요.'}
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
                onClick={() => setView('manage')}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
              >
                <span>
                  <span className="block text-sm font-extrabold text-gray-900">계정 관리</span>
                  <span className="mt-0.5 block text-xs text-gray-500">등록된 메일 계정을 관리합니다.</span>
                </span>
                <MenuIcon type="chevronRight" />
              </button>
              <button
                type="button"
                onClick={openMailClaw}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <img src="/img/mail/mailclaw-character.png" alt="" className="h-10 w-10 flex-shrink-0 object-contain" />
                  <span className="min-w-0">
                    <span className="block text-sm font-extrabold text-gray-900">MailClaw</span>
                    <span className="mt-0.5 block text-xs text-gray-500">수신 메일 자동화 조건과 동작을 관리합니다.</span>
                  </span>
                </span>
                <MenuIcon type="chevronRight" />
              </button>
              <button
                type="button"
                onClick={openAttachPolicy}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
              >
                <span>
                  <span className="block text-sm font-extrabold text-gray-900">첨부파일 정책</span>
                  <span className="mt-0.5 block text-xs text-gray-500">첨부 용량·개수 상한과 차단 확장자를 설정합니다.</span>
                </span>
                <MenuIcon type="chevronRight" />
              </button>
            </div>
          )}

          {view === 'attachPolicy' && (
            <div className="grid gap-4">
              {attachPolicyError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">{attachPolicyError}</p>
              )}
              {attachPolicyStatus && (
                <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-700">{attachPolicyStatus}</p>
              )}
              {!isSiteAdmin && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
                  값은 조회만 가능합니다. 첨부파일 정책은 사이트 관리자만 변경할 수 있습니다.
                </p>
              )}
              <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700">
                Gmail 등 대부분의 제공자는 메일 1건 한도가 약 25MB이며, 전송 시 base64 인코딩으로 크기가 약 37% 늘어납니다. 합계는 원본 기준 20MB 이하를 권장합니다.
              </p>
              {attachPolicyLoading || !attachPolicyForm ? (
                <p className="py-6 text-center text-sm font-bold text-gray-500">불러오는 중...</p>
              ) : (
                <form onSubmit={saveAttachPolicy} className="grid gap-4">
                  <div className="grid grid-cols-3 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-extrabold text-gray-600">단일 파일 최대(MB)</span>
                      <input
                        type="number" min="1" max="200"
                        value={attachPolicyForm.max_file_mb}
                        disabled={!isSiteAdmin}
                        onChange={e => setAttachPolicyForm(prev => ({ ...prev, max_file_mb: e.target.value }))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-extrabold text-gray-600">합계 최대(MB)</span>
                      <input
                        type="number" min="1" max="200"
                        value={attachPolicyForm.max_total_mb}
                        disabled={!isSiteAdmin}
                        onChange={e => setAttachPolicyForm(prev => ({ ...prev, max_total_mb: e.target.value }))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-extrabold text-gray-600">최대 개수</span>
                      <input
                        type="number" min="1" max="100"
                        value={attachPolicyForm.max_files}
                        disabled={!isSiteAdmin}
                        onChange={e => setAttachPolicyForm(prev => ({ ...prev, max_files: e.target.value }))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                      />
                    </label>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-xs font-extrabold text-gray-600">차단 확장자 (콤마로 구분)</span>
                    <textarea
                      rows={3}
                      value={attachPolicyForm.blocked_extensions}
                      disabled={!isSiteAdmin}
                      placeholder="exe, bat, cmd, com, scr, js, vbs, jar, msi"
                      onChange={e => setAttachPolicyForm(prev => ({ ...prev, blocked_extensions: e.target.value }))}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                    />
                    <span className="mt-1 block text-xs text-gray-400">여기 등록한 확장자의 첨부는 보내기에서 거부됩니다.</span>
                  </label>
                  {isSiteAdmin && (
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={attachPolicySaving}
                        className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500 disabled:opacity-60"
                      >
                        {attachPolicySaving ? '저장 중...' : '저장'}
                      </button>
                    </div>
                  )}
                </form>
              )}
            </div>
          )}

          {view === 'add' && (
            <div className="grid gap-3">
              {providers.map(provider => (
                <button
                  key={provider.key}
                  type="button"
                  onClick={() => openImapPreset(provider.key)}
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

          {view === 'imap' && (
            <form onSubmit={saveNaverAccount} className="grid gap-4">
              <div className="flex items-center gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
                <ProviderLogo provider={imapBrand} />
                <div className="min-w-0">
                  <h3 className="text-sm font-extrabold text-gray-900">{MAIL_PRESET_META[imapBrand]?.title || 'IMAP/SMTP 설정'}</h3>
                  <p className="mt-0.5 text-xs text-gray-500">{MAIL_PRESET_META[imapBrand]?.help || 'IMAP/SMTP 서버 값을 입력하세요.'}</p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="이메일">
                  <MailInput
                    type="email"
                    required
                    value={naverForm.email_address}
                    onChange={event => updateNaverField('email_address', event.target.value)}
                    placeholder={MAIL_PRESET_META[imapBrand]?.emailPlaceholder || 'name@example.com'}
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
                {(imapBrand === 'naver' || imapBrand === 'other') && (
                  <Field label="사용자 이름">
                    <MailInput
                      required
                      value={naverForm.username}
                      onChange={event => updateNaverField('username', event.target.value)}
                      placeholder={MAIL_PRESET_META[imapBrand]?.emailPlaceholder || 'name@example.com'}
                    />
                  </Field>
                )}
                <Field label="앱 비밀번호">
                  <MailInput
                    type="password"
                    required
                    value={naverForm.password}
                    onChange={event => updateNaverField('password', event.target.value)}
                    placeholder="앱 비밀번호"
                  />
                </Field>
              </div>

              {MAIL_PRESET_META[imapBrand]?.appPwUrl && (
                <a
                  href={MAIL_PRESET_META[imapBrand].appPwUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="-mt-1 inline-flex w-fit text-xs font-bold text-indigo-600 hover:underline"
                >
                  {MAIL_PRESET_META[imapBrand].appPwLabel} →
                </a>
              )}

              {hasPresetServers && (
                <button
                  type="button"
                  onClick={() => setShowAdvanced(v => !v)}
                  className="inline-flex w-fit text-xs font-bold text-gray-400 hover:text-gray-700"
                >
                  {showAdvanced ? '▾ 고급 설정(IMAP/SMTP 서버) 숨기기' : '▸ 고급 설정(IMAP/SMTP 서버)'}
                </button>
              )}

              {(!hasPresetServers || showAdvanced) && (
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
              )}

              {naverError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">
                  {naverError}
                </p>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={naverSaving}
                  className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500 disabled:opacity-60"
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

          {view === 'manage' && (
            accounts.length > 0 ? (
              <div className="grid gap-2">
                {accounts.map(account => (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => openAccountDetail(account)}
                    className="flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
                  >
                    <ProviderLogo provider={account.provider} host={account.imap_host} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-extrabold text-gray-900">{getAccountLabel(account)}</span>
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

          {view === 'mailclaw' && (
            <div className="grid gap-4">
              <div className="flex items-center gap-3 rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3">
                <img src="/img/mail/mailclaw-character.png" alt="" className="h-14 w-14 flex-shrink-0 object-contain" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-extrabold text-gray-900">MailClaw</h3>
                  <p className="mt-0.5 text-xs leading-5 text-gray-500">켜진 조건은 AND로 판정하고, AI 분석 후 원본 전달, 폴더 이동 순서로 실행합니다.</p>
                </div>
              </div>

              <div className="flex items-end gap-3">
                <Field label="메일 공간">
                  <MailSelect
                    value={mailClawTenantId}
                    onChange={event => {
                      const tenantId = event.target.value
                      setMailClawTenantId(tenantId)
                      loadMailClawData(tenantId)
                    }}
                  >
                    {[...new Map(accounts.map(account => [account.tenant_id, account.tenant_name || account.tenant_id])).entries()].map(([id, name]) => (
                      <option key={id} value={id}>{name}</option>
                    ))}
                  </MailSelect>
                </Field>
                <button
                  type="button"
                  onClick={newMailClawRule}
                  className="h-10 rounded-lg bg-indigo-600 px-4 text-sm font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500"
                >
                  추가
                </button>
              </div>

              {mailClawError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">{mailClawError}</p>
              )}

              <div className="grid max-h-[360px] gap-2 overflow-y-auto pr-1">
                {mailClawLoading ? (
                  <div className="rounded-lg border border-gray-200 px-4 py-6 text-center text-sm font-bold text-gray-400">불러오는 중...</div>
                ) : mailClawRules.length > 0 ? mailClawRules.map(rule => (
                  <div key={rule.id} className="rounded-lg border border-gray-200 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <button type="button" onClick={() => editMailClawRule(rule)} className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-sm font-extrabold text-gray-900">{rule.name}</span>
                        <span className="mt-1 block truncate text-xs text-gray-500">
                          {[rule.sender_check_enabled ? '발신자' : '', rule.cc_check_enabled ? '참조자' : '', rule.keyword_check_enabled ? '키워드' : ''].filter(Boolean).join(' AND ') || '조건 없음'}
                          {' / '}
                          {[rule.ai_analysis_enabled ? 'AI 분석' : '', rule.important_mail_enabled ? '중요 메일 등록' : '', rule.forward_enabled ? '원본 전달' : '', rule.move_folder_enabled ? '폴더 이동' : '', rule.tag_smart_folder_enabled ? '스마트 폴더 태그' : ''].filter(Boolean).join(' → ') || '동작 없음'}
                        </span>
                      </button>
                      <span className={`rounded-full px-2 py-1 text-[11px] font-extrabold ${rule.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-400'}`}>
                        {rule.enabled ? 'ON' : 'OFF'}
                      </span>
                      {rule.name !== DEFAULT_MAILCLAW_TRASH_RULE_NAME && (
                        <button
                          type="button"
                          onClick={() => deleteMailClawRule(rule)}
                          disabled={mailClawSaving}
                          className="rounded-md px-2 py-1 text-xs font-bold text-red-500 hover:bg-red-50"
                        >
                          삭제
                        </button>
                      )}
                    </div>
                  </div>
                )) : (
                  <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center">
                    <p className="text-sm font-bold text-gray-700">등록된 MailClaw 규칙이 없습니다.</p>
                  </div>
                )}
              </div>

              {mailClawLogs.length > 0 && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <h3 className="text-sm font-extrabold text-gray-900">최근 실행 로그</h3>
                  <div className="mt-2 max-h-32 overflow-y-auto divide-y divide-gray-200">
                    {mailClawLogs.slice(0, 5).map(log => (
                      <div key={log.id} className="py-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-bold text-gray-700">{log.rule_name}</span>
                          <span className="flex-shrink-0 font-bold text-gray-400">{log.status}</span>
                        </div>
                        <div className="mt-0.5 truncate text-gray-400">{log.subject || log.from_email || log.message_id}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {view === 'mailclawEdit' && (
            <form id="mailclaw-rule-form" onSubmit={saveMailClawRule} className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex-shrink-0 text-xs font-bold text-gray-500">자동화 이름</span>
                  <MailInput
                    required
                    value={mailClawForm.name}
                    onChange={event => updateMailClawField('name', event.target.value)}
                    placeholder="예: 중요한 고객 메일"
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2">
                  <span className="text-sm font-bold text-gray-700">활성화</span>
                  <SlideToggle
                    checked={mailClawForm.enabled}
                    onChange={value => updateMailClawField('enabled', value)}
                    label="자동화 활성화 Enable"
                  />
                </div>
              </div>

              <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <h3 className="text-sm font-extrabold text-gray-900">조건</h3>
                {[
                  ['sender_check_enabled', 'sender_conditions_text', '발신자 체크', '발신자 이메일을 줄바꿈 또는 쉼표로 입력'],
                  ['cc_check_enabled', 'cc_conditions_text', '참조자 체크', '참조자 이메일을 줄바꿈 또는 쉼표로 입력'],
                  ['keyword_check_enabled', 'keyword_conditions_text', '키워드 체크', '메일 제목 키워드를 줄바꿈 또는 쉼표로 입력'],
                ].map(([enabledKey, textKey, label, placeholder]) => (
                  <div key={enabledKey} className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:flex-row sm:items-start">
                    <div className="flex w-full flex-shrink-0 items-center justify-between gap-3 sm:w-64 sm:pt-2">
                      <span className="text-sm font-extrabold text-gray-800">{label}</span>
                      <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400">
                        <span>Enable</span>
                        <SlideToggle
                          checked={!!mailClawForm[enabledKey]}
                          onChange={value => updateMailClawField(enabledKey, value)}
                          label={`${label} Enable`}
                        />
                      </div>
                    </div>
                    <textarea
                      value={mailClawForm[textKey]}
                      onChange={event => updateMailClawField(textKey, event.target.value)}
                      disabled={!mailClawForm[enabledKey]}
                      placeholder={placeholder}
                      className="min-h-[70px] w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100 disabled:text-gray-400"
                    />
                  </div>
                ))}
              </div>

              <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <h3 className="text-sm font-extrabold text-gray-900">동작</h3>
                <div className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-[280px_96px_minmax(0,1fr)] sm:items-center">
                  <span className="whitespace-nowrap text-sm font-bold text-gray-700">AI 메일 분석</span>
                  <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400 sm:justify-end">
                    <span>Enable</span>
                    <SlideToggle
                      checked={mailClawForm.ai_analysis_enabled}
                      onChange={value => updateMailClawField('ai_analysis_enabled', value)}
                      label="AI 메일 분석 Enable"
                    />
                  </div>
                  <div className="hidden sm:block" />
                </div>
                <div className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-[280px_96px_minmax(0,1fr)] sm:items-center">
                  <span className="whitespace-nowrap text-sm font-bold text-gray-700">중요 메일 등록</span>
                  <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400 sm:justify-end">
                    <span>Enable</span>
                    <SlideToggle
                      checked={mailClawForm.important_mail_enabled}
                      onChange={value => updateMailClawField('important_mail_enabled', value)}
                      label="중요 메일 등록 Enable"
                    />
                  </div>
                  <div className="hidden sm:block" />
                </div>
                <div className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-[280px_96px_minmax(0,1fr)] sm:items-center">
                  <span className="whitespace-nowrap text-sm font-bold text-gray-700">지정된 메일 주소로 원본 메일 전달</span>
                  <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400 sm:justify-end">
                    <span>Enable</span>
                    <SlideToggle
                      checked={mailClawForm.forward_enabled}
                      onChange={value => updateMailClawField('forward_enabled', value)}
                      label="지정된 메일 주소로 원본 메일 전달 Enable"
                    />
                  </div>
                  <textarea
                    value={mailClawForm.forward_addresses_text}
                    onChange={event => updateMailClawField('forward_addresses_text', event.target.value)}
                    disabled={!mailClawForm.forward_enabled}
                    placeholder="전달 받을 메일 주소"
                    className="min-h-10 w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100 disabled:text-gray-400"
                  />
                </div>
                <div className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-[280px_96px_minmax(0,1fr)] sm:items-center">
                  <span className="whitespace-nowrap text-sm font-bold text-gray-700">지정된 폴더로 이동</span>
                  <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400 sm:justify-end">
                    <span>Enable</span>
                    <SlideToggle
                      checked={mailClawForm.move_folder_enabled}
                      onChange={value => updateMailClawField('move_folder_enabled', value)}
                      label="지정된 폴더로 이동 Enable"
                    />
                  </div>
                  <select
                    value={mailClawForm.target_folder_id}
                    onChange={event => updateMailClawField('target_folder_id', event.target.value)}
                    disabled={!mailClawForm.move_folder_enabled}
                    className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    <option value="">폴더 선택</option>
                    {mailClawFolders.map(folder => (
                      <option key={folder.id} value={folder.id}>{folder.label}</option>
                    ))}
                  </select>
                </div>

                {/* 스마트 폴더 태그 부여(+아카이브) — MailService.md 13.6 */}
                <div className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-[280px_96px_minmax(0,1fr)] sm:items-center">
                  <span className="whitespace-nowrap text-sm font-bold text-gray-700">스마트 폴더에 태그</span>
                  <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400 sm:justify-end">
                    <span>Enable</span>
                    <SlideToggle
                      checked={mailClawForm.tag_smart_folder_enabled}
                      onChange={value => updateMailClawField('tag_smart_folder_enabled', value)}
                      label="스마트 폴더에 태그 Enable"
                    />
                  </div>
                  <select
                    value={mailClawForm.tag_smart_folder_id}
                    onChange={event => updateMailClawField('tag_smart_folder_id', event.target.value)}
                    disabled={!mailClawForm.tag_smart_folder_enabled}
                    className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    <option value="">스마트 폴더 선택</option>
                    {mailClawSmartFolders.map(folder => (
                      <option key={folder.id} value={folder.id}>{folder.name}</option>
                    ))}
                  </select>
                  {mailClawForm.tag_smart_folder_enabled && (
                    <label className="flex items-center gap-2 text-xs font-bold text-gray-500 sm:col-span-3">
                      <input
                        type="checkbox"
                        checked={mailClawForm.tag_archive_enabled}
                        onChange={event => updateMailClawField('tag_archive_enabled', event.target.checked)}
                        className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>태그와 함께 각 계정의 보관함으로 이동(받은편지함에서 치움 · 하드 삭제 아님)</span>
                    </label>
                  )}
                  {mailClawSmartFolders.length === 0 && (
                    <p className="text-[11px] font-semibold text-gray-400 sm:col-span-3">아직 스마트 폴더가 없습니다. 메일 사이드바에서 먼저 스마트 폴더를 만들어주세요.</p>
                  )}
                </div>
              </div>

              {mailClawError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">{mailClawError}</p>
              )}

              {mailClawApplyProgress && (
                <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-3">
                  <div className="flex items-center justify-between gap-3 text-xs font-extrabold text-indigo-900">
                    <span>{mailClawApplyProgress.current}</span>
                    <span>
                      {mailClawApplyProgress.total
                        ? `${Math.round((mailClawApplyProgress.done / mailClawApplyProgress.total) * 100)}%`
                        : mailClawApplyProgress.phase === 'collecting' ? '준비 중' : '0%'}
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
                    <div
                      className={`h-full rounded-full bg-indigo-600 transition-all ${mailClawApplyProgress.phase === 'collecting' ? 'animate-pulse' : ''}`}
                      style={{
                        width: mailClawApplyProgress.total
                          ? `${Math.max(4, Math.round((mailClawApplyProgress.done / mailClawApplyProgress.total) * 100))}%`
                          : mailClawApplyProgress.phase === 'collecting' ? '35%' : '0%',
                      }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-indigo-700">
                    <span>총 {mailClawApplyProgress.total}</span>
                    <span>완료 {mailClawApplyProgress.done}</span>
                    <span>일치 {mailClawApplyProgress.matched}</span>
                    <span>건너뜀 {mailClawApplyProgress.skipped}</span>
                    <span>실패 {mailClawApplyProgress.failed}</span>
                  </div>
                </div>
              )}

            </form>
          )}

          {view === 'accountDetail' && selectedAccount && (
            <div className="grid gap-4">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <ProviderLogo provider={selectedAccount.provider} host={selectedAccount.imap_host} />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-extrabold text-gray-900">
                    {accountEditMode ? '메일 계정 편집' : '메일 계정 관리'}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-gray-500">{selectedAccount.email_address}</span>
                </div>
                {isImapAccount(selectedAccount) && !accountEditMode && (
                  <button
                    type="button"
                    onClick={() => {
                      setAccountEditForm(accountToEditForm(selectedAccount))
                      setAccountEditMode(true)
                      setAccountError('')
                    }}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-indigo-500"
                  >
                    편집
                  </button>
                )}
              </div>

              {isImapAccount(selectedAccount) && accountEditMode && accountEditForm ? (
                <form onSubmit={saveAccountEdit} className="grid gap-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="이메일">
                      <MailInput
                        type="email"
                        required
                        value={accountEditForm.email_address}
                        onChange={event => updateAccountEditField('email_address', event.target.value)}
                      />
                    </Field>
                    <Field label="표시 이름">
                      <MailInput
                        value={accountEditForm.display_name}
                        onChange={event => updateAccountEditField('display_name', event.target.value)}
                      />
                    </Field>
                    <Field label="사용자 이름">
                      <MailInput
                        required
                        value={accountEditForm.username}
                        onChange={event => updateAccountEditField('username', event.target.value)}
                      />
                    </Field>
                  </div>

                  <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                    <h3 className="text-sm font-extrabold text-gray-900">IMAP/SMTP 설정</h3>
                    <div className="grid gap-3 sm:grid-cols-[1fr_90px_120px]">
                      <Field label="IMAP 서버">
                        <MailInput
                          required
                          value={accountEditForm.imap_host}
                          onChange={event => updateAccountEditField('imap_host', event.target.value)}
                        />
                      </Field>
                      <Field label="포트">
                        <MailInput
                          required
                          type="number"
                          min="1"
                          value={accountEditForm.imap_port}
                          onChange={event => updateAccountEditField('imap_port', event.target.value)}
                        />
                      </Field>
                      <Field label="보안">
                        <MailSelect
                          value={accountEditForm.imap_security}
                          onChange={event => updateAccountEditField('imap_security', event.target.value)}
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
                          value={accountEditForm.smtp_host}
                          onChange={event => updateAccountEditField('smtp_host', event.target.value)}
                        />
                      </Field>
                      <Field label="포트">
                        <MailInput
                          required
                          type="number"
                          min="1"
                          value={accountEditForm.smtp_port}
                          onChange={event => updateAccountEditField('smtp_port', event.target.value)}
                        />
                      </Field>
                      <Field label="보안">
                        <MailSelect
                          value={accountEditForm.smtp_security}
                          onChange={event => updateAccountEditField('smtp_security', event.target.value)}
                        >
                          <option value="ssl">SSL</option>
                          <option value="starttls">STARTTLS</option>
                          <option value="none">없음</option>
                        </MailSelect>
                      </Field>
                    </div>

                    <Field label="새 앱 비밀번호">
                      <MailInput
                        type="password"
                        value={accountEditForm.password}
                        onChange={event => updateAccountEditField('password', event.target.value)}
                        placeholder="변경할 때만 입력"
                      />
                    </Field>
                  </div>

                  {accountError && (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">
                      {accountError}
                    </p>
                  )}

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setAccountEditMode(false)
                        setAccountEditForm(accountToEditForm(selectedAccount))
                        setAccountError('')
                      }}
                      className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50"
                    >
                      취소
                    </button>
                    <button
                      type="submit"
                      disabled={accountSaving}
                      className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500 disabled:opacity-60"
                    >
                      {accountSaving ? '저장 중...' : '저장'}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <DetailValue label="이메일" value={selectedAccount.email_address} />
                    <DetailValue label="표시 이름" value={selectedAccount.display_name} />
                    <DetailValue label="사용자 이름" value={selectedAccount.username || selectedAccount.email_address} />
                  </div>

                  {isImapAccount(selectedAccount) && (
                    <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                      <h3 className="text-sm font-extrabold text-gray-900">IMAP/SMTP 설정</h3>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <DetailValue label="IMAP 서버" value={selectedAccount.imap_host} />
                        <DetailValue label="IMAP 포트" value={selectedAccount.imap_port} />
                        <DetailValue label="IMAP 보안" value={formatSecurity(selectedAccount.imap_security)} />
                        <DetailValue label="SMTP 서버" value={selectedAccount.smtp_host} />
                        <DetailValue label="SMTP 포트" value={selectedAccount.smtp_port} />
                        <DetailValue label="SMTP 보안" value={formatSecurity(selectedAccount.smtp_security)} />
                      </div>
                      <DetailValue label="암호" value="저장됨" />
                    </div>
                  )}
                </>
              )}

              {!isImapAccount(selectedAccount) && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-center">
                  <p className="text-sm font-bold text-gray-700">이 계정의 상세 설정 화면은 준비 중입니다.</p>
                </div>
              )}

              {!accountEditMode && (
                <div className="flex items-center justify-between border-t border-gray-100 pt-4">
                  <span className="text-xs text-gray-400">연동을 해제하면 이 계정의 동기화 데이터가 모두 삭제됩니다.</span>
                  <button
                    type="button"
                    onClick={deleteAccount}
                    disabled={accountSaving}
                    className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-extrabold text-red-600 hover:bg-red-100 disabled:opacity-60"
                  >
                    {accountSaving ? '처리 중...' : '연동 해제(삭제)'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-6 py-4">
          {view === 'main' ? (
            <span className="text-xs text-gray-400">4.0.1 메일 계정 관리 메뉴</span>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (view === 'accountDetail') {
                  setSelectedAccount(null)
                  setView('manage')
                } else if (view === 'mailclawEdit') {
                  setView('mailclaw')
                } else {
                  setView(view === 'gmail' || view === 'imap' ? 'add' : 'main')
                }
              }}
              className="text-sm font-bold text-gray-500 hover:text-gray-900"
            >
              뒤로
            </button>
          )}
          <div className="flex items-center gap-2">
            {view === 'mailclawEdit' && (
              <>
                <button
                  type="button"
                  onClick={() => setView('mailclaw')}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={applySelectedMailClawToCurrentFolder}
                  disabled={!hasMailClawActiveScope || !mailClawActiveTenantId || mailClawTenantId !== mailClawActiveTenantId || mailClawApplying || mailClawSaving}
                  title={
                    !hasMailClawActiveScope
                      ? '현재 선택된 폴더가 없습니다'
                      : mailClawTenantId !== mailClawActiveTenantId
                        ? '선택된 MailClaw와 현재 폴더의 메일 공간이 다릅니다'
                        : `${mailClawActiveScopeLabel}에 적용`
                  }
                  className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-extrabold text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {mailClawApplying ? '적용 중...' : '현재 폴더에 적용'}
                </button>
                <button
                  type="submit"
                  form="mailclaw-rule-form"
                  disabled={mailClawSaving || mailClawApplying}
                  className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500 disabled:opacity-60"
                >
                  {mailClawSaving ? '저장 중...' : '저장'}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500"
            >
              닫기
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default MailAccountManageModal
