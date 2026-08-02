const test = require('node:test')
const assert = require('node:assert/strict')

const {
  isCompleteEmailAddress,
  matchRule,
} = require('./mailClawMatching')

test('recognizes only complete email addresses', () => {
  assert.equal(isCompleteEmailAddress('user@example.com'), true)
  assert.equal(isCompleteEmailAddress(' USER@EXAMPLE.CO.KR '), true)
  assert.equal(isCompleteEmailAddress('kr'), false)
  assert.equal(isCompleteEmailAddress('rnd-pso@tipa.or'), true)
  assert.equal(isCompleteEmailAddress('@example.com'), false)
})

test('trash rule ignores incomplete sender conditions', () => {
  const rule = {
    name: 'MailClaw 휴지통 이동',
    sender_check_enabled: true,
    sender_conditions: ['kr'],
    cc_check_enabled: false,
    keyword_check_enabled: false,
  }
  assert.equal(matchRule(rule, { from_email: 'jangjy@siliconcube.co.kr' }), false)
})

test('trash rule still matches a complete sender email', () => {
  const rule = {
    name: 'MailClaw 휴지통 이동',
    sender_check_enabled: true,
    sender_conditions: ['jangjy@siliconcube.co.kr'],
    cc_check_enabled: false,
    keyword_check_enabled: false,
  }
  assert.equal(matchRule(rule, { from_email: 'jangjy@siliconcube.co.kr' }), true)
})

test('other MailClaw rules retain partial sender matching', () => {
  const rule = {
    name: '거래처 도메인 분류',
    sender_check_enabled: true,
    sender_conditions: ['@example.com'],
    cc_check_enabled: false,
    keyword_check_enabled: false,
  }
  assert.equal(matchRule(rule, { from_email: 'sales@example.com' }), true)
})

test('recipient condition matches an address in the To header', () => {
  const rule = {
    name: '수신자별 자동화',
    sender_check_enabled: false,
    recipient_check_enabled: true,
    recipient_conditions: ['team@example.com'],
    cc_check_enabled: false,
    keyword_check_enabled: false,
  }
  const message = {
    to_json: [
      { name: 'Sales', email: 'sales@example.com' },
      { name: 'Team', email: 'TEAM@example.com' },
    ],
  }
  assert.equal(matchRule(rule, message), true)
})

test('recipient condition does not match an address found only in Cc', () => {
  const rule = {
    name: '수신자별 자동화',
    sender_check_enabled: false,
    recipient_check_enabled: true,
    recipient_conditions: ['team@example.com'],
    cc_check_enabled: false,
    keyword_check_enabled: false,
  }
  assert.equal(matchRule(rule, {
    to_json: [{ email: 'other@example.com' }],
    cc_json: [{ email: 'team@example.com' }],
  }), false)
})
