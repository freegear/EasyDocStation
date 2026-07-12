import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'
import ConfirmDialog from '../../components/ConfirmDialog'
import { MAIL_TEXT } from './mailText'
import { MailIcon, MenuIcon, ToolbarButton } from './mailIcons'
import MailSummaryPanel from './MailSummaryPanel'
import { copyTextWithFallback } from './mailClipboard'
import { formatFileSize } from './mailFormatUtils'
import { formatAddress, normalizeAddressList } from './mailAddressUtils'
import { formatMailSummaryForCopy, normalizeMailSummary, parseSummaryActionDateTime } from './mailSummaryUtils'
import { useAnchoredMenuPosition } from './useAnchoredMenuPosition'

function EmptyMailViewer({ mt = MAIL_TEXT.ko }) {
  return (
    <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-indigo-500">
        <MailIcon className="w-8 h-8" />
      </div>
      <h2 className="mt-4 text-lg font-extrabold text-gray-900">{mt.selectMailTitle}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-gray-500">
        {mt.selectMailDesc}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <ToolbarButton icon="reply" label={mt.reply} />
        <ToolbarButton icon="forward" label={mt.forward} />
        <ToolbarButton icon="ai" label={mt.sendToAgentic} />
      </div>
    </div>
  )
}

function saveAddressListItem(key, address) {
  if (!address?.email) return
  try {
    const rows = JSON.parse(window.localStorage.getItem(key) || '[]')
    const next = Array.isArray(rows) ? rows.filter(item => item?.email !== address.email) : []
    next.unshift({ name: address.name || '', email: address.email, savedAt: new Date().toISOString() })
    window.localStorage.setItem(key, JSON.stringify(next.slice(0, 500)))
  } catch {
    // localStorage가 막힌 환경에서는 메뉴 동작만 조용히 닫는다.
  }
}

async function copyAddressToClipboard(address) {
  const text = address?.email || ''
  if (!text) return
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function MailAddressMenu({ menu, onClose, onSearch, mt = MAIL_TEXT.ko }) {
  const { ref, style } = useAnchoredMenuPosition(menu?.x ?? 0, menu?.y ?? 0)
  if (!menu?.address?.email) return null
  const { address } = menu
  const itemClass = 'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50'
  const am = mt.addressMenu
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[210px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={style}
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        className={itemClass}
        onClick={() => {
          window.location.href = `mailto:${encodeURIComponent(address.email)}`
          onClose()
        }}
      >
        <MenuIcon type="draft" />
        <span>{am.compose}</span>
      </button>
      <button
        type="button"
        className={itemClass}
        onClick={async () => {
          await copyAddressToClipboard(address)
          onClose()
        }}
      >
        <MenuIcon type="archive" />
        <span>{am.copy}</span>
      </button>
      <div className="my-1 border-t border-gray-100" />
      <button
        type="button"
        className={itemClass}
        onClick={() => {
          saveAddressListItem('easystation.mail.contacts', address)
          onClose()
        }}
      >
        <span className="w-4 text-center text-gray-400">+</span>
        <span>{am.addContact}</span>
      </button>
      <button
        type="button"
        className={itemClass}
        onClick={() => {
          saveAddressListItem('easystation.mail.vip', address)
          onClose()
        }}
      >
        <MenuIcon type="star" />
        <span>{am.addVip}</span>
      </button>
      <div className="my-1 border-t border-gray-100" />
      <button
        type="button"
        className={itemClass}
        onClick={() => {
          onSearch?.(address.email)
          onClose()
        }}
      >
        <MenuIcon type="search" />
        <span>{am.search}</span>
      </button>
    </div>
  )
}

function MailAddressButton({ address, onOpen }) {
  if (!address?.email && !address?.name) return null
  return (
    <button
      type="button"
      className="rounded px-1 font-semibold text-gray-600 transition hover:bg-indigo-50 hover:text-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      onClick={(event) => {
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        // 원좌표만 전달하고 위치 보정은 useAnchoredMenuPosition이 처리한다. (MailService.md 19.55)
        onOpen?.({
          address,
          x: rect.left,
          y: rect.bottom + 6,
        })
      }}
    >
      {formatAddress(address)}
    </button>
  )
}

