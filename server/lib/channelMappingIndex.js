const DEFAULT_MIN_CONFIDENCE = 0.45
const MAX_TERMS_PER_CHANNEL_SOURCE = 80

const STOP_TERMS = new Set([
  'pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
  'the', 'and', 'for', 'with', 'from', 'this', 'that',
  '설치', '계획', '요약', '정리', '자료', '문서', '파일', '내용', '프로젝트', '제안서', '보고서',
])

function normalizeTerm(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_./\\()[\]{}:;,+="'`~!@#$%^&*?|<>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactTerm(value = '') {
  return normalizeTerm(value).replace(/\s+/g, '')
}

function stripChannelPrefix(value = '') {
  return String(value || '').replace(/^\s*\d{1,4}\s*[-_.]\s*/, '').trim()
}

function isUsefulTerm(term = '') {
  const norm = normalizeTerm(term)
  if (!norm || norm.length < 2) return false
  if (/^\d+$/.test(norm)) return false
  if (STOP_TERMS.has(norm)) return false
  return /[a-z0-9가-힣]/i.test(norm)
}

function addTerm(map, term, source, confidence, weight = 1) {
  const clean = stripChannelPrefix(term)
  const norm = normalizeTerm(clean)
  if (!isUsefulTerm(norm)) return
  const key = `${source}:${norm}`
  const prev = map.get(key)
  if (prev) {
    prev.hit_count += weight
    prev.confidence = Math.max(prev.confidence, confidence)
    return
  }
  map.set(key, {
    term: clean.trim(),
    term_norm: norm,
    source,
    confidence,
    hit_count: weight,
  })
}

function addTermVariants(map, term, source, confidence, weight = 1) {
  const stripped = stripChannelPrefix(term)
  addTerm(map, stripped, source, confidence, weight)
  const compact = compactTerm(stripped)
  if (compact && compact !== normalizeTerm(stripped)) {
    addTerm(map, compact, source, Math.max(0.4, confidence - 0.05), weight)
  }

  const parts = normalizeTerm(stripped).split(' ').filter(Boolean)
  for (const part of parts) {
    if (part.length >= 3) addTerm(map, part, source, Math.max(0.35, confidence - 0.15), weight)
  }
}

function extractFilenameTerms(fileName = '') {
  const withoutExt = String(fileName || '').replace(/\.[^.]+$/, '')
  const normalized = normalizeTerm(withoutExt)
  const terms = new Set()
  if (normalized) terms.add(normalized)

  const chunks = normalized.split(' ').filter(Boolean)
  for (const chunk of chunks) {
    if (chunk.length >= 3) terms.add(chunk)
  }

  for (let size = 2; size <= Math.min(4, chunks.length); size += 1) {
    for (let i = 0; i <= chunks.length - size; i += 1) {
      const phrase = chunks.slice(i, i + size).join(' ')
      if (phrase.length >= 4) terms.add(phrase)
    }
  }

  return [...terms].filter(isUsefulTerm)
}

function extractContentTerms(content = '') {
  const text = normalizeTerm(content)
  if (!text) return []
  const terms = new Map()

  const patterns = [
    /[가-힣A-Za-z0-9]+(?:건설|전자|산업|시스템|큐브|cube|station|global|platform|vision|safe|post|구역|지구|현장|캠|프로젝트)/g,
    /[A-Za-z][A-Za-z0-9]{2,}/g,
    /[가-힣]{3,}(?:\s+[가-힣]{2,}){0,2}/g,
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const term = normalizeTerm(match[0])
      if (!isUsefulTerm(term)) continue
      terms.set(term, (terms.get(term) || 0) + 1)
    }
  }

  return [...terms.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, MAX_TERMS_PER_CHANNEL_SOURCE)
    .map(([term, count]) => ({ term, count }))
}

async function ensureChannelMappingIndexSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS channel_mapping_index (
      id          BIGSERIAL PRIMARY KEY,
      channel_id  VARCHAR(50) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      term        TEXT        NOT NULL,
      term_norm   TEXT        NOT NULL,
      source      TEXT        NOT NULL DEFAULT 'auto',
      confidence  NUMERIC(5,4) NOT NULL DEFAULT 0.5,
      hit_count   INTEGER     NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (channel_id, term_norm, source)
    )
  `)
  await db.query('CREATE INDEX IF NOT EXISTS idx_channel_mapping_norm ON channel_mapping_index(term_norm)')
  await db.query('CREATE INDEX IF NOT EXISTS idx_channel_mapping_channel ON channel_mapping_index(channel_id)')
}

async function rebuildChannelMappingIndex(db) {
  await ensureChannelMappingIndexSchema(db)

  const channelsResult = await db.query(`
    SELECT c.id, c.name, c.description, t.name AS team_name
    FROM channels c
    LEFT JOIN teams t ON t.id = c.team_id
    WHERE COALESCE(c.is_archived, false) = false
    ORDER BY c.id
  `)

  await db.query('BEGIN')
  try {
    await db.query('TRUNCATE channel_mapping_index RESTART IDENTITY')

    let inserted = 0
    for (const channel of channelsResult.rows) {
      const terms = new Map()
      addTermVariants(terms, channel.id, 'channel_id', 0.85, 2)
      addTermVariants(terms, channel.name, 'channel_name', 0.95, 5)
      addTermVariants(terms, stripChannelPrefix(channel.name), 'channel_name', 0.98, 5)
      addTermVariants(terms, channel.team_name, 'team_name', 0.65, 1)
      addTermVariants(terms, channel.description, 'channel_description', 0.45, 1)

      const attachments = await db.query(`
        SELECT filename, COUNT(*)::int AS count
        FROM attachments
        WHERE channel_id = $1
          AND filename IS NOT NULL
        GROUP BY filename
        ORDER BY count DESC, filename ASC
        LIMIT 120
      `, [channel.id])
      for (const row of attachments.rows) {
        for (const term of extractFilenameTerms(row.filename)) {
          addTerm(terms, term, 'attachment_filename', 0.72, Math.max(1, row.count || 1))
        }
      }

      const documents = await db.query(`
        SELECT content, file_name, COUNT(*) OVER () AS total_count
        FROM search_documents
        WHERE channel_id = $1
        ORDER BY updated_at DESC
        LIMIT 200
      `, [channel.id]).catch(() => ({ rows: [] }))
      for (const row of documents.rows || []) {
        for (const term of extractFilenameTerms(row.file_name || '')) {
          addTerm(terms, term, 'search_file_name', 0.68, 1)
        }
        for (const item of extractContentTerms(row.content || '')) {
          addTerm(terms, item.term, 'search_content', 0.5, Math.min(5, item.count))
        }
      }

      const rows = [...terms.values()]
        .sort((a, b) => b.confidence - a.confidence || b.hit_count - a.hit_count || b.term_norm.length - a.term_norm.length)
        .slice(0, 240)

      for (const row of rows) {
        await db.query(
          `INSERT INTO channel_mapping_index
             (channel_id, term, term_norm, source, confidence, hit_count, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (channel_id, term_norm, source)
           DO UPDATE SET
             term = EXCLUDED.term,
             confidence = EXCLUDED.confidence,
             hit_count = EXCLUDED.hit_count,
             updated_at = NOW()`,
          [channel.id, row.term, row.term_norm, row.source, row.confidence, row.hit_count],
        )
        inserted += 1
      }
    }

    await db.query('COMMIT')
    return { channels: channelsResult.rowCount, terms: inserted }
  } catch (err) {
    await db.query('ROLLBACK')
    throw err
  }
}

function queryContainsTerm(queryNorm, termNorm) {
  if (!queryNorm || !termNorm) return false
  if (termNorm.length < 2) return false
  const compactQuery = queryNorm.replace(/\s+/g, '')
  const compact = termNorm.replace(/\s+/g, '')
  if (compact.length >= 3 && compactQuery.includes(compact)) return true
  return queryNorm.includes(termNorm)
}

async function resolveQueryChannelScope(db, {
  query,
  allowedChannelIds = [],
  currentChannelId = '',
  explicitScope = 'global_scope',
  minConfidence = DEFAULT_MIN_CONFIDENCE,
} = {}) {
  await ensureChannelMappingIndexSchema(db)

  const allowedSet = new Set((allowedChannelIds || []).map(v => String(v || '').trim()).filter(Boolean))
  const safeCurrent = String(currentChannelId || '').trim()
  const queryNorm = normalizeTerm(query)
  const fallbackChannelIds = safeCurrent && allowedSet.has(safeCurrent)
    ? [safeCurrent]
    : [...allowedSet]

  if (!queryNorm || allowedSet.size === 0) {
    return {
      channelIds: [],
      matchedChannelIds: [],
      matches: [],
      mode: 'empty',
    }
  }

  const result = await db.query(`
    SELECT channel_id, term, term_norm, source, confidence::float AS confidence, hit_count
    FROM channel_mapping_index
    WHERE channel_id = ANY($1)
      AND confidence >= $2
    ORDER BY confidence DESC, hit_count DESC, length(term_norm) DESC
    LIMIT 3000
  `, [[...allowedSet], minConfidence])

  const matches = []
  for (const row of result.rows) {
    if (!queryContainsTerm(queryNorm, row.term_norm)) continue
    matches.push({
      channelId: row.channel_id,
      term: row.term,
      termNorm: row.term_norm,
      source: row.source,
      confidence: Number(row.confidence || 0),
      hitCount: Number(row.hit_count || 0),
      score: Number(row.confidence || 0) + Math.min(0.2, Number(row.hit_count || 0) * 0.01) + Math.min(0.15, row.term_norm.length * 0.005),
    })
  }

  matches.sort((a, b) => b.score - a.score)
  const bestByChannel = new Map()
  for (const match of matches) {
    if (!bestByChannel.has(match.channelId)) bestByChannel.set(match.channelId, match)
  }

  const best = [...bestByChannel.values()].sort((a, b) => b.score - a.score)
  const topScore = best[0]?.score || 0
  const matchedChannelIds = best
    .filter(item => item.score >= Math.max(0.65, topScore - 0.18))
    .slice(0, 5)
    .map(item => item.channelId)

  if (matchedChannelIds.length > 0) {
    return {
      channelIds: matchedChannelIds,
      matchedChannelIds,
      matches: best.slice(0, 10),
      mode: explicitScope === 'global_scope' ? 'mapping_index' : `${explicitScope}_mapping_index`,
    }
  }

  return {
    channelIds: fallbackChannelIds,
    matchedChannelIds: [],
    matches: [],
    mode: safeCurrent && allowedSet.has(safeCurrent) ? 'current_channel' : 'accessible_channels',
  }
}

module.exports = {
  ensureChannelMappingIndexSchema,
  rebuildChannelMappingIndex,
  resolveQueryChannelScope,
  normalizeTerm,
}
