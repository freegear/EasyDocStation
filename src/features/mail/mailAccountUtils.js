export function getAccountLabel(account) {
  return account?.display_name || account?.email_address || ''
}
