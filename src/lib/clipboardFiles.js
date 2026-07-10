function extensionFromMime(type = '') {
  const normalized = String(type || '').toLowerCase()
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg'
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/gif') return 'gif'
  if (normalized === 'image/webp') return 'webp'
  if (normalized === 'image/bmp') return 'bmp'
  if (normalized === 'image/svg+xml') return 'svg'
  return 'png'
}

function timestampForFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function shouldRenameClipboardImage(file) {
  const name = String(file?.name || '').trim()
  return !name || /^image(?:\s*\(\d+\))?\.[a-z0-9]+$/i.test(name)
}

function normalizeClipboardImageFile(file, index = 0) {
  if (!shouldRenameClipboardImage(file) || typeof File === 'undefined') return file
  const suffix = index > 0 ? `-${index + 1}` : ''
  const ext = extensionFromMime(file.type)
  return new File([file], `pasted-image-${timestampForFilename()}${suffix}.${ext}`, {
    type: file.type || `image/${ext}`,
    lastModified: file.lastModified || Date.now(),
  })
}

export function getPastedImageFiles(event) {
  const data = event?.clipboardData || event?.nativeEvent?.clipboardData
  if (!data) return []

  const files = []
  for (const item of Array.from(data.items || [])) {
    if (item?.kind !== 'file') continue
    const file = item.getAsFile?.()
    if (file?.type?.startsWith('image/')) files.push(file)
  }

  for (const file of Array.from(data.files || [])) {
    if (file?.type?.startsWith('image/')) files.push(file)
  }

  const seen = new Set()
  const deduped = []
  for (const file of files) {
    const key = `${file.name || ''}:${file.type || ''}:${file.size || 0}:${file.lastModified || 0}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(file)
  }

  return deduped.map((file, index) => normalizeClipboardImageFile(file, index))
}
