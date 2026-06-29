import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Slice } from '@tiptap/pm/model'

const EASYDOC_CLIPBOARD_MIME = 'application/x-easydocstation-md-slice'
const EASYDOC_CLIPBOARD_VERSION = 1

function getSlicePlainText(view, slice) {
  const serialized = view.serializeForClipboard?.(slice)
  const text = serialized?.text || slice.content.textBetween(0, slice.content.size, '\n\n', '\n')
  return String(text || '').replace(/\u00a0/g, ' ')
}

function readEasyDocClipboardSlice(view, event) {
  const raw = event.clipboardData?.getData(EASYDOC_CLIPBOARD_MIME)
  if (!raw) return null

  try {
    const payload = JSON.parse(raw)
    if (payload?.version !== EASYDOC_CLIPBOARD_VERSION || !payload?.slice) return null
    return Slice.fromJSON(view.state.schema, payload.slice)
  } catch (err) {
    console.warn('EasyDocStation clipboard payload ignored:', err)
    return null
  }
}

function getDomSelectedTextInsideElement(container) {
  const selection = window.getSelection?.()
  const text = selection?.toString?.() || ''
  if (!text.trim() || !selection?.rangeCount || !container) return ''

  const range = selection.getRangeAt(0)
  const commonNode = range?.commonAncestorContainer
  const anchor = selection.anchorNode
  const focus = selection.focusNode
  const isInside = (node) => Boolean(node && container.contains(node.nodeType === 1 ? node : node.parentNode))

  if (isInside(commonNode) || isInside(anchor) || isInside(focus)) return text
  return ''
}

function getDomSelectedTextInside(view) {
  return getDomSelectedTextInsideElement(view?.dom)
}

function stopClipboardEvent(event) {
  event.preventDefault()
  event.stopPropagation()
  event.nativeEvent?.stopImmediatePropagation?.()
  event.stopImmediatePropagation?.()
}

function writeEasyDocClipboardData(view, event, { cut = false } = {}) {
  const selection = view?.state?.selection
  const data = event.clipboardData
  if (!selection || !data) return false
  if (cut && !view.editable) return false

  const hasEditorSelection = !selection.empty
  const slice = hasEditorSelection ? selection.content() : null
  const plainText = slice ? getSlicePlainText(view, slice) : getDomSelectedTextInside(view)
  if (!plainText.trim()) return false

  stopClipboardEvent(event)
  data.clearData()
  data.setData('text/plain', plainText)

  if (slice) {
    const payload = {
      version: EASYDOC_CLIPBOARD_VERSION,
      slice: slice.toJSON(),
    }
    data.setData(EASYDOC_CLIPBOARD_MIME, JSON.stringify(payload))
  }

  if (cut) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'))
  }

  return true
}

function pasteEasyDocClipboardData(view, event) {
  if (!view?.editable) return false
  const slice = readEasyDocClipboardSlice(view, event)
  if (!slice || slice === Slice.empty) return false

  stopClipboardEvent(event)
  view.dispatch(
    view.state.tr
      .replaceSelection(slice)
      .scrollIntoView()
      .setMeta('paste', true)
      .setMeta('uiEvent', 'paste'),
  )
  return true
}

export const EasyDocClipboardExtension = Extension.create({
  name: 'easyDocClipboard',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('easyDocClipboard'),
        props: {
          handleDOMEvents: {
            copy(view, event) {
              return writeEasyDocClipboardData(view, event)
            },
            cut(view, event) {
              return writeEasyDocClipboardData(view, event, { cut: true })
            },
            paste(view, event) {
              return pasteEasyDocClipboardData(view, event)
            },
          },
        },
      }),
    ]
  },
})



export { getDomSelectedTextInsideElement, stopClipboardEvent, writeEasyDocClipboardData, pasteEasyDocClipboardData }
