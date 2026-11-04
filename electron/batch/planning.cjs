const crypto = require('node:crypto')

const ALGORITHM_VERSION = 1
const FRAME_RATES = [24, 25, 30, 50, 60]
const roundTime = (value) => Math.round(value * 1e6) / 1e6

function normalizeOptions(input = {}) {
  const segmentSeconds = Number(input.segmentSeconds ?? 3)
  const targetSeconds = Number(input.targetSeconds ?? 30)
  const count = Number(input.count)
  const fps = Number(input.fps ?? 30)
  const concurrency = input.concurrency == null || input.concurrency === 'auto' ? 'auto' : Number(input.concurrency)
  const width = Number(input.width ?? 1920)
  const height = Number(input.height ?? 1080)
  const threshold = Number(input.threshold ?? 0.35)
  const videoBitrateMbps = Number(input.videoBitrateMbps ?? 12)
  const seed = String(input.seed ?? 'videome').trim()
  if (!Number.isFinite(segmentSeconds) || segmentSeconds < 0.1 || segmentSeconds > 3600) throw new Error('片段时长必须为 0.1–3600 秒。')
  if (!Number.isFinite(targetSeconds) || targetSeconds < 0.1 || targetSeconds > 3600) throw new Error('成片时长必须为 0.1–3600 秒。')
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('生成数量必须为 1–1000 的整数。')
  if (!FRAME_RATES.includes(fps)) throw new Error('输出帧率必须为 24、25、30、50 或 60。')
  if (concurrency !== 'auto' && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)) throw new Error('并发上限必须为自动或 1–8。')
  if (![width, height].every((value) => Number.isInteger(value) && value >= 2 && value <= 7680 && value % 2 === 0)) throw new Error('输出宽高必须为不超过 7680 的正偶数。')
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new Error('镜头检测阈值必须在 0 和 1 之间。')
  if (!Number.isFinite(videoBitrateMbps) || videoBitrateMbps < 1 || videoBitrateMbps > 100) throw new Error('视频码率必须为 1–100 Mbps。')
  if (!seed || seed.length > 200) throw new Error('随机种子不能为空，且不能超过 200 字符。')
  const targetFrames = Math.round(targetSeconds * fps)
  return { segmentSeconds, targetSeconds, count, fps, concurrency, width, height, threshold, videoBitrateMbps, seed,
    alignScenes: input.alignScenes !== false, targetFrames, actualSeconds: targetFrames / fps,
    snapWindow: Math.min(1, Math.max(0.25, segmentSeconds * 0.25)) }
}

function planSegments(duration, options, sceneCuts = []) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确定视频有效时长。')
  const minimum = Math.max(0.5, options.segmentSeconds / 2)
  const cuts = sceneCuts.filter((cut) => Number.isFinite(cut) && cut > 0 && cut < duration).sort((first, second) => first - second)
  const boundaries = [0]
  for (let nominal = options.segmentSeconds; nominal < duration; nominal += options.segmentSeconds) {
    if (boundaries.length > 100000) throw new Error('源视频切片超过 100000 个，请增加片段时长。')
    const previous = boundaries.at(-1)
    if (nominal - previous + 1e-6 < Math.min(minimum, options.segmentSeconds)) continue
    const candidates = options.alignScenes ? cuts.filter((cut) => Math.abs(cut - nominal) <= options.snapWindow && cut - previous >= minimum && duration - cut >= minimum) : []
    const boundary = candidates.sort((first, second) => Math.abs(first - nominal) - Math.abs(second - nominal) || first - second)[0] ?? nominal
    if (duration - boundary < minimum) break
    boundaries.push(roundTime(boundary))
  }
  boundaries.push(duration)
  return boundaries.slice(0, -1).map((start, index) => ({
    id: `segment-${index + 1}`, sourceStart: start, sourceEnd: boundaries[index + 1],
    duration: boundaries[index + 1] - start,
    frames: Math.max(1, Math.floor((boundaries[index + 1] - start) * options.fps + 1e-6)),
    snappedToScene: cuts.some((cut) => Math.abs(cut - boundaries[index + 1]) < 1e-6),
  }))
}

function randomFor(seed) {
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0)
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function shuffled(values, random) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}

function makeSequence(segments, options, random) {
  let remaining = options.targetFrames
  let pool = []
  const sequence = []
  while (remaining > 0) {
    if (sequence.length >= 64) throw new Error('单条成片超过 64 个片段，请增大片段时长或降低成片时长。')
    if (!pool.length) {
      pool = shuffled(segments, random)
      if (pool.length > 1 && pool[0].id === sequence.at(-1)?.segmentId) [pool[0], pool[1]] = [pool[1], pool[0]]
    }
    const segment = pool.shift()
    const frames = Math.min(segment.frames, remaining)
    sequence.push({ segmentId: segment.id, sourceStart: segment.sourceStart, sourceEnd: segment.sourceEnd, frames })
    remaining -= frames
  }
  const tail = sequence.at(-1)
  const previous = sequence.at(-2)
  const minimumTail = Math.min(Math.ceil(0.5 * options.fps), options.targetFrames)
  if (previous && tail.frames < minimumTail) {
    const transfer = Math.min(minimumTail - tail.frames, previous.frames - 1, Math.floor((tail.sourceEnd - tail.sourceStart) * options.fps + 1e-6) - tail.frames)
    if (transfer > 0) { previous.frames -= transfer; tail.frames += transfer }
  }
  return sequence
}

