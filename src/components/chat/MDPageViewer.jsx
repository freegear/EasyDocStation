import { useState, useEffect, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Node, Extension, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
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
import mermaid from 'mermaid'
import * as echarts from 'echarts'
import { HexColorPicker } from 'react-colorful'
import { useChat } from '../../contexts/ChatContext'
import { useAuth } from '../../contexts/AuthContext'
import { useT } from '../../i18n/useT'
import ConfirmDialog from '../ConfirmDialog'
import { getMdPageContent, getMdPageTitle } from '../../templates/formTemplates'
import { apiFetch, getToken } from '../../lib/api'
import '../../styles/tiptap.css'

const MD_PAGE_MARKER = '<!--md-page-->'
const MD_IMAGE_META_PREFIX = '<!--md-image-meta:'
const MD_DOC_META_PREFIX = '<!--md-doc-meta:'
const ResizableImage = ImageResize.extend({ name: 'image' })
const FILE_VIEW_URL_PATTERN = /(https?:\/\/[^\s)"']+\/api\/files\/view\/[A-Za-z0-9-]+(?:\?[^\s)"']*)?|\/api\/files\/view\/[A-Za-z0-9-]+(?:\?[^\s)"']*)?)/g
const TOC_NODE_NAME = 'tocNode'
const DEFAULT_IMAGE_CONTAINER_STYLE = 'width: 100%; height: auto; cursor: pointer;'
const DEFAULT_IMAGE_WRAPPER_STYLE = 'display: flex;'
const DEFAULT_PREVIEW_CONFIG = {
  imagePreview: { width: 512, height: 512 },
  pdfPreview: { width: 480, height: 270 },
  txtPreview: { width: 270, height: 480 },
  pptPreview: { width: 480, height: 270 },
  pptxPreview: { width: 480, height: 270 },
  excelPreview: { width: 480, height: 270 },
  wordPreview: { width: 270, height: 480 },
  moviePreview: { width: 480, height: 270 },
  htmlPreview: { width: 480, height: 270 },
}
const MERMAID_RENDER_CLASS = 'md-mermaid-render'
const MERMAID_PLUGIN_KEY = new PluginKey('md-mermaid-preview')
const ECHARTS_RENDER_CLASS = 'md-echarts-render'
const ECHARTS_PLUGIN_KEY = new PluginKey('md-echarts-preview')
let mermaidInitialized = false

function hashText(source = '') {
  let hash = 0
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(i)
    hash |= 0
  }
  return String(hash)
}

function escapeHtml(source = '') {
  return String(source)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function ensureMermaidInitialized() {
  if (mermaidInitialized) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // PNG export 시 canvas taint를 유발할 수 있는 foreignObject 기반 html label을 비활성화
    flowchart: { htmlLabels: false },
  })
  mermaidInitialized = true
}

function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function sanitizeFilenamePart(text = '') {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'diagram'
}

async function downloadSvgAsPng(svgMarkup, filenameBase = 'mermaid-diagram', minWidth = 2000) {
  const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' })
  const svgUrl = URL.createObjectURL(svgBlob)
  try {
    const img = new Image()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = svgUrl
    })

    const intrinsicWidth = Math.max(1, Math.ceil(img.width || 1200))
    const intrinsicHeight = Math.max(1, Math.ceil(img.height || 800))
    const targetWidth = Math.max(Number(minWidth) || 2000, intrinsicWidth)
    const targetHeight = Math.max(1, Math.round((intrinsicHeight * targetWidth) / intrinsicWidth))

    const width = targetWidth
    const height = targetHeight
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas context를 생성할 수 없습니다.')

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)

    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!pngBlob) throw new Error('PNG 변환에 실패했습니다.')
    const pngUrl = URL.createObjectURL(pngBlob)
    const a = document.createElement('a')
    a.href = pngUrl
    a.download = `${filenameBase}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(pngUrl)
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}

function buildExportSafeMermaidSource(source = '') {
  const initDirective = '%%{init: {"securityLevel":"strict","flowchart":{"htmlLabels":false}}}%%'
  const raw = String(source || '').trim()
  if (!raw) return initDirective
  if (raw.startsWith('%%{init:') || raw.startsWith('%%{initialize:')) return raw
  return `${initDirective}\n${raw}`
}

function sanitizeSvgForCanvas(svgMarkup = '') {
  // External url() / @import가 남아 있으면 canvas taint 가능성이 높아져 제거한다.
  return String(svgMarkup || '')
    .replace(/@import\s+url\([^)]+\)\s*;?/gi, '')
    .replace(/url\(\s*['"]?https?:\/\/[^)'" ]+['"]?\s*\)/gi, 'none')
}

async function renderMermaidSvgForExport(source = '') {
  ensureMermaidInitialized()
  const exportSource = buildExportSafeMermaidSource(source)
  const renderId = `md-mermaid-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { svg } = await mermaid.render(renderId, exportSource)
  return sanitizeSvgForCanvas(svg)
}

