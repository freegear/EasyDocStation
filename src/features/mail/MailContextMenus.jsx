import { useEffect, useRef, useState } from 'react'
import { MAIL_TEXT } from './mailText'
import { MenuIcon } from './mailIcons'
import { useAnchoredMenuPosition, useAnchoredSubmenuPosition } from './useAnchoredMenuPosition'
import { FOLDER_COLOR_OPTIONS, getFolderColorLabel, getMailFolderLabel, isSystemMailFolder } from './mailFolderUtils'

function MailMessageContextMenu({ menu, folders, onClose, onDelete, onMarkUnread, onToggleStar, onMove, onRegisterMailClaw, onRegisterMailClawTrash, onRegisterAsPost, onNote, mt = MAIL_TEXT.ko }) {
  const { ref, style } = useAnchoredMenuPosition(menu?.x ?? 0, menu?.y ?? 0)
  const [moveSubmenuAnchor, setMoveSubmenuAnchor] = useState(null)
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false)
  const moveSubmenuCloseTimerRef = useRef(null)
  const { ref: moveSubmenuRef, style: moveSubmenuStyle } = useAnchoredSubmenuPosition(moveSubmenuAnchor)
  useEffect(() => () => {
    if (moveSubmenuCloseTimerRef.current) clearTimeout(moveSubmenuCloseTimerRef.current)
  }, [])
  if (!menu?.message) return null
  const moveFolders = folders.filter(folder => folder.id && folder.id !== menu.message.folder_id)
  const count = Number(menu.targetIds?.length || 1)
  // 라벨/동작 방향은 우클릭한 메일의 현재 상태 기준(14.3). 표시됨이면 '해제', 아니면 '표시'.
  const isStarred = !!menu.message.is_starred
  const openMoveSubmenu = (anchor) => {
    if (moveSubmenuCloseTimerRef.current) clearTimeout(moveSubmenuCloseTimerRef.current)
    setMoveSubmenuAnchor(anchor)
    setMoveSubmenuOpen(true)
  }
  const scheduleMoveSubmenuClose = () => {
    if (moveSubmenuCloseTimerRef.current) clearTimeout(moveSubmenuCloseTimerRef.current)
    moveSubmenuCloseTimerRef.current = setTimeout(() => setMoveSubmenuOpen(false), 120)
  }
  return (
    <div
      ref={ref}
      data-mail-message-context-menu
      className="fixed z-50 min-w-[300px] whitespace-nowrap rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={style}
      onClick={event => event.stopPropagation()}
    >
      {count > 1 && (
        <div className="border-b border-gray-100 px-3 py-2 text-xs font-extrabold text-indigo-600">
          {mt.selectedCount(count)}
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
        <span>{mt.context.delete}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onToggleStar?.(menu, !isStarred)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-amber-50"
      >
        <span className={isStarred ? 'text-amber-400' : 'text-gray-400'}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill={isStarred ? 'currentColor' : 'none'} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.48 3.5l2.12 4.3 4.74.69-3.43 3.34.81 4.72-4.24-2.23-4.24 2.23.81-4.72-3.43-3.34 4.74-.69 2.12-4.3z" />
          </svg>
        </span>
        <span>{isStarred ? mt.context.unstar : mt.context.star}</span>
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
        <span>{mt.context.markUnread}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onRegisterMailClaw?.(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-indigo-700 hover:bg-indigo-50"
      >
        <MenuIcon type="ai" />
        <span>{mt.context.registerMailClaw}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onRegisterMailClawTrash?.(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-indigo-700 hover:bg-indigo-50"
      >
        <MenuIcon type="ai" />
        <span>{mt.context.registerMailClawTrash}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onRegisterAsPost?.(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-indigo-700 hover:bg-indigo-50"
      >
        <MenuIcon type="board" />
        <span>{mt.context.registerAsPost}</span>
      </button>
      <button
        type="button"
        disabled={count > 1}
        title={count > 1 ? mt.note.multiDisabled : undefined}
        onClick={() => {
          if (count > 1) return
          onNote?.(menu.message)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-white"
      >
        <MenuIcon type="note" />
        <span>{menu.message.has_note ? mt.context.viewNote : mt.context.addNote}</span>
      </button>
      <div
        className="relative"
        onMouseLeave={scheduleMoveSubmenuClose}
      >
        <button
          type="button"
          onMouseEnter={(event) => {
            openMoveSubmenu(event.currentTarget.getBoundingClientRect())
          }}
          onFocus={(event) => {
            openMoveSubmenu(event.currentTarget.getBoundingClientRect())
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
        >
          <MenuIcon type="folder" />
          <span className="flex-1">{mt.context.move}</span>
          <MenuIcon type="chevronRight" />
        </button>
        {moveSubmenuOpen && (
          <div
            ref={moveSubmenuRef}
            className="fixed z-[60] min-w-[230px] max-w-[320px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
            style={moveSubmenuStyle}
            onMouseEnter={() => {
              if (moveSubmenuCloseTimerRef.current) clearTimeout(moveSubmenuCloseTimerRef.current)
              setMoveSubmenuOpen(true)
            }}
            onMouseLeave={scheduleMoveSubmenuClose}
          >
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
                <span className="min-w-0 flex-1 truncate">{getMailFolderLabel(folder, mt)}</span>
              </button>
            )) : (
              <div className="px-3 py-2 text-xs text-gray-400">{mt.context.noMoveFolders}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function FolderContextMenu({ menu, onClose, onCreateFolder, onCreateSubFolder, onRenameFolder, onDeleteFolder, onSetFolderColor, onEmptyTrash, mt = MAIL_TEXT.ko }) {
  const { ref, style } = useAnchoredMenuPosition(menu?.x ?? 0, menu?.y ?? 0)
  if (!menu?.folder) return null
  // deletable === false: 서버가 삭제를 거부한 폴더(네이버 자동분류함/서버 예약 메일함 등). (folder_delete_error.md 2번)
  const serverUndeletable = menu.folder.deletable === false
  const canDelete = !isSystemMailFolder(menu.folder) && !serverUndeletable
  const canRename = !isSystemMailFolder(menu.folder)
  const fm = mt.folderMenu
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[210px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={style}
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
        <span>{fm.add}</span>
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
        <span>{fm.addSub}</span>
      </button>
      <button
        type="button"
        disabled={!canRename}
        onClick={() => {
          if (!canRename) return
          onRenameFolder(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-white"
      >
        <span className="w-4 text-center text-gray-400">✎</span>
        <span>{fm.rename}</span>
      </button>
      <button
        type="button"
        disabled={!canDelete}
        title={serverUndeletable ? '이 메일함은 서버에서 삭제할 수 없습니다.' : undefined}
        onClick={() => {
          if (!canDelete) return
          onDeleteFolder(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-white"
      >
        <MenuIcon type="trash" />
        <span>{fm.delete}</span>
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
          <span>{fm.emptyTrash}</span>
        </button>
      )}
      <div className="my-1 border-t border-gray-100" />
      <div className="px-3 py-2 text-xs font-extrabold text-gray-400">{fm.color}</div>
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
          <span>{getFolderColorLabel(option, mt)}</span>
        </button>
      ))}
    </div>
  )
}

function UnifiedFolderContextMenu({ menu, onClose, onRefresh, onSetFolderColor, onEmptyUnifiedTrash, mt = MAIL_TEXT.ko }) {
  const { ref, style } = useAnchoredMenuPosition(menu?.x ?? 0, menu?.y ?? 0)
  if (!menu?.folder) return null
  const label = String(menu.folder.label || '').trim()
  const isTrash = String(menu.folder.type || '') === 'trash' || String(menu.folder.key || '') === 'trash'
  const fm = mt.folderMenu
  const disabledTitle = fm.disabledUnified
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[210px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={style}
      onClick={event => event.stopPropagation()}
    >
      {isTrash && (
        <>
          <button
            type="button"
            onClick={() => {
              onEmptyUnifiedTrash?.(menu.folder)
              onClose()
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
          >
            <MenuIcon type="trash" />
            <span>{fm.emptyTrash}</span>
          </button>
          <div className="my-1 border-t border-gray-100" />
        </>
      )}
      <button
        type="button"
        onClick={() => {
          onRefresh()
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <MenuIcon type="refresh" />
        <span>{mt.refresh}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          if (label) navigator.clipboard?.writeText(label).catch(() => {})
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <span className="w-4 text-center text-gray-400">⧉</span>
        <span>{fm.copyName}</span>
      </button>
      <div className="my-1 border-t border-gray-100" />
      <button
        type="button"
        disabled
        title={disabledTitle}
        className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-left text-gray-300"
      >
        <span className="w-4 text-center">+</span>
        <span>{fm.add}</span>
      </button>
      <button
        type="button"
        disabled
        title={disabledTitle}
        className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-left text-gray-300"
      >
        <span className="w-4 text-center">↳</span>
        <span>{fm.addSub}</span>
      </button>
      <button
        type="button"
        disabled
        title={disabledTitle}
        className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-left text-gray-300"
      >
        <MenuIcon type="trash" />
        <span>{fm.delete}</span>
      </button>
      <div className="my-1 border-t border-gray-100" />
      <div className="px-3 py-2 text-xs font-extrabold text-gray-400">{fm.color}</div>
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
          <span>{getFolderColorLabel(option, mt)}</span>
        </button>
      ))}
    </div>
  )
}

// 스마트 폴더(태그 기반 통합) 우클릭 메뉴 — 이름 변경 / 삭제 / 색상. (MailService.md 13)
function SmartFolderContextMenu({ menu, onClose, onRename, onDelete, onSetColor, mt = MAIL_TEXT.ko }) {
  const { ref, style } = useAnchoredMenuPosition(menu?.x ?? 0, menu?.y ?? 0)
  if (!menu?.folder) return null
  const fm = mt.folderMenu
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[200px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={style}
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => { onRename(menu.folder); onClose() }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <MenuIcon type="draft" />
        <span>{fm.rename}</span>
      </button>
      <button
        type="button"
        onClick={() => { onDelete(menu.folder); onClose() }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
      >
        <MenuIcon type="trash" />
        <span>{fm.smartDelete}</span>
      </button>
      <div className="my-1 border-t border-gray-100" />
      <div className="px-3 py-2 text-xs font-extrabold text-gray-400">{fm.smartColor}</div>
      {FOLDER_COLOR_OPTIONS.map(option => (
        <button
          key={option.key || 'default'}
          type="button"
          onClick={() => { onSetColor(menu.folder, option.key); onClose() }}
          className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-gray-50"
        >
          <span
            className="h-4 w-4 rounded-full border border-gray-200"
            style={{ backgroundColor: option.value || '#e5e7eb' }}
          />
          <span>{getFolderColorLabel(option, mt)}</span>
        </button>
      ))}
    </div>
  )
}

export { MailMessageContextMenu, FolderContextMenu, UnifiedFolderContextMenu, SmartFolderContextMenu }
