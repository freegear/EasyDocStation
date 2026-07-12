const test = require('node:test')
const assert = require('node:assert/strict')
const { parseGmailMessage } = require('./messageParser')

test('filename과 attachmentId가 없는 CID 이미지 body data를 첨부 후보로 보존한다', () => {
  const inlineData = Buffer.from('inline-image').toString('base64url')
  const parsed = parseGmailMessage({
    id: 'gmail-message-1',
    payload: {
      headers: [],
      mimeType: 'multipart/related',
      parts: [{
        mimeType: 'image/png',
        filename: '',
        headers: [
          { name: 'Content-ID', value: '<poster@example>' },
          { name: 'Content-Disposition', value: 'inline' },
        ],
        body: { data: inlineData, size: 12 },
      }],
    },
  })

  assert.equal(parsed.hasAttachments, true)
  assert.equal(parsed.attachments.length, 1)
  assert.deepEqual(parsed.attachments[0], {
    providerAttachmentId: undefined,
    inlineData,
    filename: 'inline-image-1',
    contentType: 'image/png',
    sizeBytes: 12,
    contentId: 'poster@example',
    disposition: 'inline',
  })
})

test('일반 본문 body data는 이미지 첨부로 오인하지 않는다', () => {
  const parsed = parseGmailMessage({
    id: 'gmail-message-2',
    payload: {
      headers: [],
      mimeType: 'text/plain',
      body: { data: Buffer.from('hello').toString('base64url'), size: 5 },
    },
  })

  assert.equal(parsed.bodyText, 'hello')
  assert.equal(parsed.attachments.length, 0)
})