function AddressRow({ label, addresses, onOpen }) {
  if (!addresses.length) return null
  return (
    <div className="flex flex-wrap items-baseline gap-x-1 gap-y-1">
      <span className="font-bold text-gray-700">{label}</span>
      {addresses.map((address, index) => (
        <span key={`${label}-${address.email || address.name}-${index}`} className="inline-flex items-baseline">
          <MailAddressButton address={address} onOpen={onOpen} />
          {index < addresses.length - 1 && <span className="text-gray-400">,</span>}
        </span>
      ))}
    </div>
  )
}

function MailReplyActionButton({ icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 items-center gap-2 rounded-md px-2 text-sm font-semibold text-gray-500 transition hover:bg-gray-50 hover:text-gray-800"
    >
      <MenuIcon type={icon} />
      <span>{label}</span>
    </button>
  )
}

function attachmentUrl(message, attachment, preview = false) {
  const suffix = preview ? '/preview' : ''
  return `/api/mail/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}${suffix}?tenantId=${encodeURIComponent(message.tenant_id || '')}`
}

const DEFAULT_DISPLAY_CONFIG = {
  imagePreview: { width: 512, height: 512 },
  pdfPreview: { width: 480, height: 270 },
  txtPreview: { width: 270, height: 480 },
}

function attachmentPreviewSize(attachment, displayConfig) {
  const name = String(attachment?.filename || '').toLowerCase()
  const type = String(attachment?.content_type || '').toLowerCase()
  const key = type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp)$/.test(name)
    ? 'imagePreview'
    : type === 'text/plain' || name.endsWith('.txt')
      ? 'txtPreview'
      : 'pdfPreview'
  const fallback = DEFAULT_DISPLAY_CONFIG[key]
  const configured = displayConfig?.[key] || fallback
  return {
    width: Math.max(1, Number(configured?.width) || fallback.width),
    height: Math.max(1, Number(configured?.height) || fallback.height),
  }
}

function AttachmentInlinePreview({ message, attachment, displayConfig, mt }) {
  const labels = mt.attachmentPreview
  const [preview, setPreview] = useState({ loading: true, kind: '', url: '', text: '', error: '' })
  const { width, height } = attachmentPreviewSize(attachment, displayConfig)

  useEffect(() => {
    let active = true
    let objectUrl = ''
    const controller = new AbortController()
    fetch(attachmentUrl(message, attachment, true), { credentials: 'include', signal: controller.signal })
      .then(async response => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error || labels.unsupported)
        }
        const kind = response.headers.get('X-Mail-Attachment-Preview-Kind') || ''
        const blob = await response.blob()
        if (kind === 'text') return { kind, text: await blob.text(), url: '' }
        if (kind === 'pdf') return { kind, text: '', url: attachmentUrl(message, attachment, true) }
        objectUrl = URL.createObjectURL(blob)
        return { kind, text: '', url: objectUrl }
      })
      .then(result => active && setPreview({ loading: false, error: '', ...result }))
      .catch(error => {
        if (active && error.name !== 'AbortError') setPreview({ loading: false, kind: '', url: '', text: '', error: error.message || labels.unsupported })
      })
    return () => {
      active = false
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment, labels.unsupported, message])

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-gray-100" style={{ width, height }}>
      {preview.loading && <div className="flex h-full items-center justify-center text-sm font-bold text-gray-500">{labels.loading}</div>}
      {preview.error && <div className="flex h-full items-center justify-center p-4 text-center text-sm font-bold text-red-600">{preview.error}</div>}
      {!preview.loading && !preview.error && preview.kind === 'image' && <img src={preview.url} alt={attachment.filename} className="h-full w-full object-contain" />}
      {!preview.loading && !preview.error && preview.kind === 'pdf' && <iframe title={attachment.filename} src={preview.url} className="h-full w-full bg-white" />}
      {!preview.loading && !preview.error && preview.kind === 'text' && <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words bg-white p-4 text-sm leading-6 text-gray-800">{preview.text}</pre>}
    </div>
  )
}

