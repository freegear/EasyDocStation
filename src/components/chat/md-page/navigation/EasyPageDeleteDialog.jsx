import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

export default function EasyPageDeleteDialog({ pageTitle, directChildren, subtreePages, destinations, deleting, onConfirm, onCancel }) {
  const [strategy, setStrategy] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const canConfirm = useMemo(() => {
    if (strategy === 'move_children') return Boolean(destinationId)
    if (strategy === 'delete_subtree') return confirmation.trim() === '삭제'
    return false
  }, [confirmation, destinationId, strategy])

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 px-4">
      <div role="dialog" aria-modal="true" aria-labelledby="easy-page-delete-title" className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl">
        <h3 id="easy-page-delete-title" className="text-lg font-bold text-gray-900">하위 페이지 처리 방법</h3>
        <p className="mt-2 text-sm text-gray-600"><strong>{pageTitle}</strong> 아래에 직접 하위 페이지 {directChildren.length}개가 있습니다. 삭제 전에 처리 방법을 선택하세요.</p>
        <ul className="mt-3 max-h-28 overflow-y-auto rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
          {directChildren.map(page => <li key={page.postId} className="truncate">• {page.title}</li>)}
        </ul>

        <label className={`mt-4 block rounded-xl border p-3 ${strategy === 'move_children' ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200'}`}>
          <span className="flex items-start gap-2">
            <input type="radio" name="deleteStrategy" value="move_children" checked={strategy === 'move_children'} onChange={() => setStrategy('move_children')} />
            <span><strong className="block text-sm text-gray-900">하위 페이지 이동 후 현재 페이지만 삭제</strong><span className="text-xs text-gray-500">직접 하위 페이지의 순서를 유지해 선택한 페이지 아래로 이동합니다.</span></span>
          </span>
          {strategy === 'move_children' && (
            <select value={destinationId} onChange={event => setDestinationId(event.target.value)} className="mt-3 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
              <option value="">새 부모 페이지 선택</option>
              {destinations.map(page => <option key={page.postId} value={page.postId}>{page.title}</option>)}
            </select>
          )}
        </label>

        <label className={`mt-3 block rounded-xl border p-3 ${strategy === 'delete_subtree' ? 'border-red-400 bg-red-50' : 'border-gray-200'}`}>
          <span className="flex items-start gap-2">
            <input type="radio" name="deleteStrategy" value="delete_subtree" checked={strategy === 'delete_subtree'} onChange={() => setStrategy('delete_subtree')} />
            <span><strong className="block text-sm text-red-700">현재 페이지와 모든 하위 페이지 함께 삭제</strong><span className="text-xs text-red-600">현재 페이지를 포함해 총 {subtreePages.length}개 페이지가 삭제됩니다.</span></span>
          </span>
          {strategy === 'delete_subtree' && (
            <div className="mt-3">
              <ul className="max-h-32 overflow-y-auto rounded-lg border border-red-100 bg-white px-3 py-2 text-xs text-gray-600">
                {subtreePages.map(page => <li key={page.postId} className="truncate">• {page.title}</li>)}
              </ul>
              <label className="mt-2 block text-xs font-medium text-red-700">계속하려면 ‘삭제’를 입력하세요.</label>
              <input value={confirmation} onChange={event => setConfirmation(event.target.value)} className="mt-1 w-full rounded-lg border border-red-300 px-3 py-2 text-sm" autoComplete="off" />
            </div>
          )}
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={deleting} onClick={onCancel} className="rounded-xl px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-50">취소</button>
          <button type="button" disabled={!canConfirm || deleting} onClick={() => onConfirm({ strategy, destinationId })} className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40">
            {deleting ? '처리 중...' : strategy === 'delete_subtree' ? `총 ${subtreePages.length}개 페이지 삭제` : '이동 후 삭제'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
