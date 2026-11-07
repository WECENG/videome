import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { DubbingManager, timing, normalizedCues } = require('./manager.cjs')
const { readCloudAudio } = require('./tts-response.cjs')
const { ResourceGate } = require('../batch/manager.cjs')

describe('dubbing timing and persistent tasks', () => {
  it('accepts binary audio and base64 audio responses from OpenAI-compatible TTS', async () => {
    const wav = Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'binary')
    const binary = new Response(wav, { headers: { 'content-type': 'audio/wav' } })
    await expect(readCloudAudio(binary)).resolves.toEqual(wav)
    const encoded = wav.toString('base64')
    const json = new Response(JSON.stringify({ audio: encoded }), { headers: { 'content-type': 'application/json' } })
    await expect(readCloudAudio(json)).resolves.toEqual(wav)
  })
  it('reports HTML gateway responses instead of passing them to ffmpeg', async () => {
    const html = new Response('<!doctype html><html><body>Not Found</body></html>', { headers: { 'content-type': 'text/html' } })
    await expect(readCloudAudio(html)).rejects.toThrow('网页而不是音频')
  })
  it('pads short speech naturally and never exceeds 1.25x or truncates long speech', () => {
    expect(timing(1, 2)).toEqual({ speed: 1, fits: true })
    expect(timing(2.5, 2)).toEqual({ speed: 1.25, fits: true })
    expect(timing(2.501, 2).fits).toBe(false)
    expect(() => timing(0, 2)).toThrow()
  })
  it('clamps timestamp overlaps and source boundaries and removes non-dialogue labels', () => {
    expect(normalizedCues([{ start: 0, end: 2, text: '[Music]' }, { start: 1, end: 3, text: 'Hello.' }, { start: 2, end: 8, text: 'World.' }], 5)
      .map((cue) => [cue.start, cue.end])).toEqual([[1, 3], [3, 5]])
  })
  it('restores interrupted drafts without changing the project and invalidates edited audio', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dubbing-test-'))
    try {
      await fs.mkdir(path.join(root, 'job'))
      const job = { id: 'job', projectId: 'p', status: 'generating', createdAt: '2026', voice: 3,
        cues: [{ id: 'cue-0', translation: '你好', status: 'ready', audioPath: '/old.wav' }] }
      await fs.writeFile(path.join(root, 'job', 'job.json'), JSON.stringify(job))
      const manager = new DubbingManager({ root }); await manager.initialized
      expect(manager.get('job').status).toBe('interrupted')
      expect(manager.list('other')).toEqual([])
      const updated = await manager.update({ id: 'job', cues: [{ id: 'cue-0', translation: '您好' }] })
      expect(updated.cues[0]).toMatchObject({ translation: '您好', audioPath: null, status: 'draft' })
      const prosodyUpdated = await manager.update({ id: 'job', cues: [{ id: 'cue-0', translation: '您好。再见。', prosody: { pause: 'strong' } }] })
      expect(prosodyUpdated.cues[0].prosody.pause).toBe('strong')
      expect(prosodyUpdated.cues[0].prosody.segments[0].pauseAfterMs).toBeGreaterThan(260)
      const restarted = new DubbingManager({ root }); await restarted.initialized
      expect(restarted.get('job').cues[0].translation).toBe('您好。再见。')
      expect(() => manager.start('job', 'unknown')).toThrow('未知')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  it('cancels a running stage and releases the media resource gate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dubbing-cancel-'))
    try {
      const source = path.join(root, 'source.wav'); await fs.writeFile(source, 'source')
      const stat = await fs.stat(source); const gate = new ResourceGate()
      const manager = new DubbingManager({ root, gate, models: { status: async () => ({ ready: true }) } }); await manager.initialized
      manager.jobs.set('job', { id: 'job', source: { path: source, duration: 1 }, fingerprint: { size: stat.size, mtimeMs: stat.mtimeMs }, cues: [] })
      await fs.mkdir(path.join(root, 'job'))
      manager.analyze = async (job, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        if (signal.aborted) reject(new Error('cancelled'))
      })
      manager.start('job', 'analyze')
      expect(gate.owner).toBe('dubbing')
      await manager.cancel('job')
      expect(manager.get('job').status).toBe('cancelled')
      expect(gate.owner).toBeNull()
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  it('queues multiple created jobs and starts the next one after the active job finishes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dubbing-queue-'))
    try {
      const source = path.join(root, 'source.wav'); await fs.writeFile(source, 'source')
      const models = { status: async () => ({ ready: true }), manifest: { version: 'test' } }
      const manager = new DubbingManager({ root, models }); await manager.initialized
      let releaseFirst
      let firstRun = true
      const firstGate = new Promise((resolve) => { releaseFirst = resolve })
      manager.analyze = async (job) => {
        if (firstRun) { firstRun = false; await firstGate }
        job.status = 'review'; job.stage = '完成识别'
      }
      const first = await manager.create({ projectId: 'p', source: { path: source, duration: 1, trimStart: 0, start: 0, snapshot: '{}' } })
      const second = await manager.create({ projectId: 'p', source: { path: source, duration: 1, trimStart: 0, start: 2, snapshot: '{}' } })
      expect(manager.pending).toEqual([second.id])
      expect(manager.get(second.id).stage).toContain('排队')
      releaseFirst()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(manager.get(first.id).status).toBe('review')
      expect(manager.get(second.id).status).toBe('review')
      expect(manager.pending).toEqual([])
      expect(manager.active).toBeNull()
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  it('runs the automatic action through recognition, translation and generation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dubbing-auto-'))
    try {
      const source = path.join(root, 'source.wav'); await fs.writeFile(source, 'source')
      const manager = new DubbingManager({ root, models: { status: async () => ({ ready: true }), manifest: { version: 'test' } } }); await manager.initialized
      manager.analyze = async (job) => { job.cues = [{ id: 'cue-0', start: 0, end: 1, text: 'Hello', translation: '你好', status: 'draft' }]; job.backgroundPath = path.join(root, 'background.wav'); await fs.writeFile(job.backgroundPath, 'background') }
      manager.generate = async (job) => { job.cues[0].audioPath = path.join(root, 'cue.wav'); job.cues[0].status = 'ready'; job.status = 'ready'; job.stage = '试听确认后入轨' }
      const job = await manager.create({ projectId: 'p', source: { path: source, duration: 1, trimStart: 0, start: 0, snapshot: '{}' }, action: 'auto' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(manager.get(job.id)).toMatchObject({ status: 'ready', cues: [{ translation: '你好', status: 'ready' }] })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})
