const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { exec, execFile } = require('child_process')
const { client, isConnected } = require('../cassandra')
const db = require('../db')
const requireAuth = require('../middleware/auth')
const { getDatabasePath } = require('../databasePaths')

// Load config for storage path
const configPath = path.join(__dirname, '../../config.json')
let config = {}
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (e) {
  console.error('Failed to load config.json for File Service')
}

const STORAGE_BASE = getDatabasePath(config, 'ObjectFile Path')
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret'

// Ensure storage base exists
if (!fs.existsSync(STORAGE_BASE)) {
  fs.mkdirSync(STORAGE_BASE, { recursive: true })
}

const THUMBNAIL_BASE = path.join(STORAGE_BASE, 'thumbnails')
if (!fs.existsSync(THUMBNAIL_BASE)) {
  fs.mkdirSync(THUMBNAIL_BASE, { recursive: true })
}
const PREVIEW_BASE = path.join(STORAGE_BASE, 'previews')
if (!fs.existsSync(PREVIEW_BASE)) {
  fs.mkdirSync(PREVIEW_BASE, { recursive: true })
}
const LINK_PREVIEW_BASE = path.join(PREVIEW_BASE, 'link-previews')
if (!fs.existsSync(LINK_PREVIEW_BASE)) {
  fs.mkdirSync(LINK_PREVIEW_BASE, { recursive: true })
}
const LINK_PREVIEW_CACHE_VERSION = 'v2'

function readConfigSafe() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

function isPrivateHostname(hostname = '') {
  const h = String(hostname || '').toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '[::1]') return true
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true
  return false
}

function normalizePreviewUrl(rawUrl = '') {
  const parsed = new URL(String(rawUrl || '').trim())
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error('http/https 링크만 지원합니다.')
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error('내부망 주소는 미리보기를 지원하지 않습니다.')
  }
  return parsed.toString()
}

function withTimeout(promise, ms, label = 'timeout') {
  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function generateLinkPreviewImage(url, outPath, width, height) {
  let playwright
  try {
    playwright = require('playwright')
  } catch {
    throw new Error('playwright 모듈이 설치되어 있지 않습니다.')
  }

  const browser = await playwright.chromium.launch({ headless: true, timeout: 10000 })
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      javaScriptEnabled: true,
    })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 })
    await page.waitForTimeout(1200)
    await page.screenshot({ path: outPath, type: 'png' })
    await context.close()
  } finally {
    await browser.close()
  }
}

