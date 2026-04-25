import { useState } from 'react'
import { useSelectionClickGuard } from '../../hooks/useSelectionClickGuard'

function SelectableCard({ title, text, counterTestId, bodyTestId }) {
  const [count, setCount] = useState(0)
  const guard = useSelectionClickGuard({
    scope: `fixture-${title}`,
    dragThreshold: 4,
    blockOnAnySelection: true,
  })

  function handleCardClick(e) {
    if (guard.shouldBlockClick(e, { useDragThreshold: true })) return
    setCount((v) => v + 1)
  }

  return (
    <div
      data-testid={`${bodyTestId}-card`}
      className="rounded-xl border border-gray-300 bg-white p-4 shadow-sm"
      onMouseDown={guard.handleMouseDown}
      onMouseUp={guard.handleMouseUp}
      onClickCapture={guard.handleClickCapture}
      onClick={handleCardClick}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
        <span className="text-xs text-gray-500" data-testid={counterTestId}>{count}</span>
      </div>
      <p
        data-testid={bodyTestId}
        className="select-text cursor-text text-sm leading-relaxed text-gray-700"
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      >
        {text}
      </p>
    </div>
  )
}

export default function SelectionGuardPlaywrightFixture() {
  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <h1 className="text-lg font-bold text-gray-900">Selection Guard Fixture</h1>
        <SelectableCard
          title="Post Body"
          counterTestId="post-open-count"
          bodyTestId="post-body-text"
          text="게시글 본문 선택 테스트입니다. 이 문장에서 일부만 드래그한 뒤 마우스를 놓고 카드를 다시 클릭해도 열기 카운트가 증가하면 안 됩니다."
        />
        <SelectableCard
          title="Comment Body"
          counterTestId="comment-open-count"
          bodyTestId="comment-body-text"
          text="댓글 본문 선택 테스트입니다. 이 문장에서 단어 범위를 선택한 뒤 클릭 이벤트가 무시되는지 확인합니다."
        />
      </div>
    </main>
  )
}
