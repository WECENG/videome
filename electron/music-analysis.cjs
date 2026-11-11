const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')

const ENGINE_VERSION = 'music-analysis-v1'
const SAMPLE_RATE = 11025
const FRAME_SIZE = 1024
const HOP_SIZE = 512
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const percentile = (values, fraction) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))]
}

function fingerprint(filePath, stat) {
  const value = `${path.resolve(filePath)}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${ENGINE_VERSION}`
  return { key: crypto.createHash('sha256').update(value).digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs, engineVersion: ENGINE_VERSION }
}

function run(binary, args, { signal, timeout = 15 * 60_000, capture = true } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('音乐分析已取消。'))
    const child = spawn(binary, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const abort = () => { try { child.kill('SIGTERM') } catch {} }
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; abort() }, timeout)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString().slice(-12000) })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new Error('音乐分析已取消。'))
      else if (timedOut) reject(new Error('音乐分析超时，可稍后重试。'))
      else if (code !== 0) reject(new Error(stderr.trim().split(/\r?\n/).slice(-3).join('\n') || `FFmpeg 退出 (${code})`))
      else resolve(stdout)
    })
  })
}

function runDetailed(binary, args, { signal, timeout = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('视频分析已取消。'))
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''; let stderr = ''; let timedOut = false
    const abort = () => { try { child.kill('SIGTERM') } catch {} }
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; abort() }, timeout)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new Error('视频分析已取消。'))
      else if (timedOut) reject(new Error('视频分析超时，可稍后重试。'))
      else if (code !== 0) reject(new Error(stderr.trim().split(/\r?\n/).slice(-3).join('\n') || `FFmpeg 退出 (${code})`))
      else resolve({ stdout, stderr })
    })
  })
}

function decodeSamples(buffer) {
  const samples = new Float32Array(Math.floor(buffer.length / 2))
  for (let index = 0; index < samples.length; index += 1) samples[index] = buffer.readInt16LE(index * 2) / 32768
  return samples
}

function frameFeatures(samples) {
  const rms = []; const zcr = []; const brightness = []; const onsets = []
  let previousEnergy = 0
  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    let energy = 0; let crossings = 0; let high = 0; let total = 0; let previous = samples[start]
    for (let offset = 0; offset < FRAME_SIZE; offset += 1) {
      const value = samples[start + offset]
      energy += value * value
      if ((value >= 0) !== (previous >= 0)) crossings += 1
      previous = value
      const weight = Math.abs(value)
      total += weight
      if (offset > FRAME_SIZE / 3) high += weight
    }
    const value = Math.sqrt(energy / FRAME_SIZE)
    rms.push(value)
    zcr.push(crossings / FRAME_SIZE)
    brightness.push(total ? high / total : 0)
    onsets.push(Math.max(0, value - previousEnergy))
    previousEnergy = value
  }
  return { rms, zcr, brightness, onsets }
}

function estimateBpm(onsets) {
  if (onsets.length < 8) return { bpm: null, confidence: 0 }
  const average = mean(onsets)
  const centered = onsets.map((value) => Math.max(0, value - average))
  let best = { lag: 0, score: 0 }
  const minLag = Math.max(1, Math.floor((60 / 180) * SAMPLE_RATE / HOP_SIZE))
  const maxLag = Math.min(Math.floor((60 / 55) * SAMPLE_RATE / HOP_SIZE), centered.length - 2)
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0
    for (let index = lag; index < centered.length; index += 1) score += centered[index] * centered[index - lag]
    if (score > best.score) best = { lag, score }
  }
  if (!best.lag || best.score <= 0) return { bpm: null, confidence: 0 }
  let bpm = 60 * SAMPLE_RATE / (best.lag * HOP_SIZE)
  while (bpm < 70) bpm *= 2
  while (bpm > 150) bpm /= 2
  const confidence = clamp(best.score / Math.max(0.0001, centered.reduce((sum, value) => sum + value * value, 0)), 0, 1)
  return { bpm: Math.round(bpm), confidence: Number(confidence.toFixed(3)) }
}

function classifyMood({ energy, brightness, dynamicRange, silenceRatio }) {
  if (energy > 0.52 && brightness > 0.48) return 'energetic'
  if (brightness > 0.44 && energy > 0.28) return 'sunny'
  if (dynamicRange < 0.16 && silenceRatio > 0.12) return 'calm'
  if (brightness < 0.28 || dynamicRange > 0.35) return 'dreamy'
  return 'versatile'
}