function parseEchartsOption(source = '') {
  const text = String(source || '').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (_) {
    try {
      // eslint-disable-next-line no-new-func
      return Function(`"use strict"; return (${text});`)()
    } catch (err) {
      throw new Error(`ECharts 옵션 파싱 실패: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function getCodeBlockLanguage(node) {
  const attrs = node?.attrs || {}
  const raw = String(
    attrs.language
    ?? attrs.lang
    ?? attrs.params
    ?? attrs.syntax
    ?? '',
  ).trim().toLowerCase()
  if (!raw) return ''
  const first = raw.split(/\s+/)[0] || ''
  return first.replace(/^language-/, '')
}

function isLikelyEchartsOption(source = '') {
  try {
    const option = parseEchartsOption(source)
    if (!option || typeof option !== 'object' || Array.isArray(option)) return false
    const keys = ['series', 'xAxis', 'yAxis', 'dataset', 'title', 'legend', 'tooltip', 'grid', 'radar', 'geo']
    return keys.some((k) => Object.prototype.hasOwnProperty.call(option, k))
  } catch {
    return false
  }
}

function buildEchartsExportBaseName(source = '') {
  const option = parseEchartsOption(source)
  const title = typeof option?.title?.text === 'string' ? option.title.text : 'echarts-diagram'
  return sanitizeFilenamePart(title || 'echarts-diagram')
}

function ensureEchartsSize(option = {}) {
  const cloned = { ...option }
  if (!cloned.animation) cloned.animation = false
  return cloned
}

function downloadDataUrl(filename, dataUrl) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function exportEchartsAsPng(source = '', minWidth = 2000) {
  const option = ensureEchartsSize(parseEchartsOption(source))
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1200px;height:800px;'
  document.body.appendChild(host)
  try {
    const chart = echarts.init(host, null, { renderer: 'canvas' })
    chart.setOption(option, true)
    chart.resize()
    const w = Math.max(1, chart.getWidth() || 1200)
    const pixelRatio = Math.max(1, Math.ceil((Number(minWidth) || 2000) / w))
    const dataUrl = chart.getDataURL({
      type: 'png',
      pixelRatio,
      backgroundColor: '#ffffff',
      excludeComponents: ['toolbox'],
    })
    chart.dispose()
    return dataUrl
  } finally {
    host.remove()
  }
}

async function exportEchartsAsSvg(source = '') {
  const option = ensureEchartsSize(parseEchartsOption(source))
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1200px;height:800px;'
  document.body.appendChild(host)
  try {
    const chart = echarts.init(host, null, { renderer: 'svg' })
    chart.setOption(option, true)
    chart.resize()
    const svgEl = host.querySelector('svg')
    if (!(svgEl instanceof SVGElement)) {
      chart.dispose()
      throw new Error('SVG 렌더를 생성하지 못했습니다.')
    }
    const serializer = new XMLSerializer()
    const svg = serializer.serializeToString(svgEl)
    chart.dispose()
    return svg
  } finally {
    host.remove()
  }
}

const MermaidPreviewExtension = Extension.create({
  name: 'mdMermaidPreview',

  addProseMirrorPlugins() {
    const cache = new Map()
    const pending = new Map()
    let viewRef = null
    let seq = 0
    let refreshTick = 0

    const buildDecorations = (doc) => {
      const decorations = []
      doc.descendants((node, pos) => {
        if (node.type.name !== 'codeBlock') return
        const language = String(node.attrs?.language || '').trim().toLowerCase()
        if (language !== 'mermaid') return

        const source = String(node.textContent || '').trim()
        if (!source) return
        const sourceHash = hashText(source)
        const widgetPos = pos + node.nodeSize
        decorations.push(Decoration.node(pos, pos + node.nodeSize, {
          class: 'md-mermaid-source-hidden',
        }))

        decorations.push(Decoration.widget(widgetPos, () => {
          const container = document.createElement('div')
          container.className = MERMAID_RENDER_CLASS
          container.setAttribute('contenteditable', 'false')

          const cached = cache.get(sourceHash)
          if (cached?.status === 'ok') {
            const header = document.createElement('div')
            header.className = 'md-mermaid-actions'

            const svgBtn = document.createElement('button')
            svgBtn.type = 'button'
            svgBtn.className = 'md-mermaid-action-btn'
            svgBtn.textContent = 'SVG 저장'
            svgBtn.onclick = () => {
              const name = sanitizeFilenamePart(source.split('\n')[0] || 'mermaid-diagram')
              downloadTextFile(`${name}.svg`, cached.svg, 'image/svg+xml;charset=utf-8')
            }

            const pngBtn = document.createElement('button')
            pngBtn.type = 'button'
            pngBtn.className = 'md-mermaid-action-btn'
            pngBtn.textContent = 'PNG 2000px'
            pngBtn.onclick = async () => {
              try {
                const name = sanitizeFilenamePart(source.split('\n')[0] || 'mermaid-diagram')
                const exportSvg = await renderMermaidSvgForExport(source)
                await downloadSvgAsPng(exportSvg, name, 2000)
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                window.alert(`PNG 저장 실패: ${msg}`)
              }
            }

            const png4kBtn = document.createElement('button')
            png4kBtn.type = 'button'
            png4kBtn.className = 'md-mermaid-action-btn'
            png4kBtn.textContent = 'PNG 4000px'
            png4kBtn.onclick = async () => {
              try {
                const name = sanitizeFilenamePart(source.split('\n')[0] || 'mermaid-diagram')
                const exportSvg = await renderMermaidSvgForExport(source)
                await downloadSvgAsPng(exportSvg, name, 4000)
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                window.alert(`PNG 저장 실패: ${msg}`)
              }
            }

            const png6kBtn = document.createElement('button')
            png6kBtn.type = 'button'
            png6kBtn.className = 'md-mermaid-action-btn'
            png6kBtn.textContent = 'PNG 6000px'
            png6kBtn.onclick = async () => {
              try {
                const name = sanitizeFilenamePart(source.split('\n')[0] || 'mermaid-diagram')
                const exportSvg = await renderMermaidSvgForExport(source)
                await downloadSvgAsPng(exportSvg, name, 6000)
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                window.alert(`PNG 저장 실패: ${msg}`)
              }
            }

            header.appendChild(svgBtn)
            header.appendChild(pngBtn)
            header.appendChild(png4kBtn)
            header.appendChild(png6kBtn)
            container.appendChild(header)

            const svgWrap = document.createElement('div')
            svgWrap.className = 'md-mermaid-svg-wrap'
            svgWrap.innerHTML = cached.svg
            container.appendChild(svgWrap)
            return container
          }
          if (cached?.status === 'error') {
            container.innerHTML = `<pre class="md-mermaid-error">${escapeHtml(cached.message)}</pre>`
            return container
          }

          container.innerHTML = '<div class="md-mermaid-rendering">Mermaid 렌더링 중...</div>'

          if (!pending.has(sourceHash)) {
            ensureMermaidInitialized()
            const renderId = `md-mermaid-${Date.now()}-${seq}`
            seq += 1
            const task = mermaid.render(renderId, source)
              .then(({ svg }) => {
                cache.set(sourceHash, { status: 'ok', svg })
              })
              .catch((err) => {
                const message = err instanceof Error ? err.message : String(err)
                cache.set(sourceHash, { status: 'error', message })
              })
              .finally(() => {
                pending.delete(sourceHash)
                if (viewRef) {
                  refreshTick += 1
                  const tr = viewRef.state.tr.setMeta(MERMAID_PLUGIN_KEY, { refresh: true })
                  viewRef.dispatch(tr)
                }
              })
            pending.set(sourceHash, task)
          }

          return container
        }, {
          key: `md-mermaid-${widgetPos}-${sourceHash}-${refreshTick}`,
          side: 1,
        }))
      })
      return DecorationSet.create(doc, decorations)
    }

    return [
      new Plugin({
        key: MERMAID_PLUGIN_KEY,
        state: {
          init: (_, state) => buildDecorations(state.doc),
          apply: (tr, oldDecos, _oldState, newState) => {
            const meta = tr.getMeta(MERMAID_PLUGIN_KEY)
            if (tr.docChanged || (meta && meta.refresh)) {
              return buildDecorations(newState.doc)
            }
            return oldDecos.map(tr.mapping, tr.doc)
          },
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
        },
        view(view) {
          viewRef = view
          return {
            destroy() {
              viewRef = null
            },
          }
        },
      }),
    ]
  },
})

const EchartsPreviewExtension = Extension.create({
  name: 'mdEchartsPreview',

  addProseMirrorPlugins() {
    const buildDecorations = (doc) => {
      const decorations = []
      doc.descendants((node, pos) => {
        if (node.type.name !== 'codeBlock') return
        const language = getCodeBlockLanguage(node)

        const source = String(node.textContent || '').trim()
        if (!source) return
        const isEchartsLanguage = ['echarts', 'echart'].includes(language)
        const isFallbackJsonOption =
          (!language || ['json', 'javascript', 'js'].includes(language))
          && isLikelyEchartsOption(source)
        if (!isEchartsLanguage && !isFallbackJsonOption) return

        const widgetPos = pos + node.nodeSize
        decorations.push(Decoration.node(pos, pos + node.nodeSize, {
          class: 'md-echarts-source-hidden',
        }))

        decorations.push(Decoration.widget(widgetPos, () => {
          const container = document.createElement('div')
          container.className = ECHARTS_RENDER_CLASS
          container.setAttribute('contenteditable', 'false')

          const header = document.createElement('div')
          header.className = 'md-echarts-actions'

          const svgBtn = document.createElement('button')
          svgBtn.type = 'button'
          svgBtn.className = 'md-echarts-action-btn'
          svgBtn.textContent = 'SVG 저장'
          svgBtn.onclick = async () => {
            try {
              const base = buildEchartsExportBaseName(source)
              const svg = await exportEchartsAsSvg(source)
              downloadTextFile(`${base}.svg`, svg, 'image/svg+xml;charset=utf-8')
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              window.alert(`SVG 저장 실패: ${msg}`)
            }
          }

          const png2kBtn = document.createElement('button')
          png2kBtn.type = 'button'
          png2kBtn.className = 'md-echarts-action-btn'
          png2kBtn.textContent = 'PNG 2000px'
          png2kBtn.onclick = async () => {
            try {
              const base = buildEchartsExportBaseName(source)
              const dataUrl = await exportEchartsAsPng(source, 2000)
              downloadDataUrl(`${base}.png`, dataUrl)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              window.alert(`PNG 저장 실패: ${msg}`)
            }
          }

          const png4kBtn = document.createElement('button')
          png4kBtn.type = 'button'
          png4kBtn.className = 'md-echarts-action-btn'
          png4kBtn.textContent = 'PNG 4000px'
          png4kBtn.onclick = async () => {
            try {
              const base = buildEchartsExportBaseName(source)
              const dataUrl = await exportEchartsAsPng(source, 4000)
              downloadDataUrl(`${base}.png`, dataUrl)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              window.alert(`PNG 저장 실패: ${msg}`)
            }
          }

          const png6kBtn = document.createElement('button')
          png6kBtn.type = 'button'
          png6kBtn.className = 'md-echarts-action-btn'
          png6kBtn.textContent = 'PNG 6000px'
          png6kBtn.onclick = async () => {
            try {
              const base = buildEchartsExportBaseName(source)
              const dataUrl = await exportEchartsAsPng(source, 6000)
              downloadDataUrl(`${base}.png`, dataUrl)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              window.alert(`PNG 저장 실패: ${msg}`)
            }
          }

          header.appendChild(svgBtn)
          header.appendChild(png2kBtn)
          header.appendChild(png4kBtn)
          header.appendChild(png6kBtn)
          container.appendChild(header)

          const chartWrap = document.createElement('div')
          chartWrap.className = 'md-echarts-wrap'
          container.appendChild(chartWrap)

          chartWrap.innerHTML = '<div class="md-echarts-rendering">ECharts 렌더링 중...</div>'
          window.requestAnimationFrame(() => {
            try {
              const option = ensureEchartsSize(parseEchartsOption(source))
              chartWrap.innerHTML = ''
              const host = document.createElement('div')
              host.style.width = '100%'
              host.style.minHeight = '380px'
              host.style.height = '420px'
              chartWrap.appendChild(host)
              const chart = echarts.init(host, null, { renderer: 'canvas' })
              chart.setOption(option, true)
              chart.resize()
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              chartWrap.innerHTML = `<pre class="md-echarts-error">${escapeHtml(message)}</pre>`
            }
          })

          return container
        }, {
          key: `md-echarts-${widgetPos}-${hashText(source)}`,
          side: 1,
        }))
      })
      return DecorationSet.create(doc, decorations)
    }

    return [
      new Plugin({
        key: ECHARTS_PLUGIN_KEY,
        state: {
          init: (_, state) => buildDecorations(state.doc),
          apply: (tr, oldDecos, _oldState, newState) => {
            const meta = tr.getMeta(ECHARTS_PLUGIN_KEY)
            if (tr.docChanged || (meta && meta.refresh)) return buildDecorations(newState.doc)
            return oldDecos.map(tr.mapping, tr.doc)
          },
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
        },
      }),
    ]
  },
})

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

const TocNode = Node.create({
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

function extractImageMeta(mdText = '') {
  const regex = /<!--md-image-meta:([A-Za-z0-9+/=_-]+)-->/g
  const matches = Array.from(String(mdText || '').matchAll(regex))
  const encoded = matches.length > 0 ? matches[matches.length - 1]?.[1] : ''
  if (!encoded) return {}
  try {
    const decoded = atob(encoded)
    try {
      return normalizeImageMetaKeys(JSON.parse(decoded) || {})
    } catch {
      // Backward/forward safety for unicode payloads.
      return normalizeImageMetaKeys(JSON.parse(decodeURIComponent(escape(decoded))) || {})
    }
  } catch {
    return {}
  }
}

function stripImageMeta(mdText = '') {
  return String(mdText || '').replace(/\n?<!--md-image-meta:[A-Za-z0-9+/=_-]+-->\s*/g, '')
}

function mapDocMetaUrls(node, mapper = (v) => v) {
  if (Array.isArray(node)) return node.map((child) => mapDocMetaUrls(child, mapper))
  if (!node || typeof node !== 'object') return node

  const next = { ...node }
  if (next.attrs && typeof next.attrs === 'object') {
    next.attrs = { ...next.attrs }
    if (typeof next.attrs.src === 'string') next.attrs.src = mapper(next.attrs.src)
    if (typeof next.attrs.href === 'string') next.attrs.href = mapper(next.attrs.href)
  }
  if (Array.isArray(next.content)) {
    next.content = next.content.map((child) => mapDocMetaUrls(child, mapper))
  }
  return next
}

function extractDocMeta(mdText = '') {
  const regex = /<!--md-doc-meta:([A-Za-z0-9+/=_-]+)-->/g
  const matches = Array.from(String(mdText || '').matchAll(regex))
  const encoded = matches.length > 0 ? matches[matches.length - 1]?.[1] : ''
  if (!encoded) return null
  try {
    const decoded = atob(encoded)
    const parsed = JSON.parse(decodeURIComponent(escape(decoded)))
    if (!parsed || typeof parsed !== 'object') return null
    return mapDocMetaUrls(parsed, (url) => stripAuthTokenFromFileViewUrl(url))
  } catch {
    return null
  }
}

function stripDocMeta(mdText = '') {
  return String(mdText || '').replace(/\n?<!--md-doc-meta:[A-Za-z0-9+/=_-]+-->\s*/g, '')
}

function stripAllMdMeta(mdText = '') {
  return stripDocMeta(stripImageMeta(mdText))
}

function attachDocMeta(mdText = '', docJson = null) {
  const plain = stripDocMeta(mdText || '')
  if (!docJson || typeof docJson !== 'object') return plain
  const sanitized = mapDocMetaUrls(docJson, (url) => stripAuthTokenFromFileViewUrl(url))
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(sanitized))))
  return `${plain}\n${MD_DOC_META_PREFIX}${encoded}-->`
}

function attachImageMeta(mdText = '', imageMeta = {}) {
  const plain = stripImageMeta(mdText || '')
  const normalizedMeta = normalizeImageMetaKeys(imageMeta || {})
  const keys = Object.keys(normalizedMeta)
  if (keys.length === 0) return plain
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(normalizedMeta))))
  return `${plain}\n${MD_IMAGE_META_PREFIX}${encoded}-->`
}

function mapFileViewUrl(url, mutateParams) {
  try {
    const input = String(url || '').trim()
    if (!input) return input
    const absolute = /^https?:\/\//i.test(input)
    const parsed = new URL(input, window.location.origin)
    if (!parsed.pathname.startsWith('/api/files/view/')) return input
    mutateParams(parsed.searchParams)
    if (absolute) return parsed.toString()
    const q = parsed.searchParams.toString()
    return `${parsed.pathname}${q ? `?${q}` : ''}${parsed.hash || ''}`
  } catch {
    return String(url || '')
  }
}

function normalizeFileViewUrlKey(url) {
  try {
    const input = String(url || '').trim()
    if (!input) return ''
    const parsed = new URL(input, window.location.origin)
    if (!parsed.pathname.startsWith('/api/files/view/')) return input
    parsed.searchParams.delete('auth_token')
    const entries = Array.from(parsed.searchParams.entries())
    entries.sort(([a], [b]) => a.localeCompare(b))
    const query = new URLSearchParams(entries).toString()
    return `${parsed.pathname}${query ? `?${query}` : ''}`
  } catch {
    return String(url || '').trim()
  }
}

function stripAuthTokenFromFileViewUrl(url) {
  return mapFileViewUrl(url, (params) => {
    params.delete('auth_token')
  })
}

function ensureAuthTokenInFileViewUrl(url, token) {
  return mapFileViewUrl(url, (params) => {
    params.delete('auth_token')
    if (token) params.set('auth_token', token)
  })
}

function rewriteFileViewUrlsInMarkdown(md = '', rewriteFn = (v) => v) {
  return String(md || '').replace(FILE_VIEW_URL_PATTERN, (matched) => rewriteFn(matched))
}

function stripAuthTokenFromMarkdown(md = '') {
  return rewriteFileViewUrlsInMarkdown(md, stripAuthTokenFromFileViewUrl)
}

function injectAuthTokenIntoMarkdown(md = '', token = '') {
  return rewriteFileViewUrlsInMarkdown(md, (url) => ensureAuthTokenInFileViewUrl(url, token))
}

function normalizeMarkdownForTableParsing(md = '') {
  const text = String(md || '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  // 리스트 항목 내부에서 "들여쓴 백틱 1줄"이 indented code block으로 오인되는 케이스 보정
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!/^\s{4,}`[^`\n]+`\s*$/.test(line)) continue

    let prev = i - 1
    while (prev >= 0 && lines[prev].trim() === '') prev -= 1
    if (prev < 0) continue

    const prevLine = lines[prev]
    const isListLine = /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(prevLine)
    if (!isListLine) continue

    lines[i] = `  ${line.trim()}`
  }
  const normalizedText = lines.join('\n')
  // Markdown image line 바로 아래에 GFM table 헤더가 붙으면 표 파싱이 깨지는 케이스가 있어
  // 블록 경계를 명확히 하기 위해 빈 줄을 강제한다.
  return normalizedText
    .replace(/(!\[[^\]]*]\([^)]*\))(?=\|)/g, '$1\n\n')
    .replace(/(<img\b[^>]*>)(?=\|)/gi, '$1\n\n')
    .replace(/(!\[[^\]]*]\([^)]+\)(?:\{[^}]*\})?[^\n]*)\n(?=\|.+\|)/g, '$1\n\n')
    .replace(/(<img\b[^>]*>[^\n]*)\n(?=\|.+\|)/gi, '$1\n\n')
}

