import { MAIL_TEXT } from './mailText'

export const FOLDER_COLOR_OPTIONS = [
  { key: '', label: '기본값', value: '' },
  { key: 'red', label: '빨강', value: '#ff4b55' },
  { key: 'orange', label: '주황', value: '#ff9f43' },
  { key: 'yellow', label: '노랑', value: '#ffd84d' },
  { key: 'green', label: '녹색', value: '#32e96b' },
  { key: 'blue', label: '파랑', value: '#3db7f2' },
  { key: 'purple', label: '퍼플', value: '#bf3df2' },
]

export const FOLDER_COLOR_MAP = Object.fromEntries(FOLDER_COLOR_OPTIONS.map(item => [item.key, item.value]))

export function getFolderColorLabel(option, mt = MAIL_TEXT.ko) {
  return mt.colors?.[option.key || 'default'] || option.label
}

const AUTO_TAG_PALETTE = ['red', 'orange', 'yellow', 'green', 'blue', 'purple']

function autoTagColorKey(name) {
  let h = 0
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return AUTO_TAG_PALETTE[h % AUTO_TAG_PALETTE.length]
}

export function resolveTagColor(colorKey, name) {
  return FOLDER_COLOR_MAP[colorKey || autoTagColorKey(name)] || ''
}

const MAIL_FOLDER_TYPE_ORDER = {
  inbox: 0,
  sent: 1,
  drafts: 2,
  archive: 3,
  spam: 90,
  trash: 100,
}

function getFolderTypeOrder(folder = {}) {
  if (Object.prototype.hasOwnProperty.call(MAIL_FOLDER_TYPE_ORDER, folder?.type)) {
    return MAIL_FOLDER_TYPE_ORDER[folder.type]
  }
  return 50
}

export function getMailFolderLabel(folder = {}, mt = MAIL_TEXT.ko) {
  const rawName = String(folder?.name || '').trim()
  const normalized = rawName.toLowerCase()
  if (folder?.type && mt.folders?.[folder.type]) return mt.folders[folder.type]
  if (normalized === 'junk' || normalized === 'spam') return mt.folders.spam
  if (normalized === '받은 편지함') return mt.folders.inbox
  if (normalized === '보낸 메일') return mt.folders.sent
  if (normalized === '임시 보관함') return mt.folders.drafts
  if (normalized === '휴지통') return mt.folders.trash
  return rawName
}

export function getMailFolderTitle(folder = {}, mt = MAIL_TEXT.ko) {
  if (folder?.sync_status === 'missing') return mt.folderMissingTitle
  if (folder?.is_local) {
    const label = getMailFolderLabel(folder, mt)
    return `${label} ${mt.localFolderTitle}`
  }
  return undefined
}

function compareMailFolders(a = {}, b = {}, mt = MAIL_TEXT.ko) {
  const typeDelta = getFolderTypeOrder(a) - getFolderTypeOrder(b)
  if (typeDelta !== 0) return typeDelta
  const aLabel = getMailFolderLabel(a, mt)
  const bLabel = getMailFolderLabel(b, mt)
  const nameDelta = aLabel.localeCompare(bLabel, undefined, { numeric: true, sensitivity: 'base' })
  if (nameDelta !== 0) return nameDelta
  return String(a.id || a.name || '').localeCompare(String(b.id || b.name || ''))
}

export function buildHierarchicalFolderList(folders = [], mt = MAIL_TEXT.ko) {
  const rows = Array.isArray(folders) ? folders.filter(Boolean) : []
  const ids = new Set(rows.map(folder => folder.id).filter(Boolean))
  const childrenByParent = new Map()
  const roots = []

  for (const folder of rows) {
    const parentId = folder.parent_folder_id || ''
    if (parentId && ids.has(parentId)) {
      const children = childrenByParent.get(parentId) || []
      children.push(folder)
      childrenByParent.set(parentId, children)
    } else {
      roots.push(folder)
    }
  }

  const ordered = []
  const visited = new Set()

  function appendBranch(folder, depth) {
    const key = folder.id || `${folder.name}-${ordered.length}`
    if (visited.has(key)) return
    visited.add(key)
    ordered.push({ folder, depth })

    const children = [...(childrenByParent.get(folder.id) || [])].sort((a, b) => compareMailFolders(a, b, mt))
    for (const child of children) appendBranch(child, depth + 1)
  }

  for (const folder of [...roots].sort((a, b) => compareMailFolders(a, b, mt))) {
    appendBranch(folder, 0)
  }

  for (const folder of rows) {
    const key = folder.id || `${folder.name}-${ordered.length}`
    if (!visited.has(key)) appendBranch(folder, 0)
  }

  return ordered
}

export function isSystemMailFolder(folder) {
  return ['inbox', 'sent', 'drafts', 'trash', 'archive', 'spam'].includes(folder?.type)
}

export function normalizeFolderName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function isMailTrashFolder(folder = {}) {
  return folder?.type === 'trash'
    || String(folder?.provider_folder_id || '').toUpperCase() === 'TRASH'
    || String(folder?.name || '').trim() === '휴지통'
}
