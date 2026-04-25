const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const path = require('path')
const fs = require('fs')
const { v4: uuidv4 } = require('uuid')
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
  try {
    if (fs.existsSync(previewPdfPath)) {
      const sourceMtime = fs.statSync(fullPath).mtimeMs
      const previewMtime = fs.statSync(previewPdfPath).mtimeMs
      if (previewMtime >= sourceMtime) return previewPdfPath
    }

    const tmpDir = fs.mkdtempSync(path.join(PREVIEW_BASE, 'tmp-'))
    try {
      const sourcePdf = await convertWithLibreOfficeToPdf(fullPath, tmpDir)
      fs.copyFileSync(sourcePdf, previewPdfPath)
      return previewPdfPath
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  } catch (err) {
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
    const file_uuid = uuidv4()

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

    res.setHeader('Content-Type', contentType)
    if (!req.query.preview && !contentType.startsWith('image/') && !contentType.startsWith('video/')) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`)
    } else if (!req.query.preview && (originalExt === '.ppt' || originalExt === '.pptx')) {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`)
    }
    fs.createReadStream(fullPath).pipe(res)
  } catch (err) {
    next(err)
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

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`)

    const fileStream = fs.createReadStream(fullPath)
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
