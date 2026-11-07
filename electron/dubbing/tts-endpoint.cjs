function ttsEndpointCandidates(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!normalized) return []
  const withoutV1 = normalized.replace(/\/v1$/i, '') || normalized
  return [...new Set([
    `${normalized}/audio/speech`,
    `${withoutV1}/v1/audio/speech`,
    `${withoutV1}/audio/speech`,
  ])]
}

module.exports = { ttsEndpointCandidates }