async function downloadRemotePreviewFallback(url, outPath, width, height) {
  // thum.io public screenshot fallback
  const fallbackUrl = `https://image.thum.io/get/width/${Math.max(120, Math.min(1600, width))}/crop/${Math.max(90, Math.min(2000, height))}/?url=${encodeURIComponent(url)}`
  const res = await fetchWithTimeout(fallbackUrl, {}, 10000)
  if (!res.ok) throw new Error(`fallback preview fetch failed (${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('fallback preview empty body')
  fs.writeFileSync(outPath, buf)
}

function decodeHtmlEntities(input = '') {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function extractMetaImageUrl(html = '', pageUrl = '') {
  const normalizedHtml = String(html || '')
  const candidates = []
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i,
  ]
  for (const re of patterns) {
    const m = normalizedHtml.match(re)
    if (m?.[1]) candidates.push(m[1])
  }
  for (const raw of candidates) {
    const decoded = decodeHtmlEntities(raw.trim())
    if (!decoded) continue
    try {
      const resolved = new URL(decoded, pageUrl).toString()
      if (/^https?:\/\//i.test(resolved)) return resolved
    } catch {}
  }
  return ''
}

async function fetchMetaPreviewImage(pageUrl) {
  const pageRes = await fetchWithTimeout(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      Referer: pageUrl,
    },
  }, 10000)
  if (!pageRes.ok) throw new Error(`meta page fetch failed (${pageRes.status})`)
  const html = await pageRes.text()
  const imageUrl = extractMetaImageUrl(html, pageUrl)
  if (!imageUrl) throw new Error('meta image not found')

  const imageRes = await fetchWithTimeout(imageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Referer: pageUrl,
    },
  }, 10000)
  if (!imageRes.ok) throw new Error(`meta image fetch failed (${imageRes.status})`)
  const contentType = String(imageRes.headers.get('content-type') || '').toLowerCase()
  if (!contentType.startsWith('image/')) {
    throw new Error(`meta image content-type invalid (${contentType || 'unknown'})`)
  }
  const bytes = Buffer.from(await imageRes.arrayBuffer())
  if (!bytes.length) throw new Error('meta image empty')
  return { bytes, contentType }
}

function writePlaceholderPng(outPath, width, height, host = '') {
  const safeHost = String(host || '').slice(0, 80).replace(/[<>&"]/g, '')
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#eef2ff"/>
      <stop offset="100%" stop-color="#e5e7eb"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="1" y="1" width="${Math.max(0, width - 2)}" height="${Math.max(0, height - 2)}" fill="none" stroke="#c7d2fe"/>
  <text x="50%" y="46%" dominant-baseline="middle" text-anchor="middle" font-size="15" fill="#374151" font-family="Arial, sans-serif">Preview Unavailable</text>
  <text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" font-size="12" fill="#6b7280" font-family="Arial, sans-serif">${safeHost}</text>
</svg>`
  fs.writeFileSync(outPath, Buffer.from(svg, 'utf8'))
}

function toAsciiFilename(name = '') {
  return String(name || 'download')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
}

function encodeRFC5987(str = '') {
  return encodeURIComponent(str)
    .replace(/['()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A')
}

function setAttachmentHeaders(res, filename, contentType, contentLength) {
  const safeName = String(filename || 'download')
  const asciiName = toAsciiFilename(safeName)
  const disposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeRFC5987(safeName)}`
  res.setHeader('Content-Disposition', disposition)
  res.setHeader('Content-Type', contentType || 'application/octet-stream')
  if (Number.isFinite(contentLength) && contentLength >= 0) {
    res.setHeader('Content-Length', String(contentLength))
  }
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}

function appendThumbLog(logFile, message) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`)
  } catch (_) {}
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function convertWithLibreOfficeToPdf(inputPath, outDir) {
  const ext = path.extname(inputPath).toLowerCase()
  const preferredFilter = (
    (ext === '.ppt' || ext === '.pptx') ? 'pdf:impress_pdf_Export' :
    (ext === '.doc' || ext === '.docx') ? 'pdf:writer_pdf_Export' :
    (ext === '.xls' || ext === '.xlsx') ? 'pdf:calc_pdf_Export' :
    'pdf'
  )
  const userProfileDir = fs.mkdtempSync(path.join(outDir, 'lo-profile-'))
  const baseArgs = [
    '--headless',
    '--nologo',
    '--nolockcheck',
    '--nodefault',
    '--norestore',
    `-env:UserInstallation=file://${userProfileDir}`,
  ]

  const convertArgsList = preferredFilter === 'pdf'
    ? [['--convert-to', 'pdf', '--outdir', outDir, inputPath]]
    : [
        ['--convert-to', preferredFilter, '--outdir', outDir, inputPath],
        ['--convert-to', 'pdf', '--outdir', outDir, inputPath],
      ]

  let lastErr = null
  for (const cmd of ['libreoffice', 'soffice']) {
    for (const convertArgs of convertArgsList) {
      try {
        await execFileAsync(cmd, [...baseArgs, ...convertArgs], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
        const expected = path.join(outDir, `${path.parse(inputPath).name}.pdf`)
        if (fs.existsSync(expected)) return expected

        const fallbackPdfName = fs.readdirSync(outDir).find(n => n.toLowerCase().endsWith('.pdf'))
        if (fallbackPdfName) return path.join(outDir, fallbackPdfName)
      } catch (err) {
        lastErr = err
      }
    }
  }

  const err = new Error('LibreOffice PDF conversion failed')
  err.cause = lastErr
  throw err
}

async function generateThumbnail(fileUuid, fullPath) {
  const logFile = path.join(STORAGE_BASE, 'thumbnail_debug.log')
  const ext = path.extname(fullPath).toLowerCase()
  const uniqueThumbName = `${fileUuid}.png`
  const finalThumbPath = path.join(THUMBNAIL_BASE, uniqueThumbName)
  const thumbRelPath = path.join('thumbnails', uniqueThumbName)

  try {
    if (process.platform === 'darwin') {
      const cmd = `qlmanage -t -s 512 -o "${THUMBNAIL_BASE}" "${fullPath}"`
      appendThumbLog(logFile, `Generating (darwin): ${cmd}`)
      await new Promise((resolve, reject) => {
        exec(cmd, (err, _stdout, stderr) => {
          if (err) {
            err.stderr = stderr
            reject(err)
            return
          }
          resolve()
        })
      })
      const generatedPath = path.join(THUMBNAIL_BASE, path.basename(fullPath) + '.png')
      if (!fs.existsSync(generatedPath)) return null
      fs.renameSync(generatedPath, finalThumbPath)
      return thumbRelPath
    }

    if (process.platform !== 'linux') return null

    const tmpDir = fs.mkdtempSync(path.join(THUMBNAIL_BASE, 'tmp-'))
    try {
      const pngBase = path.join(tmpDir, 'preview')
      const pngPath = `${pngBase}.png`
      const officeExts = new Set(['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'])
      const videoExts = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm'])

      if (ext === '.pdf') {
        appendThumbLog(logFile, `Generating (linux/pdf): ${fullPath}`)
        await execFileAsync('pdftoppm', ['-png', '-singlefile', '-f', '1', '-scale-to', '512', fullPath, pngBase])
      } else if (officeExts.has(ext)) {
        appendThumbLog(logFile, `Generating (linux/office): ${fullPath}`)
        const sourcePdf = await convertWithLibreOfficeToPdf(fullPath, tmpDir)
        await execFileAsync('pdftoppm', ['-png', '-singlefile', '-f', '1', '-scale-to', '512', sourcePdf, pngBase])
      } else if (videoExts.has(ext)) {
        appendThumbLog(logFile, `Generating (linux/video): ${fullPath}`)
        await execFileAsync('ffmpeg', ['-y', '-ss', '00:00:01', '-i', fullPath, '-frames:v', '1', '-vf', 'scale=512:-1', pngPath])
      } else {
        return null
      }

      if (!fs.existsSync(pngPath)) return null
      fs.renameSync(pngPath, finalThumbPath)
      return thumbRelPath
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  } catch (err) {
    const reason = err.code === 'ENOENT'
      ? `required command missing: ${err.path || 'unknown'}`
      : (err.stderr || err.message || 'unknown error')
    appendThumbLog(logFile, `Error for ${fileUuid}: ${reason}`)
    return null
  }
}

async function convertOfficeToPdf(fileUuid, fullPath) {
  const ext = path.extname(fullPath).toLowerCase()
  const officeExts = new Set(['.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx'])
  if (!officeExts.has(ext)) return null

  const previewPdfPath = path.join(PREVIEW_BASE, `${fileUuid}.pdf`)
  const logFile = path.join(STORAGE_BASE, 'thumbnail_debug.log')
  try {
    appendThumbLog(logFile, `Preview convert start: ${fullPath}`)
    if (fs.existsSync(previewPdfPath)) {
      const sourceMtime = fs.statSync(fullPath).mtimeMs
      const previewMtime = fs.statSync(previewPdfPath).mtimeMs
      if (previewMtime >= sourceMtime) {
        appendThumbLog(logFile, `Preview convert cache hit: ${previewPdfPath}`)
        return previewPdfPath
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(PREVIEW_BASE, 'tmp-'))
    try {
      const sourcePdf = await convertWithLibreOfficeToPdf(fullPath, tmpDir)
      fs.copyFileSync(sourcePdf, previewPdfPath)
      appendThumbLog(logFile, `Preview convert ok: ${previewPdfPath}`)
      return previewPdfPath
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  } catch (err) {
    appendThumbLog(logFile, `Preview convert error: ${err?.cause?.stderr || err?.stderr || err?.message || err}`)
    console.error('[Preview] Office->PDF conversion failed:', err?.cause?.stderr || err?.stderr || err?.message || err)
    return null
  }
}

/**
 * 단계 1 & 2: Mock Presigned URL 생성 (Upload)
 * POST /api/files/get-upload-url
 */
router.post('/get-upload-url', requireAuth, async (req, res, next) => {
  try {
    const { filename, contentType, channelId } = req.body
    const file_uuid = crypto.randomUUID()

    // DS.002: ChannelID로 만든 폴더 밑에 File마다 폴더를 둔다.
    const key = path.join(channelId || 'unknown', file_uuid, filename)

    // Register in Cassandra (if connected)
    if (isConnected()) {
      await client.execute(`
        INSERT INTO attachments (id, filename, content_type, size, status, storage_path, uploader_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [file_uuid, filename, contentType, 0, 'PENDING', key, req.user.id, new Date()], { prepare: true })
    }

    // Fallback/Legacy: Register in PostgreSQL as well (for stability or transition)
    await db.query(`
      INSERT INTO attachments (id, filename, content_type, size, status, storage_path, uploader_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [file_uuid, filename, contentType, 0, 'PENDING', key, req.user.id])

    // Generate Mask Presigned URL with Token
    const token = jwt.sign({
      file_uuid,
      key,
      action: 'WRITE',
      user_id: req.user.id
    }, JWT_SECRET, { expiresIn: '15m' })

    // Return relative URL so browser/dev-proxy origin mismatches do not break upload.
    const uploadUrl = `/api/files/gateway/upload?token=${token}`
    
    res.json({ uploadUrl, file_uuid, key })
  } catch (err) {
    console.error('get-upload-url error:', err)
    next(err)
  }
})

/**
 * 파일 인라인 보기 (이미지 썸네일, 일반 다운로드)
 * GET /api/files/view/:id?auth_token=...
 */
router.get('/view/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    let file
    
    if (isConnected()) {
      const res = await client.execute('SELECT * FROM attachments WHERE id = ?', [id], { prepare: true })
      if (res.rowCount > 0) file = res.rows[0]
    }
    
    if (!file) {
      const result = await db.query('SELECT * FROM attachments WHERE id = $1', [id])
      if (result.rowCount > 0) file = result.rows[0]
    }

    if (!file) return res.status(404).send('파일을 찾을 수 없습니다.')

    let fullPath = path.join(STORAGE_BASE, file.storage_path)
    let contentType = file.content_type || 'application/octet-stream'
    const originalExt = path.extname(file.filename || file.storage_path || '').toLowerCase()

    // 썸네일 요청 처리
    if (req.query.thumbnail === 'true' && file.thumbnail_path) {
      const thumbPath = path.join(STORAGE_BASE, file.thumbnail_path)
      if (fs.existsSync(thumbPath)) {
        fullPath = thumbPath
        contentType = 'image/png' // qlmanage outputs png
      }
    }

    // PPT/PPTX 등 오피스 문서를 PDF로 변환해 실제 페이지 미리보기 제공
    if (req.query.preview === 'pdf') {
      const convertedPdfPath = await convertOfficeToPdf(id, fullPath)
      if (!convertedPdfPath) {
        return res.status(500).send('미리보기 PDF 변환에 실패했습니다.')
      }
      fullPath = convertedPdfPath
      contentType = 'application/pdf'
      const base = (file.filename || 'preview')
      const safePdfName = base.replace(/\.(pptx|ppt|docx|doc|xlsx|xls)$/i, '.pdf')
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(safePdfName)}"`)
    }

    if (!fs.existsSync(fullPath)) return res.status(404).send('파일을 찾을 수 없습니다.')

    const stat = fs.statSync(fullPath)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', String(stat.size))
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!req.query.preview && !contentType.startsWith('image/') && !contentType.startsWith('video/')) {
      setAttachmentHeaders(res, file.filename, contentType, stat.size)
    } else if (!req.query.preview && (originalExt === '.ppt' || originalExt === '.pptx')) {
      const asciiName = toAsciiFilename(file.filename)
      const utf8Name = encodeRFC5987(file.filename || '')
      res.setHeader('Content-Disposition', `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`)
    }
    const stream = fs.createReadStream(fullPath)
    stream.on('error', (err) => {
      console.error('[files/view] stream error:', err)
      if (!res.headersSent) {
        res.status(500).send('파일 전송 중 오류가 발생했습니다.')
        return
      }
      res.destroy(err)
    })
    stream.pipe(res)
  } catch (err) {
    next(err)
  }
})

// 외부 링크 HTML Preview 이미지 생성
// GET /api/files/link-preview-image?url=...&width=480&height=270
router.get('/link-preview-image', async (req, res) => {
  try {
    const targetUrl = normalizePreviewUrl(req.query.url)
    const cfg = readConfigSafe()
    const cfgWidth = Number(cfg?.htmlPreview?.width) || 480
    const cfgHeight = Number(cfg?.htmlPreview?.height) || 270
    const width = Math.max(120, Math.min(1920, Number(req.query.width) || cfgWidth))
    const height = Math.max(90, Math.min(1080, Number(req.query.height) || cfgHeight))

    const key = crypto
      .createHash('sha1')
      .update(`${LINK_PREVIEW_CACHE_VERSION}|${targetUrl}|${width}x${height}`)
      .digest('hex')
    const imgPath = path.join(LINK_PREVIEW_BASE, `${key}.img`)
    const typePath = path.join(LINK_PREVIEW_BASE, `${key}.type`)
    const tmpPath = path.join(LINK_PREVIEW_BASE, `${key}.${Date.now()}.tmp.img`)

    const maxAgeMs = 1000 * 60 * 30 // 30분 캐시
    if (fs.existsSync(imgPath)) {
      const ageMs = Date.now() - fs.statSync(imgPath).mtimeMs
      if (ageMs < maxAgeMs) {
        const contentType = fs.existsSync(typePath) ? (fs.readFileSync(typePath, 'utf8') || 'image/png') : 'image/png'
        res.setHeader('Content-Type', contentType)
        res.setHeader('Cache-Control', 'private, max-age=300')
        return fs.createReadStream(imgPath).pipe(res)
      }
    }

    try {
      const metaImg = await withTimeout(fetchMetaPreviewImage(targetUrl), 15000, 'meta preview timeout')
      fs.writeFileSync(tmpPath, metaImg.bytes)
      fs.writeFileSync(typePath, metaImg.contentType)
    } catch (metaErr) {
      console.warn('[link-preview-image] meta image failed, fallback screenshot:', metaErr?.message || metaErr)
      try {
        await withTimeout(generateLinkPreviewImage(targetUrl, tmpPath, width, height), 18000, 'local screenshot timeout')
      } catch (primaryErr) {
        // 로컬 렌더 실패 시 원격 스크린샷 fallback 시도
        console.warn('[link-preview-image] local render failed, try remote fallback:', primaryErr?.message || primaryErr)
        try {
          await withTimeout(downloadRemotePreviewFallback(targetUrl, tmpPath, width, height), 12000, 'remote fallback timeout')
        } catch (remoteErr) {
          console.warn('[link-preview-image] remote fallback failed, placeholder:', remoteErr?.message || remoteErr)
          const host = (() => { try { return new URL(targetUrl).host } catch { return '' } })()
          writePlaceholderPng(tmpPath, width, height, host)
          fs.writeFileSync(typePath, 'image/svg+xml')
        }
      }
      if (!fs.existsSync(typePath)) {
        fs.writeFileSync(typePath, 'image/png')
      }
    }
    fs.renameSync(tmpPath, imgPath)
    const contentType = fs.existsSync(typePath) ? (fs.readFileSync(typePath, 'utf8') || 'image/png') : 'image/png'
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'private, max-age=300')
    return fs.createReadStream(imgPath).pipe(res)
  } catch (err) {
    console.error('[link-preview-image]', err?.message || err)
    return res.status(502).json({ error: '링크 미리보기를 생성하지 못했습니다.' })
  }
})

/**
 * 단계 1 & 2: Mock Presigned URL 생성 (Download)
 * GET /api/files/:id/get-download-url
 */
router.get('/:id/get-download-url', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    let file
    
    if (isConnected()) {
      const res = await client.execute('SELECT * FROM attachments WHERE id = ?', [id], { prepare: true })
      if (res.rowCount > 0) file = res.rows[0]
    }
    
    if (!file) {
      const result = await db.query('SELECT * FROM attachments WHERE id = $1', [id])
      if (result.rowCount > 0) file = result.rows[0]
    }

    if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' })
    
    const token = jwt.sign({
      file_uuid: id,
      key: file.storage_path,
      action: 'READ',
      user_id: req.user.id
    }, JWT_SECRET, { expiresIn: '30m' })

    // Return relative URL so browser/dev-proxy origin mismatches do not break download.
    const downloadUrl = `/api/files/gateway/download?token=${token}`
    
    res.json({ downloadUrl })
  } catch (err) {
    next(err)
  }
})

