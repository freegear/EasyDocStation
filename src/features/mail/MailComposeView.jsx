import { useEffect, useMemo, useRef, useState } from 'react'
import { $createParagraphNode, $getRoot, $getSelection, $isRangeSelection, FORMAT_ELEMENT_COMMAND, FORMAT_TEXT_COMMAND, REDO_COMMAND, UNDO_COMMAND } from 'lexical'
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html'
import { $patchStyleText } from '@lexical/selection'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { ListItemNode, ListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from '@lexical/list'
import { LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link'
import { apiFetch } from '../../lib/api'
import { ToolbarButton, MenuIcon } from './mailIcons'
import { DEFAULT_ATTACH_POLICY, fileExtOf, isPreviewableImageFile, normalizeAttachPolicy } from './mailAttachmentUtils'
import { getAccountLabel } from './mailAccountUtils'
import { formatFileSize } from './mailFormatUtils'
import { MAIL_TEXT } from './mailText'
import { formatAddress, isValidEmailAddress, parseAddressInput, serializeAddressInput } from './mailAddressUtils'

function ComposeToolbarButton({ active = false, onClick, children, title, disabled = false }) {
  return (
    <button
      type="button"
      onMouseDown={event => {
        event.preventDefault()
        onClick?.()
      }}
      title={title}
      disabled={disabled}
      className={`flex h-10 min-w-10 items-center justify-center rounded-md px-2 text-sm font-extrabold transition ${
        active
          ? 'bg-gray-100 text-gray-950'
          : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950'
      } disabled:cursor-not-allowed disabled:opacity-35`}
    >
      {children}
    </button>
  )
}

function ComposeToolbarSelect({ value, onChange, options, title, className = '' }) {
  return (
    <label className={`relative flex h-10 items-center ${className}`} title={title}>
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className="h-10 cursor-pointer appearance-none rounded-md border-0 bg-transparent py-0 pl-2 pr-8 text-sm font-semibold text-gray-600 outline-none transition hover:bg-gray-100 focus:bg-gray-100"
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-800">
        <MenuIcon type="chevronDown" />
      </span>
    </label>
  )
}

function ComposeToolbarDivider() {
  return <span className="mx-1 h-10 w-px flex-shrink-0 bg-gray-200" />
}

function ComposeHistoryIcon({ direction = 'undo', className = 'h-6 w-6' }) {
  const mirrored = direction === 'redo'
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.15"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M9 5 5 9l4 4" />
      <path d="M5 9h7a7 7 0 1 1-6.02 3.44" />
    </svg>
  )
}

function ComposeColorButton({ title, value, onChange, children }) {
  return (
    <label
      className="relative flex h-10 min-w-10 cursor-pointer items-center justify-center rounded-md px-2 text-sm font-extrabold text-gray-700 transition hover:bg-gray-100 hover:text-gray-950"
      title={title}
    >
      {children}
      <input
        type="color"
        value={value}
        onChange={event => onChange(event.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label={title}
      />
    </label>
  )
}

function MailComposeToolbar() {
  const [editor] = useLexicalComposerContext()
  const [blockStyle, setBlockStyle] = useState('normal')
  const [fontFamily, setFontFamily] = useState('Arial')
  const [fontSize, setFontSize] = useState(16)
  const [textColor, setTextColor] = useState('#111827')
  const [highlightColor, setHighlightColor] = useState('#ffffff')
  const [align, setAlign] = useState('left')

  function applyTextStyle(style) {
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) $patchStyleText(selection, style)
    })
  }

  function changeBlockStyle(value) {
    setBlockStyle(value)
    const sizeByBlock = {
      normal: '14px',
      title: '22px',
      subtitle: '18px',
    }
    const weightByBlock = {
      normal: '400',
      title: '700',
      subtitle: '700',
    }
    applyTextStyle({
      'font-size': sizeByBlock[value] || '14px',
      'font-weight': weightByBlock[value] || '400',
    })
  }

  function changeFontFamily(value) {
    setFontFamily(value)
    applyTextStyle({ 'font-family': value })
  }

  function changeFontSize(value) {
    const nextSize = Math.max(8, Math.min(72, Number(value) || 16))
    setFontSize(nextSize)
    applyTextStyle({ 'font-size': `${nextSize}px` })
  }

  function changeTextColor(value) {
    setTextColor(value)
    applyTextStyle({ color: value })
  }

  function changeHighlightColor(value) {
    setHighlightColor(value)
    applyTextStyle({ 'background-color': value })
  }

  function changeAlign(value) {
    setAlign(value)
    editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, value)
  }

  function editLink() {
    const url = window.prompt('링크 URL을 입력하세요')
    if (!url) return
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, url)
  }

  function handleInsert(value) {
    if (value === 'bullet') editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
    if (value === 'number') editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
    if (value === 'link') editLink()
  }

  return (
    <div className="flex min-h-[56px] flex-wrap items-center gap-1 border-b border-gray-200 bg-white px-4 py-2 shadow-sm">
      <ComposeToolbarButton title="실행 취소" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>
        <ComposeHistoryIcon direction="undo" className="h-6 w-6 text-gray-600" />
      </ComposeToolbarButton>
      <ComposeToolbarButton title="다시 실행" onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>
        <ComposeHistoryIcon direction="redo" className="h-6 w-6 text-gray-300" />
      </ComposeToolbarButton>
      <ComposeToolbarDivider />
      <ComposeToolbarSelect
        value={blockStyle}
        onChange={changeBlockStyle}
        title="문단 스타일"
        className="w-[170px]"
        options={[
          { value: 'normal', label: 'Normal' },
          { value: 'title', label: 'Title' },
          { value: 'subtitle', label: 'Subtitle' },
        ]}
      />
      <ComposeToolbarDivider />
      <ComposeToolbarSelect
        value={fontFamily}
        onChange={changeFontFamily}
        title="글꼴"
        className="w-[150px]"
        options={[
          { value: 'Arial', label: 'Arial' },
          { value: 'Helvetica', label: 'Helvetica' },
          { value: 'Georgia', label: 'Georgia' },
          { value: 'Times New Roman', label: 'Times' },
          { value: 'Courier New', label: 'Courier' },
        ]}
      />
      <ComposeToolbarDivider />
      <ComposeToolbarButton title="글자 크기 줄이기" onClick={() => changeFontSize(fontSize - 1)}>−</ComposeToolbarButton>
      <input
        type="number"
        min="8"
        max="72"
        value={fontSize}
        onChange={event => changeFontSize(event.target.value)}
        className="h-9 w-14 rounded-lg border-2 border-gray-400 bg-white text-center text-sm font-extrabold text-gray-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        title="글자 크기"
      />
      <ComposeToolbarButton title="글자 크기 키우기" onClick={() => changeFontSize(fontSize + 1)}>+</ComposeToolbarButton>
      <ComposeToolbarDivider />
      <ComposeToolbarButton title="굵게" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}>B</ComposeToolbarButton>
      <ComposeToolbarButton title="기울임" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}>
        <span className="italic">I</span>
      </ComposeToolbarButton>
      <ComposeToolbarButton title="밑줄" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')}>
        <span className="underline">U</span>
      </ComposeToolbarButton>
      <ComposeToolbarButton title="인라인 코드" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')}>&lt;&gt;</ComposeToolbarButton>
      <ComposeToolbarButton title="링크" onClick={editLink}>⌁</ComposeToolbarButton>
      <ComposeColorButton title="글자 색상" value={textColor} onChange={changeTextColor}>
        <span className="border-b-2" style={{ borderColor: textColor }}>A</span>
      </ComposeColorButton>
      <ComposeColorButton title="배경 색상" value={highlightColor} onChange={changeHighlightColor}>
        <span className="rounded-sm px-1" style={{ backgroundColor: highlightColor }}>◆</span>
      </ComposeColorButton>
      <ComposeToolbarSelect
        value="none"
        onChange={value => applyTextStyle({ 'text-transform': value })}
        title="대소문자"
        className="w-[86px]"
        options={[
          { value: 'none', label: 'Aa' },
          { value: 'uppercase', label: 'AA' },
          { value: 'lowercase', label: 'aa' },
        ]}
      />
      <ComposeToolbarDivider />
      <ComposeToolbarSelect
        value=""
        onChange={handleInsert}
        title="삽입"
        className="w-[136px]"
        options={[
          { value: '', label: '+ Insert' },
          { value: 'bullet', label: 'Bullet List' },
          { value: 'number', label: 'Number List' },
          { value: 'link', label: 'Link' },
        ]}
      />
      <ComposeToolbarDivider />
      <ComposeToolbarSelect
        value={align}
        onChange={changeAlign}
        title="정렬"
        className="w-[165px]"
        options={[
          { value: 'left', label: 'Left Align' },
          { value: 'center', label: 'Center Align' },
          { value: 'right', label: 'Right Align' },
          { value: 'justify', label: 'Justify' },
        ]}
      />
    </div>
  )
}

