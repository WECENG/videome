import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
const require = createRequire(import.meta.url)
const media = require('./media.cjs')
const { normalizeOptions } = require('./planning.cjs')
const { planSegments, planOutputs, buildRepresentativeProject } = require('./planning.cjs')
const { buildExportArguments } = require('../export.cjs')
const ffmpeg = '/opt/homebrew/bin/ffmpeg'
const ffprobe = '/opt/homebrew/bin/ffprobe'
let folder
let source
beforeAll(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'videome-batch-media-'))
  const sourcePath = path.join(folder, 'source.mp4')
  await media.run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', sourcePath])
  source = media.sourceFromProbe(sourcePath, await media.probe(ffprobe, sourcePath))
})
afterAll(async () => { await rm(folder, { recursive: true, force: true }) })

async function pixel(filePath, time) {
  const { stdout } = await media.run(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', filePath, '-frames:v', '1', '-vf', 'crop=2:2:100:80,signalstats,metadata=print:file=-', '-f', 'null', '-'])
  return Number(stdout.match(/lavfi.signalstats.YAVG=(\S+)/)?.[1])
}

describe('batch mix media correctness', () => {
  it('reports signal-terminated subprocesses as failures', async () => {
    await expect(media.run(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'])).rejects.toThrow('媒体进程退出')
  })
  it('renders a reordered colour sequence and validates 900 frames with matching audio', async () => {
    const options = normalizeOptions({ count: 1, width: 320, height: 180 })
    const sequence = Array.from({ length: 30 }, (_, index) => ({ sourceStart: index % 2 ? 0 : 1, sourceEnd: index % 2 ? 1 : 2, frames: 30 }))
    const output = path.join(folder, 'mixed.mp4')
    await media.render(ffmpeg, source, { sequence }, options, output)
    const verification = await media.verify(ffmpeg, ffprobe, output, options, true)
    expect(verification.frames).toBe(900)
    expect(await pixel(output, 0.5)).toBeLessThan(50)
    expect(await pixel(output, 1.5)).toBeGreaterThan(65)
  }, 60000)

  it('fixes the second timeline clip black frame regression', async () => {
    const project = { duration: 2, frameSize: { width: 320, height: 180 }, frameRate: { numerator: 30, denominator: 1 }, assets: [{ id: 'source', path: source.path, kind: 'video' }], tracks: [{ id: 'v', type: 'video', order: 0 }], subtitle: { enabled: false, cues: [] }, clips: [0, 1].map((index) => ({ id: `clip-${index}`, assetId: 'source', kind: 'video', trackId: 'v', start: index, duration: 1, trimStart: index, trimEnd: index + 1 })) }
    const output = path.join(folder, 'timeline.mkv')
    await media.run(ffmpeg, buildExportArguments({ preset: 'lossless', format: 'mkv', project }, output).args)
    const value = await pixel(output, 1.5)
    expect(value).toBeGreaterThan(30)
    expect(value).toBeLessThan(55)
  }, 30000)

  it('preserves native scene timestamps and rejects HDR metadata', async () => {
    const cuts = await media.analyzeScenes(ffmpeg, source, normalizeOptions({ count: 1 }), {})
    expect(cuts.some((cut) => Math.abs(cut - 1) < 1 / 30)).toBe(true)
    expect(() => media.sourceFromProbe('/hdr.mov', { streams: [{ codec_type: 'video', color_transfer: 'smpte2084' }] })).toThrow('HDR')
  }, 30000)

  it('pads late and short source audio and supports video-only output', async () => {
    const options = normalizeOptions({ count: 1, width: 320, height: 180, targetSeconds: 2 })
    const sequence = [{ sourceStart: 0, sourceEnd: 2, frames: 60 }]
    const delayed = path.join(folder, 'delayed.mp4')
    await media.render(ffmpeg, { ...source, audio: { ...source.audio, offset: 0.5, duration: 0.5 } }, { sequence }, options, delayed)
    expect((await media.verify(ffmpeg, ffprobe, delayed, options, true)).audioDuration).toBeCloseTo(2, 2)
    const silent = path.join(folder, 'silent.mp4')
    await media.render(ffmpeg, { ...source, audio: null }, { sequence }, options, silent)
    expect((await media.verify(ffmpeg, ffprobe, silent, options, false)).audioDuration).toBeNull()
  }, 30000)

  it('retries a hardware initialization failure once with a valid software output', async () => {
    if (process.platform !== 'darwin') return
    const options = normalizeOptions({ count: 1, targetSeconds: 1, width: 320, height: 180 })
    const output = path.join(folder, 'fallback.mp4')
    let attempts = 0
    let reduced = false
    const encoder = await media.render(ffmpeg, source, { sequence: [{ sourceStart: 0, sourceEnd: 1, frames: 30 }] }, options, output, {
      onHardwareFallback: () => { reduced = true },
      run: async (binary, args, context) => {
        attempts += 1
        if (args.includes('h264_videotoolbox')) throw new Error('VideoToolbox cannot create compression session')
        return media.run(binary, args, context)
      },
    })
    expect(encoder).toBe('libx264')
    expect(reduced).toBe(true)
    expect(attempts).toBe(2)
    expect((await media.verify(ffmpeg, ffprobe, output, options, true)).frames).toBe(30)
  }, 30000)

  it('normalizes VFR and nonzero timestamps without changing the frame budget', async () => {
    const shiftedPath = path.join(folder, 'shifted.mp4')
    await media.run(ffmpeg, ['-v', 'error', '-y', '-i', source.path, '-map', '0:v:0', '-vf', "select='not(mod(n,3))',setpts=PTS+2/TB", '-fps_mode', 'vfr', '-c:v', 'libx264', '-threads', '2', shiftedPath])
    const shifted = media.sourceFromProbe(shiftedPath, await media.probe(ffprobe, shiftedPath))
    expect(shifted.videoStart).toBeGreaterThanOrEqual(2)
    const options = normalizeOptions({ count: 1, targetSeconds: 1.2, width: 320, height: 180 })
    const output = path.join(folder, 'vfr-output.mp4')
    await media.render(ffmpeg, shifted, { sequence: [{ sourceStart: 0.1, sourceEnd: shifted.duration, frames: 36 }] }, options, output)
    expect((await media.verify(ffmpeg, ffprobe, output, options, false)).frames).toBe(36)
  }, 30000)

  it('applies source rotation once and preserves source-based representative re-export', async () => {
    const rotatedPath = path.join(folder, 'rotated.mp4')
    await media.run(ffmpeg, ['-v', 'error', '-y', '-display_rotation:v:0', '90', '-i', source.path, '-c', 'copy', rotatedPath])
    const rotated = media.sourceFromProbe(rotatedPath, await media.probe(ffprobe, rotatedPath))
    expect(rotated.width).toBe(180)
    expect(rotated.height).toBe(320)
    const options = normalizeOptions({ count: 1, targetSeconds: 2, width: 180, height: 320 })
    const output = path.join(folder, 'portrait.mp4')
    await media.render(ffmpeg, rotated, { sequence: [{ sourceStart: 0, sourceEnd: 2, frames: 60 }] }, options, output)
    expect((await media.verify(ffmpeg, ffprobe, output, options, true)).frames).toBe(60)
    const rotatedItem = { index: 1, signature: 'portrait', sequence: [{ sourceStart: 0, sourceEnd: 2, frames: 60 }] }
    const reopened = buildRepresentativeProject({ id: 'reopened', source: { ...rotated, sha256: 'portrait' }, options }, rotatedItem)
    reopened.assets[0].rotation = 90
    const reopenedOutput = path.join(folder, 'reopened-portrait.mp4')
    await media.run(ffmpeg, buildExportArguments({ preset: 'high', format: 'mp4', project: reopened }, reopenedOutput).args)
    expect((await media.verify(ffmpeg, ffprobe, reopenedOutput, options, true)).frames).toBe(60)
    const portraitPlan = buildExportArguments({ preset: 'high', format: 'mp4', project: reopened }, path.join(folder, 'unused.mp4'))
    expect(portraitPlan.args[portraitPlan.args.indexOf('-filter_complex') + 1]).not.toContain('transpose=')
    const standard = normalizeOptions({ count: 1, targetSeconds: 2, segmentSeconds: 1, width: 320, height: 180 })
    const [item] = await planOutputs(planSegments(source.duration, standard), standard)
    const representative = buildRepresentativeProject({ id: 'roundtrip', source: { ...source, sha256: 'abcdef' }, options: standard }, item)
    const roundtrip = path.join(folder, 'roundtrip.mp4')
    await media.run(ffmpeg, buildExportArguments({ preset: 'high', format: 'mp4', project: representative }, roundtrip).args)
    expect((await media.verify(ffmpeg, ffprobe, roundtrip, standard, true)).frames).toBe(60)
  }, 30000)
})
