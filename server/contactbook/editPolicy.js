function canEditGoogleContact(row) {
  return row?.provider === 'GOOGLE' && Boolean(String(row.remote_uid || '').trim())
}

function canEditAppleContact(row) {
  return row?.provider === 'APPLE' && Boolean(String(row.remote_uid || '').trim())
}

function canEditContact(row) {
  return canEditGoogleContact(row) || canEditAppleContact(row)
}

function validateContactEdit(body) {
  const text = (name, limit, required = false) => {
    const value = String(body?.[name] ?? '').replace(/\r/g, '').trim()
    if (required && !value) { const error = new Error('표시 이름을 입력해 주세요.'); error.status = 400; throw error }
    if (value.length > limit) { const error = new Error(`${name} 값이 너무 깁니다.`); error.status = 400; throw error }
    return value
  }
  return {
    displayName: text('displayName', 300, true), givenName: text('givenName', 150), familyName: text('familyName', 150),
    nickname: text('nickname', 150), organization: text('organization', 300), department: text('department', 300),
    jobTitle: text('jobTitle', 300), note: text('note', 5000), primaryEmail: text('primaryEmail', 500), primaryPhone: text('primaryPhone', 100),
  }
}

module.exports = { canEditGoogleContact, canEditAppleContact, canEditContact, validateContactEdit }
