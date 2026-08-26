const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const gpuGate = require('./gpu/gpuGate')

const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
const DEFAULT_META_BASE_URL = 'https://api.meta.ai/v1'
const DEFAULT_META_MODEL = 'muse-spark-1.2'
const DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant'

function getOllamaChatOptions() {
  return {
    hostname: String(process.env.OLLAMA_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: Number(process.env.OLLAMA_PORT || 11434),
    path: '/api/chat',
  }
}

function requestOllama(payload, timeoutMs = 120000) {
  // Ollama(dgx-spark)는 GPU 소비자다. 답변 생성 동안 대화형 리스를 갱신해
  // 폴더 학습이 양보하도록 한다(MDfiles/GpuScheduling.md 1·5단계).
  return gpuGate.withInteractiveLease(() => requestOllamaRaw(payload, timeoutMs), 30)
}

function requestOllamaRaw(payload, timeoutMs = 120000) {
  const options = getOllamaChatOptions()
  const body = JSON.stringify(payload)

  return new Promise((resolve, reject) => {
    const req = http.request({
      ...options,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${raw.slice(0, 300)}`))
          return
        }
        try {
          const data = JSON.parse(raw)
          resolve({
            content: String(data?.message?.content || '').trim(),
            provider: 'ollama',
            model: String(payload?.model || ''),
            raw: data,
          })
        } catch (err) {
          reject(err)
        }
      })
    })

    req.on('timeout', () => req.destroy(new Error('OLLAMA_TIMEOUT')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function normalizeGroqConfig(groq = {}) {
  return {
    enabled: Boolean(groq?.enabled),
    prefer_when_available: Boolean(groq?.prefer_when_available),
    api_key: String(groq?.api_key || process.env.GROQ_API_KEY || '').trim(),
    model: String(groq?.model || process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim() || DEFAULT_GROQ_MODEL,
    base_url: String(groq?.base_url || process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL).trim() || DEFAULT_GROQ_BASE_URL,
    use_for_mail_summary: Boolean(groq?.use_for_mail_summary),
  }
}

function normalizeDeepSeekConfig(deepseek = {}) {
  return {
    enabled: Boolean(deepseek?.enabled),
    api_key: String(deepseek?.api_key || process.env.DEEPSEEK_API_KEY || '').trim(),
    model: String(deepseek?.model || process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL).trim() || DEFAULT_DEEPSEEK_MODEL,
    base_url: String(deepseek?.base_url || process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL).trim() || DEFAULT_DEEPSEEK_BASE_URL,
    use_for_mail_summary: Boolean(deepseek?.use_for_mail_summary),
  }
}

function normalizeMetaConfig(meta = {}) {
  return {
    enabled: Boolean(meta?.enabled),
    api_key: String(meta?.api_key || process.env.MODEL_API_KEY || process.env.META_API_KEY || process.env.LLAMA_API_KEY || '').trim(),
    model: String(meta?.model || process.env.META_MODEL || DEFAULT_META_MODEL).trim() || DEFAULT_META_MODEL,
    base_url: String(meta?.base_url || process.env.META_BASE_URL || DEFAULT_META_BASE_URL).trim() || DEFAULT_META_BASE_URL,
  }
}

function loadRuntimeConfig() {
  try {
    const configPath = path.resolve(__dirname, '../config.json')
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (_) {
    return {}
  }
}

function ollamaPayloadToGroqBody(payload = {}, groqConfig = {}) {
  const options = payload.options || {}
  return {
    model: groqConfig.model || DEFAULT_GROQ_MODEL,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.1,
    max_tokens: Number.isFinite(Number(options.num_predict)) ? Number(options.num_predict) : 2048,
    stream: false,
  }
}

function requestGroq(payload, groqConfig, timeoutMs = 120000) {
  const normalized = normalizeGroqConfig(groqConfig)
  if (!normalized.api_key) return Promise.reject(new Error('GROQ_API_KEY_MISSING'))

  const baseUrl = normalized.base_url.endsWith('/') ? normalized.base_url.slice(0, -1) : normalized.base_url
  const endpoint = new URL(baseUrl + '/chat/completions')
  const body = JSON.stringify(ollamaPayloadToGroqBody(payload, normalized))

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${normalized.api_key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GROQ HTTP ${res.statusCode}: ${raw.slice(0, 300)}`))
          return
        }
        try {
          const data = JSON.parse(raw)
          resolve({
            content: String(data?.choices?.[0]?.message?.content || '').trim(),
            provider: 'groq',
            model: normalized.model,
            raw: data,
          })
        } catch (err) {
          reject(err)
        }
      })
    })

    req.on('timeout', () => req.destroy(new Error('GROQ_TIMEOUT')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function requestDeepSeek(payload, deepseekConfig, timeoutMs = 120000) {
  const normalized = normalizeDeepSeekConfig(deepseekConfig)
  if (!normalized.api_key) return Promise.reject(new Error("DEEPSEEK_API_KEY_MISSING"))
  const baseUrl = normalized.base_url.endsWith('/') ? normalized.base_url.slice(0, -1) : normalized.base_url
  const endpoint = new URL(baseUrl + '/chat/completions')
  const body = JSON.stringify(ollamaPayloadToGroqBody(payload, normalized))
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: endpoint.hostname, port: endpoint.port || 443, path: endpoint.pathname + endpoint.search, method: "POST", headers: { Authorization: "Bearer " + normalized.api_key, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: timeoutMs }, res => {
      let raw = ""
      res.setEncoding("utf8")
      res.on("data", chunk => { raw += chunk })
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error("DEEPSEEK HTTP " + res.statusCode + ": " + raw.slice(0, 300)))
        try { const data = JSON.parse(raw); resolve({ content: String(data?.choices?.[0]?.message?.content || "").trim(), provider: "deepseek", model: normalized.model, raw: data }) } catch (err) { reject(err) }
      })
    })
    req.on("timeout", () => req.destroy(new Error("DEEPSEEK_TIMEOUT")))
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

