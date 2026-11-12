const fs = require('node:fs/promises')
const fsNative = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const planning = require('./planning.cjs')
const media = require('./media.cjs')
const { JobStore } = require('../batch/store.cjs')
const { publishExclusive, checkOutputDirectory } = require('../filesystem.cjs')

class BatchSegmentManager extends EventEmitter {
  constructor({ root, ffmpeg, ffprobe, gate, engine = media, hooks = {} }) {
    super(); this.store = new JobStore(root); this.ffmpeg = ffmpeg; this.ffprobe = ffprobe; this.gate = gate
    this.engine = engine; this.hooks = hooks; this.jobs = new Map(); this.controllers = new Map(); this.activeJob = null
    this.stopping = false; this.lastEvent = new Map(); this.eventTimers = new Map(); this.changes = Promise.resolve(); this.analysisTail = Promise.resolve(); this.initialized = this.restore()
  }

  async restore() {
    for (const job of await this.store.loadAll()) {
      if (['analyzing', 'queued', 'running', 'pausing', 'cancelling', 'recovering'].includes(job.status)) job.status = 'interrupted'
      for (const item of job.items || []) if (['rendering', 'verifying', 'publishing'].includes(item.status)) { item.status = 'queued'; item.percent = 0 }
      this.jobs.set(job.id, job)
    }
  }
  context(job) { return { signal: this.controllers.get(job.id)?.signal } }
  notify(job) {
    if (this.stopping) return
    const deliver = () => { this.eventTimers.delete(job.id); this.lastEvent.set(job.id, Date.now()); this.emit('progress', this.snapshot(job)) }
    const wait = 250 - (Date.now() - (this.lastEvent.get(job.id) || 0))
    if (wait <= 0 && !this.eventTimers.has(job.id)) deliver()
    else if (!this.eventTimers.has(job.id)) this.eventTimers.set(job.id, setTimeout(deliver, Math.max(1, wait)))
  }
  snapshot(job) {
    const copy = structuredClone(job); copy.segmentCount = copy.segments?.length || copy.items?.length || 0
    copy.counts = { completed: 0, failed: 0, queued: 0, active: 0 }
    for (const item of copy.items || []) {
      if (item.status === 'completed') copy.counts.completed += 1
      else if (item.status === 'failed') copy.counts.failed += 1
      else if (['rendering', 'verifying', 'publishing'].includes(item.status)) copy.counts.active += 1
      else copy.counts.queued += 1
    }
    delete copy.segments
    return copy
  }
  async get(id) { await this.initialized; return this.snapshot(this.requireJob(id)) }
  async list() { await this.initialized; return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((job) => this.snapshot(job)) }
  requireJob(id) { const job = this.jobs.get(id); if (!job) throw new Error('分段任务不存在。'); return job }
  async save(job) { await this.store.save(job); this.notify(job) }
  change(operation) { const result = this.changes.catch(() => {}).then(operation); this.changes = result; return result }

  async create(input) {
    await this.initialized
    if (this.stopping) throw new Error('应用正在退出。')
    if (!this.ffmpeg || !this.ffprobe) throw new Error('批量分段需要 FFmpeg 和 ffprobe。')
    const options = planning.normalizeOptions(input)
    if (!path.isAbsolute(input.sourcePath || '') || !path.isAbsolute(input.outputDirectory || '')) throw new Error('请选择源视频和输出目录。')
    const base = await fs.realpath(input.outputDirectory)
    if (!(await fs.stat(base)).isDirectory()) throw new Error('输出目标必须为目录。')
    if (process.platform === 'win32' && base.startsWith('\\\\')) throw new Error('首版批量输出请使用本地 NTFS 目录。')
    await checkOutputDirectory(base)
    const sourcePath = await fs.realpath(input.sourcePath)
    const id = crypto.randomUUID()
    const outputDirectory = path.join(base, `Videome-分段-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}`)
    await fs.mkdir(outputDirectory, { recursive: false })
    const job = { schemaVersion: 1, type: 'segment', algorithmVersion: planning.ALGORITHM_VERSION, id, status: 'analyzing', phase: 'fingerprint', createdAt: new Date().toISOString(), sourcePath, outputDirectory, options, items: [], warnings: [], error: null, concurrency: 1 }
    this.jobs.set(id, job); this.controllers.set(id, new AbortController()); await this.save(job)
    const analysis = this.analysisTail.catch(() => {}).then(() => this.analyze(job)).finally(() => this.controllers.delete(id))
    this.analysisTail = analysis; this.analysisTasks ||= new Set(); this.analysisTasks.add(analysis); void analysis.finally(() => this.analysisTasks.delete(analysis))
    return { jobId: id }
  }

