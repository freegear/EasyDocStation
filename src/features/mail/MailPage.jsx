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
import ConfirmDialog from '../../components/ConfirmDialog'

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

function ToolbarButton({ icon, label, primary = false, onClick, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-bold transition-all ${
        primary
          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500'
          : 'border border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900'
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <MenuIcon type={icon} />
      <span>{label}</span>
    </button>
  )
}

const MAIL_PAGE_SIZE = 100
const FOLDER_SYNC_COOLDOWN_MS = 5 * 60 * 1000

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

function MailMessageList({ messages, loading, error, label, selectedId, selectedIds, onSelect, onDoubleClick, onContextMenu, loadingMore }) {
  if (loading) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-sm font-bold text-gray-500">
        메일을 불러오는 중입니다.
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
  if (!messages.length) return <EmptyMailList label={label} />
  return (
    <div className="divide-y divide-gray-100">
      {messages.map((message, index) => {
        const unread = !message.is_read
        const checked = selectedIds?.has?.(message.id)
        return (
          <button
            key={message.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onSelect?.(message, index, event)
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              onDoubleClick?.(message, index, event)
            }}
            onContextMenu={(event) => onContextMenu?.(event, message, index)}
            className={`flex w-full items-start gap-3 px-4 py-3 text-left transition ${
              checked
                ? 'bg-indigo-100 ring-1 ring-inset ring-indigo-200'
                : selectedId === message.id
                  ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-100'
                  : 'hover:bg-indigo-50'
            }`}
          >
            <span className="mt-4 flex h-3 w-3 flex-shrink-0 items-center justify-center">
              {checked ? (
                <span className="flex h-3 w-3 items-center justify-center rounded-full bg-indigo-600 text-[8px] font-black text-white">✓</span>
              ) : unread ? (
                <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className={`truncate text-sm ${unread ? 'font-extrabold text-gray-900' : 'font-medium text-gray-500'}`}>
                  {message.from_name || message.from_email || '(보낸 사람 없음)'}
                </span>
                <span className={`flex-shrink-0 text-[11px] ${unread ? 'font-bold text-gray-500' : 'font-normal text-gray-400'}`}>
                  {message.received_at ? new Date(message.received_at).toLocaleDateString() : ''}
                </span>
              </div>
              <div className={`mt-1 truncate text-sm ${unread ? 'font-bold text-gray-900' : 'font-normal text-gray-500'}`}>
                {message.subject || '(제목 없음)'}
              </div>
              {message.snippet && (
                <div className={`mt-1 line-clamp-2 text-xs leading-5 ${unread ? 'text-gray-500' : 'text-gray-400'}`}>
                  {message.snippet}
                </div>
              )}
            </span>
          </button>
        )
      })}
      {loadingMore && (
        <div className="px-4 py-3 text-center text-xs font-bold text-gray-400">더 불러오는 중…</div>
      )}
    </div>
  )
}

function MailMessageContextMenu({ menu, folders, onClose, onDelete, onMarkUnread, onMove }) {
  if (!menu?.message) return null
  const moveFolders = folders.filter(folder => folder.id && folder.id !== menu.message.folder_id)
  const count = Number(menu.targetIds?.length || 1)
  return (
    <div
      className="fixed z-50 min-w-[190px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={{ left: menu.x, top: menu.y }}
      onClick={event => event.stopPropagation()}
    >
      {count > 1 && (
        <div className="border-b border-gray-100 px-3 py-2 text-xs font-extrabold text-indigo-600">
          {count}개 메일 선택됨
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          onDelete(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
      >
        <MenuIcon type="trash" />
        <span>메일 삭제</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onMarkUnread(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
        <span>안읽은 메일로</span>
      </button>
      <div className="group relative">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
        >
          <MenuIcon type="folder" />
          <span className="flex-1">이동</span>
          <MenuIcon type="chevronRight" />
        </button>
        <div className="invisible absolute left-full top-0 ml-1 max-h-72 min-w-[190px] overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 opacity-0 shadow-xl shadow-gray-900/10 transition group-hover:visible group-hover:opacity-100">
          {moveFolders.length > 0 ? moveFolders.map(folder => (
            <button
              key={folder.id}
              type="button"
              onClick={() => {
                onMove(menu, folder)
                onClose()
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
            >
              <MenuIcon type={folder.type === 'inbox' ? 'inbox' : folder.type === 'trash' ? 'trash' : 'folder'} />
              <span className="truncate">{getMailFolderLabel(folder)}</span>
            </button>
          )) : (
            <div className="px-3 py-2 text-xs text-gray-400">이동할 폴더가 없습니다</div>
          )}
        </div>
      </div>
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
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <MailComposeToolbar />
        <div className="relative h-[1080px] overflow-y-auto">
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

function MailComposeView({ accounts, defaultAccountId, initialDraft, onCancel, onSent, onDraftSaved }) {
  const selectableAccounts = accounts.filter(account => account?.id && account?.tenant_id)
  const [accountId, setAccountId] = useState(initialDraft?.accountId || defaultAccountId || selectableAccounts[0]?.id || '')
  const [draftId, setDraftId] = useState(initialDraft?.draftId || '')
  const [to, setTo] = useState(initialDraft?.to || '')
  const [cc, setCc] = useState(initialDraft?.cc || '')
  const [bcc, setBcc] = useState(initialDraft?.bcc || '')
  const [subject, setSubject] = useState(initialDraft?.subject || '')
  const [body, setBody] = useState({ html: initialDraft?.html || '', text: initialDraft?.text || '' })
  const [sending, setSending] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!accountId && selectableAccounts[0]?.id) setAccountId(selectableAccounts[0].id)
  }, [accountId, selectableAccounts])

  useEffect(() => {
    if (!initialDraft) return
    setAccountId(initialDraft.accountId || defaultAccountId || selectableAccounts[0]?.id || '')
    setDraftId(initialDraft.draftId || '')
    setTo(initialDraft.to || '')
    setCc(initialDraft.cc || '')
    setBcc(initialDraft.bcc || '')
    setSubject(initialDraft.subject || '')
    setBody({ html: initialDraft.html || '', text: initialDraft.text || '' })
    setStatus('')
    setError('')
  }, [defaultAccountId, initialDraft?.draftId])

  const selectedAccount = selectableAccounts.find(account => account.id === accountId)

  async function sendMail() {
    setError('')
    setStatus('')
    if (!selectedAccount) {
      setError('보낼 메일 계정을 선택해주세요.')
      return
    }
    if (!to.trim()) {
      setError('받는 사람을 입력해주세요.')
      return
    }
    if (!subject.trim() && !body.text.trim()) {
      setError('제목 또는 본문을 입력해주세요.')
      return
    }
    setSending(true)
    try {
      await apiFetch(`/mail/accounts/${selectedAccount.id}/send`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: selectedAccount.tenant_id,
          to,
          cc,
          bcc,
          subject,
          html: body.html,
          text: body.text,
        }),
      })
      setStatus('메일을 보냈습니다.')
      onSent?.()
    } catch (err) {
      setError(err.message || '메일을 보내지 못했습니다.')
    } finally {
      setSending(false)
    }
  }

  async function saveDraft() {
    setError('')
    setStatus('')
    if (!selectedAccount) {
      setError('임시 저장할 메일 계정을 선택해주세요.')
      return
    }
    if (!subject.trim() && !body.text.trim() && !to.trim() && !cc.trim() && !bcc.trim()) {
      setError('임시 저장할 내용을 입력해주세요.')
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
      setStatus('임시 보관함에 저장했습니다.')
      onDraftSaved?.(selectedAccount.id, result?.draft)
    } catch (err) {
      setError(err.message || '임시 저장하지 못했습니다.')
    } finally {
      setSavingDraft(false)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex-shrink-0 border-b border-gray-100 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-extrabold text-gray-900">메일 쓰기</h2>
          </div>
          <div className="flex items-center gap-2">
            <ToolbarButton icon="back" label="취소" onClick={onCancel} disabled={sending || savingDraft} />
            <ToolbarButton icon="draft" label={savingDraft ? '저장 중' : '임시 저장'} onClick={saveDraft} disabled={sending || savingDraft || selectableAccounts.length === 0} />
            <ToolbarButton icon="sent" label={sending ? '보내는 중' : '보내기'} primary onClick={sendMail} disabled={sending || savingDraft || selectableAccounts.length === 0} />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-3">
          <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
            <span>보내는 계정</span>
            <select
              value={accountId}
              onChange={event => setAccountId(event.target.value)}
              className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              {selectableAccounts.length === 0 ? (
                <option value="">연결된 메일 계정이 없습니다</option>
              ) : selectableAccounts.map(account => (
                <option key={account.id} value={account.id}>
                  {getAccountLabel(account)} &lt;{account.email_address}&gt;
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
            <span>받는 사람</span>
            <input
              value={to}
              onChange={event => setTo(event.target.value)}
              placeholder="name@example.com, another@example.com"
              className="h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </label>

          <div className="grid gap-3 lg:grid-cols-2">
            <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
              <span>참조</span>
              <input
                value={cc}
                onChange={event => setCc(event.target.value)}
                placeholder="cc@example.com"
                className="h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </label>
            <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
              <span>숨은 참조</span>
              <input
                value={bcc}
                onChange={event => setBcc(event.target.value)}
                placeholder="bcc@example.com"
                className="h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </label>
          </div>

          <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
            <span>제목</span>
            <input
              value={subject}
              onChange={event => setSubject(event.target.value)}
              placeholder="제목을 입력하세요"
              className="h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </label>

          <div className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr]">
            <span className="pt-3">본문</span>
            <MailComposeEditor
              onChange={setBody}
              initialHtml={initialDraft?.html || ''}
              focusEmptyTop={!!initialDraft?.focusEmptyTop}
            />
          </div>

          {(error || status) && (
            <p className={`rounded-lg px-3 py-2 text-sm font-bold ${
              error ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'
            }`}>
              {error || status}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function normalizeAddressList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => ({
      name: String(item?.name || '').trim(),
      email: String(item?.email || item?.address || '').trim(),
    }))
    .filter(item => item.name || item.email)
}

function formatAddress(address) {
  if (!address?.email) return address?.name || ''
  return address.name ? `${address.name} <${address.email}>` : address.email
}

function addressListToInput(value) {
  return normalizeAddressList(value).map(formatAddress).join(', ')
}

function addressListToSearchText(value) {
  return normalizeAddressList(value)
    .map(item => `${item.name} ${item.email}`.trim())
    .join(' ')
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function textToDraftHtml(value) {
  const lines = String(value || '').split(/\r?\n/)
  if (!lines.length) return ''
  return lines.map(line => `<p>${escapeHtml(line) || '<br>'}</p>`).join('')
}

function getDraftComposeData(message, accountId) {
  const text = message?.body_text || message?.snippet || ''
  return {
    draftId: message?.id || '',
    accountId: message?.account_id || accountId || '',
    to: addressListToInput(message?.to_json),
    cc: addressListToInput(message?.cc_json),
    bcc: addressListToInput(message?.bcc_json),
    subject: message?.subject || '',
    html: message?.body_html || textToDraftHtml(text),
    text,
  }
}

function addSubjectPrefix(subject, prefix) {
  const value = String(subject || '').trim() || '(제목 없음)'
  const pattern = new RegExp(`^${prefix.replace(':', '')}\\s*:`, 'i')
  return pattern.test(value) ? value : `${prefix} ${value}`
}

function uniqueAddresses(addresses, excludedEmails = new Set()) {
  const seen = new Set()
  return normalizeAddressList(addresses).filter(address => {
    const email = String(address.email || '').trim().toLowerCase()
    const key = email || String(address.name || '').trim().toLowerCase()
    if (!key || excludedEmails.has(email) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function formatOriginalDate(message) {
  const value = message?.received_at || message?.sent_at || message?.created_at || ''
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch (_) {
    return String(value)
  }
}

function buildOriginalMessageHtml(message, mode) {
  const from = formatAddress({ name: message?.from_name || '', email: message?.from_email || '' }) || '-'
  const to = addressListToInput(message?.to_json) || '-'
  const cc = addressListToInput(message?.cc_json)
  const subject = message?.subject || '(제목 없음)'
  const body = message?.body_html || textToDraftHtml(message?.body_text || message?.snippet || '')
  const title = mode === 'forward' ? '-----Forwarded Message-----' : '-----Original Message-----'
  const ccLine = cc ? `<br><b>Cc:</b> ${escapeHtml(cc)}` : ''

  return [
    '<p><br></p>',
    `<p>${escapeHtml(title)}<br>`,
    `<b>From:</b> ${escapeHtml(from)}<br>`,
    `<b>To:</b> ${escapeHtml(to)}${ccLine}<br>`,
    `<b>Date:</b> ${escapeHtml(formatOriginalDate(message))}<br>`,
    `<b>Subject:</b> ${escapeHtml(subject)}</p>`,
    '<div>',
    body,
    '</div>',
  ].join('')
}

function getMailActionComposeData(message, action, accountId, ownEmails = new Set()) {
  const from = uniqueAddresses([{ name: message?.from_name || '', email: message?.from_email || '' }])
  const originalTo = normalizeAddressList(message?.to_json)
  const originalCc = normalizeAddressList(message?.cc_json)
  const isForward = action === 'forward'
  const isReplyAll = action === 'replyAll'

  return {
    accountId: message?.account_id || accountId || '',
    draftId: '',
    to: isForward
      ? ''
      : addressListToInput(isReplyAll ? uniqueAddresses([...from, ...originalTo]) : from),
    cc: isReplyAll ? addressListToInput(uniqueAddresses(originalCc)) : '',
    bcc: '',
    subject: addSubjectPrefix(message?.subject, isForward ? 'FWD:' : 'RE:'),
    html: buildOriginalMessageHtml(message, isForward ? 'forward' : 'reply'),
    text: '',
    focusEmptyTop: true,
  }
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

function MailAddressMenu({ menu, onClose, onSearch }) {
  if (!menu?.address?.email) return null
  const { address } = menu
  const itemClass = 'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50'
  return (
    <div
      className="fixed z-50 min-w-[210px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={{ left: menu.x, top: menu.y }}
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
        <span>메일 작성</span>
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
        <span>주소 복사</span>
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
        <span>연락처에 추가</span>
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
        <span>VIP 목록에 추가</span>
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
        <span>해당 주소를 검색</span>
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
        onOpen?.({
          address,
          x: Math.min(rect.left, window.innerWidth - 230),
          y: Math.min(rect.bottom + 6, window.innerHeight - 230),
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

function MailViewer({ message, loading, error, onAddressSearch, onMailAction }) {
  const [addressMenu, setAddressMenu] = useState(null)

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

  if (loading) {
    return (
      <div className="flex h-full min-h-[360px] items-center justify-center px-8 text-sm font-bold text-gray-500">
        메일 본문을 불러오는 중입니다.
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
  if (!message) return <EmptyMailViewer />

  const fromAddresses = [{ name: message.from_name || '', email: message.from_email || '' }]
    .filter(item => item.name || item.email)
  const toAddresses = normalizeAddressList(message.to_json)
  const ccAddresses = normalizeAddressList(message.cc_json)

  return (
    <article className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex-shrink-0 border-b border-gray-100 px-6 py-5">
        <h2 className="text-xl font-extrabold leading-8 text-gray-900">
          {message.subject || '(제목 없음)'}
        </h2>
        <div className="mt-3 grid gap-1 text-sm text-gray-500">
          <AddressRow label="보낸 사람" addresses={fromAddresses} onOpen={setAddressMenu} />
          <AddressRow label="받는 사람" addresses={toAddresses} onOpen={setAddressMenu} />
          <AddressRow label="참조" addresses={ccAddresses} onOpen={setAddressMenu} />
          <div>
            <span className="font-bold text-gray-700">날짜</span>{' '}
            {message.received_at ? new Date(message.received_at).toLocaleString() : '-'}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-white">
        {message.body_html ? (
          <iframe
            title="메일 본문"
            sandbox=""
            srcDoc={message.body_html}
            className="h-full min-h-[560px] w-full border-0 bg-white"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words px-6 py-5 text-sm leading-7 text-gray-800">
            {message.body_text || message.snippet || '본문이 없습니다.'}
          </pre>
        )}
      </div>
      <footer className="flex flex-shrink-0 items-center gap-6 border-t border-gray-100 px-6 py-4">
        <MailReplyActionButton icon="forward" label="전달" onClick={() => onMailAction?.('forward', message)} />
        <MailReplyActionButton icon="reply" label="전체 답장" onClick={() => onMailAction?.('replyAll', message)} />
        <MailReplyActionButton icon="reply" label="답장" onClick={() => onMailAction?.('reply', message)} />
      </footer>
      <MailAddressMenu
        menu={addressMenu}
        onClose={() => setAddressMenu(null)}
        onSearch={onAddressSearch}
      />
    </article>
  )
}

const FOLDER_COLOR_OPTIONS = [
  { key: '', label: '기본값', value: '' },
  { key: 'red', label: '빨강', value: '#ff4b55' },
  { key: 'orange', label: '주황', value: '#ff9f43' },
  { key: 'yellow', label: '노랑', value: '#ffd84d' },
  { key: 'green', label: '녹색', value: '#32e96b' },
  { key: 'blue', label: '파랑', value: '#3db7f2' },
  { key: 'purple', label: '퍼플', value: '#bf3df2' },
]

const FOLDER_COLOR_MAP = Object.fromEntries(FOLDER_COLOR_OPTIONS.map(item => [item.key, item.value]))

function getFolderDepth(folders, folder) {
  const byId = new Map((folders || []).map(item => [item.id, item]))
  let depth = 0
  let current = folder
  const seen = new Set()
  while (current?.parent_folder_id && byId.has(current.parent_folder_id) && !seen.has(current.parent_folder_id)) {
    seen.add(current.parent_folder_id)
    depth += 1
    current = byId.get(current.parent_folder_id)
  }
  return depth
}

function isSystemMailFolder(folder) {
  return ['inbox', 'sent', 'drafts', 'trash', 'archive', 'spam'].includes(folder?.type)
}

function MailMenuButton({ active, icon, label, count, unreadCount, iconColor, onClick, onContextMenu, depth = 0 }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`flex items-center gap-2.5 w-full rounded-lg text-sm text-left transition-all ${
        depth ? 'px-2 py-1.5' : 'px-2 py-2'
      } ${
        active
          ? 'bg-indigo-600 text-white shadow-lg'
          : 'text-gray-500 hover:bg-gray-200 hover:text-gray-900'
      }`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <span style={active || !iconColor ? undefined : { color: iconColor }}>
        <MenuIcon type={icon} />
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

function FolderContextMenu({ menu, onClose, onCreateFolder, onCreateSubFolder, onDeleteFolder, onSetFolderColor, onEmptyTrash }) {
  if (!menu?.folder) return null
  const canDelete = !isSystemMailFolder(menu.folder)
  return (
    <div
      className="fixed z-50 min-w-[210px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={{ left: menu.x, top: menu.y }}
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => {
          onCreateFolder(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <span className="w-4 text-center text-gray-400">+</span>
        <span>폴더 추가</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onCreateSubFolder(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <span className="w-4 text-center text-gray-400">↳</span>
        <span>서브 폴더 추가</span>
      </button>
      <button
        type="button"
        disabled={!canDelete}
        onClick={() => {
          if (!canDelete) return
          onDeleteFolder(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-white"
      >
        <MenuIcon type="trash" />
        <span>폴더 삭제</span>
      </button>
      {menu.folder.type === 'trash' && (
        <button
          type="button"
          onClick={() => {
            onEmptyTrash(menu)
            onClose()
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
        >
          <MenuIcon type="trash" />
          <span>휴지통 비우기</span>
        </button>
      )}
      <div className="my-1 border-t border-gray-100" />
      <div className="px-3 py-2 text-xs font-extrabold text-gray-400">폴더 색상 설정</div>
      {FOLDER_COLOR_OPTIONS.map(option => (
        <button
          key={option.key || 'default'}
          type="button"
          onClick={() => {
            onSetFolderColor(menu, option.key)
            onClose()
          }}
          className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-gray-50"
        >
          <span
            className="h-4 w-4 rounded-full border border-gray-200"
            style={{ backgroundColor: option.value || '#e5e7eb' }}
          />
          <span>{option.label}</span>
        </button>
      ))}
    </div>
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

function getAccountLabel(account) {
  return account?.display_name || account?.email_address || ''
}

function getMailFolderLabel(folder = {}) {
  const rawName = String(folder?.name || '').trim()
  const normalized = rawName.toLowerCase()
  if (normalized === 'junk' || normalized === 'spam') return '스팸 메일함'
  return rawName
}

function MailAccountManageModal({ accounts, tenants = [], onClose, onAccountAdded }) {
  const [view, setView] = useState('main')
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [accountEditMode, setAccountEditMode] = useState(false)
  const [accountEditForm, setAccountEditForm] = useState(null)
  const [accountSaving, setAccountSaving] = useState(false)
  const [accountError, setAccountError] = useState('')
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
      const data = await apiFetch(`/mail/accounts/${selectedAccount.id}/imap`, {
        method: 'PUT',
        body: JSON.stringify({
          ...accountEditForm,
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
              {view === 'gmail' ? 'Google 계정 인증을 진행합니다.' : view === 'naver' ? '네이버 메일 클라이언트 정보를 입력하세요.' : view === 'accountDetail' ? '메일 계정 설정 정보를 확인하세요.' : view === 'add' ? '추가할 메일 서비스를 선택하세요.' : view === 'manage' ? '관리할 계정을 선택하세요.' : '계정 추가 또는 관리 작업을 선택하세요.'}
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
                    <ProviderLogo provider={account.provider} />
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

          {view === 'accountDetail' && selectedAccount && (
            <div className="grid gap-4">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <ProviderLogo provider={selectedAccount.provider} />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-extrabold text-gray-900">
                    {selectedAccount.provider === 'naver'
                      ? accountEditMode ? '네이버 메일 계정 편집' : '네이버 메일 계정 관리'
                      : '메일 계정 관리'}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-gray-500">{selectedAccount.email_address}</span>
                </div>
                {selectedAccount.provider === 'naver' && !accountEditMode && (
                  <button
                    type="button"
                    onClick={() => {
                      setAccountEditForm(accountToEditForm(selectedAccount))
                      setAccountEditMode(true)
                      setAccountError('')
                    }}
                    className="rounded-lg bg-[#03C75A] px-3 py-1.5 text-xs font-extrabold text-white hover:bg-[#02b351]"
                  >
                    편집
                  </button>
                )}
              </div>

              {selectedAccount.provider === 'naver' && accountEditMode && accountEditForm ? (
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

                  <div className="grid gap-3 rounded-lg border border-[#03C75A]/20 bg-[#03C75A]/5 p-3">
                    <h3 className="text-sm font-extrabold text-gray-900">네이버 메일 클라이언트 설정</h3>
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
                      className="rounded-lg bg-[#03C75A] px-5 py-2 text-sm font-extrabold text-white shadow-lg shadow-green-100 hover:bg-[#02b351] disabled:opacity-60"
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

                  {selectedAccount.provider === 'naver' && (
                    <div className="grid gap-3 rounded-lg border border-[#03C75A]/20 bg-[#03C75A]/5 p-3">
                      <h3 className="text-sm font-extrabold text-gray-900">네이버 메일 클라이언트 설정</h3>
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

              {selectedAccount.provider !== 'naver' && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-center">
                  <p className="text-sm font-bold text-gray-700">이 계정의 상세 설정 화면은 준비 중입니다.</p>
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
                } else {
                  setView(view === 'gmail' || view === 'naver' ? 'add' : 'main')
                }
              }}
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
  const [mailSearchQuery, setMailSearchQuery] = useState('')
  const [collapsedAccountIds, setCollapsedAccountIds] = useState(() => new Set())
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [messages, setMessages] = useState([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState('')
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)
  const [composeMode, setComposeMode] = useState(false)
  const [composeDraft, setComposeDraft] = useState(null)
  const [selectedMessage, setSelectedMessage] = useState(null)
  const [selectedMessageIds, setSelectedMessageIds] = useState([])
  const [lastSelectedIndex, setLastSelectedIndex] = useState(null)
  const [messageMenu, setMessageMenu] = useState(null)
  const [folderMenu, setFolderMenu] = useState(null)
  const [pendingEmptyTrash, setPendingEmptyTrash] = useState(null)
  const [messageDetailLoading, setMessageDetailLoading] = useState(false)
  const [messageDetailError, setMessageDetailError] = useState('')
  const folderSyncTimesRef = useRef(new Map())

  const displayedMessages = useMemo(() => {
    const query = mailSearchQuery.trim().toLowerCase()
    if (!query) return messages
    return messages.filter(message => {
      const haystack = [
        message.subject,
        message.snippet,
        message.from_name,
        message.from_email,
        addressListToSearchText(message.to_json),
        addressListToSearchText(message.cc_json),
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }, [mailSearchQuery, messages])

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

  function openAgenticPanel() {
    window.dispatchEvent(new CustomEvent('open-agentic-panel'))
  }

  function openCompose() {
    setComposeDraft(null)
    setComposeMode(true)
    setSelectedMessage(null)
    setSelectedMessageIds([])
    setLastSelectedIndex(null)
    setMessageMenu(null)
    setMessageDetailError('')
  }

  function activateMailKey(key) {
    setComposeDraft(null)
    setComposeMode(false)
    setActiveKey(key)
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
    const [accountId, folderKey] = activeKey.split(':')
    const account = sourceAccounts.find(item => item.id === accountId)
    const folder = (account?.folders || []).find(item => String(item.id || item.name) === folderKey)
    if (!account || !folder) return null
    return { account, folder }
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

  function adjustFolderCounts({ accountId, folderId, totalDelta = 0, unreadDelta = 0 }) {
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
          }
        }),
      }
    }))
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
      setLastSelectedIndex(index)
    }
    setMessageMenu({
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 180),
      message,
      targetIds,
    })
  }

  function openFolderMenu(event, account, folder) {
    event.preventDefault()
    event.stopPropagation()
    setFolderMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 360),
      account,
      folder,
    })
  }

  function clearMailSelection() {
    setSelectedMessage(null)
    setSelectedMessageIds([])
    setLastSelectedIndex(null)
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

  async function createMailFolder(menu, parentFolder = null) {
    const account = menu?.account
    if (!account?.id || !account?.tenant_id) return
    const name = window.prompt(parentFolder ? '서브 폴더 이름을 입력하세요.' : '새 폴더 이름을 입력하세요.')
    const cleanName = String(name || '').trim()
    if (!cleanName) return
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
      setActiveKey(`${account.id}:${folder.id}`)
      setComposeMode(false)
    } catch (err) {
      setMessagesError(err.message || '폴더를 추가하지 못했습니다.')
    }
  }

  async function deleteMailFolder(menu) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id || !account?.tenant_id || isSystemMailFolder(folder)) return
    if (!window.confirm(`"${getMailFolderLabel(folder)}" 폴더를 삭제하시겠습니까?`)) return
    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}?${params.toString()}`, {
        method: 'DELETE',
      })
      setAccounts(prev => prev.map(item => (
        item.id === account.id
          ? { ...item, folders: (item.folders || []).filter(existing => existing.id !== folder.id && existing.parent_folder_id !== folder.id) }
          : item
      )))
      const active = resolveActiveFolder()
      if (active?.folder?.id === folder.id) {
        setActiveKey('inbox')
        setMessages([])
        clearMailSelection()
      }
    } catch (err) {
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

  async function markMessageUnread(target) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target)
    if (!active || targets.length === 0) return
    try {
      const params = new URLSearchParams({ tenantId: active.account.tenant_id })
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

  async function deleteMessage(target) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target)
    if (!active || targets.length === 0) return
    try {
      const params = new URLSearchParams({ tenantId: active.account.tenant_id })
      const result = await apiFetch(`/mail/messages/bulk?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'delete', messageIds: targets.map(item => item.id) }),
      })
      const resultById = new Map((result?.results || []).map(item => [item.id, item]))
      const targetIds = new Set(targets.map(item => item.id))
      setMessages(prev => prev.filter(item => !targetIds.has(item.id)))
      setSelectedMessage(prev => (prev && targetIds.has(prev.id) ? null : prev))
      setSelectedMessageIds(prev => prev.filter(id => !targetIds.has(id)))
      for (const message of targets) {
        const resultItem = resultById.get(message.id)
        const targetFolderId = resultItem?.message?.trash_folder_id || resultItem?.message?.folder_id
        adjustFolderCounts({
          accountId: message.account_id,
          folderId: message.folder_id,
          totalDelta: -1,
          unreadDelta: message.is_read ? 0 : -1,
        })
        if (targetFolderId && targetFolderId !== message.folder_id && !resultItem?.message?.soft_deleted) {
          adjustFolderCounts({
            accountId: message.account_id,
            folderId: targetFolderId,
            totalDelta: 1,
            unreadDelta: message.is_read ? 0 : 1,
          })
        }
      }
    } catch (err) {
      setMessagesError(err.message || '메일을 삭제하지 못했습니다.')
    }
  }

  async function moveMessage(target, folder) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target).filter(item => item.folder_id !== folder?.id)
    if (!active || targets.length === 0 || !folder?.id) return
    try {
      const params = new URLSearchParams({ tenantId: active.account.tenant_id })
      await apiFetch(`/mail/messages/bulk?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'move', targetFolderId: folder.id, messageIds: targets.map(item => item.id) }),
      })
      const targetIds = new Set(targets.map(item => item.id))
      setMessages(prev => prev.filter(item => !targetIds.has(item.id)))
      setSelectedMessage(prev => (prev && targetIds.has(prev.id) ? null : prev))
      setSelectedMessageIds(prev => prev.filter(id => !targetIds.has(id)))
      for (const message of targets) {
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
    } catch (err) {
      setMessagesError(err.message || '메일을 이동하지 못했습니다.')
    }
  }

  async function loadActiveMessages(sourceAccounts = accounts, options = {}) {
    setComposeMode(false)
    const { silent = false, resetSelection = true } = options
    const active = resolveActiveFolder(sourceAccounts)
    if (!active) {
      setMessages([])
      setMessagesError('')
      setSelectedMessage(null)
      setSelectedMessageIds([])
      setLastSelectedIndex(null)
      setMessageDetailError('')
      setHasMoreMessages(false)
      return
    }
    if (!silent) setMessagesLoading(true)
    setMessagesError('')
    try {
      const params = new URLSearchParams({
        tenantId: active.account.tenant_id,
        accountId: active.account.id,
        folderId: active.folder.id,
        limit: String(MAIL_PAGE_SIZE),
        offset: '0',
      })
      const rows = await apiFetch(`/mail/messages?${params.toString()}`)
      const list = Array.isArray(rows) ? rows : []
      setMessages(list)
      setHasMoreMessages(list.length === MAIL_PAGE_SIZE)
      if (resetSelection) {
        setSelectedMessage(null)
        setSelectedMessageIds([])
        setLastSelectedIndex(null)
        setMessageDetailError('')
      }
    } catch (err) {
      setMessagesError(err.message || '메일 목록을 불러오지 못했습니다.')
    } finally {
      if (!silent) setMessagesLoading(false)
    }
  }

  // 무한 스크롤: 다음 페이지를 이어서 불러온다.
  async function loadMoreMessages() {
    const active = resolveActiveFolder()
    if (!active || loadingMore || messagesLoading || !hasMoreMessages) return
    setLoadingMore(true)
    try {
      const params = new URLSearchParams({
        tenantId: active.account.tenant_id,
        accountId: active.account.id,
        folderId: active.folder.id,
        limit: String(MAIL_PAGE_SIZE),
        offset: String(messages.length),
      })
      const rows = await apiFetch(`/mail/messages?${params.toString()}`)
      const list = Array.isArray(rows) ? rows : []
      setMessages(prev => [...prev, ...list])
      setHasMoreMessages(list.length === MAIL_PAGE_SIZE)
    } catch (err) {
      // 추가 로드 실패는 다음 스크롤에서 재시도
    } finally {
      setLoadingMore(false)
    }
  }

  function handleMessagesScroll(e) {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
      loadMoreMessages()
    }
  }

  async function refreshMail() {
    setSyncLoading(true)
    setMessagesError('')
    try {
      await apiFetch('/mail/sync-all', {
        method: 'POST',
        body: JSON.stringify({ full: true }),
      })
      const nextAccounts = await reloadMailAccounts()
      await loadActiveMessages(nextAccounts, { silent: true, resetSelection: false })
    } catch (err) {
      setMessagesError(err.message || '메일 새로고침에 실패했습니다.')
    } finally {
      setSyncLoading(false)
    }
  }

  async function selectMessage(message, index, event) {
    const active = resolveActiveFolder()
    if (!active || !message?.id) return
    setComposeMode(false)
    if (event?.shiftKey && lastSelectedIndex != null) {
      const start = Math.min(lastSelectedIndex, index)
      const end = Math.max(lastSelectedIndex, index)
      setSelectedMessageIds(displayedMessages.slice(start, end + 1).map(item => item.id))
    } else {
      setSelectedMessageIds([message.id])
      setLastSelectedIndex(index)
    }
    setMessageDetailLoading(true)
    setMessageDetailError('')
    try {
      const params = new URLSearchParams({ tenantId: active.account.tenant_id })
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
    if (!active || active.folder.type !== 'drafts' || !message?.id) return
    event?.stopPropagation?.()
    setSelectedMessageIds([message.id])
    setLastSelectedIndex(index)
    setMessageDetailLoading(true)
    setMessageDetailError('')
    setMessagesError('')
    try {
      const params = new URLSearchParams({ tenantId: active.account.tenant_id })
      const detail = await apiFetch(`/mail/messages/${message.id}?${params.toString()}`)
      setComposeDraft(getDraftComposeData(detail, active.account.id))
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
    const ownEmails = new Set(
      accounts
        .map(account => String(account.email_address || '').trim().toLowerCase())
        .filter(Boolean),
    )
    setComposeDraft(getMailActionComposeData(message, action, accountId, ownEmails))
    setSelectedMessage(null)
    setSelectedMessageIds([])
    setLastSelectedIndex(null)
    setMessageMenu(null)
    setMessageDetailError('')
    setComposeMode(true)
  }

  useEffect(() => {
    let cancelled = false
    const openedKey = activeKey
    ;(async () => {
      await loadActiveMessages()
      const active = resolveActiveFolder()
      // 사용자 지정 폴더는 DB 목록을 먼저 보여준 뒤, IMAP 동기화는 백그라운드로 수행한다.
      if (cancelled || !active || active.folder.type !== 'custom') return
      const syncKey = `${active.account.id}:${active.folder.id}`
      const lastSyncedAt = folderSyncTimesRef.current.get(syncKey) || 0
      if (Date.now() - lastSyncedAt < FOLDER_SYNC_COOLDOWN_MS) return
      folderSyncTimesRef.current.set(syncKey, Date.now())
      setSyncLoading(true)
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
        if (!cancelled) setMessagesError(err.message || '폴더 동기화에 실패했습니다.')
      } finally {
        if (!cancelled) setSyncLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, accounts.length])

  useEffect(() => {
    if (!messageMenu) return undefined
    function closeMenu() {
      setMessageMenu(null)
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
    function clearOnEscape(event) {
      if (event.key === 'Escape' && (selectedMessage || selectedMessageIds.length > 0)) {
        clearMailSelection()
      }
    }
    window.addEventListener('keydown', clearOnEscape)
    return () => window.removeEventListener('keydown', clearOnEscape)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMessage, selectedMessageIds.length])

  const mainMenus = [
    { key: 'all', label: '모든 편지함', icon: 'all' },
    { key: 'inbox', label: '받은 편지함', icon: 'inbox' },
    { key: 'starred', label: '별표됨', icon: 'star' },
    { key: 'drafts', label: '임시 보관함', icon: 'draft' },
    { key: 'search', label: '검색', icon: 'search' },
    { key: 'sent', label: '보낸 메일', icon: 'sent' },
    { key: 'trash', label: '휴지통', icon: 'trash' },
  ]

  const activeLabel = mainMenus.find(item => item.key === activeKey)?.label
    || accounts.flatMap(account => (account.folders || []).map(folder => ({
      key: `${account.id}:${folder.id || folder.name}`,
      label: `${getAccountLabel(account)} / ${getMailFolderLabel(folder)}`,
    }))).find(item => item.key === activeKey)?.label
    || '메일'
  const activeFolder = resolveActiveFolder()
  const activeAccountId = activeFolder?.account?.id || accounts[0]?.id || ''
  const isActiveDraftFolder = activeFolder?.folder?.type === 'drafts'
  const contextMenuFolders = (accounts.find(account => account.id === messageMenu?.message?.account_id)?.folders || [])
  const selectedMessageIdSet = new Set(selectedMessageIds)

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 min-w-0 overflow-hidden bg-gray-50">
      <aside className="w-full md:w-64 flex-shrink-0 bg-gray-200 flex flex-col h-auto md:h-full max-h-72 md:max-h-none border-b md:border-b-0 md:border-r border-gray-100">
        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-3 pb-2 mb-1 border-b border-gray-300">
            <div className="flex items-center gap-2.5 px-2 py-2 text-gray-900">
              <MailIcon className="w-5 h-5 text-indigo-600" />
              <span className="font-extrabold">메일</span>
            </div>
            <button
              type="button"
              onClick={openCompose}
              className="mb-2 flex w-full items-center gap-2.5 rounded-lg border border-indigo-100 bg-white px-4 py-3 text-left text-sm font-extrabold text-indigo-600 shadow-sm transition-all hover:border-indigo-200 hover:bg-indigo-50 hover:shadow-md"
            >
              <MenuIcon type="draft" />
              <span>메일 쓰기</span>
            </button>
            <button
              type="button"
              onClick={refreshMail}
              disabled={syncLoading}
              className="mb-3 flex w-full items-center gap-2.5 rounded-lg border border-gray-300 bg-gray-100 px-4 py-2.5 text-left text-sm font-bold text-gray-600 transition-all hover:bg-white hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <MenuIcon type="refresh" />
              <span>{syncLoading ? '동기화 중' : '새로 고침'}</span>
            </button>
            <div className="flex flex-col gap-1 mt-1">
              {mainMenus.map(item => (
                <MailMenuButton
                  key={item.key}
                  active={!composeMode && activeKey === item.key}
                  icon={item.icon}
                  label={item.label}
                  onClick={() => activateMailKey(item.key)}
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
                      { id: 'drafts', name: '임시 보관함', type: 'drafts' },
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
                      <span className="truncate">{getAccountLabel(account)}</span>
                    </button>
                    {!collapsed && (
                      <div className="flex flex-col gap-0.5">
                        {folders.map(folder => {
                          const key = `${account.id}:${folder.id || folder.name}`
                          const folderDepth = 1 + getFolderDepth(folders, folder)
                          const folderColor = FOLDER_COLOR_MAP[folder.color_key] || ''
                          return (
                            <MailMenuButton
                              key={key}
                              active={activeKey === key}
                              icon={folder.type === 'inbox' || folder.name === '받은 편지함' ? 'inbox' : folder.type === 'trash' ? 'trash' : 'folder'}
                              label={getMailFolderLabel(folder)}
                              count={folder.message_count}
                              unreadCount={folder.unread_count}
                              iconColor={folderColor}
                              depth={folderDepth}
                              onClick={() => activateMailKey(key)}
                              onContextMenu={(event) => openFolderMenu(event, account, folder)}
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

        <div className="flex gap-2 border-t border-gray-100 px-3 py-2">
          <button
            type="button"
            onClick={onBackToMain}
            className="flex basis-3/4 items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-gray-500 transition-all hover:bg-gray-200 hover:text-gray-900"
          >
            <MenuIcon type="back" />
            <span className="font-medium">메인 메뉴로 이동</span>
          </button>
          <button
            type="button"
            onClick={() => setShowAccountModal(true)}
            className="flex basis-1/4 items-center justify-center rounded-lg px-2 py-2 text-gray-500 transition-all hover:bg-gray-200 hover:text-gray-900"
            title="계정 설정"
            aria-label="계정 설정"
          >
            <MenuIcon type="settings" />
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-hidden flex flex-col bg-gray-50">
        <section className="flex-1 min-h-0 overflow-hidden p-4 md:p-5">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white lg:flex-row">
            {!composeMode && (
              <div className="flex h-80 flex-shrink-0 flex-col border-b border-gray-200 lg:h-full lg:w-[360px] lg:border-b-0 lg:border-r">
                <div className="flex-shrink-0 border-b border-gray-100 p-3">
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                      <MenuIcon type="search" />
                    </span>
                    <input
                      type="search"
                      value={mailSearchQuery}
                      onChange={event => setMailSearchQuery(event.target.value)}
                      placeholder="메일 검색..."
                      className="h-10 w-full rounded-lg border border-gray-200 bg-gray-50 pl-10 pr-3 text-sm text-gray-700 outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
                    <span className="font-bold">메일 목록</span>
                    {selectedMessageIds.length > 0 ? (
                      <button
                        type="button"
                        onClick={clearMailSelection}
                        className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-1 font-extrabold text-indigo-600 transition hover:bg-indigo-100"
                        title="선택 해제"
                      >
                        <span>{selectedMessageIds.length}개 선택됨</span>
                        <span aria-hidden="true">×</span>
                      </button>
                    ) : (
                      <span>{displayedMessages.length}개</span>
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
                  />
                </div>
              </div>
            )}

            <div className="min-w-0 flex-1 overflow-hidden">
              {composeMode ? (
                <MailComposeView
                  key={composeDraft?.draftId || 'new-compose'}
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
                      setActiveKey(`${accountId}:${draftFolder.id || draftFolder.name}`)
                    } else {
                      await loadActiveMessages(nextAccounts, { silent: true, resetSelection: true })
                    }
                  }}
                />
              ) : (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <MailViewer
                      message={selectedMessage}
                      loading={messageDetailLoading}
                      error={messageDetailError}
                      onAddressSearch={setMailSearchQuery}
                      onMailAction={startMailAction}
                    />
                  </div>
                </div>
              )}
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
      <MailMessageContextMenu
        menu={messageMenu}
        folders={contextMenuFolders}
        onClose={() => setMessageMenu(null)}
        onDelete={deleteMessage}
        onMarkUnread={markMessageUnread}
        onMove={moveMessage}
      />
      <FolderContextMenu
        menu={folderMenu}
        onClose={() => setFolderMenu(null)}
        onCreateFolder={(menu) => createMailFolder(menu)}
        onCreateSubFolder={(menu) => createMailFolder(menu, menu?.folder)}
        onDeleteFolder={deleteMailFolder}
        onSetFolderColor={setMailFolderColor}
        onEmptyTrash={setPendingEmptyTrash}
      />
      {pendingEmptyTrash && (
        <ConfirmDialog
          title="휴지통 비우기"
          message={'휴지통에 있는 모든 메일을 영구 삭제합니다.\n\n이 작업은 복구할 수 없다.\n\n계속하시겠습니까?'}
          confirmText="확인"
          cancelText="취소"
          danger
          onConfirm={() => emptyTrashFolder(pendingEmptyTrash)}
          onCancel={() => setPendingEmptyTrash(null)}
        />
      )}
    </div>
  )
}
