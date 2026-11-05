const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const planning = require('./planning.cjs')
const media = require('./media.cjs')
const { JobStore, atomicJson } = require('./store.cjs')
const { publishExclusive, checkOutputDirectory } = require('../filesystem.cjs')

class ResourceGate {
  constructor() { this.owner = null }
  acquire(owner) { if (this.owner) return false; this.owner = owner; return true }
  release(owner) { if (this.owner === owner) this.owner = null }
}

class BackgroundLane {
  constructor(gate) { this.gate = gate; this.tail = Promise.resolve(); this.stopping = false }
  run(operation) {
    const next = this.tail.catch(() => {}).then(async () => {
      while (this.gate.owner?.startsWith('batch:') && !this.stopping) await new Promise((resolve) => setTimeout(resolve, 250))
      if (this.stopping) throw new Error('应用正在退出。')
      return operation()
    })
    this.tail = next
    return next
  }
}

class BatchMixManager extends EventEmitter {
  constructor({ root, ffmpeg, ffprobe, gate = new ResourceGate(), engine = media, hardware, hooks = {} }) {
    super()
    this.store = new JobStore(root)
    this.ffmpeg = ffmpeg
    this.ffprobe = ffprobe
    this.gate = gate
    this.engine = engine
    this.hardware = hardware || { cpus: os.cpus().length, memory: os.totalmem() }
    this.hooks = hooks
    this.jobs = new Map()
    this.controllers = new Map()
    this.activeJob = null
    this.stopping = false
    this.lastEvent = new Map()
    this.eventTimers = new Map()
    this.changes = Promise.resolve()
    this.analysisTail = Promise.resolve()
    this.initialized = this.restore()
  }

  async restore() {
    for (const job of await this.store.loadAll()) {
      if (['analyzing', 'queued', 'running', 'pausing', 'cancelling', 'recovering'].includes(job.status)) job.status = 'interrupted'
      this.jobs.set(job.id, job)
    }
  }

  context(job) {
    return { signal: this.controllers.get(job.id)?.signal }
  }

  notify(job) {
    if (this.stopping) return
    const deliver = () => {
      this.eventTimers.delete(job.id)
      this.lastEvent.set(job.id, Date.now())
      this.emit('progress', this.snapshot(job))
    }
    const wait = 250 - (Date.now() - (this.lastEvent.get(job.id) || 0))
    if (wait <= 0 && !this.eventTimers.has(job.id)) deliver()
    else if (!this.eventTimers.has(job.id)) this.eventTimers.set(job.id, setTimeout(deliver, Math.max(1, wait)))
  }

  snapshot(job) {
    const copy = structuredClone(job)
    copy.segmentCount = copy.segments?.length || 0
    copy.counts = { completed: 0, failed: 0, queued: 0, active: 0 }
    for (const item of copy.items) {
      if (item.status === 'completed') copy.counts.completed += 1
      else if (item.status === 'failed') copy.counts.failed += 1
      else if (['rendering', 'verifying', 'publishing'].includes(item.status)) copy.counts.active += 1
      else copy.counts.queued += 1
      delete item.sequence
    }
    delete copy.segments
    return copy
  }

  async get(id) { await this.initialized; return this.snapshot(this.requireJob(id)) }
  async list() { await this.initialized; return [...this.jobs.values()].sort((first, second) => second.createdAt.localeCompare(first.createdAt)).map((job) => this.snapshot(job)) }
  requireJob(id) { const job = this.jobs.get(id); if (!job) throw new Error('批次不存在。'); return job }
  async save(job) { await this.store.save(job); this.notify(job) }

  change(operation) {
    const result = this.changes.catch(() => {}).then(operation)
    this.changes = result
    return result
  }

