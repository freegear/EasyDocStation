import { useState, useEffect, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import MarkdownPreBlock from '../markdown/MarkdownPreBlock'
import { normalizeLatexDelimiters } from '../../lib/markdownMath'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Dropcursor from '@tiptap/extension-dropcursor'
import Link from '@tiptap/extension-link'
import Color from '@tiptap/extension-color'
import { TextStyle } from '@tiptap/extension-text-style'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { TableOfContents } from '@tiptap/extension-table-of-contents'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import ImageResize from 'tiptap-extension-resize-image'
import { Markdown } from 'tiptap-markdown'
import { useChat } from '../../contexts/ChatContext'
import { useAuth } from '../../contexts/AuthContext'
import { useT } from '../../i18n/useT'
import ConfirmDialog from '../ConfirmDialog'
import { getMdPageTitle } from '../../templates/formTemplates'
import { apiFetch, getToken } from '../../lib/api'
import { getPastedImageFiles } from '../../lib/clipboardFiles'
import { getContentFontStyle } from '../../lib/contentFont'
import { normalizeBrokenOrderedListItems } from '../../lib/markdownNormalize'
import LikeButton from './md-page/LikeButton'
import MDCommentAttachmentPreview from './md-page/MDCommentAttachmentPreview'
import TipTapToolbar from './md-page/toolbar/TipTapToolbar'
import LinkBubbleMenu from './md-page/toolbar/LinkBubbleMenu'
import TableBubbleMenu from './md-page/toolbar/TableBubbleMenu'
import InternalLinkAutocomplete from './md-page/toolbar/InternalLinkAutocomplete'
import EasyPageSlashLinkMenu from './md-page/toolbar/EasyPageSlashLinkMenu'
import { MermaidPreviewExtension, EchartsPreviewExtension } from './md-page/extensions/diagramPreviewExtensions'
import { EasyDocClipboardExtension, getDomSelectedTextInsideElement, stopClipboardEvent, writeEasyDocClipboardData, pasteEasyDocClipboardData } from './md-page/extensions/clipboardExtension'
import { TocNode } from './md-page/extensions/tocNode'
import { ImageDeleteControlExtension, isEditableImageWrapperElement } from './md-page/extensions/imageDeleteControlExtension'
import {
  DEFAULT_IMAGE_CONTAINER_STYLE,
  DEFAULT_IMAGE_WRAPPER_STYLE,
  DEFAULT_PREVIEW_CONFIG,
  MD_PAGE_MARKER,
} from './md-page/utils/constants'
import { ensureAuthTokenInFileViewUrl, injectAuthTokenIntoMarkdown, normalizeFileViewUrlKey, stripAuthTokenFromFileViewUrl, stripAuthTokenFromMarkdown } from './md-page/utils/fileViewUrls'
import { normalizeLinkUrl, normalizeMarkdownForTableParsing } from './md-page/utils/markdown'
import { findHexTokenAt, normalizeHexForColorInput } from './md-page/utils/color'
import { attachDocMeta, attachImageMeta, extractDocMeta, extractImageMeta, mapDocMetaUrls, stripAllMdMeta, stripDocMeta } from './md-page/utils/markdownMeta'
import { buildContainerStyleWithWidth, collectImageMetaFromDoc, extractPixelWidthFromStyle, normalizeImageMetaKeys, sameImageMeta } from './md-page/utils/imageMeta'
import useCommentPaneResize from './md-page/hooks/useCommentPaneResize'
import useMDPagePrint from './md-page/hooks/useMDPagePrint'
import useMDPageComments from './md-page/hooks/useMDPageComments'
import '../../styles/tiptap.css'

const ResizableImage = ImageResize.extend({ name: 'image' })
function getEditorDocSignature(editor) {
  if (!editor) return ''
  try {
    return JSON.stringify(editor.getJSON())
  } catch {
    return ''
  }
}

function findTaskItemPosFromTarget(view, targetEl) {
  if (!(targetEl instanceof Element)) return null
  const taskItemEl = targetEl.closest('li[data-type="taskItem"]')
  if (!(taskItemEl instanceof HTMLElement)) return null
  try {
    const pos = view.posAtDOM(taskItemEl, 0)
    if (!Number.isFinite(pos)) return null
    const node = view.state.doc.nodeAt(pos)
    if (!node || node.type?.name !== 'taskItem') return null
    return pos
  } catch {
    return null
  }
}

function getInternalPostLinkTarget(href = '') {
  try {
    const url = new URL(String(href || '').replace(/&amp;/g, '&'), window.location.origin)
    if (url.origin !== window.location.origin) return null
    const targetChannelId = url.searchParams.get('channelId') || url.searchParams.get('channelid')
    const targetPostId = url.searchParams.get('postId') || url.searchParams.get('postid')
    if (!targetChannelId || !targetPostId) return null
    return { channelId: targetChannelId, postId: targetPostId }
  } catch {
    return null
  }
}

function getEventTargetElement(target) {
  if (target instanceof Element) return target
  if (typeof Node !== 'undefined' && target instanceof Node) {
    return target.parentElement || null
  }
  return null
}

function getLinkHrefFromResolvedPos(resolvedPos) {
  const marks = [
    ...(resolvedPos.marks?.() || []),
    ...(resolvedPos.nodeAfter?.marks || []),
    ...(resolvedPos.nodeBefore?.marks || []),
  ]
  const linkMark = marks.find(mark => mark?.type?.name === 'link' && mark.attrs?.href)
  return linkMark?.attrs?.href ? String(linkMark.attrs.href) : ''
}

function getEditorLinkHrefFromEvent(editor, event) {
  const target = getEventTargetElement(event?.target)
  const anchor = target?.closest?.('a[href]')
  if (anchor instanceof HTMLAnchorElement) {
    const href = String(anchor.getAttribute('href') || '').trim()
    if (href) return href
  }

  const view = editor?.view
  if (!view?.posAtCoords || !event || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
    return ''
  }

  const found = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!found || !Number.isFinite(found.pos)) return ''

  const { doc } = view.state
  const docSize = doc.content.size
  const positions = [found.pos, found.pos - 1, found.pos + 1]
    .filter(pos => Number.isFinite(pos) && pos >= 0 && pos <= docSize)

  for (const pos of positions) {
    try {
      const href = getLinkHrefFromResolvedPos(doc.resolve(pos))
      if (href) return href
    } catch {
      // Try the adjacent editor positions; some clicks land on mark boundaries.
    }
  }
  return ''
}