function normalizeImageMetaKeys(imageMeta = {}) {
  const entries = Object.entries(imageMeta || {})
  if (entries.length === 0) return {}
  const normalized = {}
  for (const [key, val] of entries) {
    const nextKey = normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(String(key || '').trim()))
    if (!nextKey) continue
    normalized[nextKey] = val || {}
  }
  return normalized
}

function extractPixelWidthFromStyle(style = '') {
  const text = String(style || '')
  const m = text.match(/width:\s*([0-9.]+)px/i)
  if (!m?.[1]) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? String(Math.round(n)) : null
}

function buildContainerStyleWithWidth(existingStyle = '', width = null) {
  const styleText = String(existingStyle || '').trim()
  const widthValue = width == null ? null : `${Number(width)}px`
  if (!widthValue || Number.isNaN(Number(width))) {
    return styleText || DEFAULT_IMAGE_CONTAINER_STYLE
  }

  if (!styleText) {
    return `width: ${widthValue}; height: auto; cursor: pointer;`
  }

  if (/width\s*:/i.test(styleText)) {
    return styleText.replace(/width:\s*[^;]+;?/i, `width: ${widthValue};`)
  }
  return `width: ${widthValue}; ${styleText}`
}

function normalizeStyleStr(s) {
  return String(s || '').trim().replace(/;\s*$/, '')
}

function hasSizingMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return false
  const widthFromAttr = meta.width
  const widthFromContainerStyle = extractPixelWidthFromStyle(meta.containerStyle || '')
  return (
    widthFromAttr != null
    || widthFromContainerStyle != null
  )
}

function collectImageMetaFromDoc(doc, fallbackMap = {}) {
  const normalizedFallbackMap = normalizeImageMetaKeys(fallbackMap || {})
  const map = {}
  doc.descendants((node) => {
    if (node.type.name !== 'image') return
    const src = normalizeFileViewUrlKey(stripAuthTokenFromFileViewUrl(String(node.attrs?.src || '').trim()))
    if (!src) return
    const widthFromAttr = node.attrs?.width ?? null
    const widthFromStyle = extractPixelWidthFromStyle(node.attrs?.containerStyle || '')
    const resolvedWidth = widthFromAttr ?? widthFromStyle ?? null
    const current = {
      width: resolvedWidth,
      containerStyle: node.attrs?.containerStyle ?? null,
      wrapperStyle: node.attrs?.wrapperStyle ?? null,
    }
    const fallback = normalizedFallbackMap?.[src] || {}
    map[src] = hasSizingMeta(current) ? current : {
      width: fallback.width ?? current.width ?? null,
      containerStyle: fallback.containerStyle ?? current.containerStyle ?? null,
      wrapperStyle: fallback.wrapperStyle ?? current.wrapperStyle ?? null,
    }
  })
  return map
}

function sameImageMeta(a = {}, b = {}) {
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length) return false
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false
    const av = a[aKeys[i]] || {}
    const bv = b[bKeys[i]] || {}
    if ((av.width ?? null) !== (bv.width ?? null)) return false
    if (normalizeStyleStr(av.containerStyle) !== normalizeStyleStr(bv.containerStyle)) return false
    if (normalizeStyleStr(av.wrapperStyle) !== normalizeStyleStr(bv.wrapperStyle)) return false
  }
  return true
}

function normalizeLinkUrl(input = '') {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(raw)) return raw
  return `https://${raw}`
}

function truncateSingleLine(text = '', max = 60) {
  const oneLine = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) || ''
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}

function isEditableImageWrapperElement(el) {
  if (!(el instanceof HTMLElement)) return false
  if (el.tagName !== 'DIV') return false
  const container = el.firstElementChild
  if (!(container instanceof HTMLElement) || container.tagName !== 'DIV') return false
  const img = container.firstElementChild
  return img instanceof HTMLImageElement
}

function normalizeHexColor(raw, fallback = '#111827') {
  const value = String(raw || '').trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value.slice(1).split('').map(ch => `${ch}${ch}`).join('')}`
  }
  const rgbMatch = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (rgbMatch) {
    const r = Math.max(0, Math.min(255, Number(rgbMatch[1] || 0)))
    const g = Math.max(0, Math.min(255, Number(rgbMatch[2] || 0)))
    const b = Math.max(0, Math.min(255, Number(rgbMatch[3] || 0)))
    return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`
  }
  return fallback
}

function normalizeHexForColorInput(raw = '#000000') {
  const hex = String(raw || '').trim()
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    return `#${hex.slice(1).split('').map(ch => `${ch}${ch}`).join('')}`
  }
  return '#000000'
}

function findHexTokenAt(text = '', cursorIndex = 0) {
  const src = String(text || '')
  const idx = Number.isFinite(cursorIndex) ? cursorIndex : 0
  const re = /#[0-9a-fA-F]{3,8}\b/g
  let m
  while ((m = re.exec(src)) !== null) {
    const start = m.index
    const end = start + m[0].length
    if (idx >= start && idx <= end) return { start, end, value: m[0] }
  }
  return null
}

function getEditorDocSignature(editor) {
  if (!editor) return ''
  try {
    return JSON.stringify(editor.getJSON())
  } catch (_) {
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
  } catch (_) {
    return null
  }
}