/**
 * Gateway: Upload Handler
 * PUT /api/files/gateway/upload?token=...
 */
router.put('/gateway/upload', async (req, res) => {
  const { token } = req.query
  if (!token) return res.status(401).send('Token required')

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (decoded.action !== 'WRITE') return res.status(403).send('Invalid action')

    const fullPath = path.join(STORAGE_BASE, decoded.key)
    const dirPath = path.dirname(fullPath)
    
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }

    const fileStream = fs.createWriteStream(fullPath)
    let totalSize = 0

    req.on('data', (chunk) => {
      totalSize += chunk.length
    })

    req.pipe(fileStream)

    fileStream.on('finish', async () => {
      // Update record in Cassandra
      if (isConnected()) {
        await client.execute(`
          UPDATE attachments SET status = 'COMPLETED', size = ? WHERE id = ?
        `, [totalSize, decoded.file_uuid], { prepare: true })
      }

      // Update record in PostgreSQL
      await db.query(`
        UPDATE attachments
        SET status = 'COMPLETED', size = $1, created_at = NOW()
        WHERE id = $2
      `, [totalSize, decoded.file_uuid])

      // ─── 썸네일 생성 (macOS + Ubuntu) ─────────────────────────
      const isThumbTarget = /\.(pdf|pptx|ppt|docx|doc|xlsx|xls|mp4|mov|avi|mkv|webm)$/i.test(decoded.key)
      if (isThumbTarget) {
        const thumbRelPath = await generateThumbnail(decoded.file_uuid, fullPath)
        if (thumbRelPath) {
          try {
            if (isConnected()) {
              await client.execute(
                'UPDATE attachments SET thumbnail_path = ? WHERE id = ?',
                [thumbRelPath, decoded.file_uuid], { prepare: true }
              )
            }
            await db.query(
              'UPDATE attachments SET thumbnail_path = $1 WHERE id = $2',
              [thumbRelPath, decoded.file_uuid]
            )
          } catch (e) {
            console.error('[Thumbnail] DB update failed:', e)
          }
        }
      }

      res.status(200).send('Upload successful')
    })

    fileStream.on('error', (err) => {
      console.error('File Stream Error:', err)
      res.status(500).send('File saving error')
    })

  } catch (err) {
    return res.status(401).send('Invalid or expired token')
  }
})

