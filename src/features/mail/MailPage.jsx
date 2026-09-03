import { useEffect, useMemo, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { apiFetch } from '../../lib/api'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../contexts/ToastContext'
import { useAuth } from '../../contexts/AuthContext'
import { useChat } from '../../contexts/ChatContext'
import { MAIL_TEXT, getMailText } from './mailText'
import { MailIcon, MenuIcon, ToolbarButton } from './mailIcons'
import MailMessageList from './MailMessageList'
import MailComposeView from './MailComposeView'
import MailViewer from './MailViewer'
import MailAccountManageModal from './MailAccountManageModal'
import MailInputDialog from './MailInputDialog'
import MailToPostDialog from './MailToPostDialog'
import MailNoteDialog from './MailNoteDialog'
import { FolderContextMenu, MailMessageContextMenu, SmartFolderContextMenu, UnifiedFolderContextMenu } from './MailContextMenus'
import { ProviderLogo } from './MailProviderLogo'
import { getAccountLabel } from './mailAccountUtils'
import {
  getDraftComposeData,
  getMailActionComposeData,
} from './mailAddressUtils'
import {
  FOLDER_COLOR_MAP,
  buildHierarchicalFolderList,
  getMailFolderLabel,
  getMailFolderTitle,
  isMailTrashFolder,
  isSystemMailFolder,
  normalizeFolderName,
  resolveTagColor,
} from './mailFolderUtils'

const MAIL_PAGE_SIZE = 100
const FOLDER_SYNC_COOLDOWN_MS = 30 * 1000
const UNIFIED_KEY_PREFIX = 'unified:'
const SMART_KEY_PREFIX = 'smart:'
const SMART_SEED_STORAGE_KEY = 'mail-smart-folder-seeded-v1'
const UNIFIED_FOLDER_COLOR_STORAGE_KEY = 'mail-unified-folder-colors-v1'

const UNIFIED_SYSTEM_FOLDERS = [
  { key: 'all', labelKey: 'all', icon: 'all' },
  { key: 'inbox', labelKey: 'inbox', icon: 'inbox', type: 'inbox' },
  { key: 'starred', labelKey: 'starred', icon: 'star' },
  { key: 'drafts', labelKey: 'drafts', icon: 'draft', type: 'drafts' },
  { key: 'search', labelKey: 'search', icon: 'search' },
  { key: 'sent', labelKey: 'sent', icon: 'sent', type: 'sent' },
  { key: 'trash', labelKey: 'trash', icon: 'trash', type: 'trash' },
]

// 컨텍스트 메뉴 위치 자동 보정 훅. (MailService.md 19.55)
// 커서 원좌표를 받아 렌더 후 실제 크기를 실측하고, 화면 하단/우측을 벗어나면 위/왼쪽으로 접어
// 메뉴가 잘리지 않게 한다. 측정 전에는 visibility:hidden으로 깜빡임을 막는다.
function MailMenuButton({ active, icon, label, count, unreadCount, iconColor, onClick, onContextMenu, depth = 0, title, onDragOver, onDragLeave, onDrop, dropActive = false }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`flex items-center gap-2.5 w-full rounded-lg text-sm text-left transition-all ${
        depth ? 'px-2 py-1.5' : 'px-2 py-2'
      } ${
        dropActive
          ? 'bg-indigo-600 text-white shadow-lg ring-2 ring-inset ring-indigo-300'
          : active
            ? 'bg-indigo-600 text-white shadow-lg'
            : 'text-gray-500 hover:bg-gray-200 hover:text-gray-900'
      }`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <span style={active || !iconColor ? undefined : { color: iconColor }}>
        <MenuIcon type={icon} filled={!active && !!iconColor && icon === 'folder'} />
      </span>
      <span className="flex-1 font-medium truncate">{label}</span>
      <span className={`text-xs rounded-full px-1.5 py-0.5 font-bold min-w-[18px] text-center ${
        active ? 'bg-white/20 text-white' : 'bg-gray-300 text-gray-700'
      }`}>
        {`${Number(unreadCount || 0)} / ${Number(count || 0)}`}
      </span>
    </button>
  )
}

