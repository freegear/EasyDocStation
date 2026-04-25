export function findDuplicateFileNames(files = []) {
  const countByName = new Map()

  files.forEach((file) => {
    const originalName = String(file?.name || '').trim()
    if (!originalName) return
    const key = originalName.toLocaleLowerCase()
    const prev = countByName.get(key)
    if (prev) {
      prev.count += 1
      return
    }
    countByName.set(key, { name: originalName, count: 1 })
  })

  return Array.from(countByName.values())
    .filter((entry) => entry.count > 1)
    .map((entry) => entry.name)
}
