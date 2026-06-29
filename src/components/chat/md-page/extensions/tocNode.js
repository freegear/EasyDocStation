import { Node, mergeAttributes } from '@tiptap/core'
import { TOC_NODE_NAME } from '../utils/constants'

function collectHeadingItems(doc, limit = 10) {
  const items = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return
    const level = Number(node.attrs?.level || 1)
    const text = String(node.textContent || '').trim()
    if (!text) return
    items.push({ pos, level, text })
  })
  if (limit > 0) return items.slice(0, limit)
  return items
}

export const TocNode = Node.create({
  name: TOC_NODE_NAME,
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      maxShowCount: {
        default: 10,
        parseHTML: el => Number(el.getAttribute('data-max-show-count') || 10),
        renderHTML: attrs => ({ 'data-max-show-count': String(attrs.maxShowCount ?? 10) }),
      },
      topOffset: {
        default: 60,
        parseHTML: el => Number(el.getAttribute('data-top-offset') || 60),
        renderHTML: attrs => ({ 'data-top-offset': String(attrs.topOffset ?? 60) }),
      },
      showTitle: {
        default: true,
        parseHTML: el => el.getAttribute('data-show-title') !== 'false',
        renderHTML: attrs => ({ 'data-show-title': String(attrs.showTitle !== false) }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-toc-node="true"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-toc-node': 'true', class: 'md-toc-node' })]
  },

  addCommands() {
    return {
      insertTocNode:
        (attrs = {}) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              maxShowCount: Number(attrs.maxShowCount ?? 10),
              topOffset: Number(attrs.topOffset ?? 60),
              showTitle: attrs.showTitle !== false,
            },
          }),
    }
  },

  addNodeView() {
    return ({ editor, node }) => {
      const dom = document.createElement('div')
      dom.className = 'md-toc-node'
      dom.setAttribute('data-toc-node', 'true')

      const render = () => {
        const maxShowCount = Number(node.attrs?.maxShowCount ?? 10)
        const topOffset = Number(node.attrs?.topOffset ?? 60)
        const showTitle = node.attrs?.showTitle !== false
        const items = collectHeadingItems(editor.state.doc, maxShowCount)

        dom.innerHTML = ''

        if (showTitle) {
          const title = document.createElement('div')
          title.className = 'md-toc-node-title'
          title.textContent = '목차'
          dom.appendChild(title)
        }

        const list = document.createElement('div')
        list.className = 'md-toc-node-list'

        if (items.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'md-toc-node-empty'
          empty.textContent = '제목(H1/H2/H3)을 추가하면 목차가 표시됩니다.'
          list.appendChild(empty)
        } else {
          items.forEach((item) => {
            const row = document.createElement('button')
            row.type = 'button'
            row.className = 'md-toc-node-item'
            row.style.paddingLeft = `${Math.max(0, (item.level - 1) * 12)}px`
            row.textContent = item.text
            row.onclick = (e) => {
              e.preventDefault()
              editor.chain().focus().setTextSelection(item.pos).run()
              const headingEl = editor.view.nodeDOM(item.pos)
              if (headingEl instanceof HTMLElement) {
                headingEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
                if (topOffset > 0) {
                  window.setTimeout(() => window.scrollBy({ top: -topOffset, behavior: 'smooth' }), 30)
                }
              }
            }
            list.appendChild(row)
          })
        }

        dom.appendChild(list)
      }

      const onUpdate = () => render()
      render()
      editor.on('update', onUpdate)

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== TOC_NODE_NAME) return false
          node = updatedNode
          render()
          return true
        },
        ignoreMutation: () => true,
        destroy() {
          editor.off('update', onUpdate)
        },
      }
    }
  },
})

