import { useEffect, useRef, useState } from 'react'
import { HexColorPicker } from 'react-colorful'
import { normalizeHexColor } from '../utils/color'

export default function TextColorControl({ editor, t }) {
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
