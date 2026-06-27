const iconv = require('iconv-lite')
const libmime = require('libmime')

// ---------------------------------------------------------------------------
// 메일 헤더(제목/발신자명 등) 디코딩 유틸.
//
// 한국 메일 중 일부는 비표준으로 헤더에 RFC 2047 인코딩 워드(=?euc-kr?...?=) 대신
// EUC-KR/CP949 "원문 바이트"를 그대로 넣는다. 이 경우 charset 정보가 없어 파서가
// UTF-8로 읽으면 한글이 U+FFFD(�)로 손실된다. 여기서 원문 바이트를 보존해
// (1) 인코딩 워드면 libmime, (2) raw 바이트면 UTF-8 우선 → 실패 시 CP949로 디코딩한다.
// ---------------------------------------------------------------------------

function normalizeCharset(cs) {
  if (!cs) return 'cp949'
  const c = String(cs).toLowerCase().replace(/['"]/g, '').trim()
  // EUC-KR 계열은 모두 CP949(상위호환)로 매핑
  if (['ks_c_5601-1987', 'ksc5601', 'ks_c_5601', 'ksc_5601', 'euc-kr', 'euckr', 'ms949', 'windows-949', 'x-windows-949'].includes(c)) {
    return 'cp949'
  }
  return iconv.encodingExists(c) ? c : 'cp949'
}

const ENCODED_WORD_RE = /=\?[^?]+\?[bq]\?[^?]*\?=/i

// 원문 바이트(Buffer)를 사람이 읽는 문자열로 디코딩한다.
function decodeHeaderText(rawBuf, fallbackCharset) {
  if (!rawBuf || rawBuf.length === 0) return ''
  const latin1 = rawBuf.toString('latin1')

  // 1) RFC 2047 인코딩 워드가 있으면 libmime에 위임 (혼합/연속 워드 처리)
  if (ENCODED_WORD_RE.test(latin1)) {
    try {
      return libmime.decodeWords(latin1).trim()
    } catch (_) { /* fall through */ }
  }

  // 2) raw 바이트: 유효한 UTF-8이면 UTF-8, 아니면 fallback(CP949 등)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(rawBuf).trim()
  } catch (_) {
    return iconv.decode(rawBuf, normalizeCharset(fallbackCharset)).trim()
  }
}

// 인코딩 워드를 포함할 수 있는 "문자열"을 디코딩 (Gmail API 헤더 값처럼 이미 문자열인 경우)
function decodeHeaderString(value) {
  if (!value) return ''
  const str = String(value)
  if (!ENCODED_WORD_RE.test(str)) return str
  try {
    return libmime.decodeWords(str)
  } catch (_) {
    return str
  }
}

// 원본 .eml(Buffer/string)에서 특정 헤더의 원문 바이트(folding 해제)를 추출한다.
function getRawHeader(source, name) {
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source))
  let end = buf.indexOf('\r\n\r\n')
  if (end < 0) end = buf.indexOf('\n\n')
  const headerBlock = end < 0 ? buf : buf.slice(0, end)
  const text = headerBlock.toString('latin1') // 1:1 바이트 보존
  const lines = text.split(/\r?\n/)
  const prefix = name.toLowerCase() + ':'

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().startsWith(prefix)) {
      let val = lines[i].slice(lines[i].indexOf(':') + 1)
      let j = i + 1
      while (j < lines.length && /^[ \t]/.test(lines[j])) {
        val += lines[j]
        j += 1
      }
      return Buffer.from(val, 'latin1')
    }
  }
  return null
}

// 본문/헤더에서 charset 힌트를 찾는다 (없으면 cp949 기본).
function detectFallbackCharset(source) {
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source))
  const head = buf.slice(0, 8192).toString('latin1')
  const m = head.match(/charset\s*=\s*"?([\w.\-]+)"?/i)
  return normalizeCharset(m ? m[1] : 'cp949')
}

module.exports = {
  normalizeCharset,
  decodeHeaderText,
  decodeHeaderString,
  getRawHeader,
  detectFallbackCharset,
}
