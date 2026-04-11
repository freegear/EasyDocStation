const express = require('express')
const router = express.Router()
const pool = require('../db')
const requireAuth = require('../middleware/auth')
const path = require('path')
const fs = require('fs')

// Check if user is site_admin
function requireSiteAdmin(req, res, next) {
  if (req.user.role !== 'site_admin') {
    return res.status(403).json({ error: '사이트 관리자 권한이 필요합니다.' })
  }
  next()
}

router.use(requireAuth)
router.use(requireSiteAdmin)

// Helper to get directory size recursively
function getDirSize(dirPath) {
  let size = 0
  try {
    const files = fs.readdirSync(dirPath)
    for (const file of files) {
      const fullPath = path.join(dirPath, file)
      const stats = fs.statSync(fullPath)
      if (stats.isFile()) {
        size += stats.size
      } else if (stats.isDirectory()) {
        size += getDirSize(fullPath)
      }
    }
  } catch (e) {
    console.error(`Error calculating size for ${dirPath}:`, e.message)
  }
  return size
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

router.get('/stats', async (req, res) => {
  try {
    // 1. PostgreSQL DB Stats
    // Get database name from connection string or default
    const dbName = 'easydocstation'
    const dbSizeResult = await pool.query('SELECT pg_size_pretty(pg_database_size($1)) as size', [dbName])
    const dbLocResult = await pool.query("SHOW data_directory")
    
    // Resolve symlink to show real physical path in UI
    let dbLocation = dbLocResult.rows[0].data_directory
    try {
      dbLocation = fs.realpathSync(dbLocation)
    } catch (e) {
      console.warn('Failed to resolve DB symlink:', e)
    }
    
    // 2. Object File Stats (Use path from config.json)
    const configPath = path.resolve(__dirname, '../../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const uploadPath = config['ObjectFile Path'] || path.resolve(__dirname, '../uploads')
    
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true })
    }
    const uploadSizeBytes = getDirSize(uploadPath)
    
    res.json({
      db: {
        location: dbLocation,
        size: dbSizeResult.rows[0].size,
      },
      objects: {
        location: uploadPath,
        size: formatBytes(uploadSizeBytes),
      },
      display: config.imagePreview || { width: 512, height: 512 }
    })
  } catch (err) {
    console.error('Admin Stats Error:', err)
    try {
      const dbSizeResult = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) as size')
      const dbLocResult = await pool.query("SHOW data_directory")
      
      let dbLocation = dbLocResult.rows[0].data_directory
      try {
        dbLocation = fs.realpathSync(dbLocation)
      } catch (e) {}
        
      const configPath = path.resolve(__dirname, '../../config.json')
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      const uploadPath = config['ObjectFile Path'] || path.resolve(__dirname, '../uploads')
      
      const uploadSizeBytes = getDirSize(uploadPath)
      
      res.json({
        db: {
          location: dbLocation,
          size: dbSizeResult.rows[0].size,
        },
        objects: {
          location: uploadPath,
          size: formatBytes(uploadSizeBytes),
        },
        display: config.imagePreview || { width: 512, height: 512 }
      })
    } catch (innerErr) {
      res.status(500).json({ error: 'DB 정보를 가져오는 중 오류가 발생했습니다.' })
    }
  }
})

// PUT /api/admin/config — update system configuration (config.json)
router.put('/config', requireSiteAdmin, async (req, res) => {
  try {
    const configPath = path.resolve(__dirname, '../../config.json')
    const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    
    // Merge new config
    const newConfig = {
      ...currentConfig,
      ...req.body
    }
    
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8')
    res.json({ success: true, config: newConfig })
  } catch (err) {
    console.error('Save Config Error:', err)
    res.status(500).json({ error: '설정을 저장하는 중 오류가 발생했습니다.' })
  }
})

module.exports = router