function sequenceSignature(sequence) {
  return crypto.createHash('sha256').update(JSON.stringify(sequence.map((clip) => [clip.segmentId, roundTime(clip.sourceStart), roundTime(clip.sourceEnd), clip.frames]))).digest('hex')
}

async function planOutputs(segments, options, { signal, onProgress = () => {} } = {}) {
  const items = []
  const signatures = new Set()
  const limit = Math.max(1000, options.count * 50)
  let attempt = 0
  while (items.length < options.count && attempt < limit) {
    signal?.throwIfAborted()
    const sequence = makeSequence(segments, options, randomFor(`${ALGORITHM_VERSION}:${options.seed}:${items.length + 1}:${attempt}`))
    const signature = sequenceSignature(sequence)
    attempt += 1
    if (!signatures.has(signature)) {
      signatures.add(signature)
      items.push({ index: items.length + 1, sequence, signature, status: 'queued', percent: 0, error: null })
    }
    if (attempt % 100 === 0) {
      onProgress(items.length)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  if (items.length !== options.count) {
    const error = new Error(`找到 ${items.length} 条唯一剪辑序列，未达到 ${options.count} 条。请降低数量或调整片段和成片时长。`)
    error.uniqueCount = items.length
    throw error
  }
  return items
}

function automaticConcurrency(source, options, hardware) {
  if (options.concurrency !== 'auto') return options.concurrency
  return hardware.cpus >= 4 && hardware.memory >= 16 * 1024 ** 3 && source.width * source.height <= 1920 * 1080
    && options.width * options.height <= 1920 * 1080 && source.fps <= 30.01 && options.fps <= 30 && hardware.maxSegments <= 16 ? 2 : 1
}

function estimateBytes(options, count = options.count) {
  return Math.ceil(count * options.actualSeconds * (options.videoBitrateMbps * 1e6 + 256000) / 8)
}

function buildRepresentativeProject(job, item) {
  const source = job.source
  const options = job.options
  const assetId = `batch-source-${source.sha256.slice(0, 16)}`
  const tracks = [{ id: 'video-main', type: 'video', label: '混剪视频', accent: 'lime', order: 0, locked: false, muted: false }]
  if (source.audio) tracks.push({ id: 'audio-dialogue', type: 'audio', label: '原声 · 配音', accent: 'cyan', order: 0, locked: false, muted: false })
  let positionFrames = 0
  const clips = []
  for (const [index, part] of item.sequence.entries()) {
    const start = positionFrames / options.fps
    const duration = part.frames / options.fps
    const id = `mix-${item.index}-${index}`
    clips.push({ id, kind: 'video', assetId, trackId: 'video-main', name: `镜头 ${index + 1}`, start, duration, batchMixClip: true,
      trimStart: part.sourceStart + source.videoOffset, trimEnd: part.sourceStart + source.videoOffset + duration,
      sourceDuration: source.duration + source.videoOffset, color: 'lime', volume: 1, suppressEmbeddedAudio: Boolean(source.audio), audioLinked: Boolean(source.audio) })
    if (source.audio) {
      const audioStart = Math.max(part.sourceStart, source.audio.offset)
      const audioEnd = Math.min(part.sourceStart + duration, source.audio.offset + source.audio.duration)
      if (audioEnd > audioStart) clips.push({ id: `${id}-audio`, linkedClipId: id, kind: 'audio', assetId, trackId: 'audio-dialogue',
        name: `镜头 ${index + 1} · 原声`, start: start + audioStart - part.sourceStart, duration: audioEnd - audioStart,
        trimStart: audioStart - source.audio.offset + source.audio.containerOffset,
        trimEnd: audioEnd - source.audio.offset + source.audio.containerOffset,
        sourceDuration: source.audio.duration + source.audio.containerOffset, color: 'cyan', volume: 1, audioLinked: true })
    }
    positionFrames += part.frames
  }
  return { schemaVersion: 1, name: `混剪-${job.id.slice(0, 8)}-${String(item.index).padStart(4, '0')}`, duration: options.actualSeconds, playhead: 0,
    frameSize: { width: options.width, height: options.height }, frameRate: { numerator: options.fps, denominator: 1 },
    profile: `${options.width}×${options.height} · ${options.fps} fps`, tracks, clips,
    assets: [{ id: assetId, path: source.path, name: source.name, kind: 'video', duration: source.duration + source.videoOffset,
      sourceDuration: source.duration + source.videoOffset, width: source.width, height: source.height, rotation: 0,
      videoCodec: source.codec, audioCodec: source.audio?.codec || null, batchMixSource: true }],
    subtitle: { enabled: false, cues: [] }, exportSettings: { preset: 'high', format: 'mp4', videoCodec: 'h264', videoBitrateMbps: options.videoBitrateMbps, audioBitrateKbps: 256 },
    batchMix: { jobId: job.id, index: item.index, signature: item.signature }, history: [] }
}

module.exports = { ALGORITHM_VERSION, normalizeOptions, planSegments, planOutputs, makeSequence, randomFor, sequenceSignature, estimateBytes, automaticConcurrency, buildRepresentativeProject }