export default function MDPageViewer({ post, channelId, onClose }) {
  const { updatePost, deletePost, addComment, deleteComment, posts } = useChat()
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
  const [deleting, setDeleting] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const showSaveDialogRef = useRef(false)
  const imageInputRef = useRef(null)
  const printContentRef = useRef(null)
  const printJobIdRef = useRef(0)
  const imageMetaRef = useRef(imageMeta)
  const savedContentRef = useRef(savedContent)
  const savedImageMetaRef = useRef(savedImageMeta)
  const savedDocSignatureRef = useRef(null)
  const sourceBaselineRef = useRef('')
  const [isPrinting, setIsPrinting] = useState(false)
  const [showComments, setShowComments] = useState(false)
  const [commentPaneWidth, setCommentPaneWidth] = useState(420)
  const [isResizingCommentPane, setIsResizingCommentPane] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentFiles, setCommentFiles] = useState([])
  const [commentDragOver, setCommentDragOver] = useState(false)
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [pendingDeleteCommentId, setPendingDeleteCommentId] = useState(null)
  const [previewConfig, setPreviewConfig] = useState(DEFAULT_PREVIEW_CONFIG)
  const splitAreaRef = useRef(null)
  const resizeStartRef = useRef({ x: 0, width: 420 })
  const commentFileInputRef = useRef(null)
  const sourceColorInputRef = useRef(null)
  const sourceColorRangeRef = useRef(null)
  const modeRef = useRef(mode)
  const canEditRef = useRef(false)
  const hadCodeFenceRef = useRef(/```/.test(stripAllMdMeta(initialMdStored)))

  useEffect(() => { showSaveDialogRef.current = showSaveDialog }, [showSaveDialog])
  useEffect(() => { imageMetaRef.current = imageMeta }, [imageMeta])
  useEffect(() => { savedContentRef.current = savedContent }, [savedContent])
  useEffect(() => { savedImageMetaRef.current = savedImageMeta }, [savedImageMeta])
  useEffect(() => { modeRef.current = mode }, [mode])

  const canEdit = String(post.author?.id ?? '') === String(currentUser?.id ?? '')
  useEffect(() => { canEditRef.current = canEdit }, [canEdit])
  const freshPost = posts[channelId]?.find((p) => p.id === post.id) || post
  const comments = Array.isArray(freshPost.comments) ? freshPost.comments : []

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

  useEffect(() => {
    if (!showComments) return undefined

    const onMouseMove = (e) => {
      if (!isResizingCommentPane) return
      const area = splitAreaRef.current
      if (!(area instanceof HTMLElement)) return

      const bounds = area.getBoundingClientRect()
      const delta = e.clientX - resizeStartRef.current.x
      const desired = resizeStartRef.current.width - delta
      const minComment = 280
      const minEditor = 360
      const maxComment = Math.max(minComment, bounds.width - minEditor - 8)
      const nextWidth = Math.max(minComment, Math.min(maxComment, desired))
      setCommentPaneWidth(nextWidth)
    }

    const onMouseUp = () => {
      if (!isResizingCommentPane) return
      setIsResizingCommentPane(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [showComments, isResizingCommentPane])

  useEffect(() => () => {
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  function handleCommentSplitterMouseDown(e) {
    if (!showComments) return
    e.preventDefault()
    resizeStartRef.current = { x: e.clientX, width: commentPaneWidth }
    setIsResizingCommentPane(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  function dataTransferHasFiles(dataTransfer) {
    if (!dataTransfer) return false
    if (dataTransfer.files && dataTransfer.files.length > 0) return true
    return Array.from(dataTransfer.types || []).includes('Files')
  }

  function addCommentFiles(newFilesLike) {
    const incoming = Array.from(newFilesLike || [])
    if (incoming.length === 0) return
    const nextCount = commentFiles.length + incoming.length
    if (nextCount > 10) {
      alert('첨부파일은 최대 10개까지 추가할 수 있습니다.')
      return
    }

    const limitMB = Number(maxAttachmentFileSize ?? 100)
    const limitBytes = limitMB * 1024 * 1024
    for (const f of incoming) {
      if ((f.size || 0) > limitBytes) {
        alert(`파일 용량은 ${limitMB}MB 이하만 업로드할 수 있습니다.`)
        return
      }
    }

    const mapped = incoming.map((f) => ({
      id: `md-comment-file-${Date.now()}-${Math.random()}`,
      name: f.name,
      size: f.size,
      type: f.type,
      file: f,
    }))
    setCommentFiles((prev) => [...prev, ...mapped])
  }

  function removeCommentFile(id) {
    setCommentFiles((prev) => prev.filter((f) => f.id !== id))
  }

  function handleCommentInputDrop(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    setCommentDragOver(false)
    if (e.dataTransfer?.files?.length) {
      addCommentFiles(e.dataTransfer.files)
    }
  }

  function handleCommentInputDragOver(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setCommentDragOver(true)
  }

  function handleCommentInputDragLeave(e) {
    if (!dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    setCommentDragOver(false)
  }

  async function handleCommentSubmit(e) {
    e.preventDefault()
    if (commentSubmitting) return
    const text = String(commentText || '').trim()
    if (!text && commentFiles.length === 0) return
    if (!currentUser) return

    setCommentSubmitting(true)
    try {
      const attachmentIds = []
      for (const fileObj of commentFiles) {
        const prep = await apiFetch('/files/get-upload-url', {
          method: 'POST',
          body: JSON.stringify({
            filename: fileObj.name,
            contentType: fileObj.type || 'application/octet-stream',
            channelId,
          }),
        })
        const uploadResp = await fetch(prep.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': fileObj.type || 'application/octet-stream' },
          body: fileObj.file,
        })
        if (!uploadResp.ok) {
          throw new Error(`파일 업로드 실패 (${uploadResp.status})`)
        }
        attachmentIds.push(prep.file_uuid)
      }

      await addComment(
        channelId,
        post.id,
        text,
        currentUser,
        attachmentIds,
        Math.min(Number(currentUser?.security_level ?? 0), 1),
      )
      setCommentText('')
      setCommentFiles([])
    } catch (err) {
      console.error('MD 댓글 등록 실패:', err)
      alert(`댓글 등록에 실패했습니다: ${err.message || err}`)
    } finally {
      setCommentSubmitting(false)
      setCommentDragOver(false)
    }
  }

  async function handleDeleteComment() {
    const targetId = pendingDeleteCommentId
    if (!targetId) return
    try {
      await deleteComment(channelId, post.id, targetId)
      setPendingDeleteCommentId(null)
    } catch (err) {
      console.error('MD 댓글 삭제 실패:', err)
      alert(`댓글 삭제에 실패했습니다: ${err.message || err}`)
    }
  }

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
          const nextChecked = !Boolean(node.attrs?.checked)
          const tr = view.state.tr.setNodeMarkup(taskItemPos, undefined, {
            ...node.attrs,
            checked: nextChecked,
          })
          view.dispatch(tr)
          return true
        }

        const anchor = target.closest('a[href]')
        if (!(anchor instanceof HTMLAnchorElement)) return false
        const href = String(anchor.getAttribute('href') || '').trim()
        if (!href) return false

        event.preventDefault()
        event.stopPropagation()

        const normalized = normalizeLinkUrl(href)
        window.open(normalized, '_blank', 'noopener,noreferrer')
        return true
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
              // eslint-disable-next-line no-await-in-loop
              await uploadAndInsertImage(file, insertPos)
            } else {
              // eslint-disable-next-line no-await-in-loop
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
    if (!editor) return
    // 최초 진입 시 문서 시그니처를 baseline으로 저장
    if (!savedDocSignatureRef.current) {
      savedDocSignatureRef.current = getEditorDocSignature(editor)
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

  const handleSave = useCallback(async () => {
      const md = stripAuthTokenFromMarkdown(getCurrentMarkdown())
      const withImageMeta = attachImageMeta(md, normalizeImageMetaKeys(imageMeta))
      const mdWithMeta = mode === 'preview' && editor
        ? attachDocMeta(withImageMeta, editor.getJSON())
        : stripDocMeta(withImageMeta)
    setSaving(true)
    try {
      await updatePost(channelId, post.id, { content: `${MD_PAGE_MARKER}\n${mdWithMeta}` })
      setSavedContent(md)
      setSavedImageMeta(normalizeImageMetaKeys(imageMeta))
      if (mode === 'preview' && editor) {
        savedDocSignatureRef.current = getEditorDocSignature(editor)
      } else {
        // source 모드 저장 후에는 preview 전환 시점에 baseline을 재확정한다.
        savedDocSignatureRef.current = null
      }
      setIsChanged(false)
    } catch (e) {
      console.error('MD 페이지 저장 실패:', e)
    } finally {
      setSaving(false)
    }
  }, [channelId, editor, getCurrentMarkdown, imageMeta, mode, post.id, updatePost])

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
  const logPrint = useCallback((phase, payload = {}) => {
    const jobId = printJobIdRef.current
    console.info(`[MDPrint][job:${jobId || '-'}] ${phase}`, payload)
  }, [])

  const handlePrintClick = useCallback(async () => {
    printJobIdRef.current = Date.now()
    logPrint('click.printButton')
    const target = printContentRef.current
    if (!target) {
      logPrint('pdf.failed.noContentRef')
      return
    }
    const printWindow = window.open('', '_blank')
    if (printWindow) {
      try {
        printWindow.document.write('<!doctype html><html><head><title>PDF Print</title></head><body style="margin:0;background:#111;color:#fff;font:14px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">PDF 생성 중...</body></html>')
        printWindow.document.close()
      } catch {
        // noop
      }
    } else {
      logPrint('pdf.print.popupBlocked')
    }
    try {
      setIsPrinting(true)
      logPrint('pdf.capture.start', {
        title: pageTitle || t.mdPage.title || 'EasyPage',
        scrollWidth: target.scrollWidth,
        scrollHeight: target.scrollHeight,
      })

      const original = {
        overflow: target.style.overflow,
        maxHeight: target.style.maxHeight,
        height: target.style.height,
      }
      let canvas = null
      try {
        target.style.overflow = 'visible'
        target.style.maxHeight = 'none'
        target.style.height = 'auto'

        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

        canvas = await html2canvas(target, {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          backgroundColor: '#ffffff',
          windowWidth: Math.max(target.scrollWidth, target.clientWidth),
          windowHeight: Math.max(target.scrollHeight, target.clientHeight),
          logging: false,
        })
      } finally {
        target.style.overflow = original.overflow
        target.style.maxHeight = original.maxHeight
        target.style.height = original.height
      }
      if (!canvas) throw new Error('PDF 캡처 캔버스가 생성되지 않았습니다.')

      logPrint('pdf.capture.done', { canvasWidth: canvas.width, canvasHeight: canvas.height })

      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 10
      const printableWidth = pageWidth - (margin * 2)
      const printableHeight = pageHeight - (margin * 2)
      const imageData = canvas.toDataURL('image/png')
      const imageHeight = (canvas.height * printableWidth) / canvas.width

      let renderedHeight = imageHeight
      let yOffset = margin
      pdf.addImage(imageData, 'PNG', margin, yOffset, printableWidth, imageHeight, undefined, 'FAST')
      renderedHeight -= printableHeight

      while (renderedHeight > 0) {
        pdf.addPage()
        yOffset = margin - (imageHeight - renderedHeight)
        pdf.addImage(imageData, 'PNG', margin, yOffset, printableWidth, imageHeight, undefined, 'FAST')
        renderedHeight -= printableHeight
      }

      const safeTitle = (pageTitle || t.mdPage.title || 'EasyPage').replace(/[\\/:*?"<>|]+/g, '_')
      const fileName = `${safeTitle}.pdf`
      const blob = pdf.output('blob')
      const blobUrl = URL.createObjectURL(blob)
      logPrint('pdf.blob.ready', { fileName, blobBytes: blob.size })

      if (printWindow) {
        const escapedUrl = blobUrl.replace(/"/g, '&quot;')
        printWindow.document.open()
        printWindow.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safeTitle}</title>
    <style>
      html, body { margin: 0; height: 100%; background: #111; }
      iframe { border: 0; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <iframe id="pdf-frame" src="${escapedUrl}"></iframe>
    <script>
      (function () {
        const frame = document.getElementById('pdf-frame');
        const trigger = function () {
          try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
          } catch (e) {
            window.print();
          }
        };
        frame.addEventListener('load', function () {
          setTimeout(trigger, 250);
        });
      })();
    </script>
  </body>
</html>`)
        printWindow.document.close()
        logPrint('pdf.print.window.opened', { fileName })
      } else {
        logPrint('pdf.save.fallback.start', { fileName })
        pdf.save(fileName)
        logPrint('pdf.save.fallback.done', { fileName })
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
    } catch (error) {
      console.error(`[MDPrint][job:${printJobIdRef.current || '-'}] pdf.failed`, error)
      alert('PDF 생성 중 오류가 발생했습니다.')
      if (printWindow && !printWindow.closed) {
        try { printWindow.close() } catch { /* noop */ }
      }
    } finally {
      setIsPrinting(false)
    }
  }, [logPrint, pageTitle, t.mdPage.title])

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
      // eslint-disable-next-line no-await-in-loop
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
        // eslint-disable-next-line no-await-in-loop
        await uploadAndInsertImage(file, insertPos)
      } else {
        // eslint-disable-next-line no-await-in-loop
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
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="9" y="9" width="10" height="10" rx="2" />
            <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
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
            <div className="max-w-4xl mx-auto px-8 py-8 relative">
              {canEdit && (
                <LinkBubbleMenu editor={editor} />
              )}
              {canEdit && (
                <TableBubbleMenu editor={editor} />
              )}
              <EditorContent editor={editor} className="tiptap-editor" />
              {canEdit && (
                <InternalLinkAutocomplete editor={editor} />
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
                          <div className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
                                ul: ({ children }) => <ul className="list-disc pl-9 my-1.5 space-y-1">{children}</ul>,
                                ol: ({ children, ...props }) => <ol {...props} className="list-decimal pl-5 my-1.5 space-y-1">{children}</ol>,
                              }}
                            >
                              {String(comment?.content || '')}
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
                  className={`w-full min-h-[72px] max-h-36 resize-y rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 ${commentDragOver ? 'border-indigo-400 bg-indigo-50' : 'border-gray-300 bg-white'}`}
                  disabled={commentSubmitting}
                />
                {commentFiles.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
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

function MDCommentAttachmentPreview({ attachment, resolveUrl, previewConfig }) {
  const name = String(attachment?.name || attachment?.id || '첨부파일')
  const type = String(attachment?.type || '').toLowerCase()
  const mainUrl = resolveUrl?.(attachment?.url) || attachment?.url || ''
  const thumbUrl = resolveUrl?.(attachment?.thumbnail_url) || attachment?.thumbnail_url || ''
  const isImage = type.startsWith('image/')
  const hasImagePreview = isImage || Boolean(thumbUrl)
  const previewSrc = isImage ? mainUrl : thumbUrl
  const dims = getCommentAttachmentPreviewSize({ name, type }, previewConfig)
  const previewWidth = Math.max(80, Math.round((Number(dims.width) || 480) / 2))
  const previewHeight = Math.max(60, Math.round((Number(dims.height) || 270) / 2))

  return (
    <a
      href={mainUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="rounded-xl border border-blue-200 bg-white overflow-hidden hover:border-indigo-300 transition-colors"
      title={name}
      style={{ width: `${previewWidth}px` }}
    >
      {hasImagePreview ? (
        <img
          src={previewSrc}
          alt={name}
          className="w-full object-cover bg-gray-100"
          style={{ height: `${previewHeight}px` }}
          loading="lazy"
        />
      ) : (
        <div className="w-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs" style={{ height: `${previewHeight}px` }}>
          Preview 없음
        </div>
      )}
      <div className="px-2.5 py-2 text-xs text-indigo-600 underline truncate">{name}</div>
    </a>
  )
}

function getCommentAttachmentPreviewSize(file, cfg) {
  const safe = cfg || DEFAULT_PREVIEW_CONFIG
  const name = String(file?.name || '').toLowerCase()
  const type = String(file?.type || '').toLowerCase()
  const isHtmlLike = /\.(html?|php|asp|aspx|jsp|cfm)($|\?)/i.test(name)

  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) {
    return safe.imagePreview || DEFAULT_PREVIEW_CONFIG.imagePreview
  }
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
    return safe.pdfPreview || DEFAULT_PREVIEW_CONFIG.pdfPreview
  }
  if (/\.pptx$/i.test(name)) return safe.pptxPreview || safe.pptPreview || DEFAULT_PREVIEW_CONFIG.pptxPreview
  if (/\.ppt$/i.test(name) || type.includes('presentation')) return safe.pptPreview || DEFAULT_PREVIEW_CONFIG.pptPreview
  if (/\.xlsx?$/i.test(name) || type.includes('excel') || type.includes('spreadsheet')) return safe.excelPreview || DEFAULT_PREVIEW_CONFIG.excelPreview
  if (/\.docx?$/i.test(name) || type.includes('word')) return safe.wordPreview || DEFAULT_PREVIEW_CONFIG.wordPreview
  if (isHtmlLike || type === 'text/html') return safe.htmlPreview || DEFAULT_PREVIEW_CONFIG.htmlPreview
  if (type.startsWith('video/')) return safe.moviePreview || DEFAULT_PREVIEW_CONFIG.moviePreview
  if (type.startsWith('text/') || /\.txt$/i.test(name)) return safe.txtPreview || DEFAULT_PREVIEW_CONFIG.txtPreview
  return safe.pdfPreview || DEFAULT_PREVIEW_CONFIG.pdfPreview
}

/* ─────────────────────────────────────────
   TipTap 툴바 컴포넌트
───────────────────────────────────────── */
function TipTapToolbar({ editor, t, onInsertImage, onInsertToc, isUploadingImage = false }) {
  if (!editor) return null
  const mdT = t?.mdPage || {}

  const btn = (active, onClick, label, title) => (
    <button
      key={label}
      onMouseDown={e => { e.preventDefault(); onClick() }}
      title={title}
      className={`px-2 py-1 rounded text-sm transition-colors ${
        active
          ? 'bg-indigo-100 text-indigo-700 font-semibold'
          : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
      }`}
    >
      {label}
    </button>
  )

  const sep = (key) => <div key={key} className="w-px h-5 bg-gray-200 mx-0.5" />

  return (
    <div className="flex items-center gap-0.5 px-4 py-1.5 border-b border-gray-100 bg-gray-50 flex-wrap flex-shrink-0">
      {btn(editor.isActive('bold'),      () => editor.chain().focus().toggleBold().run(),      'B',  mdT.toolbarBold || 'Bold (Ctrl+B)')}
      {btn(editor.isActive('italic'),    () => editor.chain().focus().toggleItalic().run(),    'I',  mdT.toolbarItalic || 'Italic (Ctrl+I)')}
      {btn(editor.isActive('strike'),    () => editor.chain().focus().toggleStrike().run(),    'S̶',  mdT.toolbarStrike || 'Strikethrough')}
      {btn(editor.isActive('code'),      () => editor.chain().focus().toggleCode().run(),      '<>',  mdT.toolbarInlineCode || 'Inline code')}
      {sep('s1')}
      {btn(editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), 'H1', mdT.toolbarHeading1 || 'Heading 1')}
      {btn(editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'H2', mdT.toolbarHeading2 || 'Heading 2')}
      {btn(editor.isActive('heading', { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), 'H3', mdT.toolbarHeading3 || 'Heading 3')}
      {sep('s2')}
      {btn(editor.isActive('bulletList'),  () => editor.chain().focus().toggleBulletList().run(),  mdT.toolbarBulletList || '• List',  mdT.toolbarBulletListTitle || 'Bulleted list')}
      {btn(editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), mdT.toolbarOrderedList || '1. List', mdT.toolbarOrderedListTitle || 'Numbered list')}
      {sep('s3')}
      {btn(false, onInsertToc, mdT.toolbarInsertToc || 'Insert TOC', mdT.toolbarInsertTocTitle || 'Insert table of contents')}
      {btn(editor.isActive('blockquote'),  () => editor.chain().focus().toggleBlockquote().run(),   mdT.toolbarQuote || '" Quote',   mdT.toolbarQuoteTitle || 'Quote')}
      {btn(editor.isActive('codeBlock'),   () => editor.chain().focus().toggleCodeBlock().run(),    mdT.toolbarCodeBlock || 'Code block', mdT.toolbarCodeBlockTitle || 'Code block')}
      {btn(editor.isActive('table'), () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), mdT.toolbarInsertTable || 'Insert table', mdT.toolbarInsertTableTitle || 'Insert 3x3 table')}
      <TextColorControl editor={editor} t={t} />
      {btn(false, () => editor.chain().focus().setHorizontalRule().run(), '──', mdT.toolbarHorizontalRule || 'Horizontal rule')}
      {btn(false, onInsertImage, isUploadingImage ? (mdT.toolbarUploading || 'Uploading...') : '🖼', mdT.toolbarInsertImageTitle || 'Upload and insert image')}
      {sep('s4')}
      {btn(false, () => editor.chain().focus().undo().run(), '↩', mdT.toolbarUndo || 'Undo (Ctrl+Z)')}
      {btn(false, () => editor.chain().focus().redo().run(), '↪', mdT.toolbarRedo || 'Redo (Ctrl+Y)')}
    </div>
  )
}

