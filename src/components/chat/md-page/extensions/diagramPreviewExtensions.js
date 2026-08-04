import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import mermaid from 'mermaid'
import * as echarts from 'echarts'
import { isLikelyEchartsOption, parseEchartsOption } from '../../../../lib/echartsOption'

const MERMAID_RENDER_CLASS = 'md-mermaid-render'
const MERMAID_PLUGIN_KEY = new PluginKey('md-mermaid-preview')
const ECHARTS_RENDER_CLASS = 'md-echarts-render'
const ECHARTS_PLUGIN_KEY = new PluginKey('md-echarts-preview')

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

let mermaidInitialized = false

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
  // A percent-encoded data URL grows dramatically for large Mermaid diagrams and
  // some browsers reject it before image decoding. The SVG is already stripped of
  // foreignObject/external resources, so an object URL is both origin-clean and
  // suitable for large exports.
  const safeSvg = sanitizeSvgForCanvas(svgMarkup)
  const svgBlob = new Blob([safeSvg], { type: 'image/svg+xml;charset=utf-8' })
  const svgUrl = URL.createObjectURL(svgBlob)
  try {
    const img = new Image()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('PNG 변환용 SVG 이미지를 불러오지 못했습니다.'))
      img.src = svgUrl
    })

    const intrinsicWidth = Math.max(1, Math.ceil(img.naturalWidth || img.width || 1200))
    const intrinsicHeight = Math.max(1, Math.ceil(img.naturalHeight || img.height || 800))
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

    const pngBlob = await new Promise((resolve, reject) => {
      try {
        canvas.toBlob(resolve, 'image/png')
      } catch (error) {
        reject(error)
      }
    })
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
  // A document-level init directive can turn htmlLabels back on. Strip all init
  // directives for export and prepend the known canvas-safe configuration.
  const raw = String(source || '')
    .replace(/%%\{\s*(?:init|initialize)\s*:[\s\S]*?\}%%/gi, '')
    .trim()
  if (!raw) return initDirective
  return `${initDirective}\n${raw}`
}

function sanitizeSvgForCanvas(svgMarkup = '') {
  let svg = convertForeignObjectsToSvgText(String(svgMarkup || ''))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/@import\s+(?:url\()?[^;]+;?/gi, '')
    .replace(/url\(\s*['"]?(?:https?:)?\/\/[^)]*\)/gi, 'none')
    .replace(/\s(?:href|xlink:href)\s*=\s*(['"])(?:https?:)?\/\/.*?\1/gi, '')

  // Mermaid normally emits the namespace, but it is required when the markup is
  // loaded as a standalone image rather than inserted into the HTML document.
  if (!/\sxmlns=/.test(svg)) {
    svg = svg.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"')
  }
  return svg
}

function parseSvgLength(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value || ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function getForeignObjectLines(foreignObject) {
  const lineElements = foreignObject.querySelectorAll('p, li')
  const rawLines = lineElements.length > 0
    ? Array.from(lineElements, (element) => element.textContent || '')
    : String(foreignObject.textContent || '').split(/\r?\n/)
  const lines = rawLines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return lines.length > 0 ? lines : ['']
}

function convertForeignObjectsToSvgText(svgMarkup = '') {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    return String(svgMarkup || '')
      .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, '')
  }

  const parser = new DOMParser()
  let documentNode = parser.parseFromString(String(svgMarkup || ''), 'image/svg+xml')
  let svgRoot = documentNode.documentElement
  if (documentNode.querySelector('parsererror')) {
    // Mermaid HTML labels may contain HTML-style void tags such as <br>. They are
    // valid in the page DOM but invalid XML, so parse them as HTML first. The
    // XMLSerializer below then emits a well-formed standalone SVG.
    documentNode = parser.parseFromString(String(svgMarkup || ''), 'text/html')
    svgRoot = documentNode.querySelector('svg')
    if (!svgRoot) return String(svgMarkup || '')
  }

  const svgNamespace = 'http://www.w3.org/2000/svg'
  svgRoot.querySelectorAll('foreignObject').forEach((foreignObject) => {
    const width = parseSvgLength(foreignObject.getAttribute('width'))
    const height = parseSvgLength(foreignObject.getAttribute('height'))
    const x = parseSvgLength(foreignObject.getAttribute('x'))
    const y = parseSvgLength(foreignObject.getAttribute('y'))
    const lines = getForeignObjectLines(foreignObject)
    const lineHeight = 18
    const firstLineY = y + (height / 2) - ((lines.length - 1) * lineHeight / 2)

    const text = documentNode.createElementNS(svgNamespace, 'text')
    text.setAttribute('x', String(x + (width / 2)))
    text.setAttribute('y', String(firstLineY))
    text.setAttribute('text-anchor', 'middle')
    text.setAttribute('dominant-baseline', 'middle')
    text.setAttribute('fill', 'currentColor')
    text.setAttribute(
      'style',
      'font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",Arial,sans-serif;font-size:16px;',
    )

    lines.forEach((line, index) => {
      const tspan = documentNode.createElementNS(svgNamespace, 'tspan')
      tspan.setAttribute('x', String(x + (width / 2)))
      if (index > 0) tspan.setAttribute('dy', String(lineHeight))
      tspan.textContent = line
      text.appendChild(tspan)
    })
    foreignObject.replaceWith(text)
  })

  return new XMLSerializer().serializeToString(svgRoot)
}

async function renderMermaidSvgForExport(source = '') {
  ensureMermaidInitialized()
  const exportSource = buildExportSafeMermaidSource(source)
  const renderId = `md-mermaid-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { svg } = await mermaid.render(renderId, exportSource)
  return sanitizeSvgForCanvas(svg)
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

export const MermaidPreviewExtension = Extension.create({
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

export const EchartsPreviewExtension = Extension.create({
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
