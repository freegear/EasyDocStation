export function parseEchartsOption(source = '') {
  const text = String(source || '').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    try {
      return Function(`"use strict"; return (${text});`)()
    } catch (err) {
      throw new Error(`ECharts 옵션 파싱 실패: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export function isLikelyEchartsOption(source = '') {
  try {
    const option = parseEchartsOption(source)
    if (!option || typeof option !== 'object' || Array.isArray(option)) return false

    // title/legend/tooltip/grid는 일반 업무 JSON에도 흔히 등장한다. 언어가
    // json/js인 fallback 감지에서는 실제 차트 계열을 정의하는 series가
    // 있어야 ECharts로 판정한다. series 없는 특수 옵션은 ```echarts로
    // 명시하면 기존처럼 렌더링된다.
    const series = option.series
    if (Array.isArray(series)) return series.length > 0
    return Boolean(series && typeof series === 'object')
  } catch {
    return false
  }
}