function AttachmentPreviewModal({ message, attachments, index, onIndexChange, onClose, mt }) {
  const attachment = attachments[index]
  const labels = mt.attachmentPreview
  const [preview, setPreview] = useState({ loading: true, kind: '', url: '', text: '', error: '' })

  useEffect(() => {
    let active = true
    let objectUrl = ''
    const controller = new AbortController()

    fetch(attachmentUrl(message, attachment, true), { credentials: 'include', signal: controller.signal })
      .then(async response => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error || labels.unsupported)
        }
        const kind = response.headers.get('X-Mail-Attachment-Preview-Kind') || ''
        const blob = await response.blob()
        if (kind === 'text') return { kind, text: await blob.text(), url: '' }
        objectUrl = URL.createObjectURL(blob)
        return { kind, text: '', url: objectUrl }
      })
      .then(result => {
        if (active) setPreview({ loading: false, error: '', ...result })
      })
      .catch(error => {
        if (active && error.name !== 'AbortError') {
          setPreview({ loading: false, kind: '', url: '', text: '', error: error.message || labels.unsupported })
        }
      })

    return () => {
      active = false
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment, labels.unsupported, message])

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1)
      if (event.key === 'ArrowRight' && index < attachments.length - 1) onIndexChange(index + 1)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [attachments.length, index, onClose, onIndexChange])

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-gray-950/75 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={`${labels.preview}: ${attachment.filename}`}>
      <div className="flex h-full max-h-[900px] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-extrabold text-gray-900">{attachment.filename}</div>
            <div className="text-xs text-gray-500">{index + 1} / {attachments.length} · {formatFileSize(attachment.size_bytes)}</div>
          </div>
          <a href={attachmentUrl(message, attachment)} download={attachment.filename} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-indigo-600 hover:bg-indigo-50">
            {labels.download}
          </a>
          <button type="button" onClick={onClose} aria-label={labels.close} className="rounded-lg p-2 text-xl leading-none text-gray-500 hover:bg-gray-100">×</button>
        </header>
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-gray-100 p-4">
          {preview.loading && <div className="text-sm font-bold text-gray-500">{labels.loading}</div>}
          {preview.error && (
            <div className="max-w-md rounded-xl bg-white p-6 text-center shadow-sm">
              <p className="text-sm font-bold text-red-600">{preview.error}</p>
              <a href={attachmentUrl(message, attachment)} download={attachment.filename} className="mt-4 inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white">{labels.download}</a>
            </div>
          )}
          {!preview.loading && !preview.error && preview.kind === 'image' && <img src={preview.url} alt={attachment.filename} className="max-h-full max-w-full object-contain" />}
          {!preview.loading && !preview.error && preview.kind === 'pdf' && (
            <iframe title={attachment.filename} src={preview.url} sandbox="allow-same-origin" className="h-full min-h-[520px] w-full rounded bg-white" />
          )}
          {!preview.loading && !preview.error && preview.kind === 'text' && (
            <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white p-5 text-sm leading-6 text-gray-800">{preview.text}</pre>
          )}
        </div>
        <footer className="flex items-center justify-between border-t border-gray-200 px-4 py-3">
          <button type="button" disabled={index === 0} onClick={() => onIndexChange(index - 1)} className="rounded-lg px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 disabled:opacity-30">← {labels.previous}</button>
          <button type="button" disabled={index === attachments.length - 1} onClick={() => onIndexChange(index + 1)} className="rounded-lg px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 disabled:opacity-30">{labels.next} →</button>
        </footer>
      </div>
    </div>
  )
}

