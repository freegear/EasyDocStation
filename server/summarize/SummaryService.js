const http = require('http')
const config = require('../../config.json')

function getOllamaChatOptions() {
  return {
    hostname: String(process.env.OLLAMA_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: Number(process.env.OLLAMA_PORT || 11434),
    path: '/api/chat',
  }
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildPostList(posts = []) {
  return posts.map((post, index) => {
    const content = stripHtml(post.content).slice(0, 2000)
    return [
      `[${index + 1}]`,
      `id: ${post.id}`,
      `createdAt: ${post.createdAt}`,
      `authorId: ${post.authorId ?? ''}`,
      `content: ${content}`,
    ].join('\n')
  }).join('\n\n')
}

function requestOllama(payload, timeoutMs = 120000) {
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
          resolve(String(data?.message?.content || '').trim())
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

function buildFallbackSummary(posts = []) {
  if (posts.length === 0) return '해당 날짜에 요약할 게시글이 없습니다.'

  const lines = posts.slice(0, 10).map((post, index) => {
    const content = stripHtml(post.content)
    return `${index + 1}. ${content.slice(0, 120)}${content.length > 120 ? '...' : ''}`
  })

  return [
    `총 ${posts.length}개의 게시글을 찾았습니다.`,
    '',
    ...lines,
  ].join('\n')
}

class SummaryService {
  async summarizePosts(posts, intent, options = {}) {
    if (!posts.length) {
      return {
        summary: '해당 날짜에 요약할 게시글이 없습니다.',
        model: null,
        fallback: false,
      }
    }

    const model = String(
      options.model ||
      process.env.EASYDOC_SUMMARY_MODEL ||
      process.env.EASYDOC_CHAT_MODEL ||
      config?.rag?.ocr_model ||
      'gemma4:e4b',
    ).trim()

    const payload = {
      model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: '당신은 EasyDocStation 게시글 요약기입니다. 제공된 게시글만 근거로 한국어로 간결하게 요약하세요. 없는 내용은 추측하지 마세요.',
        },
        {
          role: 'user',
          content: [
            `요청 날짜 범위: ${intent.dateRange.from} ~ ${intent.dateRange.to}`,
            `게시글 수: ${posts.length}`,
            '',
            '[게시글 목록]',
            buildPostList(posts),
            '',
            '요약 형식:',
            '- 전체 핵심 3~5개',
            '- 중요한 결정/이슈가 있으면 별도 표시',
            '- 참조 게시글 ID 목록은 작성하지 마세요. 참조 링크는 시스템이 별도로 붙입니다.',
          ].join('\n'),
        },
      ],
      options: {
        temperature: 0.2,
        num_ctx: config?.agenticai?.num_ctx || 4096,
        num_predict: config?.agenticai?.num_predict || 2048,
      },
    }

    try {
      const summary = await requestOllama(payload)
      return { summary, model, fallback: false }
    } catch (err) {
      return {
        summary: buildFallbackSummary(posts),
        model,
        fallback: true,
        error: err.message,
      }
    }
  }
}

module.exports = SummaryService
