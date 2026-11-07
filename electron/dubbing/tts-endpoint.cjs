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

function endpointCandidates(baseUrl, route) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!normalized) return []
  const withoutV1 = normalized.replace(/\/v1$/i, '') || normalized
  return [...new Set([
    `${normalized}/${route}`,
    `${withoutV1}/v1/${route}`,
    `${withoutV1}/${route}`,
  ])]
}

function transcriptionEndpointCandidates(baseUrl) { return endpointCandidates(baseUrl, 'audio/transcriptions') }
function planningEndpointCandidates(baseUrl) { return endpointCandidates(baseUrl, 'chat/completions') }

module.exports = { ttsEndpointCandidates, transcriptionEndpointCandidates, planningEndpointCandidates }