function MailViewer({ message, loading, error, onAddressSearch, onMailAction, onSummaryUpdated, onCalendarEventOpen, onRegisterAsPost, targetLanguage = 'ko', mt = MAIL_TEXT.ko }) {
  const [addressMenu, setAddressMenu] = useState(null)
  const [summary, setSummary] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryAutomationStatus, setSummaryAutomationStatus] = useState(null)
  const [summaryError, setSummaryError] = useState('')
  const [summaryCopied, setSummaryCopied] = useState(false)
  const [summaryCopyError, setSummaryCopyError] = useState('')
  const [remoteImageStatus, setRemoteImageStatus] = useState('none')
  const [remoteImageError, setRemoteImageError] = useState('')
  const [actionTimeDrafts, setActionTimeDrafts] = useState({})
  const [actionTimeSavingKey, setActionTimeSavingKey] = useState('')
  const [actionTimeError, setActionTimeError] = useState('')
  const [actionTaskSavingKey, setActionTaskSavingKey] = useState('')
  const [actionTaskError, setActionTaskError] = useState('')
  const [calendarConfirmIndex, setCalendarConfirmIndex] = useState(null)
  const [bodyFrameHeight, setBodyFrameHeight] = useState(560)
  const [displayConfig, setDisplayConfig] = useState(DEFAULT_DISPLAY_CONFIG)
  const actionTimeDraftsRef = useRef({})
  const onSummaryUpdatedRef = useRef(onSummaryUpdated)

  useEffect(() => {
    onSummaryUpdatedRef.current = onSummaryUpdated
  }, [onSummaryUpdated])

  useEffect(() => {
    if (!addressMenu) return undefined
    function closeMenu() {
      setAddressMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [addressMenu])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSummary(normalizeMailSummary(message?.summary))
      setSummaryLoading(false)
      setSummaryAutomationStatus(null)
      setSummaryError('')
      setSummaryCopied(false)
      setSummaryCopyError('')
      setRemoteImageStatus(message?.remote_image_analysis?.status || 'none')
      setRemoteImageError('')
      setActionTimeDrafts({})
      actionTimeDraftsRef.current = {}
      setActionTimeSavingKey('')
      setActionTimeError('')
      setActionTaskSavingKey('')
      setActionTaskError('')
      setBodyFrameHeight(560)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [message?.id, message?.summary])

  useEffect(() => {
    apiFetch('/config/display').then(data => {
      if (data && typeof data === 'object') setDisplayConfig(prev => ({ ...prev, ...data }))
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!message?.id || !message?.tenant_id || summary || summaryLoading) return undefined
    let cancelled = false
    let attempts = 0
    const maxAttempts = 24

    async function checkBackgroundSummary() {
      attempts += 1
      try {
        const params = new URLSearchParams({
          tenantId: message.tenant_id,
          targetLanguage,
        })
        const result = await apiFetch(`/mail/messages/${message.id}/summary?${params.toString()}`)
        if (cancelled) return
        const structuredSummary = normalizeMailSummary(result?.summary)
        if (structuredSummary) {
          setSummary(structuredSummary)
          setSummaryAutomationStatus(null)
          setSummaryError('')
          onSummaryUpdatedRef.current?.(structuredSummary)
          return
        }
        setSummaryAutomationStatus(result?.automationStatus || null)
      } catch {
        // 일시적인 조회 실패는 다음 주기에 다시 확인한다.
      }
      if (!cancelled && attempts < maxAttempts) timer = window.setTimeout(checkBackgroundSummary, 5000)
    }

    let timer
    checkBackgroundSummary()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [message?.id, message?.tenant_id, summary, summaryLoading, targetLanguage])

  function resizeBodyFrame(iframe) {
    if (!iframe) return
    try {
      const doc = iframe.contentDocument
      if (!doc) return
      if (doc.documentElement) doc.documentElement.style.overflow = 'hidden'
      if (doc.body) doc.body.style.overflow = 'hidden'
      const height = Math.max(
        560,
        doc.documentElement?.scrollHeight || 0,
        doc.body?.scrollHeight || 0,
        doc.documentElement?.offsetHeight || 0,
        doc.body?.offsetHeight || 0,
      )
      setBodyFrameHeight(height)
    } catch {
      setBodyFrameHeight(560)
    }
  }

  function handleBodyFrameLoad(event) {
    const iframe = event.currentTarget
    resizeBodyFrame(iframe)
    window.setTimeout(() => resizeBodyFrame(iframe), 250)
    window.setTimeout(() => resizeBodyFrame(iframe), 1000)
  }

  async function generateSummary() {
    if (!message?.id || !message?.tenant_id) return
    setSummaryLoading(true)
    setSummaryError('')
    setSummaryCopied(false)
    setSummaryCopyError('')
    try {
      const result = await apiFetch(`/mail/messages/${message.id}/summary`, {
        method: 'POST',
        body: JSON.stringify({ tenantId: message.tenant_id, targetLanguage }),
      })
      const structuredSummary = normalizeMailSummary(result?.summary)
      if (!structuredSummary) throw new Error(mt.summaryInvalid)
      setSummary(structuredSummary)
      onSummaryUpdated?.(structuredSummary)
    } catch (err) {
      setSummaryError(err.message || mt.summaryFailed)
    } finally {
      setSummaryLoading(false)
    }
  }

  async function analyzeRemoteImages() {
    if (!message?.id || !message?.tenant_id) return
    setRemoteImageStatus('processing')
    setRemoteImageError('')
    try {
      await apiFetch(`/mail/messages/${message.id}/remote-images/analyze`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: message.tenant_id,
          candidateIds: message?.remote_image_analysis?.candidateIds || [],
          approvalScope: 'message',
        }),
      })
      setRemoteImageStatus('completed')
      await generateSummary()
    } catch (err) {
      setRemoteImageStatus('failed')
      setRemoteImageError(err.message || '외부 이미지를 안전하게 가져오지 못했습니다.')
    }
  }

  async function copySummary() {
    if (!summary) return
    setSummaryCopyError('')
    const copied = await copyTextWithFallback(formatMailSummaryForCopy(summary, mt))
    if (copied) {
      setSummaryCopied(true)
      window.setTimeout(() => setSummaryCopied(false), 1800)
      return
    }
    setSummaryCopied(false)
    setSummaryCopyError(mt.copyFailed)
  }

  async function updateActionItemTime(index, patch) {
    if (!message?.id || !message?.tenant_id) return
    const key = String(index)
    const currentItem = summary?.actionItems?.[index] || {}
    const savedDateTime = parseSummaryActionDateTime(currentItem?.time)
    const nextDraft = {
      ...savedDateTime,
      isAllDay: currentItem?.isAllDay === true,
      ...(actionTimeDraftsRef.current[index] || {}),
      ...patch,
    }
    actionTimeDraftsRef.current = { ...actionTimeDraftsRef.current, [index]: nextDraft }
    setActionTimeDrafts(prev => ({ ...prev, [index]: nextDraft }))
    setActionTimeError('')
    if (!nextDraft.date || (!nextDraft.isAllDay && !nextDraft.time)) return

    setActionTimeSavingKey(key)
    try {
      const result = await apiFetch(`/mail/messages/${message.id}/summary/action-items/${index}/time`, {
        method: 'PATCH',
        body: JSON.stringify({
          tenantId: message.tenant_id,
          targetLanguage,
          date: nextDraft.date,
          time: nextDraft.isAllDay ? '' : nextDraft.time,
          isAllDay: nextDraft.isAllDay === true,
          createCalendarEvent: Boolean(currentItem.calendarEventId),
        }),
      })
      const structuredSummary = normalizeMailSummary(result?.summary)
      if (!structuredSummary) throw new Error(mt.summaryInvalid)
      setSummary(structuredSummary)
      onSummaryUpdated?.(structuredSummary)
      const nextDrafts = { ...actionTimeDraftsRef.current }
      delete nextDrafts[index]
      actionTimeDraftsRef.current = nextDrafts
      setActionTimeDrafts(prev => {
        const next = { ...prev }
        delete next[index]
        return next
      })
    } catch (err) {
      setActionTimeError(err.message || mt.summary?.actionTimeFailed || 'Failed to save the action item time.')
    } finally {
      setActionTimeSavingKey('')
    }
  }

  async function registerActionItemCalendar(index) {
    if (!message?.id || !message?.tenant_id) return
    const currentItem = summary?.actionItems?.[index] || {}
    const savedDateTime = parseSummaryActionDateTime(currentItem.time)
    if (!savedDateTime.date || (!currentItem.isAllDay && !savedDateTime.time)) return
    setActionTimeSavingKey(String(index))
    setActionTimeError('')
    try {
      const result = await apiFetch(`/mail/messages/${message.id}/summary/calendar-event`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: message.tenant_id,
          targetLanguage,
          actionIndex: index,
        }),
      })
      const structuredSummary = normalizeMailSummary(result?.summary)
      if (!structuredSummary) throw new Error(mt.summaryInvalid)
      setSummary(structuredSummary)
      onSummaryUpdated?.(structuredSummary)
    } catch (err) {
      setActionTimeError(err.message || mt.summary?.actionTimeFailed || 'Failed to add the action item to the calendar.')
    } finally {
      setActionTimeSavingKey('')
      setCalendarConfirmIndex(null)
    }
  }

  async function updateActionItemTask(index, task) {
    if (!message?.id || !message?.tenant_id) return false
    const nextTask = String(task || '').trim()
    if (!nextTask) {
      setActionTaskError(mt.summary?.actionTaskRequired || '액션 아이템 내용을 입력해주세요.')
      return false
    }
    if (nextTask === String(summary?.actionItems?.[index]?.task || '').trim()) return true
    setActionTaskSavingKey(String(index))
    setActionTaskError('')
    try {
      const result = await apiFetch(`/mail/messages/${message.id}/summary/action-items/${index}/task`, {
        method: 'PATCH',
        body: JSON.stringify({ tenantId: message.tenant_id, targetLanguage, task: nextTask }),
      })
      const structuredSummary = normalizeMailSummary(result?.summary)
      if (!structuredSummary) throw new Error(mt.summaryInvalid)
      setSummary(structuredSummary)
      onSummaryUpdated?.(structuredSummary)
      return true
    } catch (err) {
      setActionTaskError(err.message || mt.summary?.actionTaskFailed || '액션 아이템 내용을 저장하지 못했습니다.')
      return false
    } finally {
      setActionTaskSavingKey('')
    }
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-[360px] items-center justify-center px-8 text-sm font-bold text-gray-500">
        {mt.bodyLoading}
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full min-h-[360px] items-center justify-center px-8 text-center text-sm font-bold text-red-600">
        {error}
      </div>
    )
  }
  if (!message) return <EmptyMailViewer mt={mt} />

  const fromAddresses = [{ name: message.from_name || '', email: message.from_email || '' }]
    .filter(item => item.name || item.email)
  const toAddresses = normalizeAddressList(message.to_json)
  const ccAddresses = normalizeAddressList(message.cc_json)
  const bodyHtml = message.body_html
    ? `<base target="_blank"><style>html,body{overflow:hidden!important;}</style>${message.body_html}`
    : ''

  return (
    <article className="min-h-full bg-white">
      <header className="border-b border-gray-100 px-6 py-5">
        <h2 className="text-xl font-extrabold leading-8 text-gray-900">
          {message.subject || mt.noSubject}
        </h2>
        <div className="mt-3 grid gap-1 text-sm text-gray-500">
          <AddressRow label={mt.from} addresses={fromAddresses} onOpen={setAddressMenu} />
          <AddressRow label={mt.to} addresses={toAddresses} onOpen={setAddressMenu} />
          <AddressRow label={mt.cc} addresses={ccAddresses} onOpen={setAddressMenu} />
          <div>
            <span className="font-bold text-gray-700">{mt.date}</span>{' '}
            {message.received_at ? new Date(message.received_at).toLocaleString() : '-'}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <MailReplyActionButton icon="forward" label={mt.forward} onClick={() => onMailAction?.('forward', message)} />
          <MailReplyActionButton icon="reply" label={mt.replyAll} onClick={() => onMailAction?.('replyAll', message)} />
          <MailReplyActionButton icon="reply" label={mt.reply} onClick={() => onMailAction?.('reply', message)} />
          <button
            type="button"
            onClick={generateSummary}
            disabled={summaryLoading || summaryAutomationStatus === 'queued' || summaryAutomationStatus === 'processing'}
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-extrabold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <MenuIcon type="ai" />
            <span>{summaryLoading || summaryAutomationStatus === 'processing'
              ? mt.summaryProcessing
              : summaryAutomationStatus === 'queued'
                ? mt.summaryQueued
                : summary
                  ? mt.regenerate
                  : mt.summarize}</span>
          </button>
          {remoteImageStatus !== 'none' && remoteImageStatus !== 'completed' && (
            <button
              type="button"
              onClick={analyzeRemoteImages}
              disabled={remoteImageStatus === 'processing' || summaryLoading}
              className="inline-flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-extrabold text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <MenuIcon type="ai" />
              <span>{remoteImageStatus === 'processing' ? '외부 이미지 확인 중' : '외부 이미지 포함하여 분석'}</span>
            </button>
          )}
          {summary && (
            <button
              type="button"
              onClick={copySummary}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 transition hover:bg-gray-50 hover:text-gray-900"
            >
              {summaryCopied ? mt.copied : mt.copySummary}
            </button>
          )}
          <button
            type="button"
            onClick={() => onRegisterAsPost?.(message, summary)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 transition hover:bg-gray-50 hover:text-gray-900"
          >
            <MenuIcon type="board" />
            <span>{mt.registerAsPost}</span>
          </button>
        </div>
        {summaryCopyError && (
          <p className="mt-2 text-xs font-bold text-red-500">{summaryCopyError}</p>
        )}
        {remoteImageStatus === 'approval_required' && (
          <p className="mt-2 text-xs font-bold text-amber-600">외부 이미지에 추가 내용이 있을 수 있습니다.</p>
        )}
        {remoteImageError && (
          <p className="mt-2 text-xs font-bold text-red-500">{remoteImageError}</p>
        )}
      </header>
      <div className="bg-white">
        {(summary || summaryError) && (
          <section className="border-b border-gray-100 px-6 py-5">
            {summaryError ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">{summaryError}</p>
            ) : (
              <MailSummaryPanel
                summary={summary}
                mt={mt}
                actionTimeDrafts={actionTimeDrafts}
                actionTimeSavingKey={actionTimeSavingKey}
                actionTimeError={actionTimeError}
                actionTaskSavingKey={actionTaskSavingKey}
                actionTaskError={actionTaskError}
                onActionTimeChange={updateActionItemTime}
                onActionTaskChange={updateActionItemTask}
                onCalendarRegister={setCalendarConfirmIndex}
                onCalendarEventOpen={onCalendarEventOpen}
                referenceDate={message.received_at || message.created_at}
              />
            )}
          </section>
        )}
        {message.body_html ? (
          <iframe
            title={mt.bodyLoading}
            sandbox="allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
            srcDoc={bodyHtml}
            scrolling="no"
            onLoad={handleBodyFrameLoad}
            style={{ height: bodyFrameHeight }}
            className="block w-full border-0 bg-white"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words px-6 py-5 text-sm leading-7 text-gray-800">
            {message.body_text || message.snippet || mt.noBody}
          </pre>
        )}
        {Array.isArray(message.attachments) && message.attachments.length > 0 && (
          <div className="border-t border-gray-100 px-6 py-4">
            <div className="mb-2 text-xs font-bold text-gray-500">
              {mt.attachmentCount(message.attachments.length)}
            </div>
            <div className="flex flex-wrap gap-2">
              {message.attachments.map(att => (
                <div
                  key={att.id}
                  title={`${att.filename} (${formatFileSize(att.size_bytes)})`}
                  className="flex max-w-[280px] items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 hover:border-indigo-300 hover:bg-indigo-50"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.2 9.19a1 1 0 01-1.41-1.41l8.49-8.49" />
                  </svg>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-gray-800">{att.filename}</span>
                    <span className="block text-[11px] text-gray-400">{formatFileSize(att.size_bytes)}</span>
                  </span>
                  <a href={attachmentUrl(message, att)} download={att.filename} aria-label={`${mt.attachmentPreview.download}: ${att.filename}`} className="rounded p-1 text-indigo-500 hover:bg-indigo-100">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" /></svg>
                  </a>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-3">
              {message.attachments.filter(att => att.preview_available !== false).map(att => (
                <AttachmentInlinePreview key={att.id} message={message} attachment={att} displayConfig={displayConfig} mt={mt} />
              ))}
            </div>
          </div>
        )}
      </div>
      <MailAddressMenu
        menu={addressMenu}
        onClose={() => setAddressMenu(null)}
        onSearch={onAddressSearch}
        mt={mt}
      />
      {calendarConfirmIndex !== null && (
        <ConfirmDialog
          title={mt.summary?.calendarRegister || '캘린더에 등록'}
          message={mt.summary?.calendarRegisterConfirm || '이 액션 아이템을 캘린더에 등록할까요?'}
          detailItems={[
            String(summary?.actionItems?.[calendarConfirmIndex]?.task || '').trim(),
          ].filter(Boolean)}
          confirmText={mt.ok}
          cancelText={mt.cancel}
          titleTone="blue"
          loading={actionTimeSavingKey === String(calendarConfirmIndex)}
          onConfirm={() => registerActionItemCalendar(calendarConfirmIndex)}
          onCancel={() => setCalendarConfirmIndex(null)}
        />
      )}
    </article>
  )
}

export default MailViewer