function analyzeSamples(samples, duration) {
  const features = frameFeatures(samples)
  const rmsDb = features.rms.map((value) => 20 * Math.log10(Math.max(value, 0.00001)))
  const loud = percentile(features.rms, .8)
  const quiet = percentile(features.rms, .2)
  const energy = clamp(mean(features.rms) * 3.2, 0, 1)
  const silenceRatio = features.rms.length ? features.rms.filter((value) => value < Math.max(0.012, loud * .12)).length / features.rms.length : 0
  const dynamicRange = clamp((percentile(rmsDb, .95) - percentile(rmsDb, .1)) / 45, 0, 1)
  const brightness = clamp(mean(features.brightness), 0, 1)
  const bpm = estimateBpm(features.onsets)
  const tempo = bpm.bpm == null ? 'flexible' : bpm.bpm < 80 ? 'slow' : bpm.bpm > 115 ? 'fast' : 'mid'
  const result = { duration, bpm: bpm.bpm, bpmConfidence: bpm.confidence, energy: Number(energy.toFixed(3)), dynamicRange: Number(dynamicRange.toFixed(3)), silenceRatio: Number(silenceRatio.toFixed(3)), brightness: Number(brightness.toFixed(3)), mood: classifyMood({ energy, brightness, dynamicRange, silenceRatio }), tempo, analyzedAt: new Date().toISOString(), engineVersion: ENGINE_VERSION }
  return result
}

class MusicAnalysisService extends EventEmitter {
  constructor({ root, ffmpeg, ffprobe, gate }) {
    super(); this.root = root; this.ffmpeg = ffmpeg; this.ffprobe = ffprobe; this.gate = gate
    this.queue = []; this.active = null; this.stopping = false; this.initialized = fs.mkdir(root, { recursive: true })
  }

  cachePath(key) { return path.join(this.root, `${key}.json`) }
  async readCache(key) { try { return JSON.parse(await fs.readFile(this.cachePath(key), 'utf8')) } catch { return null } }
  async writeCache(key, value) { const temporary = `${this.cachePath(key)}.${process.pid}.tmp`; await fs.writeFile(temporary, JSON.stringify(value, null, 2)); await fs.rename(temporary, this.cachePath(key)) }
  status() { return { active: Boolean(this.active), queued: this.queue.length, engineVersion: ENGINE_VERSION } }

  async waitForResources(signal) {
    while (this.gate?.owner && !signal?.aborted && !this.stopping) await new Promise((resolve) => setTimeout(resolve, 250))
    if (signal?.aborted) throw new Error('视频分析已取消。')
    if (this.stopping) throw new Error('应用正在退出。')
  }

