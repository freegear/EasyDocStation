import test from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { toggleHeadingForSelectedLines } from './headingSelection.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
    },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline', selectable: false },
  },
})

function createEditor(doc, from, to) {
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to),
  })

  const editor = {
    get state() {
      return state
    },
    view: {
      dispatch(transaction) {
        state = state.apply(transaction)
      },
      focus() {},
    },
    chain() {
      throw new Error('Default heading toggle should not run for multi-line textblocks')
    },
  }

  return {
    editor,
    getState: () => state,
  }
}

function hardBreakLines(blockType = 'paragraph') {
  return schema.node('doc', null, [
    schema.node(blockType, blockType === 'heading' ? { level: 1 } : null, [
      schema.text('alpha'),
      schema.node('hardBreak'),
      schema.text('beta'),
      schema.node('hardBreak'),
      schema.text('gamma'),
    ]),
  ])
}

function blockSummary(doc) {
  return Array.from({ length: doc.childCount }, (_, index) => {
    const node = doc.child(index)
    return {
      type: node.type.name,
      level: node.attrs.level || null,
      text: node.textContent,
    }
  })
}

test('H1 applies only to the selected hard-break line', () => {
  const { editor, getState } = createEditor(hardBreakLines(), 7, 11)

  assert.equal(toggleHeadingForSelectedLines(editor, 1), true)
  assert.deepEqual(blockSummary(getState().doc), [
    { type: 'paragraph', level: null, text: 'alpha' },
    { type: 'heading', level: 1, text: 'beta' },
    { type: 'paragraph', level: null, text: 'gamma' },
  ])
  assert.equal(getState().selection.$from.parent.textContent, 'beta')
})

test('clicking the active heading removes H1 only from the selected line', () => {
  const { editor, getState } = createEditor(hardBreakLines('heading'), 7, 11)

  assert.equal(toggleHeadingForSelectedLines(editor, 1), true)
  assert.deepEqual(blockSummary(getState().doc), [
    { type: 'heading', level: 1, text: 'alpha' },
    { type: 'paragraph', level: null, text: 'beta' },
    { type: 'heading', level: 1, text: 'gamma' },
  ])
})

test('H1 applies only to the selected line when line breaks are text characters', () => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('alpha\nbeta\ngamma')]),
  ])
  const { editor, getState } = createEditor(doc, 7, 11)

  assert.equal(toggleHeadingForSelectedLines(editor, 1), true)
  assert.deepEqual(blockSummary(getState().doc), [
    { type: 'paragraph', level: null, text: 'alpha' },
    { type: 'heading', level: 1, text: 'beta' },
    { type: 'paragraph', level: null, text: 'gamma' },
  ])
})
