import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { IMAGE_DELETE_BUTTON_CLASS } from '../utils/constants'
import { normalizeFileViewUrlKey, stripAuthTokenFromFileViewUrl } from '../utils/fileViewUrls'

function isEditableImageWrapperElement(el) {
  if (!(el instanceof HTMLElement)) return false
  if (el.tagName !== 'DIV') return false
  const container = el.firstElementChild
  if (!(container instanceof HTMLElement) || container.tagName !== 'DIV') return false
  const img = container.firstElementChild
  return img instanceof HTMLImageElement
}

function safePosAtDOM(view, dom, offset) {
  try {
    return view.posAtDOM(dom, offset)
  } catch {
    return null
  }
}

function findImageNodePosFromWrapper(view, wrapper) {
  const candidates = [safePosAtDOM(view, wrapper, 0)]
  const container = wrapper?.firstElementChild
  if (container instanceof HTMLElement) {
    candidates.push(safePosAtDOM(view, container, 0))
  }

  for (const rawPos of candidates) {
    const pos = Number(rawPos)
    if (!Number.isFinite(pos)) continue
    const directNode = view.state.doc.nodeAt(pos)
    if (directNode?.type?.name === 'image') return pos
    const beforeNode = pos > 0 ? view.state.doc.nodeAt(pos - 1) : null
    if (beforeNode?.type?.name === 'image') return pos - 1
    const afterNode = view.state.doc.nodeAt(pos + 1)
    if (afterNode?.type?.name === 'image') return pos + 1
  }

  const img = wrapper.querySelector('img')
  const src = img instanceof HTMLImageElement
    ? normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(String(img.getAttribute('src') || '').trim()))
    : ''
  if (!src) return null

  let foundPos = null
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'image') return true
    const nodeSrc = normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(String(node.attrs?.src || '').trim()))
    if (nodeSrc === src) {
      foundPos = pos
      return false
    }
    return true
  })
  return foundPos
}

function removeImageNodeFromWrapper(view, wrapper) {
  const pos = findImageNodePosFromWrapper(view, wrapper)
  if (!Number.isFinite(pos)) return false
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type?.name !== 'image') return false

  const tr = view.state.tr.delete(pos, pos + node.nodeSize)
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

export const ImageDeleteControlExtension = Extension.create({
  name: 'imageDeleteControl',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('image-delete-control'),
        view(view) {
          const removeButtons = () => {
            view.dom
              .querySelectorAll(`.${IMAGE_DELETE_BUTTON_CLASS}`)
              .forEach(button => button.remove())
          }

          const selectedImageWrappers = () => Array.from(view.dom.querySelectorAll('div'))
            .filter(isEditableImageWrapperElement)
            .filter((wrapper) => {
              const container = wrapper.firstElementChild
              if (!(container instanceof HTMLElement)) return false
              return /dashed/i.test(container.style.border || '')
            })

          const ensureButtons = () => {
            removeButtons()
            selectedImageWrappers().forEach((wrapper) => {
              const container = wrapper.firstElementChild
              if (!(container instanceof HTMLElement)) return

              const button = document.createElement('button')
              button.type = 'button'
              button.className = IMAGE_DELETE_BUTTON_CLASS
              button.setAttribute('aria-label', '이미지 삭제')
              button.setAttribute('title', '이미지 삭제')
              button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>'
              container.appendChild(button)
            })
          }

          const scheduleEnsureButtons = () => {
            window.requestAnimationFrame(ensureButtons)
          }

          const handlePointerDown = (event) => {
            const target = event.target
            if (!(target instanceof Element)) return
            const button = target.closest(`.${IMAGE_DELETE_BUTTON_CLASS}`)
            if (!(button instanceof HTMLElement)) return

            event.preventDefault()
            event.stopPropagation()

            const wrapper = button.parentElement?.parentElement
            if (!isEditableImageWrapperElement(wrapper)) return
            removeImageNodeFromWrapper(view, wrapper)
          }

          view.dom.addEventListener('pointerdown', handlePointerDown, true)
          view.dom.addEventListener('click', scheduleEnsureButtons)
          document.addEventListener('click', scheduleEnsureButtons)
          scheduleEnsureButtons()

          return {
            update: scheduleEnsureButtons,
            destroy() {
              view.dom.removeEventListener('pointerdown', handlePointerDown, true)
              view.dom.removeEventListener('click', scheduleEnsureButtons)
              document.removeEventListener('click', scheduleEnsureButtons)
              removeButtons()
            },
          }
        },
      }),
    ]
  },
})

export { isEditableImageWrapperElement }
