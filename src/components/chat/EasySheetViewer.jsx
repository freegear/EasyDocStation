import { useState, useEffect, useRef, useCallback } from 'react'
import { createUniver, defaultTheme, LocaleType, merge } from '@univerjs/presets'
import { CommandType } from '@univerjs/core'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreKoKR from '@univerjs/preset-sheets-core/locales/ko-KR'
import UniverPresetSheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US'
import UniverPresetSheetsCoreJaJP from '@univerjs/preset-sheets-core/locales/ja-JP'
import '@univerjs/preset-sheets-core/lib/index.css'
import { useChat } from '../../contexts/ChatContext'
import { useAuth } from '../../contexts/AuthContext'
import { useT } from '../../i18n/useT'
import ConfirmDialog from '../ConfirmDialog'
import {
  EASY_SHEET_MARKER,
  getEasySheetData,
  getEasySheetTitle,
  EMPTY_SHEET_SNAPSHOT,
} from '../../templates/formTemplates'

// 앱 언어 → Univer LocaleType 매핑 (ko/en/ja 지원, 그 외 ko 폴백)
const LOCALE_MAP = {
  ko: LocaleType.KO_KR,
  en: LocaleType.EN_US,
  ja: LocaleType.JA_JP,
}

export default function EasySheetViewer({ post, channelId, onClose }) {
  const { updatePost, deletePost, posts } = useChat()
  const { currentUser, language } = useAuth()
  const t = useT()

  const containerRef = useRef(null)
  const univerRef = useRef(null)       // { univer, univerAPI }
  const disposeFnRef = useRef(null)    // onCommandExecuted 구독 해제
  const readyRef = useRef(false)       // 초기 로드 완료 후에만 dirty 추적
  const mountedRef = useRef(false)     // StrictMode 이중 마운트 가드

  const [isChanged, setIsChanged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  // 최신 게시글(목록에서 갱신될 수 있음) 기준 권한 계산
  const freshPost = posts[channelId]?.find((p) => p.id === post.id) || post
  const isAuthor = String(freshPost.author?.id ?? '') === String(currentUser?.id ?? '')
  const canEdit = freshPost.can_edit != null ? Boolean(freshPost.can_edit) : isAuthor
  const canEditRef = useRef(canEdit)
  useEffect(() => { canEditRef.current = canEdit }, [canEdit])

  const pageTitle = getEasySheetTitle(post.content, t.easySheet?.title || 'EasySheet')

  // ── Univer 인스턴스 생성/해제 (마운트 1회) ──
  useEffect(() => {
    // StrictMode(dev)에서 effect가 2번 실행되어도 인스턴스를 1개만 생성한다.
    if (mountedRef.current) return undefined
    const el = containerRef.current
    if (!el) return undefined
    mountedRef.current = true

    const locale = LOCALE_MAP[language] || LocaleType.KO_KR
    let instance
    try {
      instance = createUniver({
        locale,
        locales: {
          [LocaleType.KO_KR]: merge({}, UniverPresetSheetsCoreKoKR),
          [LocaleType.EN_US]: merge({}, UniverPresetSheetsCoreEnUS),
          [LocaleType.JA_JP]: merge({}, UniverPresetSheetsCoreJaJP),
        },
        theme: defaultTheme,
        presets: [UniverSheetsCorePreset({ container: el })],
      })
    } catch (err) {
      console.error('[EasySheet] Univer 생성 실패:', err)
      mountedRef.current = false
      return undefined
    }

    univerRef.current = instance
    const { univer, univerAPI } = instance

    // 저장된 스냅샷 주입 (파싱 실패 시 빈 워크북으로 폴백 — getEasySheetData가 보장)
    const snapshot = getEasySheetData(post.content) || EMPTY_SHEET_SNAPSHOT
    try {
      univerAPI.createWorkbook(snapshot)
    } catch (err) {
      console.error('[EasySheet] 워크북 로드 실패, 빈 워크북으로 폴백:', err)
      try { univerAPI.createWorkbook(EMPTY_SHEET_SNAPSHOT) } catch { /* noop */ }
    }

    // 읽기 전용 사용자: 워크북을 viewer 모드로 전환(best-effort)
    // API: univerAPI.getActiveWorkbook().getWorkbookPermission().setReadOnly()
    if (!canEditRef.current) {
      try {
        const workbook = univerAPI.getActiveWorkbook?.()
        const permission = workbook?.getWorkbookPermission?.()
        // setReadOnly()는 Promise — 실패해도 저장은 canEdit 게이트로 차단되므로 무시
        permission?.setReadOnly?.()?.catch?.(() => {})
      } catch (err) {
        console.warn('[EasySheet] 읽기 전용 설정 실패(저장은 권한으로 차단됨):', err)
      }
    }

    // 데이터 변경(MUTATION)만 dirty로 추적 — 선택/스크롤(OPERATION)은 제외
    const subscription = univerAPI.onCommandExecuted((command) => {
      if (!readyRef.current) return
      if (!canEditRef.current) return
      if (command?.type === CommandType.MUTATION) {
        setIsChanged(true)
      }
    })
    disposeFnRef.current = () => {
      try { subscription?.dispose?.() } catch { /* noop */ }
    }

    // 초기 로드 시 발생한 mutation을 무시하기 위해 다음 틱부터 추적 시작
    const readyTimer = setTimeout(() => { readyRef.current = true }, 0)

    return () => {
      clearTimeout(readyTimer)
      readyRef.current = false
      try { disposeFnRef.current?.() } catch { /* noop */ }
      try { univer?.dispose() } catch (err) { console.warn('[EasySheet] dispose 실패:', err) }
      univerRef.current = null
      disposeFnRef.current = null
      mountedRef.current = false
    }
    // post.id 단위로 1회 마운트 (post.content 변경으로 재마운트하지 않음 — 저장은 명시적)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id])

  // ── 저장: Univer 스냅샷 직렬화 → 마커 + JSON 으로 게시글 업데이트 ──
  const handleSave = useCallback(async () => {
    const instance = univerRef.current
    if (!instance || !canEditRef.current) return
    let snapshot
    try {
      const workbook = instance.univerAPI.getActiveWorkbook()
      snapshot = workbook?.save?.()
    } catch (err) {
      console.error('[EasySheet] 스냅샷 직렬화 실패:', err)
      alert(t.easySheet?.saveFailed || 'EasySheet 저장에 실패했습니다.')
      return
    }
    if (!snapshot) return

    setSaving(true)
    try {
      const content = `${EASY_SHEET_MARKER}\n${JSON.stringify(snapshot)}`
      await updatePost(channelId, post.id, { content })
      setIsChanged(false)
    } catch (err) {
      console.error('[EasySheet] 저장 실패:', err)
      alert(t.easySheet?.saveFailed || 'EasySheet 저장에 실패했습니다.')
    } finally {
      setSaving(false)
    }
  }, [channelId, post.id, updatePost, t])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deletePost(channelId, post.id)
      setShowDeleteDialog(false)
      onClose()
    } catch (err) {
      console.error('[EasySheet] 삭제 실패:', err)
      alert(t.easySheet?.deleteFailed || 'EasySheet 삭제에 실패했습니다.')
    } finally {
      setDeleting(false)
    }
  }, [channelId, post.id, deletePost, onClose, t])

  const handleClose = useCallback(() => {
    if (isChanged) setShowSaveDialog(true)
    else onClose()
  }, [isChanged, onClose])

  // ESC 키: 변경분 있으면 저장 확인, 없으면 닫기
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== 'Escape') return
      if (showSaveDialog || showDeleteDialog) return
      if (isChanged) setShowSaveDialog(true)
      else onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isChanged, showSaveDialog, showDeleteDialog, onClose])

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-white">
      {/* ── 상단 바 ── */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-white shadow-sm flex-shrink-0">
        <button
          onClick={handleClose}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 px-2 py-1 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          {t.easySheet?.back || t.mdPage?.back || '뒤로'}
        </button>

        <div className="w-px h-5 bg-gray-200 flex-shrink-0" />
        <span className="text-sm text-gray-700 font-medium flex-1 truncate min-w-0">
          📊 {pageTitle}
        </span>

        {!canEdit && (
          <span className="text-xs text-gray-400 flex-shrink-0">
            {t.easySheet?.readOnly || '읽기 전용'}
          </span>
        )}

        {canEdit && isChanged && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors flex-shrink-0"
          >
            {saving ? (t.easySheet?.saving || '저장 중…') : (t.easySheet?.save || '저장')}
          </button>
        )}

        {canEdit && (
          <button
            onClick={() => setShowDeleteDialog(true)}
            className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors flex-shrink-0"
          >
            {t.easySheet?.delete || t.mdPage?.delete || '삭제'}
          </button>
        )}
      </div>

      {/* ── Univer 컨테이너 ── */}
      <div className="flex-1 min-h-0 min-w-0 relative">
        <div ref={containerRef} className="absolute inset-0" />
      </div>

      {showSaveDialog && (
        <ConfirmDialog
          title={t.easySheet?.unsavedTitle || '저장하지 않은 변경사항'}
          message={t.easySheet?.unsavedMessage || '변경사항을 저장할까요?'}
          confirmText={t.easySheet?.save || '저장'}
          cancelText={t.easySheet?.discard || '저장 안 함'}
          onConfirm={async () => { setShowSaveDialog(false); await handleSave(); onClose() }}
          onCancel={() => { setShowSaveDialog(false); onClose() }}
        />
      )}

      {showDeleteDialog && (
        <ConfirmDialog
          title={t.easySheet?.deleteTitle || 'EasySheet 삭제'}
          message={t.easySheet?.deleteMessage || '이 EasySheet 게시글을 삭제할까요? 되돌릴 수 없습니다.'}
          confirmText={deleting ? (t.easySheet?.deleting || '삭제 중…') : (t.easySheet?.delete || '삭제')}
          cancelText={t.easySheet?.cancel || '취소'}
          danger
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteDialog(false)}
        />
      )}
    </div>
  )
}
