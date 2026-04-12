const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const path = require('path')
const fs = require('fs')
const { v4: uuidv4 } = require('uuid')
const { exec } = require('child_process')
const db = require('../db')
const requireAuth = require('../middleware/auth')

// Load config for storage path
const configPath = path.join(__dirname, '../../config.json')
let config = {}
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (e) {
  console.error('Failed to load config.json for File Service')
}

const STORAGE_BASE = config['ObjectFile Path'] || path.join(__dirname, '../../Database/ObjectFile')
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
    const { filename, contentType, channelName } = req.body
    const file_uuid = uuidv4()
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) // YYYYMMDDHHMMSS
    
    // Rule: ~ObjectFile/ChannelName/YYYYMMDDHHMMSS/filename
    const relativeDir = path.join(channelName || 'general', timestamp)
    const key = path.join(relativeDir, filename)

    // Create record in DB (PENDING)
    // Note: Assuming attachments table has (id, filename, content_type, size, status, storage_path, created_at)
    await db.query(`
      INSERT INTO attachments (id, filename, content_type, size, status, storage_path)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [file_uuid, filename, contentType, 0, 'PENDING', key])

    // Generate Mask Presigned URL with Token
    const token = jwt.sign({
      file_uuid,
      key,
      action: 'WRITE',
      user_id: req.user.id
    }, JWT_SECRET, { expiresIn: '15m' })

    const host = req.get('host')
    const protocol = req.protocol
    const uploadUrl = `${protocol}://${host}/api/files/gateway/upload?token=${token}`
    
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
    const result = await db.query('SELECT * FROM attachments WHERE id = $1', [id])
    if (result.rowCount === 0) return res.status(404).send('파일을 찾을 수 없습니다.')

    const file = result.rows[0]
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
    const result = await db.query('SELECT * FROM attachments WHERE id = $1', [id])
    if (result.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' })
    
    const file = result.rows[0]
    
    const token = jwt.sign({
      file_uuid: id,
      key: file.storage_path,
      action: 'READ',
      user_id: req.user.id
    }, JWT_SECRET, { expiresIn: '30m' })

    const downloadUrl = `http://localhost:${process.env.PORT || 3001}/api/files/gateway/download?token=${token}`
    
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
      // Update record to COMPLETED
      await db.query(`
        UPDATE attachments 
        SET status = 'COMPLETED', size = $1, created_at = NOW() 
        WHERE id = $2
      `, [totalSize, decoded.file_uuid])
      
      // ─── 썸네일 생성 로직 추가 (영상이거나 문서인 경우) ──────────
      const isThumbTarget = /\.(pdf|pptx|ppt|docx|doc|xlsx|xls|mp4|mov|avi|mkv|webm)$/i.test(decoded.key)
      
      if (isThumbTarget) {
        try {
            // qlmanage -t -s 512 -o <THUMBNAIL_BASE> <fullPath>
            // qlmanage는 <파일명>.png 형태로 파일을 만듦
            const cmd = `qlmanage -t -s 512 -o "${THUMBNAIL_BASE}" "${fullPath}"`
            
            // 디버그 로그용
            const logFile = path.join(STORAGE_BASE, 'thumbnail_debug.log')
            fs.appendFileSync(logFile, `[${new Date().toISOString()}] Generating for ${decoded.file_uuid}: ${cmd}\n`)

            exec(cmd, async (err, stdout, stderr) => {
              if (err) {
                fs.appendFileSync(logFile, `[${new Date().toISOString()}] Error: ${err.message}\nStderr: ${stderr}\n`)
                console.error('[Thumbnail] Generation failed:', err)
                return
              }
              
              const originalBase = path.basename(fullPath)
              const generatedPath = path.join(THUMBNAIL_BASE, originalBase + '.png')
              const uniqueThumbName = `${decoded.file_uuid}.png`
              const finalThumbPath = path.join(THUMBNAIL_BASE, uniqueThumbName)

              // qlmanage가 생성한 파일을 UUID 기반의 고유 이름으로 변경
              if (fs.existsSync(generatedPath)) {
                fs.renameSync(generatedPath, finalThumbPath)
                const thumbRelPath = path.join('thumbnails', uniqueThumbName)
                
                await db.query(`
                  UPDATE attachments SET thumbnail_path = $1 WHERE id = $2
                `, [thumbRelPath, decoded.file_uuid])
                fs.appendFileSync(logFile, `[${new Date().toISOString()}] Success: ${thumbRelPath}\n`)
              } else {
                fs.appendFileSync(logFile, `[${new Date().toISOString()}] Generated file not found: ${generatedPath}\n`)
              }
            })
        } catch (e) {
          console.error('[Thumbnail] Error:', e)
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

    const filename = path.basename(fullPath)
    
    // Set proper headers
    // Using a simple content-type check or just generic stream
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
    
    const fileStream = fs.createReadStream(fullPath)
    fileStream.pipe(res)

  } catch (err) {
    return res.status(401).send('Invalid or expired token')
  }
})

module.exports = router