function TextColorControl({ editor, t }) {
  const wrapperRef = useRef(null)
  const mdT = t?.mdPage || {}
  const [open, setOpen] = useState(false)
  const [currentColor, setCurrentColor] = useState('#111827')
  const [inputColor, setInputColor] = useState('#111827')

  useEffect(() => {
    if (!editor) return undefined
    const syncColor = () => {
      const colorAttr = editor.getAttributes('textStyle')?.color
      const normalized = normalizeHexColor(colorAttr, '#111827')
      setCurrentColor(normalized)
      setInputColor(normalized)
    }
    syncColor()
    editor.on('selectionUpdate', syncColor)
    editor.on('transaction', syncColor)
    return () => {
      editor.off('selectionUpdate', syncColor)
      editor.off('transaction', syncColor)
    }
  }, [editor])

  useEffect(() => {
    if (!open) return undefined
    const handleOutside = (e) => {
      if (!wrapperRef.current?.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [open])

  const applyColor = (hex) => {
    const normalized = normalizeHexColor(hex, currentColor)
    setCurrentColor(normalized)
    setInputColor(normalized)
    editor.chain().focus().setColor(normalized).run()
  }

  return (
    <div ref={wrapperRef} className="relative flex items-center gap-1">
      <button
        onMouseDown={(e) => {
          e.preventDefault()
          setOpen(prev => !prev)
        }}
        title={mdT.toolbarTextColor || 'Text color'}
        className="px-2 py-1 rounded text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-800"
      >
        A
        <span className="inline-block align-middle ml-1 w-3 h-3 rounded-sm border border-gray-300" style={{ backgroundColor: currentColor }} />
      </button>

      <button
        onMouseDown={(e) => {
          e.preventDefault()
          editor.chain().focus().unsetColor().run()
        }}
        title={mdT.toolbarClearColor || 'Clear color'}
        className="px-2 py-1 rounded text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-800"
      >
        {mdT.toolbarClearColorLabel || 'Clear color'}
      </button>

      {open && (
        <div
          className="absolute top-9 left-0 z-30 rounded-xl border border-gray-200 bg-white shadow-lg p-3 w-56"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <HexColorPicker color={currentColor} onChange={applyColor} />
          <div className="mt-2 flex items-center gap-2">
            <input
              value={inputColor}
              onChange={(e) => setInputColor(e.target.value)}
              className="h-8 w-full rounded-md border border-gray-300 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="#111827"
            />
            <button
              onMouseDown={(e) => {
                e.preventDefault()
                applyColor(inputColor)
              }}
              className="h-8 px-2 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-500"
            >
              적용
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function LinkBubbleMenu({ editor }) {
  const [isEditing, setIsEditing] = useState(false)
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!editor) return undefined
    const closeOnEmptySelection = () => {
      if (editor.state.selection.empty) {
        setIsEditing(false)
      }
    }
    editor.on('selectionUpdate', closeOnEmptySelection)
    return () => {
      editor.off('selectionUpdate', closeOnEmptySelection)
    }
  }, [editor])

  if (!editor) return null

  const openEdit = () => {
    const currentHref = String(editor.getAttributes('link')?.href || '')
    setUrl(currentHref)
    setIsEditing(true)
  }

  const applyLink = () => {
    const normalized = normalizeLinkUrl(url)
    if (!normalized) return
    editor.chain().focus().extendMarkRange('link').setLink({ href: normalized }).run()
    setIsEditing(false)
  }

  const unsetLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    setIsEditing(false)
  }

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: ed, from, to }) => ed.isEditable && from !== to}
      tippyOptions={{ duration: 120, placement: 'top', maxWidth: 360 }}
      className="rounded-lg border border-gray-200 bg-white shadow-md px-2 py-1 flex items-center gap-1"
    >
      {isEditing ? (
        <div className="flex items-center gap-1">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyLink()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setIsEditing(false)
              }
            }}
            placeholder="https://example.com"
            className="h-8 w-56 px-2 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            onMouseDown={(e) => { e.preventDefault(); applyLink() }}
            className="h-8 px-2 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-500"
          >
            적용
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); setIsEditing(false) }}
            className="h-8 px-2 rounded-md text-xs text-gray-600 hover:bg-gray-100"
          >
            취소
          </button>
        </div>
      ) : (
        <>
          <button
            onMouseDown={(e) => { e.preventDefault(); openEdit() }}
            className="h-8 px-2 rounded-md text-xs text-gray-700 hover:bg-gray-100"
          >
            {editor.isActive('link') ? '링크 수정' : '링크 추가'}
          </button>
          {editor.isActive('link') && (
            <button
              onMouseDown={(e) => { e.preventDefault(); unsetLink() }}
              className="h-8 px-2 rounded-md text-xs text-red-600 hover:bg-red-50"
            >
              링크 해제
            </button>
          )}
        </>
      )}
    </BubbleMenu>
  )
}