  async analyzeAssetBytes(filePath, signal) {
    if (!this.ffmpeg || !this.ffprobe) throw new Error('本机媒体分析需要 FFmpeg 和 ffprobe。')
    const absolute = path.resolve(filePath); const stat = await fs.stat(absolute); const fp = fingerprint(absolute, stat); const cached = await this.readCache(fp.key)
    if (cached?.status === 'ready' && cached.fingerprint?.size === stat.size && cached.fingerprint?.mtimeMs === stat.mtimeMs) return cached
    const metadata = JSON.parse(await run(this.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', absolute], { signal, timeout: 60_000 }))
    const audio = metadata.streams?.find((stream) => stream.codec_type === 'audio')
    if (!audio) throw new Error('没有可读取的音频流。')
    const duration = Number(metadata.format?.duration || audio.duration || 0)
    const windows = duration > 600 ? [0, Math.max(0, duration / 2 - 30), Math.max(0, duration - 60)] : [0]
    const features = []
    for (const start of windows) features.push(await decodePcm(this.ffmpeg, absolute, start, duration > 600 ? 60 : Math.max(1, duration), signal))
    const merged = features.length === 1 ? features[0] : concatSamples(features)
    const result = { fingerprint: fp, status: 'ready', path: absolute, ...analyzeSamples(merged, duration) }
    await this.writeCache(fp.key, result)
    return result
  }

  async analyzeVideo(payload = {}, signal) {
    await this.waitForResources(signal)
    const videos = Array.isArray(payload.videos) ? payload.videos : []
    const duration = Number(payload.duration) || 0
    const fileFingerprints = []
    for (const item of videos) {
      try {
        const stat = await fs.stat(item.path)
        fileFingerprints.push(fingerprint(item.path, stat))
      } catch {}
    }
    const cacheInput = JSON.stringify({ files: fileFingerprints, duration, clips: videos.map((item) => [item.start, item.duration, item.trimStart]) })
    const cacheKey = crypto.createHash('sha256').update(`video\u0000${cacheInput}`).digest('hex')
    const cached = await this.readCache(cacheKey)
    if (cached?.status === 'ready') return cached
    const clipCount = videos.length
    const cutRate = duration > 0 ? clipCount / (duration / 60) : 0
    let dialogueRatio = null; let energy = null; let meanLuma = null; let meanSaturation = null; let sceneCutCount = 0
    const audioPaths = videos.map((item) => item.path).filter(Boolean)
    if (audioPaths.length && this.ffmpeg) {
      const samples = []
      for (const filePath of audioPaths.slice(0, 8)) {
        try { samples.push(await decodePcm(this.ffmpeg, filePath, 0, 60, signal)) } catch {}
      }
      if (samples.length) {
        const merged = concatSamples(samples)
        const features = frameFeatures(merged)
        const rms = features.rms
        const active = rms.filter((value) => value > Math.max(0.018, percentile(rms, .8) * .16)).length
        dialogueRatio = Number(clamp(active / Math.max(1, rms.length), 0, 1).toFixed(3))
        energy = Number(clamp(mean(rms) * 3.2, 0, 1).toFixed(3))
      }
    }
    if (this.ffmpeg && videos.length) {
      const visualSamples = []
      for (const item of videos.slice(0, 8)) {
        try {
          const visual = await runDetailed(this.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'info', '-ss', String(item.trimStart || 0), '-t', String(Math.min(60, item.duration || 60)), '-i', item.path, '-vf', "fps=1/2,signalstats,metadata=print:direct=1", '-an', '-f', 'null', '-'], { signal, timeout: 10 * 60_000 })
          const y = [...visual.stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite)
          const sat = [...visual.stderr.matchAll(/lavfi\.signalstats\.SATAVG=([\d.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite)
          const scene = await runDetailed(this.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'info', '-ss', String(item.trimStart || 0), '-t', String(Math.min(60, item.duration || 60)), '-i', item.path, '-vf', "select='gt(scene,0.3)',showinfo", '-an', '-f', 'null', '-'], { signal, timeout: 10 * 60_000 })
          visualSamples.push({ y, sat })
          sceneCutCount += (scene.stderr.match(/showinfo.*pts_time/g) || []).length
        } catch {}
      }
      const luma = visualSamples.flatMap((item) => item.y)
      const saturation = visualSamples.flatMap((item) => item.sat)
      if (luma.length) meanLuma = Number((mean(luma) / 100).toFixed(3))
      if (saturation.length) meanSaturation = Number((mean(saturation) / 100).toFixed(3))
    }
    const targetBpm = Math.round(clamp(72 + cutRate * 6, 72, 132))
    const result = { status: 'ready', fingerprint: { key: cacheKey, files: fileFingerprints }, duration, clipCount, cutRate: Number(cutRate.toFixed(3)), sceneCutCount: Math.max(0, sceneCutCount || clipCount - 1), dialogueRatio, meanLuma, meanSaturation, targetBpm, targetEnergy: energy == null ? null : Number(clamp(energy * 1.15, 0, 1).toFixed(3)), suggestedMood: dialogueRatio != null && dialogueRatio > .45 ? 'calm' : cutRate > 8 ? 'energetic' : meanLuma != null && meanLuma < .38 ? 'dreamy' : 'sunny', analyzedAt: new Date().toISOString(), engineVersion: ENGINE_VERSION }
    await this.writeCache(cacheKey, result)
    return result
  }

  async enqueueAssets(paths = []) {
    await this.initialized
    const jobs = [...new Set(paths)].map((filePath) => ({ type: 'asset', filePath }))
    this.queue.push(...jobs); void this.pump(); return this.status()
  }
  async pump() {
    if (this.active || this.stopping || !this.queue.length) return
    if (this.gate?.owner) { setTimeout(() => this.pump(), 250); return }
    const job = this.queue.shift(); const controller = new AbortController(); this.active = { ...job, controller }
    this.emit('progress', { status: 'analyzing', type: job.type, path: job.filePath, queued: this.queue.length })
    try {
      const result = job.type === 'asset' ? await this.analyzeAssetBytes(job.filePath, controller.signal) : await this.analyzeVideo(job.payload, controller.signal)
      this.emit('progress', { status: 'ready', type: job.type, path: job.filePath, result, queued: this.queue.length })
    } catch (error) {
      this.emit('progress', { status: controller.signal.aborted ? 'cancelled' : 'failed', type: job.type, path: job.filePath, reason: error.message, queued: this.queue.length })
    } finally { this.active = null; void this.pump() }
  }
  cancel() { this.queue = []; this.active?.controller.abort(); return this.status() }
  async shutdown() { this.stopping = true; this.cancel(); await this.initialized }
}

function decodePcm(binary, filePath, start, duration, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', String(start), '-t', String(duration), '-i', filePath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const chunks = []; let stderr = ''; const abort = () => { try { child.kill('SIGTERM') } catch {} }; signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => chunks.push(chunk)); child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject); child.on('close', (code) => { signal?.removeEventListener('abort', abort); if (signal?.aborted) reject(new Error('音乐分析已取消。')); else if (code !== 0) reject(new Error(stderr.trim() || `FFmpeg 退出 (${code})`)); else resolve(decodeSamples(Buffer.concat(chunks))) })
  })
}
function concatSamples(chunks) { const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0); const merged = new Float32Array(total); let offset = 0; for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length } return merged }

module.exports = { MusicAnalysisService, ENGINE_VERSION, fingerprint, analyzeSamples }
