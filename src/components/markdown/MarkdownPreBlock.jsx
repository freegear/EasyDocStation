import { Children, isValidElement } from 'react'
import MermaidBlock from './MermaidBlock'
import { getCodeElementSource, isMermaidCodeElement } from './markdownCode'

export default function MarkdownPreBlock({ children, className = '' }) {
  const childElements = Children.toArray(children)
  const child = childElements.length === 1 ? childElements[0] : null
  if (isValidElement(child) && isMermaidCodeElement(child)) {
    return <MermaidBlock source={getCodeElementSource(child)} />
  }

  return (
    <pre className={className || 'bg-gray-900 text-gray-100 rounded-xl p-3 my-2 overflow-x-auto border border-gray-700'}>
      {children}
    </pre>
  )
}