function TableBubbleMenu({ editor }) {
  const [menuState, setMenuState] = useState({ open: false, x: 0, y: 0 })
  const menuRef = useRef(null)
  const isTableSelection = () => (
    editor?.isActive('table')
    || editor?.isActive('tableCell')
    || editor?.isActive('tableHeader')
    || editor?.isActive('tableRow')
  )

  useEffect(() => {
    if (!editor) return undefined

    const dom = editor.view?.dom
    if (!dom) return undefined

    const handleDoubleClick = (event) => {
      const rawTarget = event.target
      const target = rawTarget instanceof Element ? rawTarget : rawTarget?.parentElement
      if (!(target instanceof Element)) return

      const inTableDom = Boolean(target.closest('table, td, th'))
      if (!inTableDom) return

      const x = Number(event.clientX || 0)
      const y = Number(event.clientY || 0)

      // 더블클릭 직후 selection 갱신 타이밍을 한 틱 기다려 표 컨텍스트를 확인
      requestAnimationFrame(() => {
        if (isTableSelection()) {
          setMenuState({ open: true, x, y })
        }
      })
    }

    const handlePointerDown = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : []
      if (menuRef.current && path.includes(menuRef.current)) return
      const target = event.target
      if (menuRef.current && target instanceof Node && menuRef.current.contains(target)) return
      // 표 안/밖 어디를 클릭하든 메뉴를 닫는다.
      setMenuState((prev) => ({ ...prev, open: false }))
    }

    const handleSelectionUpdate = () => {
      if (!isTableSelection()) {
        setMenuState((prev) => ({ ...prev, open: false }))
      }
    }

    dom.addEventListener('dblclick', handleDoubleClick)
    document.addEventListener('pointerdown', handlePointerDown)
    editor.on('selectionUpdate', handleSelectionUpdate)

    return () => {
      dom.removeEventListener('dblclick', handleDoubleClick)
      document.removeEventListener('pointerdown', handlePointerDown)
      editor.off('selectionUpdate', handleSelectionUpdate)
    }
  }, [editor])

  if (!editor) return null

  if (!menuState.open) return null

  const MENU_WIDTH = 520
  const MARGIN = 12
  const left = Math.max(MARGIN, Math.min(menuState.x, window.innerWidth - MENU_WIDTH - MARGIN))
  const top = Math.max(MARGIN, Math.min(menuState.y + 12, window.innerHeight - 180))

  return (
    <div
      ref={menuRef}
      className="table-toolbar"
      style={{
        position: 'fixed',
        left: `${left}px`,
        top: `${top}px`,
        zIndex: 2000,
      }}
    >
      <div className="table-toolbar-row">
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addColumnBefore().run() }}>
          왼쪽 열 추가
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addColumnAfter().run() }}>
          오른쪽 열 추가
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addRowBefore().run() }}>
          위 행 추가
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addRowAfter().run() }}>
          아래 행 추가
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().mergeCells().run() }}>
          셀 병합
        </button>
      </div>
      <div className="table-toolbar-row">
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().splitCell().run() }}>
          셀 분할
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteColumn().run() }}>
          열 삭제
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteRow().run() }}>
          행 삭제
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeaderRow().run() }}>
          헤더 토글
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteTable().run() }}>
          표 삭제
        </button>
      </div>
    </div>
  )
}

