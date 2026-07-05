export const DEFAULT_ATTACH_POLICY = {
  maxFileMb: 20,
  maxTotalMb: 20,
  maxFiles: 20,
  blockedExtensions: ['exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'js', 'vbs', 'jar', 'msi', 'cpl', 'dll'],
}

export function normalizeAttachPolicy(p = {}) {
  return {
    maxFileMb: Number(p.max_file_mb) > 0 ? Math.floor(Number(p.max_file_mb)) : DEFAULT_ATTACH_POLICY.maxFileMb,
    maxTotalMb: Number(p.max_total_mb) > 0 ? Math.floor(Number(p.max_total_mb)) : DEFAULT_ATTACH_POLICY.maxTotalMb,
    maxFiles: Number(p.max_files) > 0 ? Math.floor(Number(p.max_files)) : DEFAULT_ATTACH_POLICY.maxFiles,
    blockedExtensions: Array.isArray(p.blocked_extensions)
      ? p.blocked_extensions.map(e => String(e).toLowerCase().replace(/^\.+/, '')).filter(Boolean)
      : [...DEFAULT_ATTACH_POLICY.blockedExtensions],
  }
}

export function fileExtOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

const PREVIEWABLE_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'])

export function isPreviewableImageFile(file) {
  const type = String(file?.type || '').toLowerCase()
  if (type.startsWith('image/')) {
    return !/heic|heif|tiff/.test(type)
  }
  return !type && PREVIEWABLE_IMAGE_EXTS.has(fileExtOf(file?.name))
}
