import { useState } from 'react'
import { MAIL_TEXT } from './mailText'
import { MailIcon } from './mailIcons'

function EmptyMailList({ label, mt = MAIL_TEXT.ko }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center px-6 text-center">
      <MailIcon className="w-9 h-9 text-indigo-500" />
      <h2 className="mt-4 text-base font-extrabold text-gray-900">{mt.emptyListTitle}</h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-gray-500">
        {mt.emptyListDesc(label)}
      </p>
    </div>
  )
}

function isNaverEmail(email) {
  return /@naver\.com$/i.test(String(email || '').trim())
}

function NaverBadge() {
  return (
    <span title="네이버 메일" aria-label="naver" className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
      <svg viewBox="0 0 40 40" className="h-4 w-4" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="40" height="40" rx="8" fill="#03C75A" />
        <path fill="#ffffff" d="M25.6 21.2L15.9 7H8V33H16.4V18.8L26.1 33H34V7H25.6Z" />
      </svg>
    </span>
  )
}

function isAppleEmail(email) {
  return /@(me|icloud)\.com$/i.test(String(email || '').trim())
}

function AppleBadge() {
  return (
    <span title="Apple 메일 (iCloud)" aria-label="apple" className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
      <svg viewBox="0 0 40 40" className="h-4 w-4" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="40" height="40" rx="8" fill="#000000" />
        <g transform="translate(8 8)">
          <path fill="#ffffff" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.1l.01-.02zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
        </g>
      </svg>
    </span>
  )
}

function getEmailDomain(email) {
  const parts = String(email || '').trim().toLowerCase().split('@')
  return parts.length === 2 && parts[1] ? parts[1] : ''
}

