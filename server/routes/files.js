const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const path = require('path')
const fs = require('fs')
const { v4: uuidv4 } = require('uuid')
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
    const fullPath = path.join(STORAGE_BASE, file.storage_path)
    if (!fs.existsSync(fullPath)) return res.status(404).send('파일을 찾을 수 없습니다.')

    const contentType = file.content_type || 'application/octet-stream'
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