function InitialHtmlPlugin({ html, focusEmptyTop = false }) {
  const [editor] = useLexicalComposerContext()
  const appliedRef = useRef(false)

  useEffect(() => {
    if (appliedRef.current || !html) return
    appliedRef.current = true
    editor.update(() => {
      const parser = new DOMParser()
      const dom = parser.parseFromString(html, 'text/html')
      const nodes = $generateNodesFromDOM(editor, dom)
      const root = $getRoot()
      root.clear()
      if (focusEmptyTop) {
        const blankParagraph = $createParagraphNode()
        root.append(blankParagraph)
        if (nodes.length) root.append(...nodes)
        blankParagraph.select()
      } else if (nodes.length) {
        root.append(...nodes)
      }
    })
  }, [editor, focusEmptyTop, html])

  return null
}

function MailComposeEditor({ onChange, initialHtml = '', focusEmptyTop = false }) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'EasyStationMailCompose',
        nodes: [ListNode, ListItemNode, LinkNode],
        theme: {
          paragraph: 'mb-3',
          list: {
            ul: 'list-disc pl-6 mb-3',
            ol: 'list-decimal pl-6 mb-3',
            listitem: 'mb-1',
          },
          text: {
            bold: 'font-bold',
            italic: 'italic',
            underline: 'underline',
          },
        },
        onError(error) {
          console.error('[MailCompose Lexical]', error)
        },
      }}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
        <MailComposeToolbar />
        <div className="relative min-h-[180px] flex-1 overflow-y-auto">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="min-h-full px-4 py-4 text-sm leading-7 text-gray-800 outline-none" />
            }
            placeholder={
              <div className="pointer-events-none absolute left-4 top-4 text-sm text-gray-400">
                메일 본문을 입력하세요.
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <ListPlugin />
          <LinkPlugin />
          <InitialHtmlPlugin html={initialHtml} focusEmptyTop={focusEmptyTop} />
          <OnChangePlugin
            onChange={(editorState, editor) => {
              editorState.read(() => {
                const root = $getRoot()
                const text = root.getTextContent()
                const html = $generateHtmlFromNodes(editor, null)
                onChange?.({ html, text })
              })
            }}
          />
        </div>
      </div>
    </LexicalComposer>
  )
}

