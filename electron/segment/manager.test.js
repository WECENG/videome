import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { BatchSegmentManager } = require('./manager.cjs')
const media = require('./media.cjs')
const { ResourceGate } = require('../batch/manager.cjs')
const folders = []
const managers = []

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown()
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

async function waitFor(manager, id, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await manager.get(id)
    if (predicate(job)) return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('分段任务等待超时。')
}

it('creates and renders ordered segments with a preserved tail and manifest', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'videome-segment-manager-'))
  folders.push(folder)
  const source = path.join(folder, 'source.mp4')
  await writeFile(source, 'source-video')
  const engine = { ...media,
    probe: async () => ({ streams: [{ codec_type: 'video', index: 0, codec_name: 'h264', width: 320, height: 180, duration: '65', avg_frame_rate: '30/1' }], format: { start_time: '0', duration: '65' } }),
    run: async () => ({ stdout: 'ffmpeg test-version' }),
    render: async (_ffmpeg, _source, item, _options, output) => { await writeFile(output, String(item.index)); return 'test-encoder' },
    verify: async (_ffmpeg, _ffprobe, output, _source, item) => ({ ...await media.fingerprint(output), frames: item.frames, duration: item.duration }),
  }
  const manager = new BatchSegmentManager({ root: path.join(folder, 'jobs'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', gate: new ResourceGate(), engine })
  managers.push(manager)
  const { jobId } = await manager.create({ sourcePath: source, outputDirectory: folder, segmentSeconds: 20 })
  const ready = await waitFor(manager, jobId, (job) => job.status === 'ready')
  expect(ready.items).toHaveLength(4)
  expect(ready.items.at(-1)).toMatchObject({ sourceStart: 60, sourceEnd: 65, duration: 5 })
  await manager.start(jobId)
  const complete = await waitFor(manager, jobId, (job) => job.status === 'completed')
  expect(complete.counts.completed).toBe(4)
  expect(await readFile(path.join(complete.outputDirectory, 'batch-manifest.csv'), 'utf8')).toContain('test-encoder')
})
