import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'
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

function MailViewer({ message, loading, error, onAddressSearch, onMailAction, onSummaryUpdated, onCalendarEventOpen, onRegisterAsPost, targetLanguage = 'ko', mt = MAIL_TEXT.ko }) {
  const [addressMenu, setAddressMenu] = useState(null)
  const [summary, setSummary] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [summaryCopied, setSummaryCopied] = useState(false)
  const [summaryCopyError, setSummaryCopyError] = useState('')
  const [actionTimeDrafts, setActionTimeDrafts] = useState({})
  const [actionTimeSavingKey, setActionTimeSavingKey] = useState('')
  const [actionTimeError, setActionTimeError] = useState('')
  const [bodyFrameHeight, setBodyFrameHeight] = useState(560)
  const actionTimeDraftsRef = useRef({})

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
      setSummaryError('')
      setSummaryCopied(false)
      setSummaryCopyError('')
      setActionTimeDrafts({})
      actionTimeDraftsRef.current = {}
      setActionTimeSavingKey('')
      setActionTimeError('')
      setBodyFrameHeight(560)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [message?.id, message?.summary])

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
          createCalendarEvent: true,
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
          <button
            type="button"
            onClick={generateSummary}
            disabled={summaryLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-extrabold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <MenuIcon type="ai" />
            <span>{summaryLoading ? mt.regenerating : summary ? mt.regenerate : mt.summarize}</span>
          </button>
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
                onActionTimeChange={updateActionItemTime}
                onCalendarEventOpen={onCalendarEventOpen}
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
                <a
                  key={att.id}
                  href={`/api/mail/messages/${message.id}/attachments/${att.id}?tenantId=${encodeURIComponent(message.tenant_id || '')}`}
                  download={att.filename}
                  title={`${att.filename} (${formatFileSize(att.size_bytes)})`}
                  className="flex max-w-[240px] items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 hover:border-indigo-300 hover:bg-indigo-50"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.2 9.19a1 1 0 01-1.41-1.41l8.49-8.49" />
                  </svg>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-gray-800">{att.filename}</span>
                    <span className="block text-[11px] text-gray-400">{formatFileSize(att.size_bytes)}</span>
                  </span>
                  <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 text-indigo-500" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
                  </svg>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
      <footer className="flex items-center gap-6 border-t border-gray-100 px-6 py-4">
        <MailReplyActionButton icon="forward" label={mt.forward} onClick={() => onMailAction?.('forward', message)} />
        <MailReplyActionButton icon="reply" label={mt.replyAll} onClick={() => onMailAction?.('replyAll', message)} />
        <MailReplyActionButton icon="reply" label={mt.reply} onClick={() => onMailAction?.('reply', message)} />
      </footer>
      <MailAddressMenu
        menu={addressMenu}
        onClose={() => setAddressMenu(null)}
        onSearch={onAddressSearch}
        mt={mt}
      />
    </article>
  )
}

export default MailViewer
