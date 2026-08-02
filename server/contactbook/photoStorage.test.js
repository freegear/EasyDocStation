const test = require('node:test')
const assert = require('node:assert/strict')
const { imageInfo } = require('./photoStorage')

test('PNG signature와 크기를 검사한다', () => {
  const buffer = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer)
  buffer.writeUInt32BE(640, 16)
  buffer.writeUInt32BE(480, 20)
  const info = imageInfo(buffer)
  assert.deepEqual({ mime: info.mime, ext: info.ext, width: info.width, height: info.height },
    { mime: 'image/png', ext: 'png', width: 640, height: 480 })
})

test('확장자와 무관하게 알 수 없는 파일을 거부한다', () => {
  assert.throws(() => imageInfo(Buffer.from('not an image')), /사진만 업로드/)
})