function SenderFavicon({ domain }) {
  const [failed, setFailed] = useState(false)
  if (!domain || failed) return null
  return (
    <img
      src={`/api/mail/favicon?domain=${encodeURIComponent(domain)}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      title={domain}
      className="h-4 w-4 flex-shrink-0 rounded-sm object-contain"
    />
  )
}

function AttachmentClipMark({ mt = MAIL_TEXT.ko }) {
  return (
    <svg
      viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-shrink-0 text-gray-400"
      fill="none" stroke="currentColor" strokeWidth="2"
      role="img" aria-label={mt.attachmentMark} title={mt.attachmentMark}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.2 9.19a1 1 0 01-1.41-1.41l8.49-8.49" />
    </svg>
  )
}

function colorWithAlpha(color, alpha = 0.14) {
  const text = String(color || '').trim()
  const match = text.match(/^#?([0-9a-f]{6})$/i)
  if (!match) return `rgba(156, 163, 175, ${alpha})`
  const hex = match[1]
  const red = parseInt(hex.slice(0, 2), 16)
  const green = parseInt(hex.slice(2, 4), 16)
  const blue = parseInt(hex.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function SmartFolderTagChip({ name, colorKey, resolveTagColor }) {
  const color = resolveTagColor?.(colorKey, name) || '#9ca3af'
  return (
    <span
      title={name}
      className="inline-flex max-w-[130px] flex-shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none"
      style={{
        backgroundColor: colorWithAlpha(color, 0.14),
        border: `1.5px solid ${colorWithAlpha(color, 0.45)}`,
        color: '#374151',
      }}
    >
      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="truncate">{name}</span>
    </span>
  )
}

export default function MailMessageList({
  messages,
  loading,
  error,
  label,
  selectedId,
  selectedIds,
  onSelect,
  onDoubleClick,
  onContextMenu,
  loadingMore,
  activeSmartFolderId,
  resolveTagColor,
  mt = MAIL_TEXT.ko,
}) {
  if (loading) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-sm font-bold text-gray-500">
        {mt.loadingMessages}
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm font-bold text-red-600">
        {error}
      </div>
    )
  }
  if (!messages.length) return <EmptyMailList label={label} mt={mt} />
  return (
    <div className="divide-y divide-gray-100">
      {messages.map((message, index) => {
        const unread = !message.is_read
        const checked = selectedIds?.has?.(message.id)
        const tags = Array.isArray(message.tags) ? message.tags : []
        const visibleTags = activeSmartFolderId ? tags.filter(tag => tag.id !== activeSmartFolderId) : tags
        const shownTags = visibleTags.slice(0, 2)
        const hiddenTags = visibleTags.slice(2)
        const hiddenTagColor = hiddenTags.length > 0
          ? resolveTagColor?.(hiddenTags[0].color_key, hiddenTags[0].name) || '#9ca3af'
          : '#9ca3af'
        return (
          <button
            key={message.id}
            type="button"
            draggable
            onDragStart={(event) => {
              if (typeof window !== 'undefined') window.getSelection()?.removeAllRanges()
              const ids = checked && selectedIds?.size > 0 ? Array.from(selectedIds) : [message.id]
              event.dataTransfer.effectAllowed = 'copyMove'
              event.dataTransfer.setData('application/x-mail-ids', JSON.stringify(ids))
            }}
            onClick={(event) => {
              event.stopPropagation()
              onSelect?.(message, index, event)
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              onDoubleClick?.(message, index, event)
            }}
            onContextMenu={(event) => onContextMenu?.(event, message, index)}
            className={`flex w-full select-none items-start gap-3 px-4 py-3 text-left transition ${
              checked
                ? 'bg-indigo-100 ring-1 ring-inset ring-indigo-200'
                : selectedId === message.id
                  ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-100'
                  : 'hover:bg-indigo-50'
            }`}
          >
            <span className="mt-4 flex flex-shrink-0 flex-col items-center gap-2">
              {message.is_starred ? (
                <svg className="h-7 w-7 text-amber-400" viewBox="0 0 24 24" fill="currentColor" aria-label={mt.context.star}>
                  <path d="M11.48 3.5l2.12 4.3 4.74.69-3.43 3.34.81 4.72-4.24-2.23-4.24 2.23.81-4.72-3.43-3.34 4.74-.69 2.12-4.3z" />
                </svg>
              ) : null}
              <span className="flex h-3 w-3 items-center justify-center">
                {checked ? (
                  <span className="flex h-3 w-3 items-center justify-center rounded-full bg-indigo-600 text-[8px] font-black text-white">✓</span>
                ) : unread ? (
                  <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
                ) : null}
              </span>
              {isNaverEmail(message.from_email) ? (
                <NaverBadge />
              ) : isAppleEmail(message.from_email) ? (
                <AppleBadge />
              ) : (
                <SenderFavicon domain={getEmailDomain(message.from_email)} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className={`truncate text-sm ${unread ? 'font-extrabold text-gray-900' : 'font-medium text-gray-500'}`}>
                  {message.from_name || message.from_email || mt.noSender}
                </span>
                <span className={`flex-shrink-0 text-[11px] ${unread ? 'font-bold text-gray-500' : 'font-normal text-gray-400'}`}>
                  {message.received_at ? new Date(message.received_at).toLocaleDateString() : ''}
                </span>
              </div>
              {message.is_search_result && (
                <div className="mt-0.5 truncate text-[10px] font-medium text-indigo-500">
                  {[message.account_email, message.folder_name].filter(Boolean).join(' · ')}
                </div>
              )}
              <div className={`mt-1 truncate text-sm ${unread ? 'font-bold text-gray-900' : 'font-normal text-gray-500'}`}>
                {message.subject || mt.noSubject}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {shownTags.map(tag => (
                    <SmartFolderTagChip key={tag.id} name={tag.name} colorKey={tag.color_key} resolveTagColor={resolveTagColor} />
                  ))}
                  {hiddenTags.length > 0 && (
                    <span
                      title={hiddenTags.map(tag => tag.name).join(', ')}
                      className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none text-gray-500"
                      style={{
                        backgroundColor: colorWithAlpha(hiddenTagColor, 0.14),
                        border: `1.5px solid ${colorWithAlpha(hiddenTagColor, 0.45)}`,
                      }}
                    >
                      +{hiddenTags.length}
                    </span>
                  )}
                  {message.snippet ? (
                    <span className={`min-w-0 truncate text-xs leading-5 ${unread ? 'text-gray-500' : 'text-gray-400'}`}>
                      {message.snippet}
                    </span>
                  ) : null}
                </div>
                {message.has_attachments && <AttachmentClipMark mt={mt} />}
              </div>
            </span>
          </button>
        )
      })}
      {loadingMore && (
        <div className="px-4 py-3 text-center text-xs font-bold text-gray-400">{mt.loadingMore}</div>
      )}
    </div>
  )
}
