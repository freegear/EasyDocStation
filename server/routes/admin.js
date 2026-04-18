const express = require('express')
const router = express.Router()
const pool = require('../db')
const requireAuth = require('../middleware/auth')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const bcrypt = require('bcryptjs')
const { client: cassandraClient } = require('../cassandra')
const { runManualTraining, reloadRagConfig, getState: getRagState } = require('../rag')
const { getDatabasePath, resolveAppBasePath } = require('../databasePaths')
const { getPostgresDatabaseName } = require('../runtimeDbConfig')
const { getPythonExecutable } = require('../pythonRuntime')

// ... (existing code helpers)

// POST /api/admin/reset — Full Site Reset
router.post('/reset', async (req, res) => {
  const { confirmation } = req.body
  if (confirmation !== '초기화를 해줘') {
    return res.status(400).json({ error: '초기화 문구가 정확하지 않습니다.' })
  }

  try {
    // 1. PostgreSQL Clean
    // Tables order to avoid FK issues: 
    // comments, attachments, posts, team_members, channel_members, channels, teams, users (except siteadmin)
    await pool.query('BEGIN')
    
    // Clear transactional data
    await pool.query('DELETE FROM comments')
    await pool.query('DELETE FROM attachments')
    await pool.query('DELETE FROM posts')
    await pool.query('DELETE FROM team_members')
    await pool.query('DELETE FROM channel_members')
    await pool.query('DELETE FROM channels')
    await pool.query('DELETE FROM teams')
    
    // Manage siteadmin user
    const adminPasswordHash = await bcrypt.hash('siteadmin1234', 10)
    
    // Delete all users except siteadmin
    await pool.query("DELETE FROM users WHERE username != 'siteadmin'")
    
    // Upsert siteadmin
    const siteAdminCheck = await pool.query("SELECT id FROM users WHERE username = 'siteadmin'")
    if (siteAdminCheck.rowCount > 0) {
      await pool.query(
        "UPDATE users SET password_hash = $1, role = 'site_admin', is_active = true WHERE username = 'siteadmin'",
        [adminPasswordHash]
      )
    } else {
      await pool.query(
        "INSERT INTO users (username, name, email, password_hash, role, is_active) VALUES ($1, $2, $3, $4, $5, $6)",
        ['siteadmin', 'Site Admin', 'admin@example.com', adminPasswordHash, 'site_admin', true]
      )
    }
    
    await pool.query('COMMIT')

    // 2. Cassandra Clean
    const { isConnected: isCassandraConnected } = require('../cassandra')
    if (isCassandraConnected()) {
      try {
        await cassandraClient.execute('TRUNCATE posts')
        await cassandraClient.execute('TRUNCATE comments')
      } catch (e) {
        console.error('Cassandra clear error:', e.message)
      }
    }

    // 3. Storage & DB Folders Clean
    const configPath = path.resolve(__dirname, '../../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    
    const deleteFolderContents = (folder) => {
      if (fs.existsSync(folder)) {
        fs.readdirSync(folder).forEach((file) => {
          const curPath = path.join(folder, file)
          if (fs.lstatSync(curPath).isDirectory()) {
            deleteFolderContents(curPath)
            fs.rmdirSync(curPath)
          } else {
            fs.unlinkSync(curPath)
          }
        })
      }
    }
    
    // Clear ObjectFile
    const uploadPath = getDatabasePath(config, 'ObjectFile Path')
    deleteFolderContents(uploadPath)
    
    // Clear LanceDB
    const lancedbPath = getDatabasePath(config, 'lancedb Database Path')
    deleteFolderContents(lancedbPath)

    res.json({ success: true, message: '사이트가 초기화되었습니다. 다시 로그인해 주세요.' })
  } catch (err) {
    await pool.query('ROLLBACK')
    console.error('Reset Error:', err)
    res.status(500).json({ error: '초기화 작업 중 오류가 발생했습니다: ' + err.message })
  }
})

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

function normalizeDirectMessageConfig(dm = {}) {
  const unlimited = Boolean(dm['무제한보관'])
  const parsedDays = Number.parseInt(dm['보존 기한'], 10)
  const retentionDays = Number.isFinite(parsedDays)
    ? Math.min(90, Math.max(1, parsedDays))
    : 30
  return {
    '보존 기한': retentionDays,
    '무제한보관': unlimited
  }
}

function normalizeSnsConfig(sns = {}) {
  return {
    kakao: {
      enabled: Boolean(sns.kakao?.enabled),
      apiKey: typeof sns.kakao?.apiKey === 'string' ? sns.kakao.apiKey : '',
    },
    line: {
      enabled: Boolean(sns.line?.enabled),
      channelAccessToken: typeof sns.line?.channelAccessToken === 'string' ? sns.line.channelAccessToken : '',
    },
    telegram: {
      enabled: Boolean(sns.telegram?.enabled),
      botName: typeof sns.telegram?.botName === 'string' ? sns.telegram.botName : '',
      botUserName: typeof sns.telegram?.botUserName === 'string'
        ? sns.telegram.botUserName
        : (typeof sns.telegram?.botId === 'string' ? sns.telegram.botId : ''),
      httpApiToken: typeof sns.telegram?.httpApiToken === 'string' ? sns.telegram.httpApiToken : '',
    },
  }
}

function normalizeAgenticAiConfig(ai = {}) {
  const language = ['ko', 'ja', 'en', 'zh'].includes(ai?.language) ? ai.language : 'ko'
  return {
    num_predict: Number.isFinite(Number(ai?.num_predict)) ? Number(ai.num_predict) : 4096,
    num_ctx: Number.isFinite(Number(ai?.num_ctx)) ? Number(ai.num_ctx) : 8192,
    history: Number.isFinite(Number(ai?.history)) ? Number(ai.history) : 6,
    language,
  }
}

function getDatabasePathConfig(config = {}) {
  return {
    easyDocStationFolder: resolveAppBasePath(config),
    postgresqlPath: config['PostgreSQL Database Path'] || 'Database/PoseSQLDB',
    cassandraPath: config['Cassandra Database Path'] || 'Database/CassandraDB',
    objectFilePath: config['ObjectFile Path'] || 'Database/ObjectFile',
    lancedbPath: config['lancedb Database Path'] || 'Database/LanceDB',
  }
}

function buildDisplayConfig(config = {}) {
  return {
    imagePreview: config.imagePreview || { width: 512, height: 512 },
    pptPreview: config.pptPreview || { width: 480, height: 270 },
    pptxPreview: config.pptxPreview || { width: 480, height: 270 },
    excelPreview: config.excelPreview || { width: 480, height: 270 },
    wordPreview: config.wordPreview || { width: 270, height: 480 },
    moviePreview: config.moviePreview || { width: 480, height: 270 },
    htmlPreview: config.htmlPreview || { width: 480, height: 270 }
  }
}

async function getDbLocationSafe() {
  try {
    const dbLocResult = await pool.query("SHOW data_directory")
    let dbLocation = dbLocResult.rows[0]?.data_directory || 'N/A'
    try {
      dbLocation = fs.realpathSync(dbLocation)
    } catch (_) {}
    return dbLocation
  } catch (e) {
    if (e && e.code === '42501') {
      return '권한 필요 (pg_read_all_settings)'
    }
    return 'N/A'
  }
}

router.get('/stats', async (req, res) => {
  try {
    // 1. PostgreSQL DB Stats
    const dbName = getPostgresDatabaseName()
    const dbSizeResult = await pool.query('SELECT pg_size_pretty(pg_database_size($1)) as size', [dbName])
    const dbLocation = await getDbLocationSafe()
    
    const configPath = path.resolve(__dirname, '../../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const uploadPath = getDatabasePath(config, 'ObjectFile Path')
    const cassandraPath = getDatabasePath(config, 'Cassandra Database Path')
    const lancedbPath = getDatabasePath(config, 'lancedb Database Path')

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
      pathConfig: getDatabasePathConfig(config),
      display: buildDisplayConfig(config),
      rag: config.rag || { trainingType: 'manual', dailyTime: '02:00', vectorSize: 1024 },
      agenticai: normalizeAgenticAiConfig(config.agenticai || {}),
      maxAttachmentFileSize: config.MaxAttachmentFileSize ?? 100,
      DirectMessage: normalizeDirectMessageConfig(config.DirectMessage || {}),
      company: config.company || {},
      sns: normalizeSnsConfig(config.sns || {})
    })
  } catch (err) {
    console.error('Admin Stats Error:', err)
    try {
      const dbSizeResult = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) as size')
      const dbLocation = await getDbLocationSafe()
        
      const configPath = path.resolve(__dirname, '../../config.json')
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      const uploadPath = getDatabasePath(config, 'ObjectFile Path')
      const cassandraPath = getDatabasePath(config, 'Cassandra Database Path')
      const lancedbPath = getDatabasePath(config, 'lancedb Database Path')
      
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
        pathConfig: getDatabasePathConfig(config),
        display: buildDisplayConfig(config),
        rag: config.rag || { trainingType: 'manual', dailyTime: '02:00', vectorSize: 1024 },
        agenticai: normalizeAgenticAiConfig(config.agenticai || {}),
        maxAttachmentFileSize: config.MaxAttachmentFileSize ?? 100,
        DirectMessage: normalizeDirectMessageConfig(config.DirectMessage || {}),
        company: config.company || {},
        sns: normalizeSnsConfig(config.sns || {})
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
    if (Object.prototype.hasOwnProperty.call(newConfig, 'agenticai')) {
      newConfig.agenticai = normalizeAgenticAiConfig(newConfig.agenticai || {})
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
    const uri = getDatabasePath(config, 'lancedb Database Path')
    const dim = config.rag?.vectorSize || 1024

    const script = `
import lancedb
db = lancedb.connect(${JSON.stringify(uri)})
data = [{"vector": [0.1] * ${dim}, "text": "init", "metadata": {"source": "system"}}]
table = db.create_table("my_rag_table", data=data, mode="overwrite")
print(f"벡터 크기 ${dim}으로 재설정 완료: {table.count_rows()}건")
`
    execFile(getPythonExecutable(), ['-c', script], { timeout: 30000 }, (err, stdout, stderr) => {
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
