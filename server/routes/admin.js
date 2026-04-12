const express = require('express')
const router = express.Router()
const pool = require('../db')
const requireAuth = require('../middleware/auth')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const { runManualTraining, reloadRagConfig, getState: getRagState } = require('../rag')

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
    
    const configPath = path.resolve(__dirname, '../../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const uploadPath = config['ObjectFile Path'] || path.resolve(__dirname, '../uploads')
    const cassandraPath = config['Cassandra Database Path'] || '/Users/kevinim/Desktop/EasyDocStation/Database/CassandraDB'
    const lancedbPath = config['lancedb Database Path'] || '/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB'

    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true })
    }

    if (!fs.existsSync(cassandraPath)) {
      fs.mkdirSync(cassandraPath, { recursive: true })
    }

    if (!fs.existsSync(lancedbPath)) {
      fs.mkdirSync(lancedbPath, { recursive: true })
    }

    const uploadSizeBytes = getDirSize(uploadPath)
    const cassandraSizeBytes = getDirSize(cassandraPath)
    const lancedbSizeBytes = getDirSize(lancedbPath)

    res.json({
      db: {
        location: dbLocation,
        size: dbSizeResult.rows[0].size,
      },
      cassandra: {
        location: cassandraPath,
        size: formatBytes(cassandraSizeBytes),
      },
      objects: {
        location: uploadPath,
        size: formatBytes(uploadSizeBytes),
      },
      lancedb: {
        location: lancedbPath,
        size: formatBytes(lancedbSizeBytes),
      },
      display: config.imagePreview || { width: 512, height: 512 },
      rag: config.rag || { trainingType: 'manual', dailyTime: '02:00', vectorSize: 1024 },
      agenticai: config.agenticai || { num_predict: 4096, num_ctx: 8192 }
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

// GET /api/admin/rag/status — 현재 RAG 상태 조회
router.get('/rag/status', async (req, res) => {
  res.json(getRagState())
})

// POST /api/admin/rag/train — 수동 학습 시작
router.post('/rag/train', async (req, res) => {
  try {
    // 비동기로 학습 시작 (완료 대기 없이 즉시 응답)
    runManualTraining().catch(e => console.error('[RAG] 수동 학습 오류:', e.message))
    res.json({ success: true, message: '학습이 시작되었습니다.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/rag/reload — 설정 변경 후 스케줄러 재적용
router.post('/rag/reload', async (req, res) => {
  try {
    reloadRagConfig()
    res.json({ success: true, state: getRagState() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/rag/reinit-lancedb — vector size 변경 후 LanceDB 테이블 재초기화
router.post('/rag/reinit-lancedb', async (req, res) => {
  try {
    const configPath = path.resolve(__dirname, '../../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const uri = config['lancedb Database Path'] || '/Users/kevinim/Desktop/EasyDocStation/Database/LanceDB'
    const dim = config.rag?.vectorSize || 1024

    const script = `
import lancedb
db = lancedb.connect(${JSON.stringify(uri)})
data = [{"vector": [0.1] * ${dim}, "text": "init", "metadata": {"source": "system"}}]
table = db.create_table("my_rag_table", data=data, mode="overwrite")
print(f"벡터 크기 ${dim}으로 재설정 완료: {table.count_rows()}건")
`
    execFile('python3', ['-c', script], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[LanceDB reinit error]', stderr)
        return res.status(500).json({ error: 'LanceDB 재초기화 실패: ' + (stderr || err.message) })
      }
      console.log('[LanceDB reinit]', stdout.trim())
      res.json({ success: true, message: stdout.trim() })
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
