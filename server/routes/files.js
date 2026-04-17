const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const path = require('path')
const fs = require('fs')
const { v4: uuidv4 } = require('uuid')
const { exec } = require('child_process')
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

    // 썸네일 요청 처리
    if (req.query.thumbnail === 'true' && file.thumbnail_path) {
      const thumbPath = path.join(STORAGE_BASE, file.thumbnail_path)
      if (fs.existsSync(thumbPath)) {
        fullPath = thumbPath
        contentType = 'image/png' // qlmanage outputs png
      }
    }

    if (!fs.existsSync(fullPath)) return res.status(404).send('파일을 찾을 수 없습니다.')

    res.setHeader('Content-Type', contentType)
    if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`)
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

      // ─── 썸네일 생성 (응답 전에 완료 대기) ───────────────────
      const isThumbTarget = /\.(pdf|pptx|ppt|docx|doc|xlsx|xls|mp4|mov|avi|mkv|webm)$/i.test(decoded.key)
      const canGenerateThumbnail = process.platform === 'darwin'

      if (isThumbTarget && canGenerateThumbnail) {
        const logFile = path.join(STORAGE_BASE, 'thumbnail_debug.log')
        const cmd = `qlmanage -t -s 512 -o "${THUMBNAIL_BASE}" "${fullPath}"`
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] Generating for ${decoded.file_uuid}: ${cmd}\n`)

        await new Promise((resolve) => {
          exec(cmd, async (err, _stdout, stderr) => {
            if (err) {
              fs.appendFileSync(logFile, `[${new Date().toISOString()}] Error: ${err.message}\nStderr: ${stderr}\n`)
              console.error('[Thumbnail] Generation failed:', err)
              return resolve()  // 실패해도 업로드는 성공 처리
            }

            const originalBase = path.basename(fullPath)
            const generatedPath = path.join(THUMBNAIL_BASE, originalBase + '.png')
            const uniqueThumbName = `${decoded.file_uuid}.png`
            const finalThumbPath = path.join(THUMBNAIL_BASE, uniqueThumbName)

            if (fs.existsSync(generatedPath)) {
              try {
                fs.renameSync(generatedPath, finalThumbPath)
                const thumbRelPath = path.join('thumbnails', uniqueThumbName)
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
                fs.appendFileSync(logFile, `[${new Date().toISOString()}] Success: ${thumbRelPath}\n`)
              } catch (e) {
                console.error('[Thumbnail] DB update failed:', e)
              }
            } else {
              fs.appendFileSync(logFile, `[${new Date().toISOString()}] Generated file not found: ${generatedPath}\n`)
            }
            resolve()
          })
        })
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
