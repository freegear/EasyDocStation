const test = require('node:test')
const assert = require('node:assert/strict')
const { GOOGLE_CARDDAV_SCOPE, normalizeGrantedScopes, validateGoogleContactScopes } = require('./googleScopes')

test('normalizes granted Google scopes without duplicates', () => {
  assert.deepEqual(normalizeGrantedScopes(`openid  ${GOOGLE_CARDDAV_SCOPE} openid`), ['openid', GOOGLE_CARDDAV_SCOPE])
})

test('requires the CardDAV scope before accepting a Google contact connection', () => {
  assert.deepEqual(validateGoogleContactScopes(`openid email ${GOOGLE_CARDDAV_SCOPE}`), ['openid', 'email', GOOGLE_CARDDAV_SCOPE])
  assert.throws(
    () => validateGoogleContactScopes('openid email profile'),
    error => error.code === 'GOOGLE_CONTACT_SCOPE_MISSING' && error.status === 403,
  )
})