function RecipientAutocomplete({ label, recipients, onChange, onError, cv }) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const composingRef = useRef(false)

  useEffect(() => {
    const term = query.trim()
    if (!term) return undefined
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      apiFetch(`/contactbook/recipient-suggestions?q=${encodeURIComponent(term)}&limit=10`, { signal: controller.signal })
        .then(data => {
          const rows = Array.isArray(data?.suggestions) ? data.suggestions : []
          setSuggestions(rows)
          setActiveIndex(rows.length ? 0 : -1)
          setOpen(true)
        })
        .catch(error => {
          if (error?.name !== 'AbortError') {
            setSuggestions([])
            setActiveIndex(-1)
            setOpen(true)
          }
        })
        .finally(() => setLoading(false))
    }, 200)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  function addRecipient(candidate) {
    const email = String(candidate?.email || '').trim()
    if (!isValidEmailAddress(email)) {
      onError?.(cv.invalidRecipient)
      return false
    }
    onError?.('')
    onChange([...recipients, { name: String(candidate?.name || '').trim(), email }])
    setQuery('')
    setSuggestions([])
    setOpen(false)
    return true
  }

  function commitQuery() {
    const parsed = parseAddressInput(query)
    if (parsed.length) {
      onChange([...recipients, ...parsed])
      onError?.('')
      setQuery('')
      setOpen(false)
      return true
    }
    if (query.trim()) onError?.(cv.invalidRecipient)
    return false
  }

  function handleKeyDown(event) {
    if (composingRef.current || event.nativeEvent?.isComposing) return
    if (open && suggestions.length && event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(index => (index + 1) % suggestions.length)
      return
    }
    if (open && suggestions.length && event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index => (index <= 0 ? suggestions.length - 1 : index - 1))
      return
    }
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (open && activeIndex >= 0 && suggestions[activeIndex]) addRecipient(suggestions[activeIndex])
      else commitQuery()
      return
    }
    if ((event.key === ',' || event.key === ';') && query.trim()) {
      event.preventDefault()
      commitQuery()
      return
    }
    if (event.key === 'Backspace' && !query && recipients.length) {
      onChange(recipients.slice(0, -1))
    }
  }

  function handlePaste(event) {
    const pasted = event.clipboardData?.getData('text') || ''
    if (!/[;,\n]/.test(pasted)) return
    const parsed = parseAddressInput(pasted)
    if (!parsed.length) return
    event.preventDefault()
    onChange([...recipients, ...parsed])
    onError?.('')
  }

  return (
    <div className="relative grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-start">
      <span className="pt-2.5">{label}</span>
      <div>
        <div
          className="flex min-h-10 flex-wrap items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 outline-none focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100"
        >
          {recipients.map((recipient, index) => (
            <span key={`${recipient.email}-${index}`} className="inline-flex max-w-full items-center gap-1 rounded-md bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-800">
              <span className="truncate">{formatAddress(recipient)}</span>
              <button type="button" onClick={() => onChange(recipients.filter((_, i) => i !== index))} className="text-indigo-400 hover:text-indigo-700" aria-label={`${formatAddress(recipient)} ${cv.removeRecipient}`}>×</button>
            </span>
          ))}
          <input
            value={query}
            onChange={event => {
              const value = event.target.value
              setQuery(value)
              if (!value.trim()) {
                setSuggestions([])
                setActiveIndex(-1)
                setOpen(false)
                setLoading(false)
              }
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={event => { composingRef.current = false; setQuery(event.currentTarget.value) }}
            onFocus={() => { if (query.trim()) setOpen(true) }}
            onBlur={() => { commitQuery(); setOpen(false) }}
            placeholder={recipients.length ? '' : 'name@example.com'}
            className="h-7 min-w-[180px] flex-1 border-0 px-1 text-sm font-normal text-gray-800 outline-none"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={`recipient-${label}-listbox`}
            aria-activedescendant={activeIndex >= 0 ? `recipient-${label}-${activeIndex}` : undefined}
          />
        </div>
        {open && (
          <div id={`recipient-${label}-listbox`} role="listbox" className="absolute left-0 right-0 z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-xl md:left-[104px]">
            {loading ? <div className="px-3 py-2 text-xs font-normal text-gray-400">{cv.recipientSearching}</div>
              : suggestions.length === 0 ? <div className="px-3 py-2 text-xs font-normal text-gray-400">{cv.noRecipientSuggestions}</div>
                : suggestions.map((suggestion, index) => (
                  <button
                    id={`recipient-${label}-${index}`}
                    key={`${suggestion.normalizedEmail}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseDown={event => { event.preventDefault(); addRecipient(suggestion) }}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left ${index === activeIndex ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}
                  >
                    <span className="min-w-0"><span className="block truncate text-sm font-semibold text-gray-800">{suggestion.name || suggestion.email}</span><span className="block truncate text-xs font-normal text-gray-500">{suggestion.email}</span></span>
                    <span className="flex-shrink-0 text-[11px] font-normal text-gray-400">{suggestion.emailType || suggestion.organization || ''}</span>
                  </button>
                ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MailComposeView({ accounts, defaultAccountId, initialDraft, onCancel, onSent, onDraftSaved, mt = MAIL_TEXT.ko }) {
  const cv = mt.composeView
  const selectableAccounts = accounts.filter(account => account?.id && account?.tenant_id)
  const [accountId, setAccountId] = useState(initialDraft?.accountId || defaultAccountId || selectableAccounts[0]?.id || '')
  const [draftId, setDraftId] = useState(initialDraft?.draftId || '')
  const [toRecipients, setToRecipients] = useState(() => parseAddressInput(initialDraft?.to || ''))
  const [ccRecipients, setCcRecipients] = useState(() => parseAddressInput(initialDraft?.cc || ''))
  const [bccRecipients, setBccRecipients] = useState(() => parseAddressInput(initialDraft?.bcc || ''))
  const [subject, setSubject] = useState(initialDraft?.subject || '')
  const [body, setBody] = useState({ html: initialDraft?.html || '', text: initialDraft?.text || '' })
  const [sending, setSending] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [attachments, setAttachments] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)
  // 첨부 이미지 미리보기 URL(File → objectURL). 첨부 변경 시 재생성하고 정리(revoke)한다. (MailService.md 10.10)
  const [lightboxImage, setLightboxImage] = useState(null) // { url, name } 확대 보기
  const attachmentPreviews = useMemo(() => {
    const map = new Map()
    for (const file of attachments) {
      if (isPreviewableImageFile(file)) {
        try { map.set(file, URL.createObjectURL(file)) } catch { /* noop */ }
      }
    }
    return map
  }, [attachments])

  useEffect(() => {
    return () => { for (const url of attachmentPreviews.values()) URL.revokeObjectURL(url) }
  }, [attachmentPreviews])
  // 첨부 정책(용량/개수/차단 확장자)은 서버에서 로드한다. (MailService.md 10.8)
  const [attachPolicy, setAttachPolicy] = useState(DEFAULT_ATTACH_POLICY)
  const to = useMemo(() => serializeAddressInput(toRecipients), [toRecipients])
  const cc = useMemo(() => serializeAddressInput(ccRecipients), [ccRecipients])
  const bcc = useMemo(() => serializeAddressInput(bccRecipients), [bccRecipients])

  useEffect(() => {
    let alive = true
    apiFetch('/mail/attachment-policy')
      .then(p => { if (alive && p) setAttachPolicy(normalizeAttachPolicy(p)) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const effectiveAccountId = accountId || selectableAccounts[0]?.id || ''
  const selectedAccount = selectableAccounts.find(account => account.id === effectiveAccountId)

  // 클립 버튼/Drag&Drop 공통: 파일을 첨부 목록에 추가한다.
  // 정책 강제: 차단 확장자 / 단일 상한 / 개수 상한 / 합계 상한 (MailService.md 10.8.6)
  function addFiles(fileList) {
    const incoming = Array.from(fileList || [])
    if (incoming.length === 0) return
    setError('')
    const maxFileBytes = attachPolicy.maxFileMb * 1024 * 1024
    const maxTotalBytes = attachPolicy.maxTotalMb * 1024 * 1024
    setAttachments(prev => {
      const merged = [...prev]
      for (const file of incoming) {
        if (merged.some(x => x.name === file.name && x.size === file.size)) continue
        const ext = fileExtOf(file.name)
        if (attachPolicy.blockedExtensions.includes(ext)) {
          setError(`허용되지 않는 파일 형식입니다: ${file.name}`)
          continue
        }
        if (file.size > maxFileBytes) {
          setError(`'${file.name}' 파일이 단일 첨부 상한(${attachPolicy.maxFileMb}MB)을 초과했습니다.`)
          continue
        }
        if (merged.length >= attachPolicy.maxFiles) {
          setError(`첨부파일은 최대 ${attachPolicy.maxFiles}개까지 추가할 수 있습니다.`)
          break
        }
        if (merged.reduce((sum, f) => sum + f.size, 0) + file.size > maxTotalBytes) {
          setError(`첨부파일 합계 용량이 ${attachPolicy.maxTotalMb}MB를 초과했습니다.`)
          continue
        }
        merged.push(file)
      }
      return merged
    })
  }

  function removeAttachment(index) {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  function handleDrop(event) {
    event.preventDefault()
    setDragOver(false)
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files)
  }

  async function sendMail() {
    setError('')
    setStatus('')
    if (!selectedAccount) {
      setError(cv.needAccount)
      return
    }
    if (!to.trim()) {
      setError(cv.needTo)
      return
    }
    if (!subject.trim() && !body.text.trim() && attachments.length === 0) {
      setError(cv.needContent)
      return
    }
    setSending(true)
    try {
      // 첨부 전송을 위해 multipart/form-data 로 보낸다. (apiFetch는 JSON 전용이라 fetch 사용)
      const form = new FormData()
      form.append('tenantId', selectedAccount.tenant_id)
      form.append('to', to)
      form.append('cc', cc)
      form.append('bcc', bcc)
      form.append('subject', subject)
      form.append('html', body.html)
      form.append('text', body.text)
      for (const file of attachments) form.append('attachments', file, file.name)

      const res = await fetch(`/api/mail/accounts/${selectedAccount.id}/send`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setStatus(cv.sent)
      setAttachments([])
      onSent?.()
    } catch (err) {
      setError(err.message || cv.sendFailed)
    } finally {
      setSending(false)
    }
  }

  async function saveDraft() {
    setError('')
    setStatus('')
    if (!selectedAccount) {
      setError(cv.needDraftAccount)
      return
    }
    if (!subject.trim() && !body.text.trim() && !to.trim() && !cc.trim() && !bcc.trim()) {
      setError(cv.needDraftContent)
      return
    }
    setSavingDraft(true)
    try {
      const result = await apiFetch(`/mail/accounts/${selectedAccount.id}/drafts`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: selectedAccount.tenant_id,
          draftId,
          to,
          cc,
          bcc,
          subject,
          html: body.html,
          text: body.text,
        }),
      })
      const nextDraftId = result?.draft?.id || draftId
      setDraftId(nextDraftId)
      setStatus(cv.draftSaved)
      onDraftSaved?.(selectedAccount.id, result?.draft)
    } catch (err) {
      setError(err.message || cv.draftFailed)
    } finally {
      setSavingDraft(false)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex-shrink-0 border-b border-gray-100 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-extrabold text-gray-900">{cv.title}</h2>
          </div>
          <div className="flex items-center gap-2">
            <ToolbarButton icon="back" label={cv.cancel} onClick={onCancel} disabled={sending || savingDraft} />
            <ToolbarButton icon="draft" label={savingDraft ? cv.saving : cv.draft} onClick={saveDraft} disabled={sending || savingDraft || selectableAccounts.length === 0} />
            <ToolbarButton icon="sent" label={sending ? cv.sending : cv.send} primary onClick={sendMail} disabled={sending || savingDraft || selectableAccounts.length === 0} />
          </div>
        </div>
      </header>

      <div
        className={`min-h-0 flex-1 overflow-y-auto px-6 py-4 ${dragOver ? 'bg-indigo-50/40 ring-2 ring-inset ring-indigo-400' : ''}`}
        onDragOver={(event) => { event.preventDefault(); if (!dragOver) setDragOver(true) }}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragOver(false) }}
        onDrop={handleDrop}
      >
        <div className="flex min-h-full flex-col gap-2.5">
          <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
            <span>{cv.fromAccount}</span>
            <select
              value={effectiveAccountId}
              onChange={event => setAccountId(event.target.value)}
              className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              {selectableAccounts.length === 0 ? (
                <option value="">{cv.noAccount}</option>
              ) : selectableAccounts.map(account => (
                <option key={account.id} value={account.id}>
                  {getAccountLabel(account)} &lt;{account.email_address}&gt;
                </option>
              ))}
            </select>
          </label>

          <RecipientAutocomplete label={cv.to} recipients={toRecipients} onChange={setToRecipients} onError={setError} cv={cv} />

          <div className="grid gap-3 lg:grid-cols-2">
            <RecipientAutocomplete label={cv.cc} recipients={ccRecipients} onChange={setCcRecipients} onError={setError} cv={cv} />
            <RecipientAutocomplete label={cv.bcc} recipients={bccRecipients} onChange={setBccRecipients} onError={setError} cv={cv} />
          </div>

          <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
            <span>{cv.subject}</span>
            <input
              value={subject}
              onChange={event => setSubject(event.target.value)}
              placeholder={cv.subjectPlaceholder}
              className="h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </label>

          <div className="grid min-h-[220px] flex-1 gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_minmax(0,1fr)]">
            <span className="pt-3">{cv.body}</span>
            <MailComposeEditor
              onChange={setBody}
              initialHtml={initialDraft?.html || ''}
              focusEmptyTop={!!initialDraft?.focusEmptyTop}
            />
          </div>

          <div className="grid flex-shrink-0 gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr]">
            <span className="pt-2">{cv.attachment}</span>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => { addFiles(event.target.files); event.target.value = '' }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 hover:border-indigo-300 hover:bg-indigo-50"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.2 9.19a1 1 0 01-1.41-1.41l8.49-8.49" />
                  </svg>
                  {cv.attachFile}
                </button>
                <span className="text-[11px] font-normal text-gray-400">{cv.dropHint}</span>
              </div>
              {attachments.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-[11px] font-bold text-gray-500">{mt.attachmentCount(attachments.length)}</div>
                  <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto pr-1">
                    {attachments.map((file, index) => {
                      const previewUrl = attachmentPreviews.get(file)
                      return (
                      <span
                        key={`${file.name}-${file.size}-${index}`}
                        className="flex max-w-[240px] items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5"
                        title={`${file.name} (${formatFileSize(file.size)})`}
                      >
                        {previewUrl ? (
                          <button
                            type="button"
                            onClick={() => setLightboxImage({ url: previewUrl, name: file.name })}
                            title="클릭하면 크게 봅니다"
                            className="flex-shrink-0 overflow-hidden rounded-md border border-gray-200 bg-white transition hover:ring-2 hover:ring-indigo-300"
                          >
                            <img src={previewUrl} alt={file.name} className="h-10 w-10 object-cover" />
                          </button>
                        ) : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-bold text-gray-800">{file.name}</span>
                          <span className="block text-[11px] font-normal text-gray-400">{formatFileSize(file.size)}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => removeAttachment(index)}
                          aria-label="첨부 삭제"
                          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-500"
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {(error || status) && (
            <p className={`flex-shrink-0 rounded-lg px-3 py-2 text-sm font-bold ${
              error ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'
            }`}>
              {error || status}
            </p>
          )}
        </div>
      </div>
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setLightboxImage(null)}
          role="dialog"
          aria-modal="true"
        >
          <img
            src={lightboxImage.url}
            alt={lightboxImage.name}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
            onClick={event => event.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setLightboxImage(null)}
            aria-label="닫기"
            className="absolute right-6 top-6 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-gray-700 shadow-lg hover:bg-white"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </section>
  )
}

export default MailComposeView