  async create(input) {
    await this.initialized
    if (this.stopping) throw new Error('应用正在退出。')
    if (!this.ffmpeg || !this.ffprobe) throw new Error('批量混剪需要 FFmpeg 和 ffprobe。')
    const options = planning.normalizeOptions(input)
    if (!path.isAbsolute(input.sourcePath || '') || !path.isAbsolute(input.outputDirectory || '')) throw new Error('请选择源视频和输出目录。')
    const base = await fs.realpath(input.outputDirectory)
    if (!(await fs.stat(base)).isDirectory()) throw new Error('输出目标必须为目录。')
    if (process.platform === 'win32' && base.startsWith('\\\\')) throw new Error('首版批量输出请使用本地 NTFS 目录。')
    await checkOutputDirectory(base)
    const sourcePath = await fs.realpath(input.sourcePath)
    const id = crypto.randomUUID()
    const outputDirectory = path.join(base, `Videome-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}`)
    await fs.mkdir(outputDirectory, { recursive: false })
    const job = { schemaVersion: 1, algorithmVersion: planning.ALGORITHM_VERSION, id, status: 'analyzing', phase: 'fingerprint', createdAt: new Date().toISOString(),
      sourcePath, outputDirectory, options, items: [], warnings: [], uniqueCount: 0, error: null }
    this.jobs.set(id, job)
    this.controllers.set(id, new AbortController())
    await this.save(job)
    const analysis = this.analysisTail.catch(() => {}).then(() => this.analyze(job)).finally(() => this.controllers.delete(id))
    this.analysisTail = analysis
    this.analysisTasks ||= new Set()
    this.analysisTasks.add(analysis)
    void analysis.finally(() => this.analysisTasks.delete(analysis))
    return { jobId: id }
  }

