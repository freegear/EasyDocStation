const express = require('express')
const router = express.Router()
const pool = require('../db')
const requireAuth = require('../middleware/auth')
const path = require('path')
const fs = require('fs')
const { execFile, spawn } = require('child_process')
const bcrypt = require('bcryptjs')
const { client: cassandraClient } = require('../cassandra')
const { runManualTraining, reloadRagConfig, getState: getRagState } = require('../rag')
const ragRouter = require('./rag')
const { getDatabasePath, resolveAppBasePath } = require('../databasePaths')
const { getPostgresDatabaseName } = require('../runtimeDbConfig')
const { getPythonExecutable } = require('../pythonRuntime')

// ... (existing code helpers)

// Check if user is site_admin
function requireSiteAdmin(req, res, next) {
  if (req.user.role !== 'site_admin') {
    return res.status(403).json({ error: '사이트 관리자 권한이 필요합니다.' })
  }
  next()
}

function syncSupabaseEnvFromConfig(config) {
  const envPath = path.resolve(__dirname, '../.env')
  const serverSupabaseUrl = String(config.SUPABASE_URL || '').trim()
  const serverSupabaseAudience = String(config.SUPABASE_JWT_AUDIENCE || 'authenticated').trim()
  const jwtSecret = String(config.JWT_SECRET || '').trim()
  const clientOrigin = String(config.CLIENT_ORIGIN || 'http://218.237.25.214:5173').trim()
  const authCookieSecure = String(config.AUTH_COOKIE_SECURE || 'false').trim().toLowerCase() === 'true' ? 'true' : 'false'
  const supabaseUrl = String(config.VITE_SUPABASE_URL || '').trim()
  const supabaseAnonKey = String(config.VITE_SUPABASE_ANON_KEY || '').trim()

  let envText = ''
  if (fs.existsSync(envPath)) {
    envText = fs.readFileSync(envPath, 'utf8')
  }

  const upsertLine = (source, key, value) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`^${escaped}=.*$`, 'm')
    const line = `${key}=${value}`
    if (regex.test(source)) return source.replace(regex, line)
    return source + (source.endsWith('\n') || source.length === 0 ? '' : '\n') + line + '\n'
  }

  let updated = envText
  if (serverSupabaseUrl) updated = upsertLine(updated, 'SUPABASE_URL', serverSupabaseUrl)
  if (serverSupabaseAudience) updated = upsertLine(updated, 'SUPABASE_JWT_AUDIENCE', serverSupabaseAudience)
  if (jwtSecret) updated = upsertLine(updated, 'JWT_SECRET', jwtSecret)
  if (clientOrigin) updated = upsertLine(updated, 'CLIENT_ORIGIN', clientOrigin)
  updated = upsertLine(updated, 'AUTH_COOKIE_SECURE', authCookieSecure)
  if (supabaseUrl) updated = upsertLine(updated, 'VITE_SUPABASE_URL', supabaseUrl)
  if (supabaseAnonKey) updated = upsertLine(updated, 'VITE_SUPABASE_ANON_KEY', supabaseAnonKey)
  fs.writeFileSync(envPath, updated, 'utf8')

  return {
    synced: true,
    path: envPath,
    hasUrl: Boolean(supabaseUrl),
    hasAnonKey: Boolean(supabaseAnonKey),
  }
}

function parseEnvTextToMap(envText = '') {
  const map = {}
  String(envText)
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = String(line || '').trim()
      if (!trimmed || trimmed.startsWith('#')) return
      const idx = trimmed.indexOf('=')
      if (idx <= 0) return
      const key = trimmed.slice(0, idx).trim()
      const value = trimmed.slice(idx + 1)
      map[key] = value
    })
  return map
}