// 메일을 게시글/댓글로 등록하는 다이얼로그 (MailService.md 23.3)
// Team → Channel → 게시글(또는 새 게시글) 순으로 선택하고, 편집한 본문으로 등록한다.
export default function MailPage({ onBackToMain, initialMailLink = null, initialFolder = null, onOpenCalendarEvent }) {
  const { showToast } = useToast()
  const { language, currentUser } = useAuth()
  const { teams, selectedTeam, selectedChannel, addPost, addComment, refreshTeams } = useChat()
  const mt = getMailText(language)
  const [tenants, setTenants] = useState([])
  const [accounts, setAccounts] = useState([])
  const [unclassifiedCounts, setUnclassifiedCounts] = useState({ message_count: 0, unread_count: 0 })
  const [mailMetaLoading, setMailMetaLoading] = useState(false)
  const [mailMetaError, setMailMetaError] = useState('')
  const [activeKey, setActiveKey] = useState(`${UNIFIED_KEY_PREFIX}all`)
  const [unifiedFolderColors, setUnifiedFolderColors] = useState(() => {
    try {
      if (typeof window === 'undefined') return {}
      const rows = JSON.parse(window.localStorage.getItem(UNIFIED_FOLDER_COLOR_STORAGE_KEY) || '{}')
      return rows && typeof rows === 'object' && !Array.isArray(rows) ? rows : {}
    } catch {
      return {}
    }
  })
  const [mailSearch, setMailSearch] = useState({ active: false, field: 'all', query: '', total: 0, nextCursor: null })
  // 통합 스마트 폴더(태그 기반 — MailService.md 13). [{ id, name, color_key, message_count, unread_count }]
  const [smartFolders, setSmartFolders] = useState([])
  // 스마트 폴더 구역 접기/펴기(헤더 클릭 토글). 브라우저에 유지.
  const [smartSectionCollapsed, setSmartSectionCollapsed] = useState(() => {
    try { return typeof window !== 'undefined' && window.localStorage.getItem('mail-smart-section-collapsed') === '1' } catch { return false }
  })
  const [collapsedAccountIds, setCollapsedAccountIds] = useState(() => new Set())
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [messages, setMessages] = useState([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState('')
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshLoading, setRefreshLoading] = useState(false)
  const [syncErrorDialog, setSyncErrorDialog] = useState(null)
  const [composeMode, setComposeMode] = useState(false)
  const [composeDraft, setComposeDraft] = useState(null)
  const [selectedMessage, setSelectedMessage] = useState(null)
  const [selectedMessageIds, setSelectedMessageIds] = useState([])
  const [lastSelectedMessageId, setLastSelectedMessageId] = useState(null)
  // Drag & Drop: 드롭 하이라이트 대상 폴더 키(계정:폴더). (MailService.md 11)
  const [dropTargetKey, setDropTargetKey] = useState(null)
  const [messageMenu, setMessageMenu] = useState(null)
  // 게시글로 등록 다이얼로그 대상 { message, summary } (MailService.md 23)
  const [postDialog, setPostDialog] = useState(null)
  const [noteDialogMessage, setNoteDialogMessage] = useState(null)
  const [folderMenu, setFolderMenu] = useState(null)
  const [unifiedFolderMenu, setUnifiedFolderMenu] = useState(null)
  const [smartFolderMenu, setSmartFolderMenu] = useState(null)
  const [mailClawRegistration, setMailClawRegistration] = useState(null)
  const [pendingEmptyTrash, setPendingEmptyTrash] = useState(null)
  // 폴더 삭제 확인 대기: { account, folder, message, danger }
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState(null)
  const [folderNameDialog, setFolderNameDialog] = useState(null)
  const [folderNameDialogLoading, setFolderNameDialogLoading] = useState(false)
  // 통합 휴지통 비우기(여러 계정 한 번에) 확인 대기. (MailService.md 15)
  const [pendingEmptyUnifiedTrash, setPendingEmptyUnifiedTrash] = useState(null)
  const [messageDetailLoading, setMessageDetailLoading] = useState(false)
  const [messageDetailError, setMessageDetailError] = useState('')
  const folderSyncTimesRef = useRef(new Map())
  const handledInitialMailLinkRef = useRef('')
  const handledInitialFolderRef = useRef('')
  const preserveSelectionOnNextLoadRef = useRef(null)
  const messageLoadSeqRef = useRef(0)
  const loadMoreSeqRef = useRef(0)
  const mailSearchRef = useRef(mailSearch)
  const mailSearchSeqRef = useRef(0)
  const shownSyncErrorsRef = useRef(new Set())

  useEffect(() => {
    mailSearchRef.current = mailSearch
  }, [mailSearch])

  async function runMailSearch(request, { append = false } = {}) {
    const field = String(request?.field || 'all')
    const query = String(request?.query || '').trim()
    const current = mailSearchRef.current
    const cursor = append ? current.nextCursor : null
    if (!query || (append && !cursor)) return

    const requestSeq = append ? mailSearchSeqRef.current : ++mailSearchSeqRef.current
    if (!append) {
      const pending = { active: true, field, query, total: 0, nextCursor: null }
      mailSearchRef.current = pending
      setMailSearch(pending)
      activeKeyRef.current = `${UNIFIED_KEY_PREFIX}search`
      setActiveKey(`${UNIFIED_KEY_PREFIX}search`)
      setComposeMode(false)
      setMessages([])
      setSelectedMessage(null)
      setSelectedMessageIds([])
      setLastSelectedMessageId(null)
      setMessagesLoading(true)
      setMessagesError('')
    } else {
      setLoadingMore(true)
    }

    try {
      const params = new URLSearchParams({ field, q: query, limit: String(MAIL_PAGE_SIZE) })
      if (cursor) params.set('cursor', cursor)
      const result = await apiFetch(`/mail/messages/search?${params.toString()}`)
      if (requestSeq !== mailSearchSeqRef.current) return
      const list = Array.isArray(result?.items) ? result.items : []
      if (append) {
        setMessages(previous => {
          const ids = new Set(previous.map(item => `${item.tenant_id}:${item.id}`))
          return [...previous, ...list.filter(item => !ids.has(`${item.tenant_id}:${item.id}`))]
        })
      } else {
        setMessages(list)
      }
      const next = {
        active: true,
        field: result?.field || field,
        query,
        total: Number(result?.total || 0),
        nextCursor: result?.nextCursor || null,
      }
      mailSearchRef.current = next
      setMailSearch(next)
      setHasMoreMessages(Boolean(result?.hasMore && result?.nextCursor))
    } catch (err) {
      if (requestSeq !== mailSearchSeqRef.current) return
      setMessagesError(err.message || '메일을 검색하지 못했습니다.')
      if (!append) setMessages([])
    } finally {
      if (requestSeq === mailSearchSeqRef.current) {
        if (append) setLoadingMore(false)
        else setMessagesLoading(false)
      }
    }
  }

  useEffect(() => {
    const handleSearch = event => runMailSearch(event.detail)
    window.addEventListener('easy-mail-search', handleSearch)
    return () => window.removeEventListener('easy-mail-search', handleSearch)
  }, [])

  function clearMailSearch() {
    mailSearchSeqRef.current += 1
    const cleared = { active: false, field: 'all', query: '', total: 0, nextCursor: null }
    mailSearchRef.current = cleared
    setMailSearch(cleared)
    setHasMoreMessages(false)
    updateActiveKey(`${UNIFIED_KEY_PREFIX}all`)
  }

  function showAccountSyncErrors(accountRows, { force = false } = {}) {
    const failures = (Array.isArray(accountRows) ? accountRows : [])
      .filter(account => account && (account.ok === false || account.sync_status === 'error'))
      .map(account => ({
        accountId: account.accountId || account.id,
        emailAddress: account.emailAddress || account.email_address || '알 수 없는 계정',
        error: account.error || account.last_error || '메일 동기화에 실패했습니다.',
      }))
      .filter(item => {
        const signature = `${item.accountId}:${item.error}`
        if (!force && shownSyncErrorsRef.current.has(signature)) return false
        shownSyncErrorsRef.current.add(signature)
        return true
      })
    if (failures.length > 0) setSyncErrorDialog(failures)
  }

  useEffect(() => {
    showAccountSyncErrors(accounts)
  }, [accounts])

  const displayedMessages = messages

  const currentTenantId = accounts.find(account => account.tenant_id)?.tenant_id
    || tenants.find(item => item.type === 'personal')?.id
    || tenants[0]?.id
    || ''
  const activeKeyRef = useRef(activeKey)
  const currentTenantIdRef = useRef(currentTenantId)
  const messagesLengthRef = useRef(messages.length)
  useEffect(() => {
    activeKeyRef.current = activeKey
    currentTenantIdRef.current = currentTenantId
    messagesLengthRef.current = messages.length
  }, [activeKey, currentTenantId, messages.length])
  // 통합 사이드바 ① 시스템 항목만 남긴다. 이름-집계 커스텀 폴더는 13장 스마트 폴더로 대치(제거). (MailService.md 13.2.1)
  const unifiedMenus = useMemo(() => {
    const totalsByType = new Map()
    // 별표됨은 폴더 타입이 아니라 교차 플래그(is_starred)이므로 모든 폴더의 별표 수를 합산한다.
    // (별표됨 목록은 휴지통을 제외하지 않으므로 여기서도 제외하지 않는다. MailService.md 13)
    const starredTotals = { message_count: 0, unread_count: 0 }

    for (const account of accounts) {
      if (currentTenantId && account.tenant_id !== currentTenantId) continue
      for (const folder of account.folders || []) {
        const messageCount = Number(folder.message_count || 0)
        const unreadCount = Number(folder.unread_count || 0)
        starredTotals.message_count += Number(folder.starred_count || 0)
        starredTotals.unread_count += Number(folder.starred_unread_count || 0)

        const type = String(folder.type || '').trim()
        if (type) {
          const prev = totalsByType.get(type) || { message_count: 0, unread_count: 0 }
          prev.message_count += messageCount
          prev.unread_count += unreadCount
          totalsByType.set(type, prev)
        }
      }
    }

    const systemMenus = UNIFIED_SYSTEM_FOLDERS.map(item => {
      const counts = item.key === 'all'
        ? unclassifiedCounts
        : item.key === 'starred'
          ? starredTotals
          : item.type
            ? (totalsByType.get(item.type) || { message_count: 0, unread_count: 0 })
            : { message_count: 0, unread_count: 0 }
      return { ...item, ...counts }
    })

    return systemMenus.map(item => ({
      ...item,
      label: mt.folders[item.labelKey] || item.key,
      color_key: unifiedFolderColors[`${currentTenantId}:${item.key}`] || '',
    }))
  }, [accounts, currentTenantId, unifiedFolderColors, mt, unclassifiedCounts])

  // lg(≥1024px) 이상에서만 목록↔본문을 드래그로 리사이즈한다. 그 미만은 기존 세로 스택 유지.
  const [isDesktopSplit, setIsDesktopSplit] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const handler = (event) => setIsDesktopSplit(event.matches)
    setIsDesktopSplit(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // md(≥768px) 이상에서 사이드바↔본문 사이를 드래그로 리사이즈한다. 그 미만은 기존 세로 스택 유지.
  const [isSidebarResizable, setIsSidebarResizable] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const handler = (event) => setIsSidebarResizable(event.matches)
    setIsSidebarResizable(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') return 256
    const saved = Number(window.localStorage.getItem('mail-sidebar-width'))
    return saved >= 200 && saved <= 480 ? saved : 256
  })
  function startSidebarResize(event) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    let lastWidth = startWidth
    const onMove = (moveEvent) => {
      lastWidth = Math.min(480, Math.max(200, startWidth + (moveEvent.clientX - startX)))
      setSidebarWidth(lastWidth)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { window.localStorage.setItem('mail-sidebar-width', String(Math.round(lastWidth))) } catch { /* noop */ }
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

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
    return Array.isArray(accountRows) ? accountRows : []
  }

  async function reloadSmartFolders(tenantId = currentTenantId) {
    if (!tenantId) return []
    const rows = await apiFetch(`/mail/smart-folders?tenantId=${encodeURIComponent(tenantId)}`)
    const list = Array.isArray(rows) ? rows : []
    setSmartFolders(list)
    return list
  }

  async function reloadUnclassifiedCounts(tenantId = currentTenantId) {
    if (!tenantId) return { message_count: 0, unread_count: 0 }
    const counts = await apiFetch(`/mail/messages/unclassified-count?tenantId=${encodeURIComponent(tenantId)}`)
    const normalized = {
      message_count: Number(counts?.message_count || 0),
      unread_count: Number(counts?.unread_count || 0),
    }
    setUnclassifiedCounts(normalized)
    return normalized
  }

  useEffect(() => {
    if (!currentTenantId) {
      setUnclassifiedCounts({ message_count: 0, unread_count: 0 })
      return undefined
    }
    let cancelled = false
    apiFetch(`/mail/messages/unclassified-count?tenantId=${encodeURIComponent(currentTenantId)}`)
      .then(counts => {
        if (cancelled) return
        setUnclassifiedCounts({
          message_count: Number(counts?.message_count || 0),
          unread_count: Number(counts?.unread_count || 0),
        })
      })
      .catch(err => {
        if (!cancelled) console.warn('[mail unclassified count] 조회 실패', err?.message || err)
      })
    return () => { cancelled = true }
  }, [currentTenantId])

  // 스마트 폴더 로드 + 최초 1회 시드 마이그레이션(이름-집계 폴더 → 동명 스마트 폴더). tenant별 멱등.
  useEffect(() => {
    if (!currentTenantId) return
    let cancelled = false
    ;(async () => {
      try {
        const seededKey = `${SMART_SEED_STORAGE_KEY}:${currentTenantId}`
        const alreadySeeded = typeof window !== 'undefined' && window.localStorage.getItem(seededKey) === '1'
        if (!alreadySeeded) {
          try {
            await apiFetch('/mail/smart-folders/seed', { method: 'POST', body: JSON.stringify({ tenantId: currentTenantId }) })
            if (typeof window !== 'undefined') window.localStorage.setItem(seededKey, '1')
          } catch { /* 시드 실패는 무시(다음 로드 때 재시도) */ }
        }
        // 이중 휴지통 정리(멱등). 재동기화 전에 1회 실행해 중복을 막는다. (MailService.md 17)
        const reconciledKey = `mail-trash-reconciled-v1:${currentTenantId}`
        const alreadyReconciled = typeof window !== 'undefined' && window.localStorage.getItem(reconciledKey) === '1'
        if (!alreadyReconciled) {
          try {
            await apiFetch('/mail/reconcile-trash', { method: 'POST', body: JSON.stringify({ tenantId: currentTenantId }) })
            if (typeof window !== 'undefined') window.localStorage.setItem(reconciledKey, '1')
          } catch { /* 정리 실패는 무시(다음 로드 때 재시도) */ }
        }
        const [rows, counts] = await Promise.all([
          apiFetch(`/mail/smart-folders?tenantId=${encodeURIComponent(currentTenantId)}`),
          apiFetch(`/mail/messages/unclassified-count?tenantId=${encodeURIComponent(currentTenantId)}`),
        ])
        if (!cancelled) {
          setSmartFolders(Array.isArray(rows) ? rows : [])
          setUnclassifiedCounts({
            message_count: Number(counts?.message_count || 0),
            unread_count: Number(counts?.unread_count || 0),
          })
        }
      } catch { /* noop */ }
    })()
    return () => { cancelled = true }
  }, [currentTenantId])

  function openAgenticPanel() {
    window.dispatchEvent(new CustomEvent('open-agentic-panel'))
  }

  function openCompose() {
    setComposeDraft(null)
    setComposeMode(true)
    setSelectedMessage(null)
    setSelectedMessageIds([])
    setLastSelectedMessageId(null)
    setMessageMenu(null)
    setMessageDetailError('')
  }

  function updateActiveKey(key) {
    activeKeyRef.current = key
    setLastSelectedMessageId(null)
    setActiveKey(key)
  }

  function activateMailKey(key) {
    if (key !== `${UNIFIED_KEY_PREFIX}search` && mailSearchRef.current.active) {
      mailSearchSeqRef.current += 1
      const cleared = { active: false, field: 'all', query: '', total: 0, nextCursor: null }
      mailSearchRef.current = cleared
      setMailSearch(cleared)
      setHasMoreMessages(false)
    }
    setComposeDraft(null)
    setComposeMode(false)
    updateActiveKey(key)
  }

  function toggleAccount(accountId) {
    setCollapsedAccountIds(prev => {
      const next = new Set(prev)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      return next
    })
  }

  function resolveActiveFolder(sourceAccounts = accounts) {
    if (!activeKey.includes(':')) return null
    if (activeKey.startsWith(UNIFIED_KEY_PREFIX)) return null
    if (activeKey.startsWith(SMART_KEY_PREFIX)) return null
    const [accountId, folderKey] = activeKey.split(':')
    const account = sourceAccounts.find(item => item.id === accountId)
    const folder = (account?.folders || []).find(item => String(item.id || item.name) === folderKey)
    if (!account || !folder) return null
    return { account, folder }
  }

  function resolveActiveUnified(sourceMenus = unifiedMenus) {
    if (!activeKey.startsWith(UNIFIED_KEY_PREFIX)) return null
    const key = activeKey.slice(UNIFIED_KEY_PREFIX.length)
    return sourceMenus.find(item => item.key === key) || null
  }

  // 활성 스마트 폴더(태그 기반 통합 — MailService.md 13). activeKey = 'smart:<id>'
  function resolveActiveSmart(sourceFolders = smartFolders) {
    if (!activeKey.startsWith(SMART_KEY_PREFIX)) return null
    const id = activeKey.slice(SMART_KEY_PREFIX.length)
    return sourceFolders.find(item => item.id === id) || null
  }

  function buildMessageViewKey(key = activeKey, tenantId = currentTenantId) {
    const safeTenantId = String(tenantId || '').trim()
    const safeKey = String(key || '').trim()
    if (!safeKey) return ''
    if (safeKey.startsWith(SMART_KEY_PREFIX)) {
      const smartFolderId = safeKey.slice(SMART_KEY_PREFIX.length)
      return smartFolderId && safeTenantId ? `smart:${safeTenantId}:${smartFolderId}` : ''
    }
    if (safeKey.startsWith(UNIFIED_KEY_PREFIX)) {
      const unifiedKey = safeKey.slice(UNIFIED_KEY_PREFIX.length)
      return unifiedKey && safeTenantId ? `unified:${safeTenantId}:${unifiedKey}` : ''
    }
    return safeTenantId ? `folder:${safeTenantId}:${safeKey}` : ''
  }

  function buildActiveMessageRequest(sourceAccounts = accounts) {
    const tenantId = currentTenantId || sourceAccounts[0]?.tenant_id || ''

    if (activeKey.startsWith(SMART_KEY_PREFIX)) {
      const smartFolderId = activeKey.slice(SMART_KEY_PREFIX.length)
      if (!tenantId || !smartFolderId) return null
      return {
        kind: 'smart',
        tenantId,
        viewKey: buildMessageViewKey(activeKey, tenantId),
        params: new URLSearchParams({
          tenantId,
          scope: 'smart',
          smartFolderId,
          limit: String(MAIL_PAGE_SIZE),
          offset: '0',
        }),
      }
    }

    const active = resolveActiveFolder(sourceAccounts)
    if (active) {
      return {
        kind: 'folder',
        tenantId: active.account.tenant_id,
        viewKey: buildMessageViewKey(activeKey, active.account.tenant_id),
        params: new URLSearchParams({
          tenantId: active.account.tenant_id,
          accountId: active.account.id,
          folderId: active.folder.id,
          limit: String(MAIL_PAGE_SIZE),
          offset: '0',
        }),
      }
    }

    const unified = resolveActiveUnified()
    if (unified && tenantId) {
      return {
        kind: 'unified',
        tenantId,
        viewKey: buildMessageViewKey(activeKey, tenantId),
        params: new URLSearchParams({
          tenantId,
          scope: 'unified',
          unifiedKey: unified.key,
          folderType: unified.type || '',
          folderName: unified.folderName || '',
          limit: String(MAIL_PAGE_SIZE),
          offset: '0',
        }),
      }
    }

    return null
  }

  function markMessageReadInState(message) {
    if (!message?.id || message.is_read) return
    setMessages(prev => prev.map(item => (
      item.id === message.id ? { ...item, is_read: true } : item
    )))
    setAccounts(prev => prev.map(account => {
      if (account.id !== message.account_id) return account
      return {
        ...account,
        folders: (account.folders || []).map(folder => {
          if (folder.id !== message.folder_id) return folder
          return {
            ...folder,
            unread_count: Math.max(0, Number(folder.unread_count || 0) - 1),
          }
        }),
      }
    }))
  }

  function adjustFolderCounts({ accountId, folderId, totalDelta = 0, unreadDelta = 0, starredDelta = 0, starredUnreadDelta = 0 }) {
    if (!accountId || !folderId) return
    setAccounts(prev => prev.map(account => {
      if (account.id !== accountId) return account
      return {
        ...account,
        folders: (account.folders || []).map(folder => {
          if (folder.id !== folderId) return folder
          return {
            ...folder,
            message_count: Math.max(0, Number(folder.message_count || 0) + totalDelta),
            unread_count: Math.max(0, Number(folder.unread_count || 0) + unreadDelta),
            starred_count: Math.max(0, Number(folder.starred_count || 0) + starredDelta),
            starred_unread_count: Math.max(0, Number(folder.starred_unread_count || 0) + starredUnreadDelta),
          }
        }),
      }
    }))
  }

  function restoreMessagesBySnapshot(currentList, snapshotList, restoreIds) {
    if (!restoreIds?.size) return currentList
    const currentById = new Map(currentList.map(item => [String(item.id), item]))
    const snapshotIds = new Set(snapshotList.map(item => String(item.id)))
    const restored = []
    for (const item of snapshotList) {
      const id = String(item.id)
      if (restoreIds.has(id)) {
        restored.push(item)
      } else if (currentById.has(id)) {
        restored.push(currentById.get(id))
      }
    }
    for (const item of currentList) {
      if (!snapshotIds.has(String(item.id))) restored.push(item)
    }
    return restored
  }

  function getActionMessages(target) {
    const ids = Array.isArray(target?.targetIds) && target.targetIds.length
      ? new Set(target.targetIds)
      : new Set(target?.id ? [target.id] : target?.message?.id ? [target.message.id] : [])
    return messages.filter(item => ids.has(item.id))
  }

  function openMessageMenu(event, message, index) {
    event.preventDefault()
    event.stopPropagation()
    const isAlreadySelected = selectedMessageIds.includes(message.id)
    const targetIds = isAlreadySelected && selectedMessageIds.length > 0
      ? selectedMessageIds
      : [message.id]
    if (!isAlreadySelected) {
      setSelectedMessageIds([message.id])
      setLastSelectedMessageId(message.id)
    }
    // 원좌표만 저장하고, 실제 위치 보정은 useAnchoredMenuPosition이 렌더 후 실측으로 처리한다. (MailService.md 19.55)
    setMessageMenu({
      x: event.clientX,
      y: event.clientY,
      message,
      targetIds,
    })
  }

  function registerMailClawFromMessage(menu) {
    const message = menu?.message
    const senderEmail = String(message?.from_email || '').trim()
    if (!senderEmail) {
      setMessagesError('보낸 사람의 메일 주소를 확인할 수 없습니다.')
      return
    }
    const account = accounts.find(item => item.id === message.account_id)
    const tenantId = account?.tenant_id || message.tenant_id || currentTenantId || ''
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(senderEmail).catch(() => {})
    }
    setMailClawRegistration({
      id: `${message.id || senderEmail}:${Date.now()}`,
      senderEmail,
      tenantId,
    })
    setShowAccountModal(true)
  }

  async function registerMailClawTrashFromMessage(menu) {
    const message = menu?.message
    const senderEmail = String(message?.from_email || '').trim()
    if (!senderEmail) {
      setMessagesError('보낸 사람의 메일 주소를 확인할 수 없습니다.')
      return
    }
    const account = accounts.find(item => item.id === message.account_id)
    const tenantId = account?.tenant_id || message.tenant_id || currentTenantId || ''
    if (!tenantId) {
      setMessagesError('MailClaw를 등록할 메일 공간을 확인할 수 없습니다.')
      return
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(senderEmail).catch(() => {})
    }
    try {
      const rule = await apiFetch('/mail/mailclaw/trash-rule/register-sender', {
        method: 'POST',
        body: JSON.stringify({ tenantId, senderEmail }),
      })
      setMessagesError('')
      const count = Array.isArray(rule?.sender_conditions) ? rule.sender_conditions.length : 0
      showToast({
        message: `'${senderEmail}' 을(를) MailClaw 휴지통 이동 발신자 목록에 추가했습니다.${count ? ` (총 ${count}개)` : ''}`,
        tone: 'success',
      })
    } catch (err) {
      setMessagesError(err.message || 'MailClaw 휴지통 이동 규칙에 등록하지 못했습니다.')
    }
  }

  // 게시글로 등록 다이얼로그 열기 (MailService.md 23.2)
  function openRegisterAsPost(message, summary = null) {
    if (!message) return
    // 접근 가능한 팀이 아직 로드되지 않았으면 한 번 갱신 시도
    if (!Array.isArray(teams) || teams.length === 0) {
      refreshTeams?.().catch(() => {})
    }
    setPostDialog({ message, summary: summary || message.summary || null })
  }

  function registerAsPostFromMessage(menu) {
    const message = menu?.message
    if (!message) {
      setMessagesError('게시글로 등록할 메일을 확인할 수 없습니다.')
      return
    }
    openRegisterAsPost(message, message.summary || null)
  }

  function updateMessageNoteState(messageId, hasNote) {
    setMessages(prev => prev.map(item => (String(item.id) === String(messageId) ? { ...item, has_note: hasNote } : item)))
    setSelectedMessage(prev => (prev && String(prev.id) === String(messageId) ? { ...prev, has_note: hasNote } : prev))
    setMessageMenu(prev => (prev?.message && String(prev.message.id) === String(messageId)
      ? { ...prev, message: { ...prev.message, has_note: hasNote } }
      : prev))
  }

  // 새 게시글 또는 선택 게시글의 댓글로 등록 (MailService.md 23.5)
  async function submitRegisterAsPost({ channelId, postId, content, messageId, tenantId, mailAttachmentIds = [] }) {
    let attachmentIds = []
    const sourceAttachmentIds = Array.isArray(mailAttachmentIds)
      ? mailAttachmentIds.map(id => String(id || '').trim()).filter(Boolean).slice(0, 10)
      : []
    if (sourceAttachmentIds.length > 0) {
      const copied = await apiFetch(`/mail/messages/${encodeURIComponent(messageId)}/post-attachments`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId,
          channelId,
          attachmentIds: sourceAttachmentIds,
        }),
      })
      attachmentIds = (copied?.attachments || []).map(att => att.id).filter(Boolean)
    }
    if (postId) {
      await addComment(channelId, postId, content, currentUser, attachmentIds, undefined)
      showToast({ message: mt.postDialog.successComment, tone: 'success' })
    } else {
      await addPost(channelId, { content, attachmentIds }, { suppressAlert: true })
      showToast({ message: mt.postDialog.successPost, tone: 'success' })
    }
  }

  function openFolderMenu(event, account, folder) {
    event.preventDefault()
    event.stopPropagation()
    setFolderMenu({
      x: event.clientX,
      y: event.clientY,
      account,
      folder,
    })
  }

  function openUnifiedFolderMenu(event, folder) {
    event.preventDefault()
    event.stopPropagation()
    setUnifiedFolderMenu({
      x: event.clientX,
      y: event.clientY,
      folder,
    })
  }

  function clearMailSelection() {
    setSelectedMessage(null)
    setSelectedMessageIds([])
    setLastSelectedMessageId(null)
    setMessageDetailError('')
    setMessageMenu(null)
  }

	  async function emptyTrashFolder(menu) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id) return

    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      const result = await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}/trash?${params.toString()}`, {
        method: 'DELETE',
      })
      const purgedUnread = Number(result?.unread_count || folder.unread_count || 0)
      const purgedCount = Number(result?.count || folder.message_count || 0)
      setAccounts(prev => prev.map(item => {
        if (item.id !== account.id) return item
        return {
          ...item,
          folders: (item.folders || []).map(folderItem => (
            folderItem.id === folder.id
              ? { ...folderItem, message_count: 0, unread_count: 0 }
              : folderItem
          )),
        }
      }))
      const active = resolveActiveFolder()
      if (active?.folder?.id === folder.id) {
        setMessages([])
        clearMailSelection()
        setHasMoreMessages(false)
      }
      if (purgedCount > 0 || purgedUnread > 0) {
        setMessagesError('')
      }
    } catch (err) {
      setMessagesError(err.message || '휴지통을 비우지 못했습니다.')
    } finally {
      setPendingEmptyTrash(null)
    }
	  }

  // 통합 휴지통 비우기: 현재 tenant의 모든 계정 휴지통 폴더를 각각 비운다(계정별 기존 라우트 재사용). (MailService.md 15)
  function getUnifiedTrashTargets() {
    const targets = []
    for (const account of accounts) {
      if (currentTenantId && account.tenant_id !== currentTenantId) continue
      for (const folder of account.folders || []) {
        if (isMailTrashFolder(folder) && folder.id) targets.push({ account, folder })
      }
    }
    return targets
  }

  async function emptyUnifiedTrash() {
    const targets = getUnifiedTrashTargets()
    if (targets.length === 0) { setPendingEmptyUnifiedTrash(null); return }
    let purgedTotal = 0
    const failures = []
    for (const { account, folder } of targets) {
      try {
        const params = new URLSearchParams({ tenantId: account.tenant_id })
        const result = await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}/trash?${params.toString()}`, {
          method: 'DELETE',
        })
        purgedTotal += Number(result?.count || 0)
        // 계정별 휴지통 카운트 0으로 낙관적 갱신
        setAccounts(prev => prev.map(item => (
          item.id !== account.id ? item : {
            ...item,
            folders: (item.folders || []).map(f => (f.id === folder.id ? { ...f, message_count: 0, unread_count: 0 } : f)),
          }
        )))
      } catch (err) {
        const label = getAccountLabel(account) || account.email_address || account.id
        failures.push({ label, message: err.message || '알 수 없는 오류' })
        console.warn(`[통합 휴지통 비우기] ${account.email_address} 실패: ${err.message}`)
      }
    }
    // 통합 휴지통 뷰를 보고 있었다면 목록 비움
    if (resolveActiveUnified()?.key === 'trash') {
      setMessages([])
      clearMailSelection()
      setHasMoreMessages(false)
    }
    // 실패 시 어떤 계정이 왜 실패했는지 함께 노출한다.
    setMessagesError(
      failures.length > 0
        ? `일부 계정의 휴지통을 비우지 못했습니다. (${failures.length}개 실패) — `
          + failures.map(f => `${f.label}: ${f.message}`).join(' / ')
        : '',
    )
    setPendingEmptyUnifiedTrash(null)
  }

  function openFolderNameDialog(config) {
    setFolderNameDialog(config)
    setFolderNameDialogLoading(false)
  }

  async function confirmFolderNameDialog(name) {
    const handler = folderNameDialog?.onSubmit
    if (!handler) return
    setFolderNameDialogLoading(true)
    try {
      await handler(name)
      setFolderNameDialog(null)
    } catch (err) {
      setMessagesError(err.message || '작업을 완료하지 못했습니다.')
    } finally {
      setFolderNameDialogLoading(false)
    }
  }

  function createMailFolder(menu, parentFolder = null) {
    const fm = mt.folderMenu
    openFolderNameDialog({
      title: parentFolder ? fm.newSubFolderTitle : fm.newFolderTitle,
      message: parentFolder ? fm.newSubFolderMessage : fm.newFolderMessage,
      initialValue: '',
      onSubmit: name => submitCreateMailFolder(menu, parentFolder, name),
    })
  }

  async function submitCreateMailFolder(menu, parentFolder = null, cleanName) {
    const account = menu?.account
    if (!account?.id || !account?.tenant_id) return
    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      const result = await apiFetch(`/mail/accounts/${account.id}/folders?${params.toString()}`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: account.tenant_id,
          name: cleanName,
          parentFolderId: parentFolder?.id || '',
        }),
      })
      const folder = result?.folder
      if (!folder?.id) return
      setAccounts(prev => prev.map(item => (
        item.id === account.id
          ? { ...item, folders: [...(item.folders || []).filter(existing => existing.id !== folder.id), folder] }
          : item
      )))
      updateActiveKey(`${account.id}:${folder.id}`)
      setComposeMode(false)
    } catch (err) {
      throw new Error(err.message || '폴더를 추가하지 못했습니다.')
    }
  }

  // 폴더 삭제: 네이티브 confirm 대신 ConfirmDialog로 확인을 받는다. 실제 삭제는 performDeleteMailFolder.
  function deleteMailFolder(menu) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id || !account?.tenant_id || isSystemMailFolder(folder)) return
    // 프로바이더별 파괴성이 다르므로 확인 문구를 분기한다. (MailService.md 16.11)
    //   - Gmail(라벨 삭제, 비파괴): 메일은 전체보관함에 남는다.
    //   - IMAP(메일함 삭제, 파괴적): 폴더와 그 안의 메일이 서버에서 영구 삭제된다.
    const label = getMailFolderLabel(folder)
    const msgCount = Number(folder.message_count || 0)
    let message
    if (folder.is_local) {
      message = `"${label}" 폴더를 삭제하시겠습니까?`
    } else if (account.provider === 'gmail') {
      message = `"${label}" 라벨을 삭제합니다.\n메일은 삭제되지 않고 전체보관함에 남습니다.`
    } else {
      message = `"${label}" 폴더${msgCount > 0 ? `와 그 안의 메일 ${msgCount}개` : ''}가 서버에서 영구 삭제됩니다.\n이 작업은 복구할 수 없습니다.`
    }
    setPendingDeleteFolder({ account, folder, message, danger: !folder.is_local })
  }

  async function performDeleteMailFolder(pending) {
    if (!pending) return
    const { account, folder } = pending
    setPendingDeleteFolder(null)
    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      const result = await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}?${params.toString()}`, {
        method: 'DELETE',
      })
      setAccounts(prev => prev.map(item => (
        item.id === account.id
          ? { ...item, folders: (item.folders || []).filter(existing => existing.id !== folder.id && existing.parent_folder_id !== folder.id) }
          : item
      )))
      const active = resolveActiveFolder()
      if (active?.folder?.id === folder.id) {
        updateActiveKey(`${UNIFIED_KEY_PREFIX}inbox`)
        setMessages([])
        clearMailSelection()
      }
      if (Number(result?.purgedMessages || 0) > 0) {
        setMessagesError(`폴더를 삭제했습니다. (메일 ${result.purgedMessages}개 영구 삭제)`)
      }
    } catch (err) {
      // 서버가 영구 거부(server_rejected)한 폴더만 백엔드가 deletable=false로 학습한다.
      // has_children(하위 폴더 정리 후 삭제 가능)은 학습하지 않으므로 로컬 상태도 건드리지 않는다.
      // 로컬 상태도 즉시 반영해 재조회 없이 삭제 메뉴가 비활성화되도록 한다. (folder_delete_error.md 2번, MailService.md 22)
      if (err.status === 409 && err.reason !== 'has_children') {
        setAccounts(prev => prev.map(item => (
          item.id === account.id
            ? { ...item, folders: (item.folders || []).map(existing => (
                existing.id === folder.id ? { ...existing, deletable: false } : existing
              )) }
            : item
        )))
      }
      setMessagesError(err.message || '폴더를 삭제하지 못했습니다.')
    }
  }

  async function setMailFolderColor(menu, colorKey) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id || !account?.tenant_id) return
    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      const result = await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ tenantId: account.tenant_id, colorKey }),
      })
      const nextFolder = result?.folder || { ...folder, color_key: colorKey || null }
      setAccounts(prev => prev.map(item => (
        item.id === account.id
          ? {
              ...item,
              folders: (item.folders || []).map(existing => (
                existing.id === folder.id ? { ...existing, color_key: nextFolder.color_key || null } : existing
              )),
            }
          : item
      )))
    } catch (err) {
      setMessagesError(err.message || '폴더 색상을 변경하지 못했습니다.')
    }
  }

  // 폴더 이름 변경 — 로컬 전용은 DB만, 프로바이더 폴더는 서버가 프로바이더에 반영. (MailService.md 16)
  function renameMailFolder(menu) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id || !account?.tenant_id) return
    const fm = mt.folderMenu
    openFolderNameDialog({
      title: fm.renameFolderTitle,
      message: fm.renameFolderMessage,
      initialValue: folder.name || '',
      onSubmit: name => submitRenameMailFolder(menu, name),
    })
  }

  async function submitRenameMailFolder(menu, newName) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id || !account?.tenant_id) return
    if (!newName || newName === (folder.name || '')) return
    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      const result = await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ tenantId: account.tenant_id, name: newName }),
      })
      const nextFolder = result?.folder || { ...folder, name: newName }
      setAccounts(prev => prev.map(item => (
        item.id === account.id
          ? {
              ...item,
              folders: (item.folders || []).map(existing => (
                existing.id === folder.id
                  ? { ...existing, name: nextFolder.name, provider_folder_id: nextFolder.provider_folder_id || existing.provider_folder_id }
                  : existing
              )),
            }
          : item
      )))
    } catch (err) {
      throw new Error(err.message || '폴더 이름을 변경하지 못했습니다.')
    }
  }

  function setUnifiedFolderColor(menu, colorKey) {
    const folder = menu?.folder
    if (!folder?.key || !currentTenantId) return
    const storageKey = `${currentTenantId}:${folder.key}`
    setUnifiedFolderColors(prev => {
      const next = { ...prev }
      if (colorKey) next[storageKey] = colorKey
      else delete next[storageKey]
      try {
        window.localStorage.setItem(UNIFIED_FOLDER_COLOR_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // localStorage가 막힌 환경에서는 현재 화면 상태만 유지한다.
      }
      return next
    })
  }

  async function markMessageUnread(target) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target)
    const tenantId = targets[0]?.tenant_id || active?.account?.tenant_id || currentTenantId
    if (!tenantId || targets.length === 0) return
    try {
      const params = new URLSearchParams({ tenantId })
      await apiFetch(`/mail/messages/bulk?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'mark_unread', messageIds: targets.map(item => item.id) }),
      })
      const targetIds = new Set(targets.map(item => item.id))
      setMessages(prev => prev.map(item => (
        targetIds.has(item.id) ? { ...item, is_read: false } : item
      )))
      setSelectedMessage(prev => (
        prev && targetIds.has(prev.id) ? { ...prev, is_read: false } : prev
      ))
      for (const message of targets) {
        if (message.is_read) {
          adjustFolderCounts({ accountId: message.account_id, folderId: message.folder_id, unreadDelta: 1 })
        }
      }
    } catch (err) {
      setMessagesError(err.message || '메일 상태를 변경하지 못했습니다.')
    }
  }

  // 중요(별표) 토글 — 선택 묶음 전체를 starred로 설정/해제. (MailService.md 14)
  async function toggleMessagesStarred(target, starred) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target)
    const tenantId = targets[0]?.tenant_id || active?.account?.tenant_id || currentTenantId
    if (!tenantId || targets.length === 0) return
    try {
      const params = new URLSearchParams({ tenantId })
      await apiFetch(`/mail/messages/bulk?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: starred ? 'star' : 'unstar', messageIds: targets.map(item => item.id) }),
      })
      const targetIds = new Set(targets.map(item => item.id))
      setMessages(prev => {
        const next = prev.map(item => (targetIds.has(item.id) ? { ...item, is_starred: starred } : item))
        // 별표됨 뷰에서 '해제'하면 조건을 벗어나므로 목록에서 제거한다.
        return resolveActiveUnified()?.key === 'starred' && !starred
          ? next.filter(item => !targetIds.has(item.id))
          : next
      })
      setSelectedMessage(prev => (prev && targetIds.has(prev.id) ? { ...prev, is_starred: starred } : prev))
      // 별표됨 사이드바 배지를 낙관적으로 갱신한다. (이미 목표 상태인 건은 서버가 no-op이므로 카운트 변화 없음)
      for (const message of targets) {
        if (!!message.is_starred === starred) continue
        adjustFolderCounts({
          accountId: message.account_id,
          folderId: message.folder_id,
          starredDelta: starred ? 1 : -1,
          starredUnreadDelta: message.is_read ? 0 : (starred ? 1 : -1),
        })
      }
      window.dispatchEvent(new CustomEvent('easy-mail-starred-changed', {
        detail: {
          tenantId,
          starred,
          messageIds: targets.map(item => item.id),
        },
      }))
    } catch (err) {
      setMessagesError(err.message || '중요 표시를 변경하지 못했습니다.')
    }
  }

  async function deleteMessage(target) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target)
    const tenantId = targets[0]?.tenant_id || active?.account?.tenant_id || currentTenantId
    if (!tenantId || targets.length === 0) return
    const targetIds = new Set(targets.map(item => String(item.id)))
    const snapshotMessages = messages
    const snapshotSelectedMessage = selectedMessage
    const snapshotSelectedMessageIds = selectedMessageIds

    setLastSelectedMessageId(null)
    setMessages(prev => prev.filter(item => !targetIds.has(String(item.id))))
    setSelectedMessage(prev => (prev && targetIds.has(String(prev.id)) ? null : prev))
    setSelectedMessageIds(prev => prev.filter(id => !targetIds.has(String(id))))
    setMessagesError('')
    for (const message of targets) {
      adjustFolderCounts({
        accountId: message.account_id,
        folderId: message.folder_id,
        totalDelta: -1,
        unreadDelta: message.is_read ? 0 : -1,
      })
    }

    try {
      const params = new URLSearchParams({ tenantId })
      const result = await apiFetch(`/mail/messages/bulk?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'delete', messageIds: targets.map(item => item.id) }),
      })
      const resultById = new Map((result?.results || []).map(item => [String(item.id), item]))
      const successTargets = targets.filter(message => resultById.get(String(message.id))?.ok)
      const failedTargets = targets.filter(message => !resultById.get(String(message.id))?.ok)
      const failedIds = new Set(failedTargets.map(item => String(item.id)))

      if (failedTargets.length > 0) {
        console.warn('[mail delete] 일부 메일 삭제 실패', {
          requested: targets.length,
          failed: failedTargets.length,
          results: failedTargets.map(message => {
            const item = resultById.get(String(message.id))
            return {
              messageId: String(message.id),
              error: item?.error || '서버에서 삭제 성공 결과를 반환하지 않았습니다.',
            }
          }),
        })
        setMessages(prev => restoreMessagesBySnapshot(prev, snapshotMessages, failedIds))
        if (snapshotSelectedMessage && failedIds.has(String(snapshotSelectedMessage.id))) {
          setSelectedMessage(snapshotSelectedMessage)
        }
        setSelectedMessageIds(prev => {
          const existing = new Set(prev.map(String))
          const restoredIds = snapshotSelectedMessageIds.filter(id => failedIds.has(String(id)) && !existing.has(String(id)))
          return [...prev, ...restoredIds]
        })
        for (const message of failedTargets) {
          adjustFolderCounts({
            accountId: message.account_id,
            folderId: message.folder_id,
            totalDelta: 1,
            unreadDelta: message.is_read ? 0 : 1,
          })
        }
      }

      for (const message of successTargets) {
        const resultItem = resultById.get(String(message.id))
        const targetFolderId = resultItem?.message?.trash_folder_id || resultItem?.message?.folder_id
        if (targetFolderId && targetFolderId !== message.folder_id && !resultItem?.message?.soft_deleted) {
          adjustFolderCounts({
            accountId: message.account_id,
            folderId: targetFolderId,
            totalDelta: 1,
            unreadDelta: message.is_read ? 0 : 1,
          })
        }
      }
      // 삭제/휴지통 이동은 스마트 폴더 태그 집계에서도 빠지므로 배지를 갱신한다. (MailService.md 13)
      await Promise.all([
        reloadSmartFolders().catch(() => {}),
        reloadUnclassifiedCounts().catch(() => {}),
      ])
      setMessagesError(failedTargets.length > 0 ? '일부 메일을 삭제하지 못했습니다.' : '')
    } catch (err) {
      setMessages(prev => restoreMessagesBySnapshot(prev, snapshotMessages, targetIds))
      setSelectedMessage(snapshotSelectedMessage)
      setSelectedMessageIds(snapshotSelectedMessageIds)
      for (const message of targets) {
        adjustFolderCounts({
          accountId: message.account_id,
          folderId: message.folder_id,
          totalDelta: 1,
          unreadDelta: message.is_read ? 0 : 1,
        })
      }
      setMessagesError(err.message || '메일을 삭제하지 못했습니다.')
    }
  }


  async function moveMessage(target, folder) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target).filter(item => item.folder_id !== folder?.id)
    const tenantId = targets[0]?.tenant_id || active?.account?.tenant_id || currentTenantId
    if (!tenantId || targets.length === 0 || !folder?.id) return
    try {
      const params = new URLSearchParams({ tenantId })
      const data = await apiFetch(`/mail/messages/bulk?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'move', targetFolderId: folder.id, messageIds: targets.map(item => item.id) }),
      })
      // 서버가 실제로 이동에 성공한 건만 반영한다. 실패 건은 목록에서 지우지 않아
      // "원본·대상 양쪽에서 사라지는" 현상을 막는다. (MailService.md 11.5.1)
      const movedIds = new Set(
        (Array.isArray(data?.results) ? data.results : [])
          .filter(item => item?.ok)
          .map(item => String(item.id)),
      )
      const moved = targets.filter(item => movedIds.has(String(item.id)))
      if (moved.length === 0) {
        setMessagesError('메일을 이동하지 못했습니다. (대상 폴더/계정을 확인하세요)')
        return
      }
      const movedSet = new Set(moved.map(item => item.id))
      setLastSelectedMessageId(null)
      setMessages(prev => prev.filter(item => !movedSet.has(item.id)))
      setSelectedMessage(prev => (prev && movedSet.has(prev.id) ? null : prev))
      setSelectedMessageIds(prev => prev.filter(id => !movedSet.has(id)))
      for (const message of moved) {
        adjustFolderCounts({
          accountId: message.account_id,
          folderId: message.folder_id,
          totalDelta: -1,
          unreadDelta: message.is_read ? 0 : -1,
        })
        adjustFolderCounts({
          accountId: message.account_id,
          folderId: folder.id,
          totalDelta: 1,
          unreadDelta: message.is_read ? 0 : 1,
        })
      }
      // 휴지통/스팸으로 이동하면 스마트 폴더 집계에서 빠지므로 배지를 갱신한다. (MailService.md 13)
      await reloadSmartFolders().catch(() => {})
      setMessagesError(moved.length < targets.length ? '일부 메일을 이동하지 못했습니다.' : '')
    } catch (err) {
      setMessagesError(err.message || '메일을 이동하지 못했습니다.')
    }
  }

  // 드롭 유효 타깃: 실제 폴더(folder.id 보유)만. 서버에 없는 로컬 표시 폴더(missing)는 제외. (MailService.md 11.4)
  function isDroppableFolder(folder) {
    return Boolean(folder?.id) && folder.sync_status !== 'missing'
  }

  // 폴더 버튼 위 dragover: 커스텀 MIME(메일 id 목록)일 때만 드롭을 허용하고 하이라이트한다.
  function handleFolderDragOver(event, folder, key) {
    if (!isDroppableFolder(folder) || !event.dataTransfer.types.includes('application/x-mail-ids')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropTargetKey !== key) setDropTargetKey(key)
  }

  function handleFolderDragLeave(event, key) {
    // 버튼 내부 자식으로 이동하는 경우(relatedTarget 포함)는 유지, 완전히 벗어날 때만 해제한다.
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setDropTargetKey(prev => (prev === key ? null : prev))
    }
  }

  // 폴더 버튼에 드롭: id 목록을 파싱해 기존 moveMessage로 이동한다(다중/단건 규칙은 이미 반영). (MailService.md 11.2)
  function handleFolderDrop(event, folder) {
    setDropTargetKey(null)
    if (!isDroppableFolder(folder)) return
    const raw = event.dataTransfer.getData('application/x-mail-ids')
    if (!raw) return
    event.preventDefault()
    let ids
    try { ids = JSON.parse(raw) } catch { return }
    if (!Array.isArray(ids) || ids.length === 0) return
    moveMessage({ targetIds: ids }, folder)
  }

  // 통합 메뉴는 여러 계정을 집계한 가상 항목이라 단일 folder.id가 없다.
  // 드롭 시 각 메일의 계정 안에서 type(inbox/trash) 또는 이름으로 실제 폴더를 해석한다. (MailService.md 11.5.1)
  function resolveUnifiedTargetFolder(account, item) {
    const folders = account?.folders || []
    if (item?.type) return folders.find(folder => String(folder.type || '') === item.type) || null
    if (item?.folderName) {
      const target = normalizeFolderName(item.folderName)
      return folders.find(folder => normalizeFolderName(folder.name) === target) || null
    }
    return null
  }

  // 통합 메뉴 유효 드롭 타깃: 받은 편지함·휴지통·사용자 지정 이름 폴더만.
  // 모든 편지함/별표됨/검색은 실제 대상이 없어 제외, 보낸 메일/임시 보관함은 의미 모호로 1차 제외. (MailService.md 11.5.1)
  function isDroppableUnified(item) {
    if (!item) return false
    if (item.type === 'inbox' || item.type === 'trash') return true
    return Boolean(item.folderName) && String(item.key || '').startsWith('name:')
  }

  // 선택이 여러 계정에 걸칠 수 있으므로, 해석된 대상 folder.id 기준으로 그룹핑해 그룹마다 기존 moveMessage로 이동한다.
  async function moveMessagesToUnified(ids, item) {
    const idSet = new Set(ids)
    const targets = messages.filter(message => idSet.has(message.id))
    if (targets.length === 0) return
    const groups = new Map()
    for (const message of targets) {
      const account = accounts.find(acc => acc.id === message.account_id)
      const folder = resolveUnifiedTargetFolder(account, item)
      if (!folder?.id || folder.id === message.folder_id) continue
      const group = groups.get(folder.id) || { folder, ids: [] }
      group.ids.push(message.id)
      groups.set(folder.id, group)
    }
    for (const group of groups.values()) {
      await moveMessage({ targetIds: group.ids }, group.folder)
    }
  }

  function handleUnifiedDragOver(event, item, key) {
    if (!isDroppableUnified(item) || !event.dataTransfer.types.includes('application/x-mail-ids')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropTargetKey !== key) setDropTargetKey(key)
  }

  function handleUnifiedDrop(event, item) {
    setDropTargetKey(null)
    if (!isDroppableUnified(item)) return
    const raw = event.dataTransfer.getData('application/x-mail-ids')
    if (!raw) return
    event.preventDefault()
    let ids
    try { ids = JSON.parse(raw) } catch { return }
    if (!Array.isArray(ids) || ids.length === 0) return
    moveMessagesToUnified(ids, item)
  }

  // 스마트 폴더 드롭(MailService.md 13.4/13.5): 이동이 아니라 "태그 부여 + 각 계정 내 아카이브".
  function handleSmartDragOver(event, key) {
    if (!event.dataTransfer.types.includes('application/x-mail-ids')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (dropTargetKey !== key) setDropTargetKey(key)
  }

  function handleSmartDrop(event, smartFolder) {
    setDropTargetKey(null)
    const raw = event.dataTransfer.getData('application/x-mail-ids')
    if (!raw) return
    event.preventDefault()
    let ids
    try { ids = JSON.parse(raw) } catch { return }
    if (!Array.isArray(ids) || ids.length === 0) return
    const sourceSmart = resolveActiveSmart()
    if (sourceSmart && sourceSmart.id === smartFolder.id) return // 같은 스마트 폴더로 드롭 = 무동작
    if (sourceSmart) {
      // 스마트 폴더 → 스마트 폴더: "이동"으로 처리(대상 태그 + 원본 태그 해제, 아카이브 안 함).
      moveMessagesBetweenSmartFolders(ids, sourceSmart, smartFolder)
    } else {
      // 그 외(받은편지함/폴더/통합)에서 스마트 폴더로: 태그 부여 + 각 계정 내 아카이브.
      tagMessagesToSmartFolder(ids, smartFolder, { archive: true })
    }
  }

  // 태그 부여(+아카이브) 실행. archive면 각 메일을 자기 계정 보관함으로 이동해 목록/카운트를 갱신한다.
  async function tagMessagesToSmartFolder(ids, smartFolder, { archive = false } = {}) {
    if (!smartFolder?.id || !currentTenantId) return
    try {
      const data = await apiFetch(`/mail/smart-folders/${smartFolder.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ tenantId: currentTenantId, messageIds: ids, archive }),
      })
      const archivedSet = new Set(Array.isArray(data?.archived) ? data.archived : [])
      // 아카이브된 메일은 원 폴더에서 빠졌으므로, 현재 뷰가 스마트 폴더가 아니면 목록에서 제거한다.
      const viewingThisSmart = activeKey === `${SMART_KEY_PREFIX}${smartFolder.id}`
      if (archivedSet.size > 0 && !viewingThisSmart) {
        setLastSelectedMessageId(null)
        setMessages(prev => prev.filter(item => !archivedSet.has(item.id)))
        setSelectedMessage(prev => (prev && archivedSet.has(prev.id) ? null : prev))
      }
      setSelectedMessageIds(prev => prev.filter(id => !archivedSet.has(id)))
      // 리스트에 남아 있는(아카이브로 빠지지 않은) 메일에는 태그 칩을 낙관적으로 추가한다(18.5).
      const taggedSet = new Set(Array.isArray(data?.tagged) ? data.tagged : ids)
      const tagChip = { id: smartFolder.id, name: smartFolder.name, color_key: smartFolder.color_key ?? null }
      const viewingUnclassified = activeKey === `${UNIFIED_KEY_PREFIX}all`
      setMessages(prev => prev.map(item => {
        if (!taggedSet.has(item.id) || archivedSet.has(item.id)) return item
        const existing = Array.isArray(item.tags) ? item.tags : []
        if (existing.some(tag => tag.id === tagChip.id)) return item
        return { ...item, tags: [...existing, tagChip] }
      }).filter(item => !viewingUnclassified || !taggedSet.has(item.id)))
      if (viewingUnclassified) {
        setLastSelectedMessageId(null)
        setSelectedMessage(prev => (prev && taggedSet.has(prev.id) ? null : prev))
        setSelectedMessageIds(prev => prev.filter(id => !taggedSet.has(id)))
      }
      // 스마트 폴더 카운트 + (아카이브로 원 폴더가 줄었으면) 계정 폴더 카운트 갱신
      await Promise.all([
        reloadSmartFolders().catch(() => {}),
        reloadUnclassifiedCounts().catch(() => {}),
      ])
      if (archivedSet.size > 0) await reloadMailAccounts().catch(() => {})
      const taggedCount = Array.isArray(data?.tagged) ? data.tagged.length : 0
      showToast?.({
        message: taggedCount > 0
          ? `${taggedCount}개를 "${smartFolder.name}"에 담았습니다${archivedSet.size ? ` (${archivedSet.size}개 보관함 이동)` : ''}.`
          : `이미 "${smartFolder.name}"에 담겨 있습니다.`,
        tone: taggedCount > 0 ? 'success' : 'default',
      })
    } catch (err) {
      setMessagesError(err.message || '스마트 폴더에 담지 못했습니다.')
    }
  }

  // 스마트 폴더 간 이동: 대상 스마트 폴더에 태그하고, 원본(현재 보던) 스마트 폴더에서 태그를 해제한다.
  // 계정 폴더/프로바이더는 건드리지 않는다(아카이브 없음) — 스마트 폴더 소속만 재구성.
  async function moveMessagesBetweenSmartFolders(ids, sourceSmart, targetSmart) {
    if (!sourceSmart?.id || !targetSmart?.id || !currentTenantId) return
    try {
      await apiFetch(`/mail/smart-folders/${targetSmart.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ tenantId: currentTenantId, messageIds: ids, archive: false }),
      })
      await apiFetch(`/mail/smart-folders/${sourceSmart.id}/messages`, {
        method: 'DELETE',
        body: JSON.stringify({ tenantId: currentTenantId, messageIds: ids }),
      })
      // 현재 원본 스마트 폴더 뷰에서 이동한 메일을 목록에서 제거
      const idSet = new Set(ids)
      setLastSelectedMessageId(null)
      setMessages(prev => prev.filter(item => !idSet.has(item.id)))
      setSelectedMessage(prev => (prev && idSet.has(prev.id) ? null : prev))
      setSelectedMessageIds(prev => prev.filter(id => !idSet.has(id)))
      await reloadSmartFolders().catch(() => {})
      showToast?.({ message: `${ids.length}개를 "${sourceSmart.name}" → "${targetSmart.name}"으로 이동했습니다.`, tone: 'success' })
    } catch (err) {
      setMessagesError(err.message || '스마트 폴더 간 이동에 실패했습니다.')
    }
  }

  function toggleSmartSection() {
    setSmartSectionCollapsed(prev => {
      const next = !prev
      try { window.localStorage.setItem('mail-smart-section-collapsed', next ? '1' : '0') } catch { /* noop */ }
      return next
    })
  }

  function createSmartFolderPrompt() {
    if (!currentTenantId) return
    const fm = mt.folderMenu
    openFolderNameDialog({
      title: fm.newSmartFolderTitle,
      message: fm.newSmartFolderMessage,
      initialValue: '',
      onSubmit: submitCreateSmartFolder,
    })
  }

  async function submitCreateSmartFolder(name) {
    if (!currentTenantId) return
    try {
      await apiFetch('/mail/smart-folders', {
        method: 'POST',
        body: JSON.stringify({ tenantId: currentTenantId, name }),
      })
      await reloadSmartFolders()
    } catch (err) {
      throw new Error(err.message || '스마트 폴더를 만들지 못했습니다.')
    }
  }

  function openSmartFolderMenu(event, folder) {
    event.preventDefault()
    event.stopPropagation()
    setSmartFolderMenu({
      x: event.clientX,
      y: event.clientY,
      folder,
    })
  }

  function renameSmartFolder(folder) {
    if (!folder?.id || !currentTenantId) return
    const fm = mt.folderMenu
    openFolderNameDialog({
      title: fm.renameSmartFolderTitle,
      message: fm.renameSmartFolderMessage,
      initialValue: folder.name || '',
      onSubmit: name => submitRenameSmartFolder(folder, name),
    })
  }

  async function submitRenameSmartFolder(folder, name) {
    if (!folder?.id || !currentTenantId) return
    if (!name || name === folder.name) return
    try {
      await apiFetch(`/mail/smart-folders/${folder.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ tenantId: currentTenantId, name }),
      })
      await reloadSmartFolders()
    } catch (err) {
      throw new Error(err.message || '스마트 폴더 이름을 변경하지 못했습니다.')
    }
  }

  async function deleteSmartFolder(folder) {
    if (!folder?.id || !currentTenantId) return
    if (!window.confirm(`"${folder.name}" 스마트 폴더를 삭제할까요?\n메일 원본은 각 계정에 그대로 남고, 이 폴더의 태그만 사라집니다.`)) return
    try {
      await apiFetch(`/mail/smart-folders/${folder.id}?tenantId=${encodeURIComponent(currentTenantId)}`, { method: 'DELETE' })
      if (activeKey === `${SMART_KEY_PREFIX}${folder.id}`) updateActiveKey(`${UNIFIED_KEY_PREFIX}all`)
      await Promise.all([reloadSmartFolders(), reloadUnclassifiedCounts()])
      if (activeKey === `${UNIFIED_KEY_PREFIX}all`) await loadActiveMessages()
    } catch (err) {
      setMessagesError(err.message || '스마트 폴더를 삭제하지 못했습니다.')
    }
  }

  async function setSmartFolderColor(folder, colorKey) {
    if (!folder?.id || !currentTenantId) return
    try {
      await apiFetch(`/mail/smart-folders/${folder.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ tenantId: currentTenantId, color_key: colorKey || '' }),
      })
      await reloadSmartFolders()
    } catch (err) {
      setMessagesError(err.message || '색상을 변경하지 못했습니다.')
    }
  }

  async function loadActiveMessages(sourceAccounts = accounts, options = {}) {
    setComposeMode(false)
    const { silent = false, resetSelection = true } = options
    const requestSeq = ++messageLoadSeqRef.current
    const request = buildActiveMessageRequest(sourceAccounts)
    const latestViewKeyForRequest = () => buildMessageViewKey(
      activeKeyRef.current,
      request?.kind === 'folder' ? request.tenantId : currentTenantIdRef.current,
    )
    const isCurrentRequest = () => (
      requestSeq === messageLoadSeqRef.current
      && request?.viewKey
      && request.viewKey === latestViewKeyForRequest()
    )
    if (!request) {
      setMessages([])
      setMessagesError('')
      setSelectedMessage(null)
      setSelectedMessageIds([])
      setLastSelectedMessageId(null)
      setMessageDetailError('')
      setHasMoreMessages(false)
      return
    }
    if (!silent) setMessagesLoading(true)
    setMessagesError('')
    try {
      const rows = await apiFetch(`/mail/messages?${request.params.toString()}`)
      if (!isCurrentRequest()) return
      const list = Array.isArray(rows) ? rows : []
      if (request.kind === 'unified' && activeKeyRef.current === `${UNIFIED_KEY_PREFIX}all`) {
        reloadUnclassifiedCounts(request.tenantId).catch(() => {})
      }
      const preserved = preserveSelectionOnNextLoadRef.current
      const nextList = preserved?.id
        ? (
            list.some(item => item.id === preserved.id)
              ? list.map(item => (item.id === preserved.id ? { ...item, ...preserved.message } : item))
              : [preserved.message, ...list]
          )
        : list
      setMessages(nextList)
      setHasMoreMessages(list.length === MAIL_PAGE_SIZE)
      if (resetSelection) {
        if (preserved?.id) {
          setSelectedMessage(preserved.message)
          setSelectedMessageIds([preserved.id])
          setLastSelectedMessageId(null)
          setMessageDetailError('')
          preserveSelectionOnNextLoadRef.current = null
        } else {
          setSelectedMessage(null)
          setSelectedMessageIds([])
          setLastSelectedMessageId(null)
          setMessageDetailError('')
        }
      }
    } catch (err) {
      if (!isCurrentRequest()) return
      setMessagesError(err.message || '메일 목록을 불러오지 못했습니다.')
    } finally {
      if (!silent && requestSeq === messageLoadSeqRef.current) setMessagesLoading(false)
    }
  }

  // 무한 스크롤: 다음 페이지를 이어서 불러온다.
  async function loadMoreMessages() {
    if (mailSearchRef.current.active) {
      if (loadingMore || messagesLoading || !hasMoreMessages) return
      await runMailSearch(mailSearchRef.current, { append: true })
      return
    }
    const active = resolveActiveFolder()
    const unified = resolveActiveUnified()
    const smartFolderId = activeKey.startsWith(SMART_KEY_PREFIX) ? activeKey.slice(SMART_KEY_PREFIX.length) : ''
    const tenantId = currentTenantId
    if ((!active && !unified && !smartFolderId) || loadingMore || messagesLoading || !hasMoreMessages) return
    if (smartFolderId && !tenantId) return
    const requestSeq = ++loadMoreSeqRef.current
    const requestOffset = messages.length
    const requestKind = active ? 'folder' : smartFolderId ? 'smart' : 'unified'
    const requestTenantId = active ? active.account.tenant_id : tenantId
    const requestViewKey = buildMessageViewKey(activeKey, requestTenantId)
    const latestViewKeyForRequest = () => buildMessageViewKey(
      activeKeyRef.current,
      requestKind === 'folder' ? requestTenantId : currentTenantIdRef.current,
    )
    const isCurrentRequest = () => (
      requestSeq === loadMoreSeqRef.current
      && requestViewKey
      && requestViewKey === latestViewKeyForRequest()
      && requestOffset === messagesLengthRef.current
    )
    setLoadingMore(true)
    try {
      const params = active
        ? new URLSearchParams({
            tenantId: active.account.tenant_id,
            accountId: active.account.id,
            folderId: active.folder.id,
            limit: String(MAIL_PAGE_SIZE),
            offset: String(messages.length),
          })
        : smartFolderId
          ? new URLSearchParams({
              tenantId,
              scope: 'smart',
              smartFolderId,
              limit: String(MAIL_PAGE_SIZE),
              offset: String(messages.length),
            })
          : new URLSearchParams({
            tenantId,
            scope: 'unified',
            unifiedKey: unified.key,
            folderType: unified.type || '',
            folderName: unified.folderName || '',
            limit: String(MAIL_PAGE_SIZE),
            offset: String(messages.length),
          })
      const rows = await apiFetch(`/mail/messages?${params.toString()}`)
      if (!isCurrentRequest()) return
      const list = Array.isArray(rows) ? rows : []
      setMessages(prev => {
        const existingIds = new Set(prev.map(item => String(item.id)))
        const uniqueList = list.filter(item => !existingIds.has(String(item.id)))
        return [...prev, ...uniqueList]
      })
      setHasMoreMessages(list.length === MAIL_PAGE_SIZE)
    } catch {
      // 추가 로드 실패는 다음 스크롤에서 재시도
    } finally {
      if (requestSeq === loadMoreSeqRef.current) setLoadingMore(false)
    }
  }

  function handleMessagesScroll(e) {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
      loadMoreMessages()
    }
  }

  async function refreshMail() {
    setRefreshLoading(true)
    setMessagesError('')
    try {
      const syncResult = await apiFetch('/mail/sync-all', {
        method: 'POST',
        body: JSON.stringify({ full: true }),
      })
      showAccountSyncErrors(syncResult?.accounts, { force: true })
      const nextAccounts = await reloadMailAccounts()
      if (mailSearchRef.current.active) {
        await runMailSearch(mailSearchRef.current)
      } else {
        await loadActiveMessages(nextAccounts, { silent: true, resetSelection: false })
      }
    } catch (err) {
      setMessagesError(err.message || '메일 새로고침에 실패했습니다.')
    } finally {
      setRefreshLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedMessage?.id || composeMode) return undefined
    const tenantId = selectedMessage.tenant_id || currentTenantId
    if (!tenantId) return undefined
    let cancelled = false
    setMessageDetailLoading(true)
    setMessageDetailError('')
    const params = new URLSearchParams({ tenantId, targetLanguage: language || 'ko' })
    apiFetch(`/mail/messages/${selectedMessage.id}?${params.toString()}`)
      .then(detail => {
        if (cancelled) return
        setSelectedMessage(detail)
      })
      .catch(err => {
        if (cancelled) return
        setMessageDetailError(err.message || '메일 본문을 불러오지 못했습니다.')
      })
      .finally(() => {
        if (!cancelled) setMessageDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [language])

  useEffect(() => {
    const messageId = String(initialMailLink?.messageId || '').trim()
    const tenantId = String(initialMailLink?.tenantId || '').trim()
    const targetLanguage = String(initialMailLink?.targetLanguage || language || 'ko').trim() || 'ko'
    const openedAt = String(initialMailLink?.openedAt || '').trim()
    if (!messageId || !tenantId) return
    const signature = `${tenantId}:${messageId}:${targetLanguage}:${openedAt}`
    if (handledInitialMailLinkRef.current === signature) return

    let cancelled = false
    async function openLinkedMail() {
      setComposeMode(false)
      setSelectedMessageIds([messageId])
      setLastSelectedMessageId(null)
      preserveSelectionOnNextLoadRef.current = null
      setMessageDetailLoading(true)
      setMessageDetailError('')
      try {
        const params = new URLSearchParams({ tenantId, targetLanguage })
        const detail = await apiFetch(`/mail/messages/${messageId}?${params.toString()}`)
        if (cancelled) return
        handledInitialMailLinkRef.current = signature
        const detailActiveKey = detail?.account_id && detail?.folder_id
          ? `${detail.account_id}:${detail.folder_id}`
          : ''
        if (detailActiveKey && detailActiveKey !== activeKey) {
          preserveSelectionOnNextLoadRef.current = { id: detail.id, message: detail }
          updateActiveKey(detailActiveKey)
        }
        setMessages(prev => {
          const exists = prev.some(item => item.id === detail.id)
          if (exists) return prev.map(item => (item.id === detail.id ? { ...item, ...detail } : item))
          return [detail, ...prev]
        })
        setSelectedMessage(detail)
      } catch (err) {
        if (!cancelled) setMessageDetailError(err.message || '메일 본문을 불러오지 못했습니다.')
      } finally {
        if (!cancelled) setMessageDetailLoading(false)
      }
    }

    openLinkedMail()
    return () => {
      cancelled = true
    }
  }, [initialMailLink?.messageId, initialMailLink?.tenantId, initialMailLink?.targetLanguage, initialMailLink?.openedAt, language])

  // Welcome 보드 "중요 메일 전체 보기" 등에서 특정 폴더로 진입 (WelcomeBoard.md 10절)
  useEffect(() => {
    const key = String(initialFolder?.key || '').trim()
    const openedAt = String(initialFolder?.openedAt || '').trim()
    if (!key) return
    const signature = `${key}:${openedAt}`
    if (handledInitialFolderRef.current === signature) return
    handledInitialFolderRef.current = signature
    setComposeMode(false)
    updateActiveKey(key)
  }, [initialFolder?.key, initialFolder?.openedAt])

  async function selectMessage(message, index, event) {
    const active = resolveActiveFolder()
    const tenantId = message?.tenant_id || active?.account?.tenant_id || currentTenantId
    if (!tenantId || !message?.id) return
    setComposeMode(false)
    const anchorIndex = lastSelectedMessageId
      ? displayedMessages.findIndex(item => String(item.id) === String(lastSelectedMessageId))
      : -1
    const currentIndex = displayedMessages.findIndex(item => String(item.id) === String(message.id))
    if (event?.shiftKey && anchorIndex >= 0 && currentIndex >= 0) {
      const start = Math.min(anchorIndex, currentIndex)
      const end = Math.max(anchorIndex, currentIndex)
      setSelectedMessageIds(displayedMessages.slice(start, end + 1).map(item => item.id))
    } else {
      setSelectedMessageIds([message.id])
      setLastSelectedMessageId(message.id)
    }
    setMessageDetailLoading(true)
    setMessageDetailError('')
    try {
      const params = new URLSearchParams({ tenantId, targetLanguage: language || 'ko' })
      const detail = await apiFetch(`/mail/messages/${message.id}?${params.toString()}`)
      if (detail?.read_status_changed) {
        markMessageReadInState(message)
      }
      setSelectedMessage(detail)
    } catch (err) {
      setMessageDetailError(err.message || '메일 본문을 불러오지 못했습니다.')
    } finally {
      setMessageDetailLoading(false)
    }
  }

  async function openDraftForEditing(message, index, event) {
    const active = resolveActiveFolder()
    const unified = resolveActiveUnified()
    const isDraftContext = active?.folder?.type === 'drafts' || unified?.type === 'drafts'
    if (!isDraftContext || !message?.id) return
    event?.stopPropagation?.()
    setSelectedMessageIds([message.id])
    setLastSelectedMessageId(message.id)
    setMessageDetailLoading(true)
    setMessageDetailError('')
    setMessagesError('')
    try {
      const params = new URLSearchParams({ tenantId: message.tenant_id || active?.account?.tenant_id || currentTenantId })
      params.set('targetLanguage', language || 'ko')
      const detail = await apiFetch(`/mail/messages/${message.id}?${params.toString()}`)
      setComposeDraft(getDraftComposeData(detail, message.account_id || active?.account?.id))
      setSelectedMessage(null)
      setMessageMenu(null)
      setComposeMode(true)
    } catch (err) {
      setMessageDetailError(err.message || '임시 보관 메일을 불러오지 못했습니다.')
    } finally {
      setMessageDetailLoading(false)
    }
  }

  function startMailAction(action, message) {
    if (!message) return
    const active = resolveActiveFolder()
    const accountId = message.account_id || active?.account?.id || accounts[0]?.id || ''
    setComposeDraft(getMailActionComposeData(message, action, accountId))
    setSelectedMessage(null)
    setSelectedMessageIds([])
    setLastSelectedMessageId(null)
    setMessageMenu(null)
    setMessageDetailError('')
    setComposeMode(true)
  }

  useEffect(() => {
    if (mailSearchRef.current.active && activeKeyRef.current === `${UNIFIED_KEY_PREFIX}search`) return undefined
    let cancelled = false
    const openedKey = activeKey
    ;(async () => {
      await loadActiveMessages()
      const active = resolveActiveFolder()
      // 거울(custom) 폴더만 DB 목록을 먼저 보여준 뒤 IMAP 동기화를 백그라운드로 수행한다.
      // 로컬 전용 폴더(is_local)나 서버에서 사라진 폴더(sync_status='missing')는 동기화하지 않는다.
      if (cancelled || !active || active.folder.type !== 'custom') return
      if (active.folder.is_local || active.folder.sync_status === 'missing') return
      const syncKey = `${active.account.id}:${active.folder.id}`
      const lastSyncedAt = folderSyncTimesRef.current.get(syncKey) || 0
      if (Date.now() - lastSyncedAt < FOLDER_SYNC_COOLDOWN_MS) return
      folderSyncTimesRef.current.set(syncKey, Date.now())
      try {
        const params = new URLSearchParams({ tenantId: active.account.tenant_id })
        await apiFetch(`/mail/accounts/${active.account.id}/folders/${active.folder.id}/sync?${params.toString()}`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
        if (cancelled) return
        const nextAccounts = await reloadMailAccounts()
        if (!cancelled && openedKey === activeKey) {
          await loadActiveMessages(nextAccounts, { silent: true, resetSelection: false })
        }
      } catch (err) {
        folderSyncTimesRef.current.delete(syncKey)
        // 백그라운드 동기화 실패는 이미 표시된 DB 목록을 덮지 않는다(목록은 그대로 유효).
        // 재인증이 필요한 경우만 사용자에게 알린다.
        if (!cancelled && err.code === 'MAIL_REAUTH_REQUIRED') {
          setMessagesError(err.message || '메일 계정 재인증이 필요합니다.')
        } else {
          console.warn('[Mail] 폴더 백그라운드 동기화 실패:', err.message)
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, accounts.length])

  // 폴더/스마트 뷰에 진입할 때마다 사이드바 카운트(accounts/smartFolders)를 조용히 리로드한다.
  // 백그라운드 자동 동기화나 다른 뷰에서의 이동으로 배지가 오래된(stale) 경우를 바로잡는다.
  // accounts만 갱신(setAccounts)하므로 메일 목록은 건드리지 않아 깜박임이 없다.
  useEffect(() => {
    if (!currentTenantId || composeMode) return
    let cancelled = false
    ;(async () => {
      try {
        await reloadMailAccounts()
        if (!cancelled) await reloadSmartFolders()
      } catch { /* 배지 갱신 실패는 무시(다음 진입 때 재시도) */ }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  useEffect(() => {
    if (!messageMenu) return undefined
    function closeOnOutsidePointer(event) {
      if (event.target instanceof Element && event.target.closest('[data-mail-message-context-menu]')) return
      setMessageMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') setMessageMenu(null)
    }
    // 캡처 단계에서 감지해 다른 화면 요소가 이벤트 전파를 막더라도 바깥 클릭으로 메뉴가 닫히게 한다.
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('contextmenu', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      window.removeEventListener('contextmenu', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [messageMenu])

  useEffect(() => {
    if (!folderMenu) return undefined
    function closeMenu() {
      setFolderMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('contextmenu', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('contextmenu', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [folderMenu])

  useEffect(() => {
    if (!unifiedFolderMenu) return undefined
    function closeMenu() {
      setUnifiedFolderMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('contextmenu', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('contextmenu', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [unifiedFolderMenu])

  useEffect(() => {
    if (!smartFolderMenu) return undefined
    function closeMenu() {
      setSmartFolderMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('contextmenu', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('contextmenu', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [smartFolderMenu])

  useEffect(() => {
    function clearOnEscape(event) {
      if (event.key === 'Escape' && (selectedMessage || selectedMessageIds.length > 0)) {
        clearMailSelection()
      }
    }
    window.addEventListener('keydown', clearOnEscape)
    return () => window.removeEventListener('keydown', clearOnEscape)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMessage, selectedMessageIds.length])

  // ESC를 500ms 안에 두 번 빠르게 누르면 메인 페이지로 이동한다.
  // 모달/확인 다이얼로그가 열려 있으면 ESC는 그쪽 처리에 맡기고 이동 카운트를 초기화한다.
  useEffect(() => {
    let lastEscAt = 0
    function onDoubleEscape(event) {
      if (event.key !== 'Escape') return
      if (showAccountModal || pendingEmptyTrash || pendingEmptyUnifiedTrash) {
        lastEscAt = 0
        return
      }
      const now = Date.now()
      if (now - lastEscAt <= 500) {
        lastEscAt = 0
        onBackToMain?.()
      } else {
        lastEscAt = now
      }
    }
    window.addEventListener('keydown', onDoubleEscape)
    return () => window.removeEventListener('keydown', onDoubleEscape)
  }, [showAccountModal, pendingEmptyTrash, pendingEmptyUnifiedTrash, onBackToMain])

  const activeUnified = resolveActiveUnified()
  const activeSmart = resolveActiveSmart()
  const activeLabel = activeUnified?.label
    || (activeSmart ? `# ${activeSmart.name}` : null)
    || accounts.flatMap(account => (account.folders || []).map(folder => ({
      key: `${account.id}:${folder.id || folder.name}`,
      label: `${getAccountLabel(account)} / ${getMailFolderLabel(folder, mt)}`,
    }))).find(item => item.key === activeKey)?.label
    || mt.mail
  const activeFolder = resolveActiveFolder()
  const activeAccountId = activeFolder?.account?.id || accounts[0]?.id || ''
  const isActiveDraftFolder = activeFolder?.folder?.type === 'drafts' || activeUnified?.type === 'drafts'
  const contextMenuFolders = (accounts.find(account => account.id === messageMenu?.message?.account_id)?.folders || [])
  const selectedMessageIdSet = new Set(selectedMessageIds)

  // 목록/본문 내용은 한 번만 정의하고, 데스크톱(분할 리사이즈)·모바일(세로 스택) 양쪽에서 재사용한다.
  const mailListContent = (
    <>
      <div className="flex-shrink-0 border-b border-gray-100 p-3">
        {mailSearch.active && (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs">
            <span className="min-w-0 truncate font-bold text-indigo-700">
              {mailSearch.query} · {mt.count(mailSearch.total)}
            </span>
            <button type="button" onClick={clearMailSearch} className="flex-shrink-0 font-extrabold text-indigo-600 hover:text-indigo-800">
              검색 해제
            </button>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
          <span className="font-bold">{mt.mailList}</span>
          {selectedMessageIds.length > 0 ? (
            <button
              type="button"
              onClick={clearMailSelection}
              className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-1 font-extrabold text-indigo-600 transition hover:bg-indigo-100"
              title={mt.clearSelection}
            >
              <span>{mt.selectedCount(selectedMessageIds.length)}</span>
              <span aria-hidden="true">×</span>
            </button>
          ) : (
            <span>{mt.count(mailSearch.active ? mailSearch.total : displayedMessages.length)}</span>
          )}
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onClick={(event) => {
          if (event.currentTarget === event.target) clearMailSelection()
        }}
        onScroll={handleMessagesScroll}
      >
        <MailMessageList
          messages={displayedMessages}
          loading={messagesLoading}
          error={messagesError}
          label={activeLabel}
          selectedId={selectedMessage?.id}
          selectedIds={selectedMessageIdSet}
          onSelect={selectMessage}
          onDoubleClick={isActiveDraftFolder ? openDraftForEditing : undefined}
          onContextMenu={openMessageMenu}
          loadingMore={loadingMore}
          activeSmartFolderId={activeSmart?.id || null}
          resolveTagColor={resolveTagColor}
          mt={mt}
        />
      </div>
    </>
  )

  const mailBodyContent = composeMode ? (
    <MailComposeView
      key={[
        composeDraft?.draftId || 'new-compose',
        composeDraft?.accountId || activeAccountId || '',
        composeDraft?.to || '',
        composeDraft?.subject || '',
      ].join(':')}
      accounts={accounts}
      defaultAccountId={activeAccountId}
      initialDraft={composeDraft}
      onCancel={() => setComposeMode(false)}
      onSent={() => {
        setComposeMode(false)
        refreshMail()
      }}
      onDraftSaved={async (accountId, draft) => {
        setComposeMode(false)
        const nextAccounts = await reloadMailAccounts()
        const account = nextAccounts.find(item => item.id === accountId)
        const draftFolder = (account?.folders || []).find(folder => folder.id === draft?.folder_id || folder.type === 'drafts')
        if (draftFolder) {
          updateActiveKey(`${accountId}:${draftFolder.id || draftFolder.name}`)
        } else {
          await loadActiveMessages(nextAccounts, { silent: true, resetSelection: true })
        }
      }}
      mt={mt}
    />
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MailViewer
          message={selectedMessage}
          loading={messageDetailLoading}
          error={messageDetailError}
          onAddressSearch={query => runMailSearch({ field: 'all', query })}
          onMailAction={startMailAction}
          onSummaryUpdated={(nextSummary) => {
            setSelectedMessage(prev => (
              prev?.id === selectedMessage?.id ? { ...prev, summary: nextSummary } : prev
            ))
          }}
          onCalendarEventOpen={onOpenCalendarEvent}
          onRegisterAsPost={(msg, sum) => openRegisterAsPost(msg || selectedMessage, sum)}
          onNote={message => setNoteDialogMessage(message)}
          targetLanguage={language || 'ko'}
          mt={mt}
        />
      </div>
    </div>
  )

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 min-w-0 overflow-hidden bg-gray-50">
      <aside
        className="w-full flex-shrink-0 bg-gray-200 flex flex-col h-auto md:h-full max-h-72 md:max-h-none border-b md:border-b-0 border-gray-100"
        style={isSidebarResizable ? { width: sidebarWidth } : undefined}
      >
        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-3 pb-2 mb-1 border-b border-gray-300">
            <div className="flex items-center justify-between px-2 py-2 text-gray-900">
              <div className="flex items-center gap-2.5">
                <MailIcon className="w-5 h-5 text-indigo-600" />
                <span className="font-extrabold">{mt.mail}</span>
              </div>
              <button
                type="button"
                onClick={() => setShowAccountModal(true)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-all hover:bg-gray-300 hover:text-gray-900"
                title={mt.accountSettings}
                aria-label={mt.accountSettings}
              >
                <MenuIcon type="settings" />
              </button>
            </div>
            <button
              type="button"
              onClick={openCompose}
              className="mb-2 flex w-full items-center gap-2.5 rounded-lg border border-indigo-100 bg-white px-4 py-3 text-left text-sm font-extrabold text-indigo-600 shadow-sm transition-all hover:border-indigo-200 hover:bg-indigo-50 hover:shadow-md"
            >
              <MenuIcon type="draft" />
              <span>{mt.compose}</span>
            </button>
            <button
              type="button"
              onClick={refreshMail}
              disabled={refreshLoading}
              className="mb-3 flex w-full items-center gap-2.5 rounded-lg border border-gray-300 bg-gray-100 px-4 py-2.5 text-left text-sm font-bold text-gray-600 transition-all hover:bg-white hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <MenuIcon type="refresh" />
              <span>{refreshLoading ? mt.syncing : mt.refresh}</span>
            </button>
            <div className="flex flex-col gap-1 mt-1">
              {unifiedMenus.map(item => {
                const key = `${UNIFIED_KEY_PREFIX}${item.key}`
                return (
                <MailMenuButton
                  key={item.key}
                  active={!composeMode && activeKey === key}
                  icon={item.icon}
                  label={item.label}
                  count={item.message_count}
                  unreadCount={item.unread_count}
                  iconColor={FOLDER_COLOR_MAP[item.color_key] || ''}
                  onClick={() => activateMailKey(key)}
                  onContextMenu={(event) => openUnifiedFolderMenu(event, item)}
                  onDragOver={(event) => handleUnifiedDragOver(event, item, key)}
                  onDragLeave={(event) => handleFolderDragLeave(event, key)}
                  onDrop={(event) => handleUnifiedDrop(event, item)}
                  dropActive={dropTargetKey === key}
                />
                )
              })}
            </div>

            {/* ② 스마트 폴더 구역 (태그 기반 통합 — MailService.md 13.2.1). 시스템 항목과 분리 표기. */}
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between px-2">
                <button
                  type="button"
                  onClick={toggleSmartSection}
                  title={mt.smartFolders}
                  className="flex select-none items-center gap-1 text-xs font-extrabold uppercase tracking-wide text-gray-400 transition-colors hover:text-gray-600"
                >
                  <span className={`transition-transform ${smartSectionCollapsed ? '-rotate-90' : ''}`}><MenuIcon type="chevronDown" /></span>
                  <span>{mt.smartFolders}</span>
                  {smartSectionCollapsed && smartFolders.length > 0 && (
                    <span className="ml-1 rounded-full bg-gray-100 px-1.5 text-[10px] font-bold text-gray-400">{smartFolders.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={createSmartFolderPrompt}
                  title={mt.addSmartFolder}
                  className="flex h-5 w-5 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-indigo-600"
                >
                  +
                </button>
              </div>
              {smartSectionCollapsed ? null : smartFolders.length === 0 ? (
                <p className="px-2 py-1 text-[11px] leading-4 text-gray-400">
                  {mt.smartFolderHint}
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {smartFolders.map(folder => {
                    const key = `${SMART_KEY_PREFIX}${folder.id}`
                    return (
                      <MailMenuButton
                        key={folder.id}
                        active={!composeMode && activeKey === key}
                        icon="tag"
                        label={folder.name}
                        count={folder.message_count}
                        unreadCount={folder.unread_count}
                        iconColor={resolveTagColor(folder.color_key, folder.name)}
                        onClick={() => activateMailKey(key)}
                        onContextMenu={(event) => openSmartFolderMenu(event, folder)}
                        onDragOver={(event) => handleSmartDragOver(event, key)}
                        onDragLeave={(event) => handleFolderDragLeave(event, key)}
                        onDrop={(event) => handleSmartDrop(event, folder)}
                        dropActive={dropTargetKey === key}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="px-3 pb-2">
            <div className="flex flex-col gap-2 mt-1">
              {accounts.map(account => {
                const collapsed = collapsedAccountIds.has(account.id)
                const folders = Array.isArray(account.folders) && account.folders.length > 0
                  ? account.folders
                  : [
                      { id: 'inbox', name: mt.folders.inbox, type: 'inbox' },
                      { id: 'sent', name: mt.folders.sent, type: 'sent' },
                      { id: 'drafts', name: mt.folders.drafts, type: 'drafts' },
                    ]
                const visibleFolders = buildHierarchicalFolderList(folders, mt)
                return (
                  <div key={account.id}>
                    <button
                      type="button"
                      onClick={() => toggleAccount(account.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-bold text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
                      aria-expanded={!collapsed}
                    >
                      <MenuIcon type={collapsed ? 'chevronRight' : 'chevronDown'} />
                      <ProviderLogo provider={account.provider} host={account.imap_host} size="sm" />
                      <span className="truncate">{getAccountLabel(account)}</span>
                    </button>
                    {!collapsed && (
                      <div className="flex flex-col gap-0.5">
                        {visibleFolders.map(({ folder, depth }) => {
                          const key = `${account.id}:${folder.id || folder.name}`
                          const folderDepth = 1 + depth
                          const folderColor = FOLDER_COLOR_MAP[folder.color_key] || ''
                          return (
                            <MailMenuButton
                              key={key}
                              active={activeKey === key}
                              icon={folder.type === 'inbox' || folder.name === '받은 편지함' || folder.name === mt.folders.inbox ? 'inbox' : folder.type === 'trash' ? 'trash' : 'folder'}
                              label={getMailFolderLabel(folder, mt)}
                              title={getMailFolderTitle(folder, mt)}
                              count={folder.message_count}
                              unreadCount={folder.unread_count}
                              iconColor={folderColor}
                              depth={folderDepth}
                              onClick={() => activateMailKey(key)}
                              onContextMenu={(event) => openFolderMenu(event, account, folder)}
                              onDragOver={(event) => handleFolderDragOver(event, folder, key)}
                              onDragLeave={(event) => handleFolderDragLeave(event, key)}
                              onDrop={(event) => handleFolderDrop(event, folder)}
                              dropActive={dropTargetKey === key}
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
                    ? mt.metaLoading
                    : mailMetaError || mt.noAccounts}
                </div>
              )}
            </div>
          </div>
        </div>

      </aside>

      {isSidebarResizable && (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startSidebarResize}
          title="드래그하여 사이드바 너비 조절"
          className="hidden md:block w-1.5 flex-shrink-0 cursor-col-resize bg-gray-200 transition-colors hover:bg-indigo-400 active:bg-indigo-500"
        />
      )}

      <main className="flex-1 min-w-0 overflow-hidden flex flex-col bg-gray-50">
        <section className="flex-1 min-h-0 overflow-hidden p-4 md:p-5">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white lg:flex-row">
            {!composeMode && isDesktopSplit ? (
              // 데스크톱: 목록↔본문을 드래그로 리사이즈. autoSaveId로 위치를 localStorage에 영속화.
              <PanelGroup direction="horizontal" autoSaveId="mail-list-split" className="flex h-full min-h-0 w-full">
                <Panel defaultSize={28} minSize={18} maxSize={50} className="flex min-h-0 flex-col">
                  {mailListContent}
                </Panel>
                <PanelResizeHandle className="w-1.5 flex-shrink-0 cursor-col-resize bg-gray-200 transition-colors hover:bg-indigo-400 active:bg-indigo-500" />
                <Panel minSize={35} className="flex min-w-0 flex-col overflow-hidden">
                  {mailBodyContent}
                </Panel>
              </PanelGroup>
            ) : (
              // 모바일(<lg) 또는 쓰기 모드: 기존 세로 스택 / 본문 전체 폭 유지.
              <>
                {!composeMode && (
                  <div className="flex h-80 flex-shrink-0 flex-col border-b border-gray-200 lg:h-full lg:w-[360px] lg:border-b-0 lg:border-r">
                    {mailListContent}
                  </div>
                )}
                <div className="min-w-0 flex-1 overflow-hidden">
                  {mailBodyContent}
                </div>
              </>
            )}
          </div>
        </section>
      </main>
      {showAccountModal && (
        <MailAccountManageModal
          accounts={accounts}
          tenants={tenants}
          activeFolder={activeFolder}
          activeUnified={activeUnified}
          currentTenantId={currentTenantId}
          initialMailClawRegistration={mailClawRegistration}
          onClose={() => setShowAccountModal(false)}
          onAccountAdded={reloadMailAccounts}
          onMailDataChanged={async () => {
            const nextAccounts = await reloadMailAccounts()
            await loadActiveMessages(nextAccounts, { silent: true, resetSelection: false })
          }}
          mt={mt}
        />
      )}
      <MailMessageContextMenu
        menu={messageMenu}
        folders={contextMenuFolders}
        onClose={() => setMessageMenu(null)}
        onDelete={deleteMessage}
        onMarkUnread={markMessageUnread}
        onToggleStar={toggleMessagesStarred}
        onMove={moveMessage}
        onRegisterMailClaw={registerMailClawFromMessage}
        onRegisterMailClawTrash={registerMailClawTrashFromMessage}
        onRegisterAsPost={registerAsPostFromMessage}
        onNote={message => setNoteDialogMessage(message)}
        mt={mt}
      />
      {postDialog && (
        <MailToPostDialog
          message={postDialog.message}
          summary={postDialog.summary}
          teams={teams}
          defaultTeamId={selectedTeam?.id != null ? String(selectedTeam.id) : ''}
          defaultChannelId={selectedChannel?.id != null ? String(selectedChannel.id) : ''}
          onClose={() => setPostDialog(null)}
          onSubmit={submitRegisterAsPost}
          targetLanguage={language || 'ko'}
          mt={mt}
        />
      )}
      {noteDialogMessage && (
        <MailNoteDialog
          message={noteDialogMessage}
          mt={mt}
          onClose={() => setNoteDialogMessage(null)}
          onSaved={(_note, result) => {
            updateMessageNoteState(noteDialogMessage.id, !result?.deleted)
            showToast({
              message: result?.deleted
                ? mt.note.delete
                : result?.ragIndexed ? mt.note.save : mt.note.ragFailed,
              tone: result?.ragIndexed === false ? 'warning' : 'success',
            })
          }}
        />
      )}
      <FolderContextMenu
        menu={folderMenu}
        onClose={() => setFolderMenu(null)}
        onCreateFolder={(menu) => createMailFolder(menu)}
        onCreateSubFolder={(menu) => createMailFolder(menu, menu?.folder)}
        onRenameFolder={renameMailFolder}
        onDeleteFolder={deleteMailFolder}
        onSetFolderColor={setMailFolderColor}
        onEmptyTrash={setPendingEmptyTrash}
        mt={mt}
      />
      <UnifiedFolderContextMenu
        menu={unifiedFolderMenu}
        onClose={() => setUnifiedFolderMenu(null)}
        onRefresh={refreshMail}
        onSetFolderColor={setUnifiedFolderColor}
        onEmptyUnifiedTrash={(folder) => setPendingEmptyUnifiedTrash(folder || { key: 'trash' })}
        mt={mt}
      />
      <SmartFolderContextMenu
        menu={smartFolderMenu}
        onClose={() => setSmartFolderMenu(null)}
        onRename={renameSmartFolder}
        onDelete={deleteSmartFolder}
        onSetColor={setSmartFolderColor}
        mt={mt}
      />
      {pendingEmptyTrash && (
        <ConfirmDialog
          title={mt.dialogs.emptyTrashTitle}
          message={mt.dialogs.emptyTrashMessage}
          confirmText={mt.ok}
          cancelText={mt.cancel}
          danger
          onConfirm={() => emptyTrashFolder(pendingEmptyTrash)}
          onCancel={() => setPendingEmptyTrash(null)}
        />
      )}
      {syncErrorDialog && (
        <ConfirmDialog
          title="메일 동기화 오류"
          message="다음 계정의 메일을 동기화하지 못했습니다. 계정 설정을 확인해주세요."
          highlightItems={syncErrorDialog.map(item => `${item.emailAddress} — ${item.error}`)}
          confirmText={mt.ok}
          hideCancel
          danger
          onConfirm={() => setSyncErrorDialog(null)}
          onCancel={() => setSyncErrorDialog(null)}
        />
      )}
      {pendingDeleteFolder && (
        <ConfirmDialog
          title={mt.folderMenu.delete}
          message={pendingDeleteFolder.message}
          confirmText={mt.ok}
          cancelText={mt.cancel}
          danger={pendingDeleteFolder.danger}
          onConfirm={() => performDeleteMailFolder(pendingDeleteFolder)}
          onCancel={() => setPendingDeleteFolder(null)}
        />
      )}
      {pendingEmptyUnifiedTrash && (
        <ConfirmDialog
          title={mt.dialogs.emptyUnifiedTrashTitle}
          message={mt.dialogs.emptyUnifiedTrashMessage(getUnifiedTrashTargets().length)}
          confirmText={mt.ok}
          cancelText={mt.cancel}
          danger
          onConfirm={emptyUnifiedTrash}
          onCancel={() => setPendingEmptyUnifiedTrash(null)}
        />
      )}
      {folderNameDialog && (
        <MailInputDialog
          title={folderNameDialog.title}
          message={folderNameDialog.message}
          initialValue={folderNameDialog.initialValue || ''}
          confirmText={mt.ok}
          cancelText={mt.cancel}
          loading={folderNameDialogLoading}
          onConfirm={confirmFolderNameDialog}
          onCancel={() => {
            if (!folderNameDialogLoading) setFolderNameDialog(null)
          }}
        />
      )}
    </div>
  )
}
