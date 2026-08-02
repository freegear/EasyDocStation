import test from 'node:test'
import assert from 'node:assert/strict'
import { appendEasyPageLinks, buildEasyPageTree, collectEasyPageSubtreeIds, extractEasyPagePostLinks, removeEasyPageLink } from '../src/components/chat/md-page/navigation/easyPageTree.js'

const page = (id, title, links = []) => ({
  id,
  channel_id: 'c1',
  content: `<!--md-page-->\n# ${title}\n\n${links.map(link => `[${link}](/?channelId=c1&postId=${link})`).join('\n')}`,
})

test('extracts internal EasyPage links in document order without duplicates', () => {
  assert.deepEqual(extractEasyPagePostLinks('[A](/?channelId=c1&postId=a) [A](/?channelId=c1&postId=a)'), [
    { channelId: 'c1', postId: 'a' },
  ])
})

test('builds the current page hierarchy and preserves child link order', () => {
  const tree = buildEasyPageTree({
    channelId: 'c1',
    currentPostId: 'b',
    channelPosts: [page('root', 'Top', ['b', 'a']), page('a', 'A'), page('b', 'B', ['c']), page('c', 'C')],
  })
  assert.equal(tree.root.title, 'Top')
  assert.deepEqual(tree.root.children.map(child => child.postId), ['b', 'a'])
  assert.deepEqual(collectEasyPageSubtreeIds(tree, 'b'), ['b', 'c'])
})

test('stops cycles and self links', () => {
  const tree = buildEasyPageTree({ channelId: 'c1', currentPostId: 'a', channelPosts: [page('a', 'A', ['a', 'b']), page('b', 'B', ['a'])] })
  assert.ok(tree.root)
  assert.equal(collectEasyPageSubtreeIds(tree, tree.rootId).length, 2)
})

test('moves structural links without leaving a dead link', () => {
  const parent = page('root', 'Top', ['child'])
  const removed = removeEasyPageLink(parent.content, 'child')
  assert.equal(extractEasyPagePostLinks(removed).length, 0)
  assert.match(removed, /child/)
  const moved = appendEasyPageLinks(page('destination', 'Destination').content, [{ postId: 'child', title: '하위 페이지' }], 'c1')
  assert.deepEqual(extractEasyPagePostLinks(moved), [{ channelId: 'c1', postId: 'child' }])
})
