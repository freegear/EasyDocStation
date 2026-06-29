import { useCallback, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

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
      logPrint('pdf.failed.noContentRef')
      return
    }
    const printWindow = window.open('', '_blank')
    if (printWindow) {
      try {
        printWindow.document.write('<!doctype html><html><head><title>PDF Print</title></head><body style="margin:0;background:#111;color:#fff;font:14px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">PDF 생성 중...</body></html>')
        printWindow.document.close()
      } catch {
        // noop
      }
    } else {
      logPrint('pdf.print.popupBlocked')
    }
    try {
      setIsPrinting(true)
      logPrint('pdf.capture.start', {
        title: pageTitle || titleFallback,
        scrollWidth: target.scrollWidth,
        scrollHeight: target.scrollHeight,
      })

      const original = {
        overflow: target.style.overflow,
        maxHeight: target.style.maxHeight,
        height: target.style.height,
      }
      let canvas = null
      try {
        target.style.overflow = 'visible'
        target.style.maxHeight = 'none'
        target.style.height = 'auto'

        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

        canvas = await html2canvas(target, {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          backgroundColor: '#ffffff',
          windowWidth: Math.max(target.scrollWidth, target.clientWidth),
          windowHeight: Math.max(target.scrollHeight, target.clientHeight),
          logging: false,
        })
      } finally {
        target.style.overflow = original.overflow
        target.style.maxHeight = original.maxHeight
        target.style.height = original.height
      }
      if (!canvas) throw new Error('PDF 캡처 캔버스가 생성되지 않았습니다.')

      logPrint('pdf.capture.done', { canvasWidth: canvas.width, canvasHeight: canvas.height })

      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 10
      const printableWidth = pageWidth - (margin * 2)
      const printableHeight = pageHeight - (margin * 2)
      const imageData = canvas.toDataURL('image/png')
      const imageHeight = (canvas.height * printableWidth) / canvas.width

      let renderedHeight = imageHeight
      let yOffset = margin
      pdf.addImage(imageData, 'PNG', margin, yOffset, printableWidth, imageHeight, undefined, 'FAST')
      renderedHeight -= printableHeight

      while (renderedHeight > 0) {
        pdf.addPage()
        yOffset = margin - (imageHeight - renderedHeight)
        pdf.addImage(imageData, 'PNG', margin, yOffset, printableWidth, imageHeight, undefined, 'FAST')
        renderedHeight -= printableHeight
      }

      const safeTitle = (pageTitle || titleFallback).replace(/[\\/:*?"<>|]+/g, '_')
      const fileName = `${safeTitle}.pdf`
      const blob = pdf.output('blob')
      const blobUrl = URL.createObjectURL(blob)
      logPrint('pdf.blob.ready', { fileName, blobBytes: blob.size })

      if (printWindow) {
        const escapedUrl = blobUrl.replace(/"/g, '&quot;')
        printWindow.document.open()
        printWindow.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safeTitle}</title>
    <style>
      html, body { margin: 0; height: 100%; background: #111; }
      iframe { border: 0; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <iframe id="pdf-frame" src="${escapedUrl}"></iframe>
    <script>
      (function () {
        const frame = document.getElementById('pdf-frame');
        const trigger = function () {
          try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
          } catch (e) {
            window.print();
          }
        };
        frame.addEventListener('load', function () {
          setTimeout(trigger, 250);
        });
      })();
    </script>
  </body>
</html>`)
        printWindow.document.close()
        logPrint('pdf.print.window.opened', { fileName })
      } else {
        logPrint('pdf.save.fallback.start', { fileName })
        pdf.save(fileName)
        logPrint('pdf.save.fallback.done', { fileName })
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
    } catch (error) {
      console.error(`[MDPrint][job:${printJobIdRef.current || '-'}] pdf.failed`, error)
      alert('PDF 생성 중 오류가 발생했습니다.')
      if (printWindow && !printWindow.closed) {
        try { printWindow.close() } catch { /* noop */ }
      }
    } finally {
      setIsPrinting(false)
    }
  }, [logPrint, pageTitle, printContentRef, titleFallback])

  return { handlePrintClick, isPrinting }
}