function looksLikeInternalPostHref(href = '') {
  return /(?:^|[?&#])channelid=/i.test(String(href || ''))
    || /(?:^|[?&#])postid=/i.test(String(href || ''))
}

export default function MDPageViewer({ post, channelId, onClose, onOpenPostLink }) {
  const { updatePost, deletePost, addPost, addComment, deleteComment, posts, selectedChannel, togglePostPin, togglePostLike, toggleCommentLike } = useChat()
  const { currentUser, maxAttachmentFileSize } = useAuth()
  const t = useT()
  const authToken = getToken() || ''
  const initialMdStored = normalizeMarkdownForTableParsing(
    stripAuthTokenFromMarkdown(String(post.content || '').replace(/^<!--md-page-->\n?/, '')),
  )
  const initialDocMeta = extractDocMeta(initialMdStored)
  const initialMdRaw = injectAuthTokenIntoMarkdown(stripAllMdMeta(initialMdStored), authToken)
  const initialEditorDoc = initialDocMeta
    ? mapDocMetaUrls(initialDocMeta, (url) => ensureAuthTokenInFileViewUrl(url, authToken))
    : null

  const [mode, setMode] = useState('preview')
  const [savedContent, setSavedContent] = useState(() => stripAllMdMeta(initialMdStored))
  const [sourceText, setSourceText] = useState(() => stripAllMdMeta(initialMdStored))
  const [imageMeta, setImageMeta] = useState(() => extractImageMeta(initialMdStored))
  const [savedImageMeta, setSavedImageMeta] = useState(() => extractImageMeta(initialMdStored))
  const [isChanged, setIsChanged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [creatingChildPage, setCreatingChildPage] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pinning, setPinning] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const showSaveDialogRef = useRef(false)
  const imageInputRef = useRef(null)
  const printContentRef = useRef(null)
  const imageMetaRef = useRef(imageMeta)
  const savedContentRef = useRef(savedContent)
  const savedImageMetaRef = useRef(savedImageMeta)
  const savedDocSignatureRef = useRef(null)
  const sourceBaselineRef = useRef('')
  const [showComments, setShowComments] = useState(false)
  const {
    commentPaneWidth,
    handleCommentSplitterMouseDown,
    isResizingCommentPane,
    splitAreaRef,
  } = useCommentPaneResize({ showComments })
  const {
    addCommentFiles,
    commentDragOver,
    commentFileInputRef,
    commentFiles,
    commentSubmitting,
    commentText,
    handleCommentInputDragLeave,
    handleCommentInputDragOver,
    handleCommentInputDrop,
    handleCommentSubmit,
    handleDeleteComment,
    pendingDeleteCommentId,
    removeCommentFile,
    setCommentText,
    setPendingDeleteCommentId,
  } = useMDPageComments({
    addComment,
    channelId,
    currentUser,
    deleteComment,
    maxAttachmentFileSize,
    postId: post.id,
  })
  const [previewConfig, setPreviewConfig] = useState(DEFAULT_PREVIEW_CONFIG)
  const contentFontStyle = getContentFontStyle(previewConfig.contentFontScale)
  const sourceColorInputRef = useRef(null)
  const sourceColorRangeRef = useRef(null)
  const modeRef = useRef(mode)
  const canEditRef = useRef(false)
  const linkNavigationGuardRef = useRef({ href: '', at: 0 })
  const editorRef = useRef(null)
  const hadCodeFenceRef = useRef(/```/.test(stripAllMdMeta(initialMdStored)))

  useEffect(() => { showSaveDialogRef.current = showSaveDialog }, [showSaveDialog])
  useEffect(() => { imageMetaRef.current = imageMeta }, [imageMeta])
  useEffect(() => { savedContentRef.current = savedContent }, [savedContent])
  useEffect(() => { savedImageMetaRef.current = savedImageMeta }, [savedImageMeta])
  useEffect(() => { modeRef.current = mode }, [mode])

  const channelPosts = Array.isArray(posts[channelId]) ? posts[channelId] : []
  const freshPost = channelPosts.find((p) => p.id === post.id) || post
  const comments = Array.isArray(freshPost.comments) ? freshPost.comments : []
  const isAuthor = String(freshPost.author?.id ?? '') === String(currentUser?.id ?? '')
  const canEdit = freshPost.can_edit != null ? Boolean(freshPost.can_edit) : isAuthor
  const isPinManagerRole = ['site_admin', 'team_admin', 'channel_admin'].includes(String(currentUser?.role || ''))
  const canPinPost = (isPinManagerRole || isAuthor) && !selectedChannel?.is_archived
  useEffect(() => { canEditRef.current = canEdit }, [canEdit])

  const handleEditorLinkNavigation = useCallback((event) => {
    if (event?.button != null && event.button !== 0) return false
    const target = getEventTargetElement(event?.target)
    if (target?.closest?.('[data-easypage-slash-link-menu="true"]')) return false
    const href = getEditorLinkHrefFromEvent(editorRef.current, event)
    if (!href) return false

    event.preventDefault()
    event.stopPropagation()

    const now = Date.now()
    const previous = linkNavigationGuardRef.current
    if (previous.href === href && now - previous.at < 500) return true
    linkNavigationGuardRef.current = { href, at: now }

    const internalTarget = getInternalPostLinkTarget(href) || getInternalPostLinkTarget(normalizeLinkUrl(href))
    if (internalTarget && typeof onOpenPostLink === 'function') {
      onOpenPostLink(internalTarget.channelId, internalTarget.postId)
      return true
    }

    if (looksLikeInternalPostHref(href)) {
      console.warn('Internal EasyPage link could not be resolved:', href)
      return true
    }

    const normalized = normalizeLinkUrl(href)
    window.open(normalized, '_blank', 'noopener,noreferrer')
    return true
  }, [onOpenPostLink])

  useEffect(() => {
    let cancelled = false
    apiFetch('/config/display')
      .then((data) => {
        if (cancelled || !data || typeof data !== 'object') return
        setPreviewConfig((prev) => ({ ...prev, ...data }))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: false,
        dropcursor: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        HTMLAttributes: {
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        },
      }),
      TextStyle,
      Color,
      TaskList,
      TaskItem.configure({
        nested: true,
        onReadOnlyChecked: () => false,
      }),
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      TableOfContents,
      TocNode,
      MermaidPreviewExtension,
      EchartsPreviewExtension,
      EasyDocClipboardExtension,
      ImageDeleteControlExtension,
      ResizableImage.configure({
        minWidth: 120,
        maxWidth: 1200,
      }),
      Dropcursor.configure({
        color: '#6366f1',
        width: 2,
      }),
      Placeholder.configure({ placeholder: t.mdPage.sourcePlaceholder }),
      // 이미지/복합 콘텐츠가 포함된 표는 순수 markdown 직렬화가 불가능할 수 있어
      // html 모드로 fallback 저장/복원을 허용한다.
      Markdown.configure({ html: true, transformCopiedText: true, transformPastedText: true }),
    ],
    content: initialEditorDoc || initialMdRaw,
    editable: canEdit && mode === 'preview',
    editorProps: {
      handleClick(view, _pos, event) {
        const target = event.target
        if (!(target instanceof Element)) return false

        if (target.closest('input[type="checkbox"]')) {
          const taskItemPos = findTaskItemPosFromTarget(view, target)
          if (!Number.isFinite(taskItemPos)) return false

          event.preventDefault()
          event.stopPropagation()

          if (!canEditRef.current || modeRef.current !== 'preview') return true

          const node = view.state.doc.nodeAt(taskItemPos)
          if (!node || node.type?.name !== 'taskItem') return true
          const nextChecked = !node.attrs?.checked
          const tr = view.state.tr.setNodeMarkup(taskItemPos, undefined, {
            ...node.attrs,
            checked: nextChecked,
          })
          view.dispatch(tr)
          return true
        }

        return handleEditorLinkNavigation(event)
      },
      handleDrop(view, event) {
        if (!canEdit || mode !== 'preview') return false
        const allFiles = Array.from(event.dataTransfer?.files || [])
        if (allFiles.length === 0) return false

        event.preventDefault()
        event.stopPropagation()
        setIsDragOver(false)

        const coords = { left: event.clientX, top: event.clientY }
        const dropPos = view.posAtCoords(coords)?.pos

        ;(async () => {
          let insertPos = Number.isFinite(dropPos) ? dropPos : null
          for (const file of allFiles) {
            if (isImageFile(file)) {
              await uploadAndInsertImage(file, insertPos)
            } else {
              await uploadAndInsertFile(file, insertPos)
            }
            insertPos = null
          }
        })()
        return true
      },
    },
    onUpdate({ editor }) {
      const md = stripAllMdMeta(editor.storage.markdown.getMarkdown())
      const hasCodeFence = /```/.test(md)
      const hasCodeBlockNode = (() => {
        let found = false
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'codeBlock') {
            found = true
            return false
          }
          return true
        })
        return found
      })()
      const hasAnyCode = hasCodeFence || hasCodeBlockNode
      const nextImageMeta = collectImageMetaFromDoc(editor.state.doc, imageMetaRef.current)
      const currentDocSignature = getEditorDocSignature(editor)
      const hasDocDiff = Boolean(savedDocSignatureRef.current)
        && currentDocSignature !== savedDocSignatureRef.current
      setImageMeta(prev => (sameImageMeta(prev, nextImageMeta) ? prev : nextImageMeta))
      setIsChanged(
        md !== savedContentRef.current
        || !sameImageMeta(nextImageMeta, savedImageMetaRef.current)
        || hasDocDiff
      )

      // MD 보기에서 코드를 입력한 순간 code(source) 보기로 자동 전환
      if (
        modeRef.current === 'preview'
        && canEditRef.current
        && !hadCodeFenceRef.current
        && hasAnyCode
      ) {
        sourceBaselineRef.current = normalizeMarkdownForTableParsing(
          stripAuthTokenFromMarkdown(md),
        )
        setSourceText(sourceBaselineRef.current)
        setMode('source')
      }

      hadCodeFenceRef.current = hasAnyCode
    },
  })
  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  function handleEditorPaste(event) {
    if (!editor?.view) return false
    const nativeEvent = event?.nativeEvent || event
    if (nativeEvent.__easyDocPasteHandled) return true

    if (pasteEasyDocClipboardData(editor.view, event)) {
      nativeEvent.__easyDocPasteHandled = true
      return true
    }

    const pastedImages = getPastedImageFiles(event)
    if (pastedImages.length === 0) return false

    nativeEvent.__easyDocPasteHandled = true
    stopClipboardEvent(event)
    ;(async () => {
      for (const file of pastedImages) {
        await uploadAndInsertImage(file)
      }
    })()
    return true
  }

  useEffect(() => {
    if (!editor) return
    // 최초 진입 시 문서 시그니처를 baseline으로 저장
    if (!savedDocSignatureRef.current) {
      savedDocSignatureRef.current = getEditorDocSignature(editor)
    }
  }, [editor])

  useEffect(() => {
    const dom = editor?.view?.dom
    if (!dom) return undefined

    const handleCopy = (event) => {
      writeEasyDocClipboardData(editor.view, event)
    }
    const handleCut = (event) => {
      writeEasyDocClipboardData(editor.view, event, { cut: true })
    }
    const handlePaste = (event) => {
      handleEditorPaste(event)
    }

    dom.addEventListener('copy', handleCopy, true)
    dom.addEventListener('cut', handleCut, true)
    dom.addEventListener('paste', handlePaste, true)

    return () => {
      dom.removeEventListener('copy', handleCopy, true)
      dom.removeEventListener('cut', handleCut, true)
      dom.removeEventListener('paste', handlePaste, true)
    }
  }, [editor])

  useEffect(() => {
    const handleDocumentCopy = (event) => {
      const editorDom = editor?.view?.dom
      const selectedText = getDomSelectedTextInsideElement(editorDom)
        || getDomSelectedTextInsideElement(printContentRef.current)
      if (!selectedText.trim() || !event.clipboardData) return

      const handled = writeEasyDocClipboardData(editor?.view, event)
      if (handled) return

      stopClipboardEvent(event)
      event.clipboardData.clearData()
      event.clipboardData.setData('text/plain', selectedText.replace(/\u00a0/g, ' '))
    }

    document.addEventListener('copy', handleDocumentCopy, true)
    return () => {
      document.removeEventListener('copy', handleDocumentCopy, true)
    }
  }, [editor])

  // mode 변경 시 editor editable 상태 동기화
  useEffect(() => {
    if (!editor) return
    editor.setEditable(canEdit && mode === 'preview')
  }, [editor, canEdit, mode])

  // 연속 이미지 run을 감지해 가로 배치 클래스를 부여한다.
  useEffect(() => {
    if (!editor) return undefined

    const applyInlineImageRunLayout = () => {
      const prose = editor.view?.dom
      if (!(prose instanceof HTMLElement)) return
      const children = Array.from(prose.children)

      children.forEach((node) => {
        if (node instanceof HTMLElement) node.classList.remove('md-image-inline-run-item')
      })

      const flushRun = (run) => {
        if (run.length < 2) return
        run.forEach((item) => item.classList.add('md-image-inline-run-item'))
      }

      let run = []
      children.forEach((node) => {
        if (isEditableImageWrapperElement(node)) {
          run.push(node)
        } else {
          flushRun(run)
          run = []
        }
      })
      flushRun(run)
    }

    const rafApply = () => window.requestAnimationFrame(applyInlineImageRunLayout)
    rafApply()
    editor.on('update', rafApply)
    editor.on('selectionUpdate', rafApply)
    return () => {
      editor.off('update', rafApply)
      editor.off('selectionUpdate', rafApply)
    }
  }, [editor])

  useEffect(() => {
    if (!editor) return
    if (!imageMeta || Object.keys(imageMeta).length === 0) return
    const tr = editor.state.tr
    let changed = false

    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return
      const src = String(node.attrs?.src || '').trim()
      const normalizedSrc = normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(src))
      const meta = imageMeta[normalizedSrc] || imageMeta[normalizeFileViewUrlKey(src)] || imageMeta[stripAuthTokenFromFileViewUrl(src)] || imageMeta[src]
      if (!src || !meta) return
      const metaWidth = meta.width ?? extractPixelWidthFromStyle(meta.containerStyle || '') ?? null
      const nextContainerStyle = meta.containerStyle
        ? buildContainerStyleWithWidth(meta.containerStyle, metaWidth)
        : buildContainerStyleWithWidth(node.attrs?.containerStyle || '', metaWidth)
      const nextAttrs = {
        ...node.attrs,
        ...(metaWidth != null ? { width: metaWidth } : {}),
        ...(nextContainerStyle ? { containerStyle: nextContainerStyle } : {}),
        ...(meta.wrapperStyle ? { wrapperStyle: meta.wrapperStyle } : {}),
      }
      if (JSON.stringify(nextAttrs) !== JSON.stringify(node.attrs)) {
        tr.setNodeMarkup(pos, undefined, nextAttrs)
        changed = true
      }
    })

    if (changed) {
      editor.view.dispatch(tr)
    }
  }, [editor, imageMeta])

  // 과거 데이터/신규 삽입 이미지에서 resize용 스타일 attrs가 비어 있으면
  // 노드뷰 리사이즈 핸들이 불안정해질 수 있어 기본값으로 보정한다.
  useEffect(() => {
    if (!editor) return
    const tr = editor.state.tr
    let changed = false

    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return
      const containerStyle = String(node.attrs?.containerStyle || '').trim()
      const wrapperStyle = String(node.attrs?.wrapperStyle || '').trim()
      if (containerStyle && wrapperStyle) return
      const width = node.attrs?.width ?? extractPixelWidthFromStyle(containerStyle) ?? null

      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        containerStyle: containerStyle || buildContainerStyleWithWidth('', width),
        wrapperStyle: wrapperStyle || DEFAULT_IMAGE_WRAPPER_STYLE,
      })
      changed = true
    })

    if (changed) {
      editor.view.dispatch(tr)
    }
  }, [editor])

  // setContent 직후 이미지 크기를 즉시 재적용 — onUpdate 콜백이 imageMeta를 덮어쓰기 전에 실행됨
  function applyImageMetaToEditor(ed, meta) {
    if (!ed || !meta || Object.keys(meta).length === 0) return
    const tr = ed.state.tr
    let changed = false
    ed.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return
      const src = String(node.attrs?.src || '').trim()
      const normalizedSrc = normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(src))
      const m = meta[normalizedSrc] || meta[normalizeFileViewUrlKey(src)] || meta[stripAuthTokenFromFileViewUrl(src)] || meta[src]
      if (!src || !m) return
      const metaWidth = m.width ?? extractPixelWidthFromStyle(m.containerStyle || '') ?? null
      const nextContainerStyle = m.containerStyle
        ? buildContainerStyleWithWidth(m.containerStyle, metaWidth)
        : buildContainerStyleWithWidth('', metaWidth)
      const nextAttrs = {
        ...node.attrs,
        ...(metaWidth != null ? { width: metaWidth } : {}),
        ...(nextContainerStyle ? { containerStyle: nextContainerStyle } : {}),
        ...(m.wrapperStyle ? { wrapperStyle: m.wrapperStyle } : {}),
      }
      if (JSON.stringify(nextAttrs) !== JSON.stringify(node.attrs)) {
        tr.setNodeMarkup(pos, undefined, nextAttrs)
        changed = true
      }
    })
    if (changed) ed.view.dispatch(tr)
  }

  // 소스 → 미리보기 전환: 소스 텍스트를 에디터에 반영
  function switchToPreview() {
    if (mode === 'source' && editor) {
      const normalizedSource = stripAuthTokenFromMarkdown(stripAllMdMeta(sourceText || ''))
      const sanitizedSource = normalizeMarkdownForTableParsing(normalizedSource)
      const baseline = sourceBaselineRef.current || ''
      // 소스가 실제로 변경되지 않았다면 setContent를 건너뛰어
      // 이미지 노드 attrs(width/containerStyle) 손실을 방지한다.
      if (sanitizedSource !== baseline) {
        const withToken = injectAuthTokenIntoMarkdown(sanitizedSource, getToken() || '')
        editor.commands.setContent(withToken)
        applyImageMetaToEditor(editor, imageMetaRef.current)
      }
      const nextChanged = sourceText !== savedContent || !sameImageMeta(imageMeta, savedImageMeta)
      setIsChanged(nextChanged)
      if (!nextChanged) {
        requestAnimationFrame(() => {
          savedDocSignatureRef.current = getEditorDocSignature(editor)
        })
      }
    }
    setMode('preview')
  }

  // 미리보기 → 소스 전환: 에디터 내용을 마크다운으로 추출
  function switchToSource() {
    if (mode === 'preview' && editor) {
      const md = normalizeMarkdownForTableParsing(
        stripAuthTokenFromMarkdown(editor.storage.markdown.getMarkdown()),
      )
      sourceBaselineRef.current = md
      setSourceText(md)
    }
    setMode('source')
  }

  function handleSourceColorPickTrigger(e) {
    if (!canEdit || mode !== 'source') return
    const ta = e.currentTarget
    if (!(ta instanceof HTMLTextAreaElement)) return
    if (ta.selectionStart !== ta.selectionEnd) return
    const token = findHexTokenAt(ta.value, ta.selectionStart)
    if (!token) return
    sourceColorRangeRef.current = { start: token.start, end: token.end }
    if (sourceColorInputRef.current) {
      sourceColorInputRef.current.value = normalizeHexForColorInput(token.value)
      sourceColorInputRef.current.click()
    }
  }

  function handleSourceColorChange(e) {
    const chosen = normalizeHexForColorInput(e.target.value)
    const range = sourceColorRangeRef.current
    if (!range) return
    setSourceText((prev) => {
      const text = String(prev || '')
      const next = text.slice(0, range.start) + chosen + text.slice(range.end)
      setIsChanged(next !== savedContent || !sameImageMeta(imageMetaRef.current, savedImageMetaRef.current))
      return next
    })
  }

  const getCurrentMarkdown = useCallback(() => {
    if (mode === 'source') {
      return normalizeMarkdownForTableParsing(stripAuthTokenFromMarkdown(stripAllMdMeta(sourceText)))
    }
    return normalizeMarkdownForTableParsing(
      stripAuthTokenFromMarkdown(stripAllMdMeta(editor?.storage.markdown.getMarkdown() || '')),
    )
  }, [mode, sourceText, editor])

  const buildCurrentMdPageContent = useCallback(() => {
    const md = stripAuthTokenFromMarkdown(getCurrentMarkdown())
    const normalizedImageMeta = normalizeImageMetaKeys(imageMeta)
    const withImageMeta = attachImageMeta(md, normalizedImageMeta)
    const mdWithMeta = mode === 'preview' && editor
      ? attachDocMeta(withImageMeta, editor.getJSON())
      : stripDocMeta(withImageMeta)
    return {
      md,
      normalizedImageMeta,
      content: `${MD_PAGE_MARKER}\n${mdWithMeta}`,
    }
  }, [editor, getCurrentMarkdown, imageMeta, mode])

  const saveCurrentMdPage = useCallback(async () => {
    const next = buildCurrentMdPageContent()
    setSaving(true)
    try {
      await updatePost(channelId, post.id, { content: next.content })
      setSavedContent(next.md)
      setSavedImageMeta(next.normalizedImageMeta)
      if (mode === 'preview' && editor) {
        savedDocSignatureRef.current = getEditorDocSignature(editor)
      } else {
        // source 모드 저장 후에는 preview 전환 시점에 baseline을 재확정한다.
        savedDocSignatureRef.current = null
      }
      setIsChanged(false)
    } catch (e) {
      console.error('MD 페이지 저장 실패:', e)
      throw e
    } finally {
      setSaving(false)
    }
  }, [buildCurrentMdPageContent, channelId, editor, mode, post.id, updatePost])

  const handleSave = useCallback(async () => {
    try {
      await saveCurrentMdPage()
    } catch {
      // Save errors are surfaced inside saveCurrentMdPage.
    }
  }, [saveCurrentMdPage])

  const handleCreateChildPageFromSelection = useCallback(async () => {
    if (!editor || creatingChildPage) return
    const { from, to, empty } = editor.state.selection
    if (empty || from === to) return
    const selectedText = editor.state.doc.textBetween(from, to, ' ')
    const normalizedTitle = selectedText.replace(/\s+/g, ' ').trim()
    if (!normalizedTitle) return
    const title = Array.from(normalizedTitle).slice(0, 80).join('')
    const childContent = `${MD_PAGE_MARKER}\n# ${title}\n\n`
    setCreatingChildPage(true)
    try {
      const createdPost = await addPost(
        channelId,
        {
          content: childContent,
          attachmentIds: [],
          security_level: freshPost.security_level ?? post.security_level,
        },
        { suppressAlert: true },
      )
      const childPostId = createdPost?.id
      if (!childPostId) throw new Error('생성된 EasyPage ID를 확인할 수 없습니다.')
      const href = `/?channelId=${encodeURIComponent(channelId)}&postId=${encodeURIComponent(childPostId)}`
      const docSize = editor.state.doc.content.size
      if (to > docSize) throw new Error('선택 영역이 변경되어 링크를 적용할 수 없습니다.')
      editor.chain().focus().setTextSelection({ from, to }).setLink({ href }).run()
      try {
        await saveCurrentMdPage()
      } catch (saveErr) {
        console.error('하위 EasyPage 링크 저장 실패:', saveErr)
        setIsChanged(true)
        alert('하위 페이지는 생성되었지만 현재 EasyPage 저장에 실패했습니다. 변경 내용을 수동으로 저장해주세요.')
      }
    } catch (err) {
      console.error('하위 EasyPage 생성 실패:', err)
      alert('하위 페이지 만들기에 실패했습니다: ' + (err?.message || err))
    } finally {
      setCreatingChildPage(false)
    }
  }, [addPost, channelId, creatingChildPage, editor, freshPost.security_level, post.security_level, saveCurrentMdPage])

  const handleCopyLink = useCallback(async () => {
    const link = `${window.location.origin}${window.location.pathname}?channelId=${encodeURIComponent(channelId)}&postId=${encodeURIComponent(post.id)}`
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(link)
      } else {
        const ta = document.createElement('textarea')
        ta.value = link
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      alert('MD 페이지 링크가 복사되었습니다.')
    } catch (e) {
      console.error('MD 페이지 링크 복사 실패:', e)
      alert('링크 복사에 실패했습니다.')
    }
  }, [channelId, post.id])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deletePost(channelId, post.id)
      setShowDeleteDialog(false)
      onClose()
    } catch (e) {
      console.error('MD 페이지 삭제 실패:', e)
      alert('MD 페이지 삭제에 실패했습니다.')
    } finally {
      setDeleting(false)
    }
  }, [channelId, deletePost, onClose, post.id])

  // ESC 키 핸들러
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== 'Escape') return
      if (showSaveDialogRef.current) return
      if (isChanged) setShowSaveDialog(true)
      else onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isChanged, onClose])

  const pageTitle = getMdPageTitle(getCurrentMarkdown(), t.mdPage.title)
  const { handlePrintClick, isPrinting } = useMDPagePrint({
    pageTitle,
    printContentRef,
    titleFallback: t.mdPage.title || 'EasyPage',
  })
  function isImageFile(file) {
    if (!file) return false
    const type = (file.type || '').toLowerCase()
    if (type.startsWith('image/')) return true
    return /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(file.name || '')
  }

  async function uploadAndInsertImage(file, insertPos = null) {
    if (!editor || !isImageFile(file)) return

    setIsUploadingImage(true)
    try {
      const prep = await apiFetch('/files/get-upload-url', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          channelId,
        }),
      })

      const uploadResp = await fetch(prep.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!uploadResp.ok) {
        throw new Error(`이미지 업로드 실패 (${uploadResp.status})`)
      }

      const authToken = getToken()
      const src = `/api/files/view/${prep.file_uuid}${authToken ? `?auth_token=${encodeURIComponent(authToken)}` : ''}`
      const chain = editor.chain().focus()
      if (Number.isFinite(insertPos)) chain.setTextSelection(insertPos)
      chain.setImage({
        src,
        alt: file.name,
        title: file.name,
        containerStyle: DEFAULT_IMAGE_CONTAINER_STYLE,
        wrapperStyle: DEFAULT_IMAGE_WRAPPER_STYLE,
      }).run()
    } catch (e) {
      console.error('MD 이미지 업로드 실패:', e)
      alert(t.mdPage.imageUploadFail || '이미지 업로드에 실패했습니다.')
    } finally {
      setIsUploadingImage(false)
    }
  }

  async function uploadAndInsertFile(file, insertPos = null) {
    if (!editor) return
    setIsUploadingImage(true)
    try {
      const prep = await apiFetch('/files/get-upload-url', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          channelId,
        }),
      })
      const uploadResp = await fetch(prep.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!uploadResp.ok) throw new Error(`파일 업로드 실패 (${uploadResp.status})`)
      const authToken = getToken()
      const href = `/api/files/view/${prep.file_uuid}${authToken ? `?auth_token=${encodeURIComponent(authToken)}` : ''}`
      const chain = editor.chain().focus()
      if (Number.isFinite(insertPos)) chain.setTextSelection(insertPos)
      chain.insertContent({
        type: 'text',
        text: file.name,
        marks: [{ type: 'link', attrs: { href } }],
      }).run()
    } catch (err) {
      console.error('MD 파일 업로드 실패:', err)
      alert(t.mdPage.imageUploadFail || '파일 업로드에 실패했습니다.')
    } finally {
      setIsUploadingImage(false)
    }
  }

  async function handleImageInputChange(e) {
    const files = Array.from(e.target.files || []).filter(isImageFile)
    if (files.length === 0) {
      e.target.value = ''
      return
    }
    for (const file of files) {
      await uploadAndInsertImage(file)
    }
    e.target.value = ''
  }

  function handleImagePickClick() {
    if (!canEdit || mode !== 'preview' || isUploadingImage) return
    imageInputRef.current?.click()
  }

  function handleInsertToc() {
    if (!editor || !canEdit || mode !== 'preview') return
    editor.commands.insertTocNode({
      maxShowCount: 10,
      topOffset: 60,
      showTitle: true,
    })
  }

  async function handleTogglePin() {
    if (!canPinPost || pinning) return
    setPinning(true)
    try {
      await togglePostPin(channelId, post.id, !freshPost.pinned)
    } catch (err) {
      alert(`핀 상태 변경에 실패했습니다: ${err.message || err}`)
    } finally {
      setPinning(false)
    }
  }

  function handleTogglePostLike() {
    togglePostLike(channelId, post.id).catch((err) => {
      alert(`좋아요 처리에 실패했습니다: ${err.message || err}`)
    })
  }

  function handleToggleCommentLike(commentId) {
    toggleCommentLike(channelId, post.id, commentId).catch((err) => {
      alert(`좋아요 처리에 실패했습니다: ${err.message || err}`)
    })
  }

  async function handleEditorDrop(e) {
    const allFiles = Array.from(e.dataTransfer?.files || [])
    if (allFiles.length === 0) return
    // 항상 preventDefault — 브라우저가 파일을 새 탭으로 여는 것을 막는다
    e.preventDefault()
    e.stopPropagation()
    if (!canEdit || mode !== 'preview') return
    setIsDragOver(false)

    let insertPos = null
    if (editor?.view?.posAtCoords) {
      const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (coords && Number.isFinite(coords.pos)) insertPos = coords.pos
    }

    for (const file of allFiles) {
      if (isImageFile(file)) {
        await uploadAndInsertImage(file, insertPos)
      } else {
        await uploadAndInsertFile(file, insertPos)
      }
      insertPos = null
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-white">

      {/* ── Top bar ── */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-white shadow-sm flex-shrink-0">
        <button
          onClick={() => { if (isChanged) setShowSaveDialog(true); else onClose() }}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 px-2 py-1 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          {t.mdPage.back}
        </button>

        <div className="w-px h-5 bg-gray-200 flex-shrink-0" />
        <span className="text-sm text-gray-700 font-medium flex-1 truncate min-w-0">{pageTitle}</span>

        <LikeButton
          liked={freshPost.likedByMe}
          count={freshPost.likeCount}
          fetchLikers={() => apiFetch(`/posts/${post.id}/likes`)}
          onClick={handleTogglePostLike}
        />

        {canPinPost && (
          <button
            onClick={handleTogglePin}
            disabled={pinning}
            title={freshPost.pinned ? (t.chat?.unpinPost || '핀해제') : (t.chat?.pinPost || '핀고정')}
            aria-label={freshPost.pinned ? (t.chat?.unpinPost || '핀해제') : (t.chat?.pinPost || '핀고정')}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors flex-shrink-0 disabled:opacity-60 ${
              freshPost.pinned
                ? 'text-amber-600 hover:text-amber-700 hover:bg-amber-50'
                : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
            }`}
          >
            <svg
              className="w-3.5 h-3.5"
              fill={freshPost.pinned ? 'currentColor' : 'none'}
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={freshPost.pinned ? 0 : 2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 4a1 1 0 00-1-1H9a1 1 0 00-1 1v6l-2 4h12l-2-4V4zm-4 14a2 2 0 002-2h-4a2 2 0 002 2z" />
            </svg>
            <span>{freshPost.pinned ? (t.chat?.unpinPost || '핀해제') : (t.chat?.pinPost || '핀고정')}</span>
          </button>
        )}

        {/* View toggle */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs flex-shrink-0">
          <button
            onClick={switchToSource}
            className={`px-3 py-1.5 transition-colors ${mode === 'source' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
          >
            {t.mdPage.viewSource}
          </button>
          <button
            onClick={switchToPreview}
            className={`px-3 py-1.5 border-l border-gray-200 transition-colors ${mode === 'preview' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
          >
            {t.mdPage.viewPreview}
          </button>
          <button
            onClick={() => setShowComments(prev => !prev)}
            className={`px-3 py-1.5 border-l border-gray-200 transition-colors ${showComments ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
          >
            {t.mdPage.viewComments?.(comments.length) || `댓글보기 (${comments.length})`}
          </button>
        </div>

        <button
          onClick={handleCopyLink}
          title="링크복사"
          aria-label="링크복사"
          className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </button>

        {canEdit && isChanged && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors flex-shrink-0"
          >
            {saving ? t.mdPage.saving : t.mdPage.save}
          </button>
        )}

        <button
          onClick={handlePrintClick}
          className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors flex-shrink-0"
        >
          {t.mdPage.print || '인쇄'}
        </button>

        {canEdit && (
          <button
            onClick={() => setShowDeleteDialog(true)}
            disabled={deleting}
            className="px-3 py-1.5 rounded-lg border border-red-200 text-xs text-red-600 hover:bg-red-50 transition-colors flex-shrink-0 disabled:opacity-60"
          >
            {deleting ? (t.mdPage.deleting || '삭제 중...') : (t.mdPage.delete || '삭제')}
          </button>
        )}

        {isPrinting && (
          <span className="text-xs text-indigo-600 font-medium">{t.mdPage.printing || '인쇄 준비 중...'}</span>
        )}

        {canEdit && mode === 'preview' && isUploadingImage && (
          <span className="text-xs text-indigo-600 font-medium">{t.mdPage.imageUploading || '이미지 업로드 중...'}</span>
        )}
      </div>

      {/* ── TipTap Toolbar (미리보기+편집 가능 모드에서만 표시) ── */}
      {canEdit && mode === 'preview' && editor && (
        <TipTapToolbar
          editor={editor}
          t={t}
          onInsertImage={handleImagePickClick}
          onInsertToc={handleInsertToc}
          isUploadingImage={isUploadingImage}
        />
      )}

      <div ref={splitAreaRef} className={`flex-1 min-h-0 flex ${showComments ? 'flex-row' : 'flex-col'}`}>
        {/* ── Content area ── */}
        <div
          ref={printContentRef}
          className={`easy-page-print-root flex-1 min-w-0 overflow-auto min-h-0 ${isDragOver ? 'bg-indigo-50/50' : ''}`}
          onDragOver={(e) => {
            if (!canEdit || mode !== 'preview') return
            if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
              e.preventDefault()
              setIsDragOver(true)
            }
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleEditorDrop}
        >
          {mode === 'source' ? (
            /* 소스 모드: 마크다운 텍스트 표시 */
            <>
              <textarea
                className="w-full h-full p-6 font-mono text-sm text-gray-800 bg-gray-50 resize-none focus:outline-none focus:bg-white transition-colors"
                value={sourceText}
                onChange={canEdit ? e => {
                  const nextSource = e.target.value
                  setSourceText(nextSource)
                  setIsChanged(nextSource !== savedContent || !sameImageMeta(imageMeta, savedImageMeta))
                } : undefined}
                onClick={handleSourceColorPickTrigger}
                readOnly={!canEdit}
                spellCheck={false}
                placeholder={t.mdPage.sourcePlaceholder}
              />
              <input
                ref={sourceColorInputRef}
                type="color"
                className="sr-only"
                onChange={handleSourceColorChange}
                tabIndex={-1}
                aria-hidden="true"
              />
            </>
          ) : (
            /* 미리보기 모드: TipTap WYSIWYG 에디터 */
            <div
              className="max-w-4xl mx-auto px-8 py-8 relative"
              onCopyCapture={(event) => {
                writeEasyDocClipboardData(editor?.view, event)
              }}
              onCutCapture={(event) => {
                writeEasyDocClipboardData(editor?.view, event, { cut: true })
              }}
              onPasteCapture={(event) => {
                handleEditorPaste(event)
              }}
              onPointerDownCapture={(event) => {
                handleEditorLinkNavigation(event)
              }}
              onMouseDownCapture={(event) => {
                handleEditorLinkNavigation(event)
              }}
              onClickCapture={(event) => {
                handleEditorLinkNavigation(event)
              }}
            >
              {canEdit && (
                <LinkBubbleMenu
                  editor={editor}
                  onCreateChildPage={handleCreateChildPageFromSelection}
                  creatingChildPage={creatingChildPage}
                />
              )}
              {canEdit && (
                <TableBubbleMenu editor={editor} />
              )}
              <EditorContent editor={editor} className="tiptap-editor" style={contentFontStyle} />
              {canEdit && (
                <InternalLinkAutocomplete editor={editor} />
              )}
              {canEdit && (
                <EasyPageSlashLinkMenu
                  editor={editor}
                  channelId={channelId}
                  currentPost={freshPost}
                  channelPosts={channelPosts}
                />
              )}
            </div>
          )}
        </div>

        {showComments && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              title="드래그해서 댓글 영역 크기 조절"
              onMouseDown={handleCommentSplitterMouseDown}
              className={`w-2 h-full flex-shrink-0 cursor-col-resize border-x border-gray-200 transition-colors ${isResizingCommentPane ? 'bg-indigo-200' : 'bg-gray-100 hover:bg-indigo-100'}`}
            >
              <div className="m-auto h-12 w-0.5 rounded-full bg-gray-400" />
            </div>

            <div
              className="border-l border-gray-200 bg-gray-50/70 px-6 py-4 overflow-auto flex-shrink-0 h-full"
              style={{ width: `${commentPaneWidth}px` }}
            >
              {comments.length === 0 ? (
                <p className="text-sm text-gray-500">등록된 댓글이 없습니다.</p>
              ) : (
                <div className="space-y-3">
                  {comments.map((comment) => {
                    const authorName = comment?.author?.name || comment?.authorName || '사용자'
                    const createdAt = comment?.createdAt
                      ? new Date(comment.createdAt).toLocaleString()
                      : ''
                    const canDeleteComment =
                      String(comment?.author?.id ?? '') === String(currentUser?.id ?? '')
                      || currentUser?.role === 'site_admin'
                    return (
                      <div key={comment.id} className="flex flex-col">
                        <div className="w-full rounded-2xl bg-blue-50 border border-blue-100 shadow-sm px-4 py-2.5">
                          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                            <span className="font-semibold text-gray-700">{authorName}</span>
                            {createdAt && <span>{createdAt}</span>}
                            {canDeleteComment && (
                              <button
                                type="button"
                                onClick={() => setPendingDeleteCommentId(comment.id)}
                                className="ml-auto px-2 py-0.5 rounded-md border border-red-200 text-red-500 hover:bg-red-50 text-[11px]"
                              >
                                삭제
                              </button>
                            )}
                          </div>
                          <div className="eds-markdown text-gray-800 whitespace-pre-wrap break-words" style={contentFontStyle}>
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm, remarkMath]}
                              rehypePlugins={[rehypeKatex]}
                              components={{
                                a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
                                ul: ({ children }) => <ul className="list-disc pl-9 my-1.5 space-y-1">{children}</ul>,
                                ol: ({ children, ...props }) => <ol {...props} className="list-decimal pl-5 my-1.5 space-y-1">{children}</ol>,
                                pre: ({ children }) => <MarkdownPreBlock>{children}</MarkdownPreBlock>,
                              }}
                            >
                              {normalizeLatexDelimiters(normalizeBrokenOrderedListItems(String(comment?.content || '')))}
                            </ReactMarkdown>
                          </div>
                          {Array.isArray(comment?.attachments) && comment.attachments.length > 0 && (
                            <div className="mt-3 grid grid-cols-1 gap-2">
                              {comment.attachments.map((att) => (
                                <MDCommentAttachmentPreview
                                  key={att.id}
                                  attachment={att}
                                  resolveUrl={(url) => ensureAuthTokenInFileViewUrl(url, getToken() || '')}
                                  previewConfig={previewConfig}
                                />
                              ))}
                            </div>
                          )}
                          <div className="mt-2 flex items-center">
                            <LikeButton
                              liked={comment?.likedByMe}
                              count={comment?.likeCount}
                              fetchLikers={() => apiFetch(`/posts/${post.id}/comments/${comment.id}/likes`)}
                              onClick={() => handleToggleCommentLike(comment.id)}
                            />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              <form onSubmit={handleCommentSubmit} className="mt-4 border-t border-gray-200 pt-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-500">댓글 입력 (파일 Drag & Drop 가능)</p>
                  <button
                    type="button"
                    onClick={() => commentFileInputRef.current?.click()}
                    className="px-2.5 py-1 rounded-md border border-gray-300 text-xs text-gray-600 hover:bg-gray-100"
                    disabled={commentSubmitting}
                  >
                    파일 추가
                  </button>
                </div>
                <textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onDragOver={handleCommentInputDragOver}
                  onDragLeave={handleCommentInputDragLeave}
                  onDrop={handleCommentInputDrop}
                  placeholder="댓글을 입력하세요..."
                  className={`w-full min-h-[72px] max-h-36 resize-y rounded-lg border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200 ${commentDragOver ? 'border-indigo-400 bg-indigo-50' : 'border-gray-300 bg-white'}`}
                  style={contentFontStyle}
                  disabled={commentSubmitting}
                />
                {commentFiles.length > 0 && (
                  <div className="mt-2 max-h-32 overflow-y-auto overscroll-contain pr-1 flex flex-wrap gap-2">
                    {commentFiles.map((f) => (
                      <div key={f.id} className="flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs text-gray-700">
                        <span className="max-w-[180px] truncate">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => removeCommentFile(f.id)}
                          className="text-gray-400 hover:text-red-500"
                          aria-label={`${f.name} 제거`}
                          disabled={commentSubmitting}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex justify-end">
                  <button
                    type="submit"
                    disabled={commentSubmitting || (!String(commentText || '').trim() && commentFiles.length === 0)}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-500 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    {commentSubmitting ? '등록 중...' : '댓글 등록'}
                  </button>
                </div>
                <input
                  ref={commentFileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    addCommentFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
              </form>
            </div>
          </>
        )}
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleImageInputChange}
      />

      {/* ── 저장 다이얼로그 ── */}
      {showSaveDialog && (
        <ConfirmDialog
          title={t.mdPage.saveDialogTitle}
          message={t.mdPage.saveDialogMessage}
          confirmText={t.mdPage.saveDialogSave}
          cancelText={t.mdPage.saveDialogDiscard}
          titleTone="blue"
          loading={saving}
          onConfirm={async () => {
            await handleSave()
            setShowSaveDialog(false)
            onClose()
          }}
          onCancel={() => {
            setShowSaveDialog(false)
            onClose()
          }}
        />
      )}

      {showDeleteDialog && (
        <ConfirmDialog
          title="삭제 확인"
          message={`${pageTitle} 페이지가 삭제 됩니다. 진행 하시겠습니까 ?`}
          confirmText="삭제"
          cancelText="취소"
          danger
          loading={deleting}
          onConfirm={handleDelete}
          onCancel={() => {
            if (deleting) return
            setShowDeleteDialog(false)
          }}
        />
      )}
      {pendingDeleteCommentId && (
        <ConfirmDialog
          title="댓글 삭제"
          message="이 댓글을 삭제하시겠습니까?"
          confirmText="삭제"
          cancelText="취소"
          danger
          onConfirm={handleDeleteComment}
          onCancel={() => setPendingDeleteCommentId(null)}
        />
      )}
    </div>
  )
}