function formatBackupTimestamp(d = new Date()) {
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${yy}${mm}${dd}_${hh}${mi}${ss}`
}

function writeSupabaseEnvFromPayload(payload = {}, { backup = false } = {}) {
  const envPath = path.resolve(__dirname, '../.env')
  const envDir = path.dirname(envPath)
  if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true })

  let envText = ''
  if (fs.existsSync(envPath)) {
    envText = fs.readFileSync(envPath, 'utf8')
    if (backup) {
      const backupPath = path.resolve(envDir, `.env_${formatBackupTimestamp(new Date())}`)
      fs.writeFileSync(backupPath, envText, 'utf8')
    }
  }

  const upsertLine = (source, key, value) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`^${escaped}=.*$`, 'm')
    const line = `${key}=${value}`
    if (regex.test(source)) return source.replace(regex, line)
    return source + (source.endsWith('\n') || source.length === 0 ? '' : '\n') + line + '\n'
  }

  const normalized = {
    SUPABASE_URL: String(payload.SUPABASE_URL || '').trim(),
    SUPABASE_JWT_AUDIENCE: String(payload.SUPABASE_JWT_AUDIENCE || 'authenticated').trim() || 'authenticated',
    JWT_SECRET: String(payload.JWT_SECRET || '').trim(),
    CLIENT_ORIGIN: String(payload.CLIENT_ORIGIN || 'http://218.237.25.214:5173').trim(),
    AUTH_COOKIE_SECURE: String(payload.AUTH_COOKIE_SECURE || 'false').trim().toLowerCase() === 'true' ? 'true' : 'false',
    VITE_SUPABASE_URL: String(payload.VITE_SUPABASE_URL || '').trim(),
    VITE_SUPABASE_ANON_KEY: String(payload.VITE_SUPABASE_ANON_KEY || '').trim(),
  }

  let updated = envText
  updated = upsertLine(updated, 'SUPABASE_URL', normalized.SUPABASE_URL)
  updated = upsertLine(updated, 'SUPABASE_JWT_AUDIENCE', normalized.SUPABASE_JWT_AUDIENCE)
  updated = upsertLine(updated, 'JWT_SECRET', normalized.JWT_SECRET)
  updated = upsertLine(updated, 'CLIENT_ORIGIN', normalized.CLIENT_ORIGIN)
  updated = upsertLine(updated, 'AUTH_COOKIE_SECURE', normalized.AUTH_COOKIE_SECURE)
  updated = upsertLine(updated, 'VITE_SUPABASE_URL', normalized.VITE_SUPABASE_URL)
  updated = upsertLine(updated, 'VITE_SUPABASE_ANON_KEY', normalized.VITE_SUPABASE_ANON_KEY)
  fs.writeFileSync(envPath, updated, 'utf8')

  return {
    synced: true,
    path: envPath,
    backupCreated: backup && fs.existsSync(envPath),
  }
}

function readSupabaseEnvSnapshot() {
  const envPath = path.resolve(__dirname, '../.env')
  let envText = ''
  if (fs.existsSync(envPath)) envText = fs.readFileSync(envPath, 'utf8')
  const map = parseEnvTextToMap(envText)
  return {
    supabase_url: map.SUPABASE_URL || '',
    supabase_jwt_audience: map.SUPABASE_JWT_AUDIENCE || 'authenticated',
    jwt_secret: map.JWT_SECRET || '',
    client_origin: map.CLIENT_ORIGIN || 'http://218.237.25.214:5173',
    auth_cookie_secure: String(map.AUTH_COOKIE_SECURE ?? 'false'),
    vite_supabase_url: map.VITE_SUPABASE_URL || '',
    vite_supabase_anon_key: map.VITE_SUPABASE_ANON_KEY || '',
  }
}

// Apply auth/authorization BEFORE declaring admin routes
router.use(requireAuth)
router.use(requireSiteAdmin)

// POST /api/admin/reset — Full Site Reset
router.post('/reset', async (req, res) => {
  const { confirmation } = req.body
  if (confirmation !== '초기화를 해줘') {
    return res.status(400).json({ error: '초기화 문구가 정확하지 않습니다.' })
  }

  const deleteFolderContents = (folder) => {
    if (!fs.existsSync(folder)) return
    fs.readdirSync(folder).forEach((file) => {
      const curPath = path.join(folder, file)
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteFolderContents(curPath)
        try { fs.rmdirSync(curPath) } catch (_) {}
      } else {
        try { fs.unlinkSync(curPath) } catch (_) {}
      }
    })
  }

  try {
    // ── 1. PostgreSQL 전체 초기화 ──────────────────────────────
    await pool.query('BEGIN')

    // 15.3.5 Direct Message 삭제
    await pool.query('DELETE FROM dm_messages')
    await pool.query('DELETE FROM dm_conversations')

    // 15.3.6 캘린더 이벤트 삭제
    await pool.query('DELETE FROM calendar_invitations')
    await pool.query('DELETE FROM calendar_events')

    // 게시글/댓글/첨부 삭제
    await pool.query('DELETE FROM comments')
    await pool.query('DELETE FROM attachments')
    await pool.query('DELETE FROM posts')

    // 기타 사용자 연결 테이블
    await pool.query('DELETE FROM channel_last_read')
    await pool.query('DELETE FROM login_history')
    await pool.query('DELETE FROM expense_doc_counter')
    await pool.query('DELETE FROM trip_doc_counter')

    // 15.3.3 채널 삭제
    await pool.query('DELETE FROM channel_admins')
    await pool.query('DELETE FROM channel_members')
    await pool.query('DELETE FROM channels')

    // 15.3.2 팀 삭제
    await pool.query('DELETE FROM team_admins')
    await pool.query('DELETE FROM team_members')
    await pool.query('DELETE FROM teams')

    // 15.3.1 사용자 삭제 — kevin@easydocstation.com 제외
    await pool.query("DELETE FROM users WHERE email != 'kevin@easydocstation.com'")

    // 관리자 계정 비밀번호 초기화 (암호: gundam)
    const adminPasswordHash = await bcrypt.hash('gundam', 10)
    const adminCheck = await pool.query("SELECT id FROM users WHERE email = 'kevin@easydocstation.com'")
    if (adminCheck.rowCount > 0) {
      await pool.query(
        "UPDATE users SET password_hash = $1, role = 'site_admin', is_active = true WHERE email = 'kevin@easydocstation.com'",
        [adminPasswordHash]
      )
    } else {
      await pool.query(
        "INSERT INTO users (username, name, email, password_hash, role, is_active) VALUES ($1, $2, $3, $4, $5, $6)",
        ['kevin', 'Site Admin', 'kevin@easydocstation.com', adminPasswordHash, 'site_admin', true]
      )
    }

    await pool.query('COMMIT')

    // ── 2. Cassandra 전체 초기화 ───────────────────────────────
    const { isConnected: isCassandraConnected } = require('../cassandra')
    if (isCassandraConnected()) {
      const cassandraTables = [
        'posts', 'comments', 'attachments',
        'calendar_events', 'calendar_invitations',
        'expense_posts', 'expense_attachments',
        'posts_by_id', 'comments_by_id',
      ]
      for (const tbl of cassandraTables) {
        try { await cassandraClient.execute(`TRUNCATE ${tbl}`) }
        catch (e) { console.error(`[Reset] Cassandra TRUNCATE ${tbl}:`, e.message) }
      }
    }

    // ── 3. 파일 스토리지 초기화 ────────────────────────────────
    const configPath = path.resolve(__dirname, '../../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

    // 15.3.4 ObjectFile (첨부파일 전체)
    deleteFolderContents(getDatabasePath(config, 'ObjectFile Path'))

    // 15.3.4 LanceDB (RAG 벡터 DB)
    deleteFolderContents(getDatabasePath(config, 'lancedb Database Path'))

    // RAG 학습 분리 데이터 (FileTrainingData)
    const fileTrainingPath = path.resolve(__dirname, '../../Database/ObjectFile/FileTrainingData')
    deleteFolderContents(fileTrainingPath)

    // ── 4. RAG 서버 재시작 — 메모리 캐시 및 DB 연결 초기화 ───────
    try { await ragRouter.restartRagServer() } catch (e) { console.error('[Reset] RAG 서버 재시작 오류:', e.message) }

    res.json({ success: true, message: '사이트가 초기화되었습니다. 다시 로그인해 주세요.' })
  } catch (err) {
    try { await pool.query('ROLLBACK') } catch (_) {}
    console.error('[Reset Error]', err)
    res.status(500).json({ error: '초기화 작업 중 오류가 발생했습니다: ' + err.message })
  }
})

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

function normalizeAgenticAiOperationMode(mode) {
  return String(mode || '').toLowerCase() === 'local' ? 'local' : 'server'
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
    pdfPreview: config.pdfPreview || { width: 480, height: 270 },
    txtPreview: config.txtPreview || { width: 270, height: 480 },
    pptPreview: config.pptPreview || { width: 480, height: 270 },
    pptxPreview: config.pptxPreview || { width: 480, height: 270 },
    excelPreview: config.excelPreview || { width: 480, height: 270 },
    wordPreview: config.wordPreview || { width: 270, height: 480 },
    moviePreview: config.moviePreview || { width: 480, height: 270 },
    htmlPreview: config.htmlPreview || { width: 480, height: 270 }
  }
}

async function getDbLocationSafe(fallbackPath = '') {
  try {
    const dbLocResult = await pool.query("SHOW data_directory")
    let dbLocation = dbLocResult.rows[0]?.data_directory || 'N/A'
    try {
      dbLocation = fs.realpathSync(dbLocation)
    } catch (_) {}
    return dbLocation
  } catch (e) {
    let safeFallback = String(fallbackPath || '').trim()
    if (safeFallback) {
      try { safeFallback = fs.realpathSync(safeFallback) } catch (_) {}
    }
    if (e && e.code === '42501') {
      return safeFallback || '접근 제한됨 (DB 설정 권한 필요)'
    }
    return safeFallback || 'N/A'
  }
}

router.get('/stats', async (req, res) => {
  try {
    const configPath = path.resolve(__dirname, '../../config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

    // 1. PostgreSQL DB Stats
    const dbName = getPostgresDatabaseName()
    const dbSizeResult = await pool.query('SELECT pg_size_pretty(pg_database_size($1)) as size', [dbName])
    const configuredPgPath = getDatabasePath(config, 'PostgreSQL Database Path')
    const dbLocation = await getDbLocationSafe(configuredPgPath)

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
      agenticai_operation_mode: normalizeAgenticAiOperationMode(config.agenticai_operation_mode),
      maxAttachmentFileSize: config.MaxAttachmentFileSize ?? 100,
      DirectMessage: normalizeDirectMessageConfig(config.DirectMessage || {}),
      company: config.company || {},
      site_url: config.site_url || '',
      site_backup_key: config['SiteBackUp Key'] || '',
      enable_data_backup: Boolean(config.enable_data_backup),
      ...readSupabaseEnvSnapshot(),
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
        agenticai_operation_mode: normalizeAgenticAiOperationMode(config.agenticai_operation_mode),
        maxAttachmentFileSize: config.MaxAttachmentFileSize ?? 100,
        DirectMessage: normalizeDirectMessageConfig(config.DirectMessage || {}),
        company: config.company || {},
        site_url: config.site_url || '',
        site_backup_key: config['SiteBackUp Key'] || '',
        enable_data_backup: Boolean(config.enable_data_backup),
        ...readSupabaseEnvSnapshot(),
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
    
    const supabaseKeys = new Set([
      'SUPABASE_URL',
      'SUPABASE_JWT_AUDIENCE',
      'JWT_SECRET',
      'CLIENT_ORIGIN',
      'AUTH_COOKIE_SECURE',
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_ANON_KEY',
    ])
    const touchedSupabaseSettings = Object.keys(req.body || {}).some((k) => supabaseKeys.has(k))

    // Merge new config (SUPABASE_* keys are excluded from config.json and handled by .env)
    const nonSupabaseBody = Object.fromEntries(
      Object.entries(req.body || {}).filter(([k]) => !supabaseKeys.has(k)),
    )
    const newConfig = {
      ...currentConfig,
      ...nonSupabaseBody
    }
    if (Object.prototype.hasOwnProperty.call(newConfig, 'agenticai')) {
      newConfig.agenticai = normalizeAgenticAiConfig(newConfig.agenticai || {})
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'agenticai_operation_mode')) {
      newConfig.agenticai_operation_mode = normalizeAgenticAiOperationMode(req.body.agenticai_operation_mode)
    } else if (!Object.prototype.hasOwnProperty.call(newConfig, 'agenticai_operation_mode')) {
      newConfig.agenticai_operation_mode = 'server'
    }

    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8')

    let envSync = null
    if (touchedSupabaseSettings) {
      envSync = writeSupabaseEnvFromPayload(req.body || {}, { backup: true })
    }

    res.json({
      success: true,
      config: newConfig,
      envSync,
      restartRequired: touchedSupabaseSettings,
    })
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

// POST /api/admin/restart — restart EasyDocStation services via restart script
router.post('/restart', async (req, res) => {
  try {
    const appRoot = path.resolve(__dirname, '../../')
    const ubuntuScript = path.resolve(appRoot, 'scripts/restart-ubuntu.sh')
    const dgxScript = path.resolve(appRoot, 'scripts/restart-dgx-spark.sh')
    const restartScript = fs.existsSync(ubuntuScript)
      ? ubuntuScript
      : fs.existsSync(dgxScript)
        ? dgxScript
        : null

    if (!restartScript) {
      return res.status(500).json({ error: '재시작 스크립트를 찾을 수 없습니다. scripts/restart-ubuntu.sh 또는 scripts/restart-dgx-spark.sh를 확인하세요.' })
    }

    const child = spawn('bash', [restartScript], {
      cwd: appRoot,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    res.json({
      success: true,
      message: '재시작 요청을 실행했습니다. 잠시 후 다시 접속해 주세요.',
      script: path.basename(restartScript),
    })
  } catch (err) {
    console.error('[admin/restart]', err)
    res.status(500).json({ error: '재시작 요청 중 오류가 발생했습니다.' })
  }
})

module.exports = router
