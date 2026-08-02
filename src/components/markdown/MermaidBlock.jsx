import { useEffect, useId, useRef, useState } from 'react'
import { normalizeMarkdownCodeSource } from './markdownCode'
import { normalizeMermaidSource } from '../../lib/mermaidSafety'

const MAX_MERMAID_SOURCE_LENGTH = 20 * 1024
const renderCache = new Map()
let mermaidModulePromise = null
let mermaidInitialized = false

function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((module) => module.default || module)
  }
  return mermaidModulePromise
}

async function getMermaid() {
  const mermaid = await loadMermaid()
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      flowchart: { htmlLabels: false },
    })
    mermaidInitialized = true
  }
  return mermaid
}

export default function MermaidBlock({ source = '' }) {
  const normalizedSource = normalizeMarkdownCodeSource(source)
  const renderSource = normalizeMermaidSource(normalizedSource)
  const validationError = !normalizedSource.trim()
    ? 'Mermaid 코드가 비어 있습니다.'
    : normalizedSource.length > MAX_MERMAID_SOURCE_LENGTH
      ? '다이어그램 코드가 너무 큽니다. 20KB 이하로 줄여주세요.'
      : ''
  const reactId = useId()
  const visibilityTargetRef = useRef(null)
  const renderTargetRef = useRef(null)
  const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const [status, setStatus] = useState('waiting')
  const [error, setError] = useState('')
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const target = visibilityTargetRef.current
    if (!target) return undefined
    if (typeof IntersectionObserver === 'undefined') return undefined

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '240px 0px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const target = renderTargetRef.current
    if (!target || !isVisible) return undefined

    let cancelled = false
    target.replaceChildren()
    if (validationError) return undefined
    const safeReactId = reactId.replace(/[^a-zA-Z0-9_-]/g, '')
    const renderId = `eds-mermaid-${safeReactId}-${Date.now()}`

    ;(async () => {
      try {
        setStatus('rendering')
        setError('')
        let rendered = renderCache.get(renderSource)
        if (!rendered) {
          const mermaid = await getMermaid()
          rendered = await mermaid.render(renderId, renderSource)
          if (renderCache.size >= 100) {
            const oldestKey = renderCache.keys().next().value
            renderCache.delete(oldestKey)
          }
          renderCache.set(renderSource, { svg: rendered.svg })
        }
        if (cancelled || !renderTargetRef.current) return

        renderTargetRef.current.innerHTML = rendered.svg
        rendered.bindFunctions?.(renderTargetRef.current)
        setStatus('ready')
      } catch (renderError) {
        document.getElementById(`d${renderId}`)?.remove()
        if (cancelled) return
        target.replaceChildren()
        setStatus('error')
        setError('Mermaid 다이어그램을 생성할 수 없습니다. 문법을 확인해주세요.')
        console.warn('[Mermaid] render failed:', renderError)
      }
    })()

    return () => {
      cancelled = true
      target.replaceChildren()
      document.getElementById(`d${renderId}`)?.remove()
    }
  }, [isVisible, normalizedSource, reactId, renderSource, validationError])

  const displayStatus = validationError ? 'error' : status
  const displayError = validationError || error

  async function copySource() {
    try {
      await navigator.clipboard.writeText(normalizedSource)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <figure ref={visibilityTargetRef} className="eds-mermaid my-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <figcaption className="flex items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2">
        <span className="text-xs font-semibold text-gray-600">Mermaid</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100"
            onClick={() => setShowSource((value) => !value)}
          >
            {showSource ? '원본 닫기' : '원본 보기'}
          </button>
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100"
            onClick={copySource}
          >
            {copied ? '복사됨' : '복사'}
          </button>
        </span>
      </figcaption>

      <div className="relative min-h-24 overflow-x-auto p-3">
        {(displayStatus === 'waiting' || displayStatus === 'rendering') && (
          <div role="status" className="flex min-h-20 items-center justify-center text-xs text-gray-500">
            Mermaid 다이어그램을 불러오는 중...
          </div>
        )}
        {displayStatus === 'error' && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {displayError}
          </div>
        )}
        <div
          ref={renderTargetRef}
          className={`eds-mermaid-svg min-w-fit ${displayStatus === 'ready' ? 'block' : 'hidden'}`}
          aria-label="Mermaid 다이어그램"
        />
      </div>

      {showSource && (
        <pre className="m-0 max-h-80 overflow-auto border-t border-gray-200 bg-gray-900 p-3 text-left text-xs leading-relaxed text-gray-100">
          <code>{normalizedSource}</code>
        </pre>
      )}
    </figure>
  )
}