  async analyze(job) {
    const owner = `batch:analysis:${job.id}`
    try {
      const context = this.context(job)
      context.signal.throwIfAborted()
      while (!this.gate.acquire(owner)) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        context.signal.throwIfAborted()
      }
      const digest = await this.engine.fingerprint(job.sourcePath, context.signal)
      const metadata = await this.engine.probe(this.ffprobe, job.sourcePath, context)
      job.source = { ...this.engine.sourceFromProbe(job.sourcePath, metadata), ...digest }
      job.ffmpegVersion = (await this.engine.run(this.ffmpeg, ['-version'], context)).stdout.split('\n')[0]
      let cuts = []
      if (job.options.alignScenes) {
        job.phase = 'scenes'
        this.notify(job)
        const cacheKey = crypto.createHash('sha256').update(`${job.algorithmVersion}:${digest.sha256}:${job.options.threshold}:${job.ffmpegVersion}`).digest('hex')
        const cachePath = path.join(this.store.root, '_scene-cache', `${cacheKey}.json`)
        try {
          let cached
          try { cached = JSON.parse(await fs.readFile(cachePath, 'utf8')) } catch {}
          if (Array.isArray(cached) && cached.every((cut) => Number.isFinite(cut) && cut >= 0 && cut <= job.source.duration)) cuts = cached
          else {
            cuts = await this.engine.analyzeScenes(this.ffmpeg, job.source, job.options, context)
            await atomicJson(cachePath, cuts, false).catch(() => {})
          }
        }
        catch (error) {
          context.signal.throwIfAborted()
          job.warnings.push(`镜头检测降级为固定切片：${error.message.slice(-500)}`)
        }
      }
      job.sceneCuts = cuts
      job.segments = planning.planSegments(job.source.duration, job.options, cuts)
      job.phase = 'planning'
      job.items = await planning.planOutputs(job.segments, job.options, { ...context, onProgress: (count) => { job.uniqueCount = count; this.notify(job) } })
      job.uniqueCount = job.items.length
      job.items.forEach((item) => { item.outputPath = path.join(job.outputDirectory, `mix-${String(item.index).padStart(4, '0')}.mp4`) })
      job.concurrency = planning.automaticConcurrency(job.source, job.options, { ...this.hardware, maxSegments: Math.max(...job.items.map((item) => item.sequence.length)) })
      job.estimatedBytes = planning.estimateBytes(job.options)
      await this.checkSpace(job)
      job.status = 'ready'
      job.phase = 'ready'
      await this.save(job)
    } catch (error) {
      job.status = this.stopping ? 'interrupted' : this.context(job).signal?.aborted ? 'cancelled' : 'analysis_failed'
      job.error = error.message
      if (error.uniqueCount != null) job.uniqueCount = error.uniqueCount
      await this.save(job).catch((saveError) => { console.error(saveError) })
    } finally {
      this.gate.release(owner)
      this.pump()
    }
  }

  async checkSpace(job) {
    const stat = await fs.statfs(job.outputDirectory)
    const remaining = job.items.length ? job.items.filter((item) => item.status !== 'completed').length : job.options.count
    if (stat.bavail * stat.bsize < planning.estimateBytes(job.options, remaining) * 1.2) throw Object.assign(new Error('输出磁盘可用空间不足，任务已暂停。'), { code: 'ENOSPC' })
    await fs.access(job.outputDirectory, require('node:fs').constants.W_OK)
  }

  async start(id) {
    return this.change(async () => {
      await this.initialized
      const job = this.requireJob(id)
      if (job.status !== 'ready') throw new Error('只可开始已经分析完成的批次。')
      if (this.gate.owner === 'ordinary') throw new Error('普通导出正在运行，请等待完成。')
      job.status = 'queued'
      await this.save(job)
      this.pump()
      return this.snapshot(job)
    })
  }

  pump() {
    if (this.activeJob || this.stopping) return
    const job = [...this.jobs.values()].find((candidate) => candidate.status === 'queued')
    if (!job || !this.gate.acquire(`batch:${job.id}`)) return
    this.activeJob = job.id
    this.execution = this.execute(job).catch(async (error) => {
      job.status = this.stopping ? 'interrupted' : this.context(job).signal?.aborted ? 'cancelled' : 'paused'
      job.error = error.message
      await this.save(job).catch(() => {})
    }).finally(() => {
      this.gate.release(`batch:${job.id}`)
      this.activeJob = null
      this.controllers.delete(job.id)
      this.pump()
    })
  }

  async execute(job) {
    this.controllers.set(job.id, new AbortController())
    const context = this.context(job)
    job.status = 'running'
    job.error = null
    const digest = await this.engine.fingerprint(job.source.path, context.signal)
    if (digest.sha256 !== job.source.sha256) throw new Error('源文件内容已变化，请重新分析。')
    job.source.mtimeMs = digest.mtimeMs
    job.source.size = digest.size
    await this.save(job)
    const workers = new Set()
    let completedAtStart = job.items.filter((item) => item.status === 'completed').length
    while (!this.stopping) {
      const pending = job.items.find((item) => item.status === 'queued')
      const done = job.items.filter((item) => item.status === 'completed').length - completedAtStart
      const limit = job.options.concurrency === 'auto' && done < 2 ? 1 : job.concurrency
      if (job.status === 'running' && pending && workers.size < limit) {
        pending.status = 'rendering'
        const worker = this.processItem(job, pending, context).finally(() => workers.delete(worker))
        workers.add(worker)
        continue
      }
      if (!workers.size) break
      await Promise.race(workers)
    }
    await Promise.all(workers)
    if (this.stopping) job.status = 'interrupted'
    else if (job.status === 'pausing') job.status = 'paused'
    else if (job.status === 'cancelling') job.status = 'cancelled'
    else if (job.status === 'running') job.status = job.items.some((item) => item.status === 'failed') ? 'partial_failed' : 'completed'
    await this.save(job)
  }

  async processItem(job, item, context) {
    const partial = path.join(job.outputDirectory, `.mix-${item.index}.partial.mp4`)
    try {
      await this.checkSpace(job)
      context.signal.throwIfAborted()
      const sourceStat = await fs.stat(job.source.path)
      if (sourceStat.size !== job.source.size || sourceStat.mtimeMs !== job.source.mtimeMs) throw Object.assign(new Error('批次执行期间源文件发生变化，已停止派发任务。'), { code: 'EIO' })
      item.startedAt = new Date().toISOString()
      item.error = null
      item.percent = 0
      await this.save(job)
      const handle = await fs.open(partial, 'wx')
      await handle.close()
      const started = Date.now()
      await this.hooks.beforeRender?.(job, item)
      item.encoder = await this.engine.render(this.ffmpeg, job.source, item, job.options, partial, {
        ...context, onProgress: (percent) => { item.percent = percent; this.notify(job) },
        onHardwareFallback: () => { if (job.options.concurrency === 'auto') job.concurrency = 1 },
      })
      item.status = 'verifying'
      item.percent = 99
      await this.save(job)
      await this.hooks.beforeVerify?.(job, item)
      item.verification = await this.engine.verify(this.ffmpeg, this.ffprobe, partial, job.options, Boolean(job.source.audio), context)
      context.signal.throwIfAborted()
      const afterStat = await fs.stat(job.source.path)
      if (afterStat.size !== job.source.size || afterStat.mtimeMs !== job.source.mtimeMs) throw Object.assign(new Error('编码期间源文件发生变化。'), { code: 'EIO' })
      item.status = 'publishing'
      await this.save(job)
      await this.hooks.beforePublish?.(job, item)
      await publishExclusive(partial, item.outputPath)
      await this.hooks.afterPublish?.(job, item)
      item.status = 'completed'
      item.percent = 100
      item.completedAt = new Date().toISOString()
      item.elapsedMs = Date.now() - started
      const samples = job.items.filter((candidate) => candidate.status === 'completed').map((candidate) => candidate.elapsedMs).filter(Boolean)
      job.averageItemMs = samples.reduce((sum, value) => sum + value, 0) / samples.length
    } catch (error) {
      item.error = error.message.slice(-3000)
      item.status = context.signal.aborted || this.stopping ? 'queued' : 'failed'
      if (['ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENODEV'].includes(error.code) || /no space left|read-only file system|permission denied|input\/output error/i.test(error.message)) {
        job.status = 'pausing'
        item.status = 'queued'
        job.error = error.message
      }
    } finally {
      await fs.rm(partial, { force: true }).catch(() => {})
      try { await this.save(job) }
      catch (error) { job.status = 'pausing'; job.error = `保存批次清单失败：${error.message}`; this.notify(job) }
    }
  }

  async pause(id) {
    return this.change(async () => {
      const job = this.requireJob(id)
      if (!['queued', 'running'].includes(job.status)) throw new Error('当前批次无法暂停。')
      job.status = job.status === 'queued' ? 'paused' : 'pausing'
      await this.save(job)
      return this.snapshot(job)
    })
  }

  async cancel(id) {
    const recovering = this.jobs.get(id)
    if (recovering?.status === 'recovering') {
      this.controllers.get(id)?.abort(new Error('恢复校验已取消。'))
      return this.snapshot(recovering)
    }
    return this.change(async () => {
      const job = this.requireJob(id)
      if (['completed', 'cancelled'].includes(job.status)) return this.snapshot(job)
      const active = job.status === 'analyzing' || this.activeJob === id
      job.status = active ? 'cancelling' : 'cancelled'
      this.controllers.get(id)?.abort(new Error('任务已取消。'))
      await this.save(job)
      return this.snapshot(job)
    })
  }

  async resume(id, { failedOnly = false, sourcePath } = {}) {
    return this.change(async () => {
      const job = this.requireJob(id)
      if (!['paused', 'cancelled', 'interrupted', 'partial_failed', 'completed'].includes(job.status) || !job.items.length) throw new Error('当前批次无法恢复，请重新分析。')
      if (this.activeJob === id) await this.execution
      if (this.activeJob || this.gate.owner) throw new Error('请等待活动导出完成后再恢复。')
      const owner = `batch:${id}`
      if (!this.gate.acquire(owner)) throw new Error('媒体资源正在使用。')
      this.controllers.set(id, new AbortController())
      job.status = 'recovering'
      try {
        await this.save(job)
        if (job.algorithmVersion !== planning.ALGORITHM_VERSION) throw new Error('批次算法版本不兼容，请重新分析。')
        const candidate = sourcePath ? await fs.realpath(sourcePath) : job.source.path
        const digest = await this.engine.fingerprint(candidate, this.context(job).signal)
        if (digest.sha256 !== job.source.sha256) throw new Error('源文件内容已变化，拒绝继续旧批次。')
        job.source.path = candidate
        job.sourcePath = candidate
        job.source.mtimeMs = digest.mtimeMs
        job.source.size = digest.size
        for (const item of job.items) {
          this.context(job).signal.throwIfAborted()
          const exists = await fs.stat(item.outputPath).catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
          if (exists) {
            if (item.verification?.sha256) {
              const outputDigest = await this.engine.fingerprint(item.outputPath, this.context(job).signal)
              if (outputDigest.sha256 !== item.verification.sha256) throw new Error(`输出 ${item.index} 内容发生变化，已保留该文件，请移动冲突文件后恢复。`)
            } else if (['rendering', 'verifying', 'publishing'].includes(item.status)) {
              item.verification = await this.engine.verify(this.ffmpeg, this.ffprobe, item.outputPath, job.options, Boolean(job.source.audio), this.context(job))
            } else throw new Error(`输出 ${item.index} 已有同名文件，已停止以避免覆盖。`)
            item.status = 'completed'
            item.percent = 100
          } else if (!failedOnly || item.status === 'failed' || ['rendering', 'verifying', 'publishing', 'completed'].includes(item.status)) {
            item.status = 'queued'
            item.percent = 0
          }
          await fs.rm(path.join(job.outputDirectory, `.mix-${item.index}.partial.mp4`), { force: true })
        }
        this.context(job).signal.throwIfAborted()
        await this.checkSpace(job)
        job.status = 'queued'
        job.error = null
        await this.save(job)
      } catch (error) {
        job.status = this.context(job).signal.aborted ? 'cancelled' : 'paused'
        job.error = error.message
        await this.save(job).catch(() => {})
        throw error
      } finally {
        this.controllers.delete(id)
        this.gate.release(owner)
      }
      this.pump()
      return this.snapshot(job)
    })
  }

  async remove(id) {
    return this.change(async () => {
      const job = this.requireJob(id)
      if (this.controllers.has(id) || ['queued', 'running', 'pausing', 'cancelling'].includes(job.status)) throw new Error('请先停止该批次。')
      await this.store.writes
      await fs.rm(path.join(this.store.root, id), { recursive: true, force: true })
      this.jobs.delete(id)
      const timer = this.eventTimers.get(id)
      if (timer) clearTimeout(timer)
      this.eventTimers.delete(id)
      this.lastEvent.delete(id)
      return { ok: true }
    })
  }

  async clearCache() {
    return this.change(async () => {
      if (this.controllers.size || this.activeJob) throw new Error('请等待分析和导出结束后清理镜头缓存。')
      await fs.rm(path.join(this.store.root, '_scene-cache'), { recursive: true, force: true })
      return { ok: true }
    })
  }

  async shutdown() {
    this.stopping = true
    for (const timer of this.eventTimers.values()) clearTimeout(timer)
    for (const controller of this.controllers.values()) controller.abort(new Error('应用退出，任务可在重启后继续。'))
    await Promise.allSettled([...(this.analysisTasks || []), this.execution, this.changes].filter(Boolean))
    for (const job of this.jobs.values()) {
      if (['queued', 'running', 'pausing', 'cancelling', 'analyzing', 'recovering'].includes(job.status)) job.status = 'interrupted'
      await this.store.save(job).catch(() => {})
    }
    await this.store.writes.catch(() => {})
  }
}

module.exports = { BatchMixManager, ResourceGate, BackgroundLane }
