const crypto = require('node:crypto')

const ALGORITHM_VERSION = 1
const roundTime = (value) => Math.round(value * 1e6) / 1e6

function normalizeOptions(input = {}) {
  const segmentSeconds = Number(input.segmentSeconds ?? 20)
  const videoBitrateMbps = Number(input.videoBitrateMbps ?? 12)
  if (!Number.isFinite(segmentSeconds) || segmentSeconds < 0.1 || segmentSeconds > 3600) throw new Error('片段时长必须为 0.1–3600 秒。')
  if (!Number.isFinite(videoBitrateMbps) || videoBitrateMbps < 1 || videoBitrateMbps > 100) throw new Error('视频码率必须为 1–100 Mbps。')
  return { segmentSeconds, videoBitrateMbps }
}

function planSegments(duration, fps, segmentSeconds) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确定视频有效时长。')
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30
  const length = Number(segmentSeconds)
  const boundaries = [0]
  for (let start = length; start < duration - 1e-6; start += length) {
    if (boundaries.length > 100000) throw new Error('源视频分段超过 100000 个，请增加片段时长。')
    boundaries.push(roundTime(start))
  }
  boundaries.push(roundTime(duration))
  return boundaries.slice(0, -1).map((sourceStart, index) => {
    const sourceEnd = boundaries[index + 1]
    const frames = Math.max(1, Math.round(sourceEnd * rate) - Math.round(sourceStart * rate))
    return { index: index + 1, sourceStart, sourceEnd, duration: roundTime(sourceEnd - sourceStart), frames }
  })
}

function estimateBytes(segments, videoBitrateMbps, hasAudio = true) {
  const audioBitrate = hasAudio ? 256000 : 0
  return Math.ceil(segments.reduce((sum, segment) => sum + segment.duration, 0) * (videoBitrateMbps * 1e6 + audioBitrate) / 8)
}

function signature(segment) {
  return crypto.createHash('sha256').update(JSON.stringify([segment.index, segment.sourceStart, segment.sourceEnd, segment.frames])).digest('hex')
}

module.exports = { ALGORITHM_VERSION, normalizeOptions, planSegments, estimateBytes, signature }