function ollamaPayloadToMetaResponsesBody(payload = {}, metaConfig = {}) {
  const input = (Array.isArray(payload.messages) ? payload.messages : []).map(message => {
    const rawContent = message?.content
    const content = Array.isArray(rawContent)
      ? rawContent.map(part => {
        if (part?.type === 'input_text') return part
        if (part?.type === 'text') return { type: 'input_text', text: String(part.text || '') }
        return part
      })
      : [{ type: 'input_text', text: String(rawContent || '') }]
    return { role: String(message?.role || 'user'), content }
  })
  return { model: metaConfig.model || DEFAULT_META_MODEL, input, stream: false }
}

function extractMetaResponseText(data = {}) {
  if (typeof data.output_text === 'string') return data.output_text.trim()
  const parts = []
  for (const item of Array.isArray(data.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('\n').trim()
}

function requestMeta(payload, metaConfig, timeoutMs = 120000) {
  const normalized = normalizeMetaConfig(metaConfig)
  if (!normalized.api_key) return Promise.reject(new Error('META_API_KEY_MISSING'))
  const baseUrl = normalized.base_url.replace(/\/+$/, '')
  const endpoint = new URL(baseUrl.endsWith('/responses') ? baseUrl : baseUrl + '/responses')
  const body = JSON.stringify(ollamaPayloadToMetaResponsesBody(payload, normalized))
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: endpoint.hostname, port: endpoint.port || 443,
      path: endpoint.pathname + endpoint.search, method: 'POST',
      headers: { Authorization: 'Bearer ' + normalized.api_key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('META HTTP ' + res.statusCode + ': ' + raw.slice(0, 300)))
        try {
          const data = JSON.parse(raw)
          resolve({ content: extractMetaResponseText(data), provider: 'meta', model: normalized.model, raw: data })
        } catch (err) { reject(err) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('META_TIMEOUT')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}
function shouldUseGroq(config = {}, task = '') {
  const groq = normalizeGroqConfig(config?.agenticai?.groq || {})
  if (!groq.enabled || !groq.api_key) return false
  if (task === 'mail_summary') return groq.use_for_mail_summary || groq.prefer_when_available
  return groq.prefer_when_available
}

async function requestChatCompletion(payload, options = {}) {
  const config = options.config || loadRuntimeConfig()
  const task = String(options.task || '')
  const timeoutMs = Number(options.timeoutMs || 120000)
  const groq = normalizeGroqConfig(config?.agenticai?.groq || {})
  const deepseek = normalizeDeepSeekConfig(config?.agenticai?.deepseek || {})
  const meta = normalizeMetaConfig(config?.agenticai?.meta || {})
  const provider = String(options.provider || config?.agenticai?.provider || 'ollama').toLowerCase()
  const preferGroq = provider === 'groq'

  const cloudRequest = provider === 'deepseek'
    ? () => requestDeepSeek(payload, deepseek, timeoutMs)
    : provider === 'meta' ? () => requestMeta(payload, meta, timeoutMs) : null
  if (cloudRequest) {
    try {
      return await cloudRequest()
    } catch (err) {
      if (options.fallbackToOllama === false || config?.agenticai?.fallback_to_ollama === false) throw err
      const fallback = await requestOllama(payload, timeoutMs)
      return { ...fallback, fallback: true, fallbackFrom: provider, fallbackReason: err.message || provider.toUpperCase() + '_FAILED' }
    }
  }

  if (preferGroq) {
    try {
      return await requestGroq(payload, groq, timeoutMs)
    } catch (err) {
      if (options.fallbackToOllama === false) throw err
      const fallback = await requestOllama(payload, timeoutMs)
      return {
        ...fallback,
        fallback: true,
        fallbackFrom: 'groq',
        fallbackReason: err.message || 'GROQ_FAILED',
      }
    }
  }

  return requestOllama(payload, timeoutMs)
}

module.exports = {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_META_BASE_URL,
  DEFAULT_META_MODEL,
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_MODEL,
  loadRuntimeConfig,
  normalizeGroqConfig,
  normalizeDeepSeekConfig,
  normalizeMetaConfig,
  requestChatCompletion,
  requestGroq,
  requestDeepSeek,
  requestMeta,
  requestOllama,
  shouldUseGroq,
}
