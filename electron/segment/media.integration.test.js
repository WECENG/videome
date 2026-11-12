import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const media = require('./media.cjs')
const planning = require('./planning.cjs')
const { locateTool } = require('../runtime.cjs')
const ffmpeg = locateTool('ffmpeg')
const ffprobe = locateTool('ffprobe')
let folder
let source

beforeAll(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'videome-segment-media-'))
  const sourcePath = path.join(folder, 'source.mp4')
  await media.run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.5', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', sourcePath])
  source = media.sourceFromProbe(sourcePath, await media.probe(ffprobe, sourcePath))
})

afterAll(async () => { await rm(folder, { recursive: true, force: true }) })

describe('batch segment media correctness', () => {
  it('renders and verifies a short tail with matching audio', async () => {
    const segments = planning.planSegments(source.duration, source.fps, 1)
    const item = segments.at(-1)
    const output = path.join(folder, 'segment-tail.mp4')
    await media.render(ffmpeg, source, item, { videoBitrateMbps: 4 }, output)
    const result = await media.verify(ffmpeg, ffprobe, output, source, item)
    expect(result.frames).toBe(item.frames)
    expect(result.audioDuration).toBeCloseTo(item.duration, 1)
  }, 60000)
})
