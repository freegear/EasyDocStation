import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'

// 폴더 업로드 모달 (UploadFolder.md 1단계 MVP)
// - <input webkitdirectory>로 폴더 선택 → 상대 경로 유지
// - 트리 미리보기 + 접근 범위 선택(개인/모두/팀) + 보안등급
// - POST /api/folder-datasets (multipart), 결과 표시
// - 접근 가능한 데이터셋 목록/삭제

function buildTree(files) {
  // files: [{ relativePath, size }]
  const root = {}
  for (const f of files) {
    const parts = f.relativePath.split('/').filter(Boolean)
    let node = root
    for (let i = 0; i < parts.length; i += 1) {
      const isLeaf = i === parts.length - 1
      const key = parts[i]
      node[key] = node[key] || (isLeaf ? { __file: true, size: f.size } : {})
      node = node[key]
    }
  }
  return root
}

function TreeNode({ name, node, depth }) {
  const isFile = node.__file
  const children = isFile ? [] : Object.keys(node).sort()
  return (
    <div>
      <div style={{ paddingLeft: depth * 14 }} className="text-xs text-gray-600 py-0.5 flex items-center gap-1">
        <span>{isFile ? '📄' : '📁'}</span>
        <span className={isFile ? '' : 'font-semibold text-gray-800'}>{name}</span>
        {isFile && <span className="text-gray-400">({Math.round((node.size || 0) / 1024)} KB)</span>}
      </div>
      {children.map(c => <TreeNode key={c} name={c} node={node[c]} depth={depth + 1} />)}
    </div>
  )
}

export default function FolderUploadModal({ open, onClose }) {
  const inputRef = useRef(null)
  const [files, setFiles] = useState([]) // {file, relativePath, size}
  const [datasetName, setDatasetName] = useState('')
  const [accessScope, setAccessScope] = useState('personal')
  const [scopeTeamId, setScopeTeamId] = useState('')
  const [securityLevel, setSecurityLevel] = useState(0)
  const [teams, setTeams] = useState([])
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState(null)
  const [datasets, setDatasets] = useState([])

  useEffect(() => {
    if (!open) return
    loadDatasets()
    apiFetch('/teams')
      .then(d => setTeams(Array.isArray(d) ? d : (d?.items || [])))
      .catch(() => setTeams([]))
  }, [open])

  async function loadDatasets() {
    try {
      const d = await apiFetch('/folder-datasets')
      setDatasets(Array.isArray(d?.items) ? d.items : [])
    } catch (_) { setDatasets([]) }
  }

  function onPick(e) {
    const picked = Array.from(e.target.files || [])
    const mapped = picked.map(f => ({
      file: f,
      relativePath: (f.webkitRelativePath || f.name).replace(/\\/g, '/'),
      size: f.size,
    }))
    setFiles(mapped)
    if (mapped.length > 0 && !datasetName) {
      setDatasetName(mapped[0].relativePath.split('/').filter(Boolean)[0] || '폴더 데이터셋')
    }
    e.target.value = ''
  }

  const tree = useMemo(() => buildTree(files), [files])
  const totalBytes = useMemo(() => files.reduce((s, f) => s + (f.size || 0), 0), [files])

  async function handleUpload() {
    if (files.length === 0) return
    setUploading(true)
    setResult(null)
    try {
      const fd = new FormData()
      for (const f of files) fd.append('files', f.file)
      fd.append('relativePaths', JSON.stringify(files.map(f => f.relativePath)))
      fd.append('datasetName', datasetName || '폴더 데이터셋')
      fd.append('accessScope', accessScope)
      if (accessScope === 'team') fd.append('scopeTeamId', scopeTeamId)
      fd.append('securityLevel', String(securityLevel))
      const res = await fetch('/api/folder-datasets', { method: 'POST', body: fd, credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setResult(data)
      setFiles([])
      await loadDatasets()
    } catch (err) {
      alert(err.message)
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(id) {
    if (!confirm('이 데이터셋과 원본 파일을 완전히 삭제합니다. 계속할까요?')) return
    try {
      await apiFetch(`/folder-datasets/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await loadDatasets()
    } catch (err) {
      alert(err.message)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">폴더 업로드 (자료실 학습)</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <input ref={inputRef} type="file" webkitdirectory="" directory="" multiple className="hidden" onChange={onPick} />

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <button onClick={() => inputRef.current?.click()} className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold">
            폴더 선택
          </button>
          {files.length > 0 && (
            <span className="text-sm text-gray-500">{files.length}개 파일 · {Math.round(totalBytes / 1024 / 1024)} MB</span>
          )}
        </div>

        {files.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <label className="text-sm text-gray-700">데이터셋 이름
                <input value={datasetName} onChange={e => setDatasetName(e.target.value)}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
              </label>
              <label className="text-sm text-gray-700">보안등급 (0~4)
                <input type="number" min={0} max={4} value={securityLevel}
                  onChange={e => setSecurityLevel(Math.max(0, Math.min(4, Number(e.target.value) || 0)))}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
              </label>
            </div>

            <div className="mb-3">
              <div className="text-sm text-gray-700 mb-1">접근 범위</div>
              <div className="flex flex-wrap gap-3 text-sm">
                {[['personal', '개인'], ['all', '모두'], ['team', '팀'], ['channel', '채널']].map(([v, label]) => (
                  <label key={v} className="flex items-center gap-1">
                    <input type="radio" name="scope" checked={accessScope === v} onChange={() => setAccessScope(v)} disabled={v === 'channel'} />
                    <span className={v === 'channel' ? 'text-gray-300' : ''}>{label}</span>
                  </label>
                ))}
              </div>
              {accessScope === 'team' && (
                <select value={scopeTeamId} onChange={e => setScopeTeamId(e.target.value)}
                  className="mt-2 border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
                  <option value="">팀 선택</option>
                  {teams.map(tm => <option key={tm.id} value={tm.id}>{tm.name || tm.id}</option>)}
                </select>
              )}
            </div>

            <div className="border border-gray-200 rounded-xl p-3 mb-3 max-h-56 overflow-y-auto bg-gray-50">
              {Object.keys(tree).sort().map(name => <TreeNode key={name} name={name} node={tree[name]} depth={0} />)}
            </div>

            <button onClick={handleUpload} disabled={uploading || (accessScope === 'team' && !scopeTeamId)}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold">
              {uploading ? '업로드 중...' : '업로드 시작'}
            </button>
          </>
        )}

        {result && (
          <div className="mt-3 text-sm bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-emerald-800">
            업로드 완료: 성공 {result.completed_count} / 실패 {result.failed_count} (총 {result.file_count})
          </div>
        )}

        <div className="mt-6">
          <h3 className="text-sm font-bold text-gray-800 mb-2">내 폴더 데이터셋</h3>
          <div className="border border-gray-200 rounded-xl divide-y">
            {datasets.length === 0 ? (
              <div className="text-sm text-gray-400 p-3">데이터셋이 없습니다.</div>
            ) : datasets.map(d => (
              <div key={d.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <div className="font-semibold text-gray-800">{d.name}</div>
                  <div className="text-gray-400 text-xs">
                    {d.access_scope} · {d.file_count}개 · {Math.round((Number(d.total_bytes) || 0) / 1024 / 1024)} MB · {d.status}
                  </div>
                </div>
                <button onClick={() => handleDelete(d.id)} className="px-3 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-xs">
                  삭제
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
