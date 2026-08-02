const DB_NAME = 'easystation-meeting-recordings'
const DB_VERSION = 1
const CHUNK_STORE = 'chunks'
const SESSION_STORE = 'sessions'

function openDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('IndexedDB를 지원하지 않는 브라우저입니다.'))
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = db.createObjectStore(CHUNK_STORE, { keyPath: 'key' })
        chunks.createIndex('meetingId', 'meetingId', { unique: false })
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'postId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('녹음 임시 저장소를 열 수 없습니다.'))
  })
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore(storeName, mode, callback) {
  const db = await openDb()
  try {
    const tx = db.transaction(storeName, mode)
    const result = await callback(tx.objectStore(storeName))
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('녹음 임시 저장 작업이 취소되었습니다.'))
    })
    return result
  } finally {
    db.close()
  }
}

export async function saveMeetingSession(session) {
  return withStore(SESSION_STORE, 'readwrite', (store) => requestResult(store.put(session)))
}

export async function getMeetingSession(postId) {
  return withStore(SESSION_STORE, 'readonly', (store) => requestResult(store.get(String(postId))))
}

export async function deleteMeetingSession(postId) {
  return withStore(SESSION_STORE, 'readwrite', (store) => requestResult(store.delete(String(postId))))
}

export async function saveMeetingChunk({ meetingId, sequence, blob, startedAtMs, durationMs, sha256 }) {
  const value = {
    key: `${meetingId}:${sequence}`,
    meetingId: String(meetingId),
    sequence: Number(sequence),
    blob,
    startedAtMs: Number(startedAtMs),
    durationMs: Number(durationMs),
    sha256: String(sha256 || ''),
    createdAt: Date.now(),
  }
  return withStore(CHUNK_STORE, 'readwrite', (store) => requestResult(store.put(value)))
}

export async function listMeetingChunks(meetingId) {
  return withStore(CHUNK_STORE, 'readonly', async (store) => {
    const index = store.index('meetingId')
    const values = await requestResult(index.getAll(String(meetingId)))
    return (values || []).sort((a, b) => Number(a.sequence) - Number(b.sequence))
  })
}

export async function deleteMeetingChunk(meetingId, sequence) {
  return withStore(CHUNK_STORE, 'readwrite', (store) => requestResult(store.delete(`${meetingId}:${sequence}`)))
}

export async function clearMeetingChunks(meetingId) {
  const chunks = await listMeetingChunks(meetingId)
  return withStore(CHUNK_STORE, 'readwrite', (store) => {
    for (const chunk of chunks) store.delete(chunk.key)
  })
}
