import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'

function getLineRanges(textblock) {
  const delimiters = []

  textblock.forEach((child, offset) => {
    if (child.type.name === 'hardBreak') {
      delimiters.push({ start: offset, size: child.nodeSize })
      return
    }

    if (!child.isText || !child.text) return

    for (let index = 0; index < child.text.length; index += 1) {
      const character = child.text[index]
      if (character === '\r' && child.text[index + 1] === '\n') {
        delimiters.push({ start: offset + index, size: 2 })
        index += 1
      } else if (character === '\n') {
        delimiters.push({ start: offset + index, size: 1 })
      }
    }
  })

  if (delimiters.length === 0) {
    return [{ start: 0, end: textblock.content.size }]
  }

  const lines = []
  let start = 0
  delimiters.forEach((delimiter) => {
    lines.push({ start, end: delimiter.start })
    start = delimiter.start + delimiter.size
  })
  lines.push({ start, end: textblock.content.size })
  return lines
}

function findLineIndex(lines, offset) {
  let lineIndex = 0
  for (let index = 1; index < lines.length; index += 1) {
    if (offset < lines[index].start) break
    lineIndex = index
  }
  return lineIndex
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum)
}

function runDefaultHeadingToggle(editor, level) {
  return editor.chain().focus().toggleHeading({ level }).run()
}

export function toggleHeadingForSelectedLines(editor, level) {
  if (!editor) return false

  const { state, view } = editor
  const { selection, schema } = state
  const { $from, $to } = selection
  const textblock = $from.parent
  const headingType = schema.nodes.heading
  const paragraphType = schema.nodes.paragraph

  if (
    !selection.empty && !$from.sameParent($to)
    || !textblock.isTextblock
    || (textblock.type !== paragraphType && textblock.type !== headingType)
  ) {
    return runDefaultHeadingToggle(editor, level)
  }

  const lines = getLineRanges(textblock)
  if (lines.length < 2) return runDefaultHeadingToggle(editor, level)

  const fromOffset = $from.parentOffset
  const toOffset = $to.parentOffset
  const firstLineIndex = findLineIndex(lines, fromOffset)
  const endProbe = selection.empty ? toOffset : Math.max(fromOffset, toOffset - 1)
  const lastLineIndex = findLineIndex(lines, endProbe)
  const clearSelectedHeading = textblock.type === headingType && textblock.attrs.level === level

  const replacementNodes = lines.map((line, index) => {
    const content = textblock.content.cut(line.start, line.end)
    const isSelectedLine = index >= firstLineIndex && index <= lastLineIndex
    if (!isSelectedLine) {
      return textblock.type.create(textblock.attrs, content, textblock.marks)
    }
    return clearSelectedHeading
      ? paragraphType.create(null, content)
      : headingType.create({ level }, content)
  })

  const blockDepth = $from.depth
  const blockStart = $from.before(blockDepth)
  const blockEnd = $from.after(blockDepth)
  const container = $from.node(blockDepth - 1)
  const blockIndex = $from.index(blockDepth - 1)
  const replacement = Fragment.fromArray(replacementNodes)

  if (!container.canReplace(blockIndex, blockIndex + 1, replacement)) {
    return runDefaultHeadingToggle(editor, level)
  }

  const nodeStarts = []
  let nextNodeStart = blockStart
  replacementNodes.forEach((node) => {
    nodeStarts.push(nextNodeStart)
    nextNodeStart += node.nodeSize
  })

  const firstLine = lines[firstLineIndex]
  const lastLine = lines[lastLineIndex]
  const newFrom = nodeStarts[firstLineIndex] + 1
    + clamp(fromOffset - firstLine.start, 0, replacementNodes[firstLineIndex].content.size)
  const newTo = nodeStarts[lastLineIndex] + 1
    + clamp(toOffset - lastLine.start, 0, replacementNodes[lastLineIndex].content.size)

  const tr = state.tr.replaceWith(blockStart, blockEnd, replacement)
  tr.setSelection(TextSelection.create(tr.doc, newFrom, newTo))
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}
