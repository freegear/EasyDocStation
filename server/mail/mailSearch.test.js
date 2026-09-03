const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildMailSearchDocument,
  validateMailSearchInput,
} = require('./mailSearch')

test('주소 검색은 정확한 정규화 이메일만 허용한다', () => {
  assert.deepEqual(validateMailSearchInput('from', ' Sender@Example.COM '), {
    field: 'from',
    query: 'sender@example.com',
  })
  assert.throws(() => validateMailSearchInput('to', 'sender'), error => error.code === 'INVALID_MAIL_SEARCH_EMAIL')
})

test('모든 검색 문서는 BCC와 첨부파일명을 포함하지 않는다', () => {
  const document = buildMailSearchDocument({
    subject: '분기 보고서',
    fromEmail: 'Boss@Example.com',
    fromName: '팀 장',
    to: [{ name: '홍 길동', email: 'USER@Example.com' }],
    cc: [{ name: '김 참조', email: 'CC@example.com' }],
    bcc: [{ name: '비밀', email: 'secret@example.com' }],
    bodyHtml: '<p>프로젝트 <strong>본문</strong></p>',
    attachmentFilenames: ['hidden-plan.pdf'],
  })

  assert.equal(document.fromEmail, 'boss@example.com')
  assert.deepEqual(document.toEmails, ['user@example.com'])
  assert.deepEqual(document.ccEmails, ['cc@example.com'])
  assert.match(document.allText, /분기 보고서/)
  assert.match(document.allText, /프로젝트 본문/)
  assert.doesNotMatch(document.allText, /secret@example\.com/)
  assert.doesNotMatch(document.allText, /hidden-plan/)
})

test('제목과 모든 검색은 유니코드·대소문자·공백을 정규화한다', () => {
  assert.deepEqual(validateMailSearchInput('subject', '  ＡＢＣ   Report  '), {
    field: 'subject',
    query: 'abc report',
  })
})