/**
 * Gateway: Download Handler
 * GET /api/files/gateway/download?token=...
 */
router.get('/gateway/download', async (req, res) => {
  const { token } = req.query
  if (!token) return res.status(401).send('Token required')

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (decoded.action !== 'READ') return res.status(403).send('Invalid action')

    const fullPath = path.join(STORAGE_BASE, decoded.key)
    if (!fs.existsSync(fullPath)) return res.status(404).send('File not found on disk')

    // DS.005: use original filename stored at upload time
    let originalName
    if (isConnected()) {
      const res = await client.execute('SELECT filename FROM attachments WHERE id = ?', [decoded.file_uuid], { prepare: true })
      if (res.rowCount > 0) originalName = res.rows[0].filename
    }

    if (!originalName) {
      const fileRow = await db.query('SELECT filename FROM attachments WHERE id = $1', [decoded.file_uuid])
      originalName = fileRow.rows[0]?.filename || path.basename(fullPath)
    }

    const stat = fs.statSync(fullPath)
    setAttachmentHeaders(res, originalName, 'application/octet-stream', stat.size)

    const fileStream = fs.createReadStream(fullPath)
    fileStream.on('error', (err) => {
      console.error('[files/download] stream error:', err)
      if (!res.headersSent) {
        res.status(500).send('파일 다운로드 중 오류가 발생했습니다.')
        return
      }
      res.destroy(err)
    })
    fileStream.pipe(res)

  } catch (err) {
    return res.status(401).send('Invalid or expired token')
  }
})

/**
 * 파일을 OS 연결 앱으로 열기
 * POST /api/files/:id/open
 */
router.post('/:id/open', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params
    const result = await db.query('SELECT * FROM attachments WHERE id = $1', [id])
    if (result.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' })

    const file = result.rows[0]
    const fullPath = path.join(STORAGE_BASE, file.storage_path)

    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '파일이 디스크에 없습니다.' })

    const platform = process.platform
    let cmd
    if (platform === 'darwin')     cmd = `open "${fullPath}"`
    else if (platform === 'linux') cmd = `xdg-open "${fullPath}"`
    else if (platform === 'win32') cmd = `start "" "${fullPath}"`
    else return res.status(400).json({ error: '지원하지 않는 OS입니다.' })

    exec(cmd, (err) => {
      if (err) {
        console.error('[Open] 파일 열기 실패:', err)
        return res.status(500).json({ error: '파일 열기에 실패했습니다.' })
      }
      res.json({ success: true })
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
