import { useCallback, useRef, useState } from 'react'
import { printSelectedContent } from '../../../../lib/printSelectedContent'

export default function useMDPagePrint({ pageTitle, printContentRef, titleFallback = 'EasyPage' }) {
  const printJobIdRef = useRef(0)
  const [isPrinting, setIsPrinting] = useState(false)

  const logPrint = useCallback((phase, payload = {}) => {
    const jobId = printJobIdRef.current
    console.info(`[MDPrint][job:${jobId || '-'}] ${phase}`, payload)
  }, [])

  const handlePrintClick = useCallback(async () => {
    printJobIdRef.current = Date.now()
    logPrint('click.printButton')
    const target = printContentRef.current
    if (!target) {
      logPrint('html.failed.noContentRef')
      return
    }

    try {
      setIsPrinting(true)
      logPrint('html.print.start', {
        title: pageTitle || titleFallback,
        scrollWidth: target.scrollWidth,
        scrollHeight: target.scrollHeight,
      })

      await printSelectedContent({
        type: 'easy-page',
        title: pageTitle || titleFallback,
        contentNode: target,
        includeHeader: false,
        preserveTaskCheckboxes: true,
        popupBlockedMessage: '인쇄 창을 열 수 없습니다. 이 사이트의 팝업을 허용해 주세요.',
        failedMessage: '인쇄 준비 중 오류가 발생했습니다.',
      })
      logPrint('html.print.opened')
    } catch (error) {
      console.error(`[MDPrint][job:${printJobIdRef.current || '-'}] html.failed`, error)
      alert(error?.message || '인쇄 준비 중 오류가 발생했습니다.')
    } finally {
      setIsPrinting(false)
    }
  }, [logPrint, pageTitle, printContentRef, titleFallback])

  return { handlePrintClick, isPrinting }
}
