import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { BatchMixManager, ResourceGate } = require('./manager.cjs')
const media = require('./media.cjs')
const folders = []
const managers = []

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown()
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

async function waitFor(manager, id, predicate) {
  for (let attempt = 0; attempt < 6000; attempt += 1) {
    const job = await manager.get(id)
    if (predicate(job)) return job
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const job = await manager.get(id)
  throw new Error(`timed out: ${job.status} ${JSON.stringify(job.counts)} ${job.error}`)
}

async function fixture(extra = {}, count = 12) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'videome-batch-manager-'))
  folders.push(folder)
  const source = path.join(folder, 'source.mp4')
  await writeFile(source, 'source-video')
  let active = 0
  let peak = 0
  let renders = 0
  const engine = { ...media,
    probe: async () => ({ streams: [{ codec_type: 'video', index: 0, codec_name: 'h264', width: 320, height: 180, duration: '60', avg_frame_rate: '30/1' }], format: { start_time: '0', duration: '60' } }),
    run: async () => ({ stdout: 'ffmpeg test-version' }),
    render: async (_binary, _source, item, _options, output, context) => {
      active += 1; peak = Math.max(peak, active); renders += 1
      try {
        await new Promise((resolve) => setTimeout(resolve, 100))
        context.signal.throwIfAborted()
        await writeFile(output, item.signature)
        return 'test-encoder'
      } finally { active -= 1 }
    },
    verify: async (_ffmpeg, _ffprobe, output, options) => ({ ...await media.fingerprint(output), frames: options.targetFrames, duration: options.actualSeconds }),
    ...extra.engine,
  }
  const manager = new BatchMixManager({ root: path.join(folder, 'jobs'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', engine, ...extra })
  managers.push(manager)
  const { jobId } = await manager.create({ sourcePath: source, outputDirectory: folder, count, width: 320, height: 180, concurrency: 4, alignScenes: false, seed: 'queue' })
  await waitFor(manager, jobId, (job) => job.status === 'ready')
  return { folder, source, manager, jobId, engine, counters: () => ({ peak, active, renders }) }
}

describe('durable bounded batch queue', () => {
  it('schedules 200 unique outputs without exceeding four active tasks and restores completed outputs', async () => {
    const { manager, jobId, folder, engine, counters } = await fixture({}, 200)
    await manager.start(jobId)
    const finished = await waitFor(manager, jobId, (job) => job.status === 'completed')
    expect(finished.counts.completed).toBe(200)
    expect(counters().peak).toBeLessThanOrEqual(4)
    expect(counters().peak).toBeGreaterThan(1)
    expect(new Set(finished.items.map((item) => item.signature)).size).toBe(200)
    const firstOutput = finished.items[0].outputPath
    const before = await stat(firstOutput)
    await manager.shutdown()
    const restarted = new BatchMixManager({ root: path.join(folder, 'jobs'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', engine })
    managers.push(restarted)
    await restarted.initialized
    await restarted.resume(jobId)
    await waitFor(restarted, jobId, (job) => job.status === 'completed')
    expect((await stat(firstOutput)).mtimeMs).toBe(before.mtimeMs)
    expect(counters().renders).toBe(200)
    expect(await readFile(path.join(finished.outputDirectory, 'batch-manifest.csv'), 'utf8')).toContain('test-encoder')
  }, 360000)

  it('stops claiming after pause, preserves completed outputs on cancel and resumes the same sequences', async () => {
    const { manager, jobId } = await fixture()
    await manager.start(jobId)
    await waitFor(manager, jobId, (job) => job.counts.completed >= 1)
    await manager.pause(jobId)
    const paused = await waitFor(manager, jobId, (job) => job.status === 'paused')
    const signatures = paused.items.map((item) => item.signature)
    expect(paused.counts.active).toBe(0)
    await manager.resume(jobId)
    await manager.cancel(jobId)
    const cancelled = await waitFor(manager, jobId, (job) => job.status === 'cancelled')
    expect(cancelled.counts.completed).toBeGreaterThanOrEqual(paused.counts.completed)
    expect(cancelled.items.map((item) => item.signature)).toEqual(signatures)
  }, 90000)

  it('pauses on disk errors and rejects changed source contents', async () => {
    const data = await fixture()
    data.manager.checkSpace = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
    await data.manager.start(data.jobId)
    const paused = await waitFor(data.manager, data.jobId, (job) => job.status === 'paused')
    expect(paused.error).toContain('disk full')
    await writeFile(data.source, 'changed')
    await expect(data.manager.resume(data.jobId)).rejects.toThrow('源文件内容已变化')
  }, 30000)

  it('reconciles a published file before its completion state was committed', async () => {
    const data = await fixture()
    const job = data.manager.requireJob(data.jobId)
    const first = job.items[0]
    await writeFile(first.outputPath, first.signature)
    first.status = 'publishing'
    first.verification = await data.engine.verify('', '', first.outputPath, job.options)
    job.status = 'running'
    await data.manager.save(job)
    const before = await stat(first.outputPath)
    const restarted = new BatchMixManager({ root: path.join(data.folder, 'jobs'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', engine: data.engine })
    managers.push(restarted)
    await restarted.initialized
    expect((await restarted.get(job.id)).status).toBe('interrupted')
    await restarted.resume(job.id)
    await waitFor(restarted, job.id, (snapshot) => snapshot.status === 'completed')
    expect((await stat(first.outputPath)).mtimeMs).toBe(before.mtimeMs)
    expect(data.counters().renders).toBe(11)
  }, 30000)

  it('uses the backup snapshot if the authoritative JSON was truncated', async () => {
    const { manager, jobId, folder } = await fixture()
    const job = manager.requireJob(jobId)
    job.status = 'paused'
    await manager.save(job)
    await writeFile(path.join(folder, 'jobs', jobId, 'job.json'), '{')
    const restarted = new BatchMixManager({ root: path.join(folder, 'jobs'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', engine: manager.engine })
    managers.push(restarted)
    expect((await restarted.get(jobId)).id).toBe(jobId)
    const restored = restarted.requireJob(jobId)
    await restarted.save(restored)
    expect(JSON.parse(await readFile(path.join(folder, 'jobs', jobId, 'job.json.bak'), 'utf8')).id).toBe(jobId)
  })

  it('reserves resources synchronously before ordinary export preparation', () => {
    const gate = new ResourceGate()
    expect(gate.acquire('ordinary')).toBe(true)
    expect(gate.acquire('batch:one')).toBe(false)
    gate.release('batch:one')
    expect(gate.owner).toBe('ordinary')
    gate.release('ordinary')
    expect(gate.acquire('batch:one')).toBe(true)
  })

  it('retries only failed items and keeps a completed file unchanged', async () => {
    const data = await fixture()
    const render = data.manager.engine.render
    data.manager.engine.render = async (...args) => {
      if (args[2].index === 2) throw new Error('isolated decoder error')
      return render(...args)
    }
    await data.manager.start(data.jobId)
    const failed = await waitFor(data.manager, data.jobId, (job) => job.status === 'partial_failed')
    expect(failed.counts.failed).toBe(1)
    const preserved = await stat(failed.items[0].outputPath)
    data.manager.engine.render = render
    await data.manager.resume(data.jobId, { failedOnly: true })
    const complete = await waitFor(data.manager, data.jobId, (job) => job.status === 'completed')
    expect(complete.counts.completed).toBe(12)
    expect((await stat(complete.items[0].outputPath)).mtimeMs).toBe(preserved.mtimeMs)
  }, 30000)

  it('refuses an unrelated same-name output and never replaces it', async () => {
    const data = await fixture()
    const job = data.manager.requireJob(data.jobId)
    await writeFile(job.items[0].outputPath, 'unrelated')
    await data.manager.start(data.jobId)
    const result = await waitFor(data.manager, data.jobId, (snapshot) => snapshot.status === 'partial_failed')
    expect(result.items[0].status).toBe('failed')
    expect(await readFile(job.items[0].outputPath, 'utf8')).toBe('unrelated')
    job.status = 'paused'
    await expect(data.manager.resume(data.jobId)).rejects.toThrow('内容发生变化')
  }, 30000)

  it('publishes recovering state before source verification and accepts cancellation', async () => {
    const data = await fixture()
    const job = data.manager.requireJob(data.jobId)
    job.status = 'paused'
    const fingerprint = data.manager.engine.fingerprint
    let notifyStarted
    const started = new Promise((resolve) => { notifyStarted = resolve })
    data.manager.engine.fingerprint = async (_source, signal) => {
      notifyStarted()
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const resume = data.manager.resume(data.jobId)
    const rejection = expect(resume).rejects.toThrow('恢复校验已取消')
    await started
    expect((await data.manager.get(data.jobId)).status).toBe('recovering')
    const saved = JSON.parse(await readFile(path.join(data.folder, 'jobs', data.jobId, 'job.json'), 'utf8'))
    expect(saved.status).toBe('recovering')
    await data.manager.cancel(data.jobId)
    await rejection
    expect((await data.manager.get(data.jobId)).status).toBe('cancelled')
    data.manager.engine.fingerprint = fingerprint
  }, 30000)
})
