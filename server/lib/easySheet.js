// EasySheet(Univer 스프레드시트 게시글) 서버측 유틸.
// 게시글 본문은 `<!--easy-sheet-->` 마커 + IWorkbookData 스냅샷(JSON) 형태로 저장된다.
// 검색 인덱싱/RAG 학습에서 JSON 원문을 그대로 넣으면 의미 없는 토큰이 들어가므로,
// 여기서 셀 텍스트만 추출해 일반 텍스트로 변환한다. (프론트 src/templates/formTemplates.js와 대응)

const EASY_SHEET_MARKER = '<!--easy-sheet-->'

function isEasySheet(content) {
  return typeof content === 'string' && content.trimStart().startsWith(EASY_SHEET_MARKER)
}

// 셀 값(v)을 사람이 읽는 문자열로. 숫자/문자/리치텍스트(p) 모두 처리.
function cellToText(cell) {
  if (cell == null || typeof cell !== 'object') return ''
  // 리치 텍스트 문단(p)이 있으면 거기서 텍스트 추출
  if (cell.p && cell.p.body && typeof cell.p.body.dataStream === 'string') {
    return cell.p.body.dataStream.replace(/\r?\n/g, ' ').trim()
  }
  const v = cell.v
  if (v == null) return ''
  return String(v).trim()
}

// EasySheet 본문에서 모든 시트의 셀 텍스트를 추출해 공백/줄바꿈으로 join.
// 파싱 실패 시 빈 문자열 반환(방어).
function extractEasySheetText(content) {
  if (!isEasySheet(content)) return ''
  const json = content
    .trimStart()
    .replace(/^<!--easy-sheet-->\n?/, '')
    .trim()
  if (!json) return ''

  let data
  try {
    data = JSON.parse(json)
  } catch {
    return ''
  }
  if (!data || typeof data !== 'object' || !data.sheets) return ''

  const order = Array.isArray(data.sheetOrder) && data.sheetOrder.length
    ? data.sheetOrder
    : Object.keys(data.sheets)

  const lines = []
  for (const sheetId of order) {
    const sheet = data.sheets[sheetId]
    if (!sheet) continue
    if (sheet.name) lines.push(String(sheet.name).trim())
    const cellData = sheet.cellData
    if (!cellData || typeof cellData !== 'object') continue
    // 행 번호 오름차순으로 순회해 읽기 순서를 유지
    const rowKeys = Object.keys(cellData).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b)
    for (const r of rowKeys) {
      const row = cellData[r]
      if (!row || typeof row !== 'object') continue
      const colKeys = Object.keys(row).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b)
      const rowTexts = []
      for (const c of colKeys) {
        const text = cellToText(row[c])
        if (text) rowTexts.push(text)
      }
      if (rowTexts.length) lines.push(rowTexts.join('\t'))
    }
  }
  return lines.join('\n').trim()
}

module.exports = { EASY_SHEET_MARKER, isEasySheet, extractEasySheetText }