function InternalLinkAutocomplete({ editor }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [replaceRange, setReplaceRange] = useState(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!editor) return undefined

    const updateTrigger = () => {
      const { state } = editor
      const { selection } = state
      if (!selection.empty) {
        setOpen(false)
        setItems([])
        return
      }

      const { $from } = selection
      if (!$from.parent.isTextblock) {
        setOpen(false)
        setItems([])
        return
      }

      const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0')
      const matched = textBefore.match(/\[\[([^\[\]]*)$/)
      if (!matched) {
        setOpen(false)
        setItems([])
        return
      }

      const typedQuery = String(matched[1] || '')
      const from = $from.start() + (matched.index ?? 0)
      const to = $from.pos

      setQuery(typedQuery)
      setReplaceRange({ from, to })
      setOpen(true)
    }

    editor.on('update', updateTrigger)
    editor.on('selectionUpdate', updateTrigger)
    updateTrigger()

    return () => {
      editor.off('update', updateTrigger)
      editor.off('selectionUpdate', updateTrigger)
    }
  }, [editor])

  useEffect(() => {
    if (!open) return undefined
    const q = query.trim()
    if (!q) {
      setItems([])
      setActiveIndex(0)
      return undefined
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const results = await apiFetch(`/posts/search?q=${encodeURIComponent(q)}`)
        if (cancelled) return

        const dedup = new Map()
        for (const row of Array.isArray(results) ? results : []) {
          const postId = row.type === 'comment' ? row.postId : row.id
          if (!postId || !row.channelId) continue
          if (!dedup.has(postId)) {
            const labelSource = row.type === 'comment' ? (row.postContent || row.content) : row.content
            dedup.set(postId, {
              postId,
              channelId: row.channelId,
              label: truncateSingleLine(labelSource || '문서', 64),
              subtitle: `${row.teamName || '-'} › ${row.channelName || '-'}`,
            })
          }
        }
        setItems(Array.from(dedup.values()).slice(0, 8))
        setActiveIndex(0)
      } catch (e) {
        if (!cancelled) {
          setItems([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }, 180)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  const selectItem = useCallback((item) => {
    if (!editor || !replaceRange || !item) return
    const href = `/?channelId=${encodeURIComponent(item.channelId)}&postId=${encodeURIComponent(item.postId)}`
    editor
      .chain()
      .focus()
      .deleteRange(replaceRange)
      .insertContent({
        type: 'text',
        text: item.label || '문서 링크',
        marks: [{ type: 'link', attrs: { href } }],
      })
      .insertContent(' ')
      .run()
    setOpen(false)
    setItems([])
  }, [editor, replaceRange])

  useEffect(() => {
    if (!open || !editor) return undefined

    const onKeyDown = (e) => {
      if (!open) return
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex(prev => (items.length ? (prev + 1) % items.length : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex(prev => (items.length ? (prev - 1 + items.length) % items.length : 0))
        return
      }
      if (e.key === 'Enter') {
        if (!items.length) return
        e.preventDefault()
        selectItem(items[activeIndex] || items[0])
      }
    }

    const dom = editor.view?.dom
    dom?.addEventListener('keydown', onKeyDown)
    return () => dom?.removeEventListener('keydown', onKeyDown)
  }, [open, editor, items, activeIndex, selectItem])

  if (!open) return null

  return (
    <div className="absolute left-8 top-10 z-20 w-96 rounded-lg border border-gray-200 bg-white shadow-lg">
      <div className="px-3 py-2 border-b border-gray-100 text-xs text-gray-500">
        내부 문서 링크: <span className="font-semibold text-gray-700">[[{query}</span>
      </div>
      <div className="max-h-64 overflow-auto">
        {loading ? (
          <div className="px-3 py-3 text-xs text-gray-500">검색 중...</div>
        ) : items.length === 0 ? (
          <div className="px-3 py-3 text-xs text-gray-500">검색 결과가 없습니다.</div>
        ) : (
          items.map((item, index) => (
            <button
              key={`${item.channelId}-${item.postId}`}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                selectItem(item)
              }}
              className={`w-full text-left px-3 py-2 border-b border-gray-50 last:border-b-0 ${
                index === activeIndex ? 'bg-indigo-50' : 'hover:bg-gray-50'
              }`}
            >
              <p className="text-sm text-gray-800 font-medium truncate">{item.label}</p>
              <p className="text-[11px] text-gray-500 truncate">{item.subtitle}</p>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
