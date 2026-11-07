function stripHtml(value) {
  return String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function decodeBase64Audio(value) {
  const text = String(value || '').trim()
  const match = text.match(/^data:[^;,]+;base64,(.+)$/is)
  const encoded = match ? match[1] : text
  if (!encoded || !/^[a-z0-9+/\s]+=*$/i.test(encoded)) return null
  try { return Buffer.from(encoded.replace(/\s+/g, ''), 'base64') } catch { return null }
}

function looksLikeAudio(buffer) {
  if (!buffer || buffer.length < 4) return false
  const head = buffer.subarray(0, 12).toString('ascii')
  return head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE'
    || head.startsWith('FORM') && (head.slice(8, 12) === 'AIFF' || head.slice(8, 12) === 'AIFC')
    || head.startsWith('OggS') || head.startsWith('fLaC') || head.startsWith('ID3')
    || buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0
}

function responseError(message, retryable = false) {
  const error = new Error(message)
  error.code = retryable ? 'INVALID_AUDIO_RESPONSE' : 'INVALID_TTS_RESPONSE'
  return error
}

async function readCloudAudio(response) {
  const type = String(response.headers.get('content-type') || '').toLowerCase()
  const bytes = Buffer.from(await response.arrayBuffer())
  const text = bytes.toString('utf8').trim()
  const jsonLike = type.includes('json') || text.startsWith('{') || text.startsWith('[')
  if (jsonLike) {
    let payload
    try { payload = JSON.parse(text) } catch { throw responseError('云端接口返回了无法解析的 JSON，而不是音频。') }
    const encoded = payload?.audio || payload?.audio_base64 || payload?.data
    const decoded = decodeBase64Audio(encoded)
    if (!decoded?.length) {
      const detail = payload?.error?.message || payload?.error || payload?.message
      throw responseError(`云端接口未返回有效音频${detail ? `：${String(detail).slice(0, 180)}` : '。'}`)
    }
    return decoded
  }
  if (type.includes('text/html') || /^<!doctype\s+html|^<html[\s>]/i.test(text)) {
    const detail = stripHtml(text).slice(0, 180)
    throw responseError(`云端接口返回了网页而不是音频${detail ? `：${detail}` : '。'}请检查接口地址是否包含 OpenAI 兼容 API 前缀（通常为 /v1），不要填写管理后台网页地址。`, true)
  }
  if (!bytes.length || (!type.startsWith('audio/') && !looksLikeAudio(bytes))) throw responseError('云端接口返回的数据不是可识别的音频。', true)
  return bytes
}

module.exports = { readCloudAudio, stripHtml, decodeBase64Audio, looksLikeAudio }