  async analyze(job) {
    const owner = `segment:analysis:${job.id}`
    try {
      const context = this.context(job); context.signal.throwIfAborted()
      while (!this.gate.acquire(owner)) { await new Promise((resolve) => setTimeout(resolve, 250)); context.signal.throwIfAborted() }
      const digest = await this.engine.fingerprint(job.sourcePath, context.signal)
      const metadata = await this.engine.probe(this.ffprobe, job.sourcePath, context)
      job.source = { ...this.engine.sourceFromProbe(job.sourcePath, metadata), ...digest }
      job.ffmpegVersion = (await this.engine.run(this.ffmpeg, ['-version'], context)).stdout.split('\n')[0]
      job.phase = 'planning'; this.notify(job)
      job.segments = planning.planSegments(job.source.duration, job.source.fps, job.options.segmentSeconds)
      const stem = path.parse(job.source.name).name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'source'
      job.items = job.segments.map((segment) => ({ ...segment, signature: planning.signature(segment), status: 'queued', percent: 0, error: null, outputPath: path.join(job.outputDirectory, `${stem}-分段-${String(segment.index).padStart(4, '0')}.mp4`) }))
      job.estimatedBytes = planning.estimateBytes(job.segments, job.options.videoBitrateMbps, Boolean(job.source.audio))
      await this.checkSpace(job); job.status = 'ready'; job.phase = 'ready'; await this.save(job)
    } catch (error) { job.status = this.stopping ? 'interrupted' : this.context(job).signal?.aborted ? 'cancelled' : 'analysis_failed'; job.error = error.message; await this.save(job).catch(() => {}) }
    finally { this.gate.release(owner); this.pump(); this.hooks.onGateReleased?.() }
  }
  async checkSpace(job) {
    const stat = await fs.statfs(job.outputDirectory); const remaining = job.items?.filter((item) => item.status !== 'completed') || []
    const expected = remaining.length ? planning.estimateBytes(remaining, job.options.videoBitrateMbps, Boolean(job.source?.audio)) : planning.estimateBytes(job.segments || [], job.options.videoBitrateMbps, Boolean(job.source?.audio))
    if (stat.bavail * stat.bsize < expected * 1.2) throw Object.assign(new Error('输出磁盘可用空间不足，任务已暂停。'), { code: 'ENOSPC' })
    await fs.access(job.outputDirectory, fsNative.constants.W_OK)
  }
  async start(id) { return this.change(async () => { await this.initialized; const job = this.requireJob(id); if (!['ready', 'paused', 'interrupted'].includes(job.status) || !job.source || !job.items?.length) throw new Error('当前分段任务无法开始，请重新分析源视频。'); if (this.gate.owner === 'ordinary') throw new Error('普通导出正在运行，请等待完成。'); job.status = 'queued'; await this.save(job); this.pump(); return this.snapshot(job) }) }
  pump() {
    if (this.activeJob || this.stopping) return
    const job = [...this.jobs.values()].find((candidate) => candidate.status === 'queued')
    if (!job || !this.gate.acquire(`segment:${job.id}`)) return
    this.activeJob = job.id; this.execution = this.execute(job).catch(async (error) => { job.status = this.stopping ? 'interrupted' : this.context(job).signal?.aborted ? 'cancelled' : 'paused'; job.error = error.message; await this.save(job).catch(() => {}) }).finally(() => { this.gate.release(`segment:${job.id}`); this.activeJob = null; this.controllers.delete(job.id); this.pump(); this.hooks.onGateReleased?.() })
  }
  async execute(job) {
    this.controllers.set(job.id, new AbortController()); const context = this.context(job); job.status = 'running'; job.error = null
    const digest = await this.engine.fingerprint(job.source.path, context.signal); if (digest.sha256 !== job.source.sha256) throw new Error('源文件内容已变化，请重新分析。')
    job.source.size = digest.size; job.source.mtimeMs = digest.mtimeMs; await this.save(job)
    while (!this.stopping) {
      const pending = job.items.find((item) => item.status === 'queued')
      if (job.status === 'running' && pending) { pending.status = 'rendering'; await this.processItem(job, pending, context); continue }
      break
    }
    if (this.stopping) job.status = 'interrupted'
    else if (job.status === 'pausing') job.status = 'paused'
    else if (job.status === 'cancelling') job.status = 'cancelled'
    else if (job.status === 'running') job.status = job.items.some((item) => item.status === 'failed') ? 'partial_failed' : 'completed'
    await this.save(job)
  }
  async processItem(job, item, context) {
    const partial = path.join(job.outputDirectory, `.segment-${item.index}.partial.mp4`)
    try {
      await this.checkSpace(job); context.signal.throwIfAborted(); const sourceStat = await fs.stat(job.source.path)
      if (sourceStat.size !== job.source.size || sourceStat.mtimeMs !== job.source.mtimeMs) throw Object.assign(new Error('编码期间源文件发生变化。'), { code: 'EIO' })
      item.startedAt = new Date().toISOString(); item.error = null; item.percent = 0; await this.save(job); const handle = await fs.open(partial, 'wx'); await handle.close(); const started = Date.now()
      await this.hooks.beforeRender?.(job, item)
      item.encoder = await this.engine.render(this.ffmpeg, job.source, item, job.options, partial, { ...context, onProgress: (percent) => { item.percent = percent; this.notify(job) } })
      item.status = 'verifying'; item.percent = 99; await this.save(job); await this.hooks.beforeVerify?.(job, item)
      item.verification = await this.engine.verify(this.ffmpeg, this.ffprobe, partial, job.source, item, context); context.signal.throwIfAborted()
      item.status = 'publishing'; await this.save(job); await publishExclusive(partial, item.outputPath); item.status = 'completed'; item.percent = 100; item.completedAt = new Date().toISOString(); item.elapsedMs = Date.now() - started
    } catch (error) {
      item.error = error.message.slice(-3000); item.status = context.signal.aborted || this.stopping ? 'queued' : 'failed'
      if (['ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENODEV'].includes(error.code) || /no space left|read-only file system|permission denied|input\/output error/i.test(error.message)) { job.status = 'pausing'; item.status = 'queued'; job.error = error.message }
    } finally { await fs.rm(partial, { force: true }).catch(() => {}); await this.save(job).catch(() => {}) }
  }
  async pause(id) { return this.change(async () => { const job = this.requireJob(id); if (!['queued', 'running'].includes(job.status)) throw new Error('当前分段任务无法暂停。'); job.status = job.status === 'queued' ? 'paused' : 'pausing'; await this.save(job); return this.snapshot(job) }) }
  async cancel(id) { return this.change(async () => { const job = this.requireJob(id); if (['completed', 'cancelled'].includes(job.status)) return this.snapshot(job); const active = job.status === 'analyzing' || this.activeJob === id; job.status = active ? 'cancelling' : 'cancelled'; this.controllers.get(id)?.abort(new Error('任务已取消。')); await this.save(job); return this.snapshot(job) }) }
  async remove(id) { return this.change(async () => { const job = this.requireJob(id); if (this.controllers.has(id) || ['queued', 'running', 'pausing', 'cancelling', 'analyzing'].includes(job.status)) throw new Error('请先停止该分段任务。'); await this.store.writes; await fs.rm(path.join(this.store.root, id), { recursive: true, force: true }); this.jobs.delete(id); const timer = this.eventTimers.get(id); if (timer) clearTimeout(timer); this.eventTimers.delete(id); this.lastEvent.delete(id); return { ok: true } }) }
  async shutdown() { this.stopping = true; for (const timer of this.eventTimers.values()) clearTimeout(timer); for (const controller of this.controllers.values()) controller.abort(new Error('应用退出，任务可在重启后继续。')); await Promise.allSettled([...(this.analysisTasks || []), this.execution, this.changes].filter(Boolean)); for (const job of this.jobs.values()) { if (['queued', 'running', 'pausing', 'cancelling', 'analyzing'].includes(job.status)) job.status = 'interrupted'; await this.store.save(job).catch(() => {}) } await this.store.writes.catch(() => {}) }
}

module.exports = { BatchSegmentManager }
