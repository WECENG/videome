import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAss } from '../src/domain.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const { buildExportArguments } = require('./export.cjs')
const { buildPreviewProxyArguments } = require('./preview.cjs')
const { locateTool } = require('./runtime.cjs')
const ffmpeg = locateTool('ffmpeg')
const ffprobe = locateTool('ffprobe')
let folder

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'videome-export-test-'))
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(folder, 'source.mp4'),
  ])
})

afterAll(async () => {
  if (folder) await rm(folder, { recursive: true, force: true })
})

describe('FFmpeg timeline export', () => {
  it('exports Windows software codecs, Unicode fonts and escaped subtitle paths', async () => {
    const special = path.join(folder, "素材 ' % [测试]")
    await mkdir(special)
    const input = path.join(special, '视频.mp4')
    await copyFile(path.join(folder, 'source.mp4'), input)
    const subtitlePath = path.join(special, "字幕 ' %.ass")
    await writeFile(subtitlePath, createAss([{ start: 0, end: 1, text: '中文 English 123' }], { width: 320, height: 180 }))
    const project = {
      duration: 1, frameSize: { width: 320, height: 180 }, frameRate: { numerator: 30, denominator: 1 },
      assets: [{ id: 'v', path: input, kind: 'video', audioCodec: 'aac' }],
      tracks: [{ id: 'v', type: 'video' }, { id: 'title', type: 'graphics', order: 1 }],
      clips: [{ id: 'v', assetId: 'v', kind: 'video', trackId: 'v', start: 0, duration: 1 }, { id: 't', kind: 'graphics', trackId: 'title', start: 0, duration: 1, text: '标题' }],
      subtitle: { cues: [{ start: 0, end: 1, text: '中文 English 123' }] },
    }
    for (const [codec, encoder] of [['h264', 'libx264'], ['hevc', 'libx265']]) {
      const output = path.join(special, `${codec}.mp4`)
      const plan = buildExportArguments({ preset: 'high', format: 'mp4', videoCodec: codec, project }, output, subtitlePath, { encoder })
      expect(plan.encoder).toBe(encoder)
      await execFileAsync(ffmpeg, plan.args, { maxBuffer: 8e6 })
      await execFileAsync(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'])
      const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output])
      expect(JSON.parse(stdout).streams.find((stream) => stream.codec_type === 'video').codec_name).toBe(codec)
    }
  }, 60000)
  it('generates an H.264 proxy that ffprobe can decode for browser playback', async () => {
    const input = path.join(folder, 'source.mp4')
    const proxy = path.join(folder, 'preview-proxy.mp4')
    await execFileAsync(ffmpeg, buildPreviewProxyArguments(input, proxy), { maxBuffer: 8 * 1024 * 1024 })
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height', '-of', 'json', proxy])
    const streams = JSON.parse(stdout).streams
    const video = streams.find((stream) => stream.codec_type === 'video')
    const audio = streams.find((stream) => stream.codec_type === 'audio')

    expect(video.codec_name).toBe('h264')
    expect(video.pix_fmt).toBe('yuv420p')
    expect(video.width).toBe(320)
    expect(video.height).toBe(180)
    expect(audio.codec_name).toBe('aac')
  }, 30_000)

  it('renders video with a separately linked audio lane and validates the output streams', async () => {
    const input = path.join(folder, 'source.mp4')
    const output = path.join(folder, 'rendered.partial.mkv')
    const project = {
      duration: 2,
      frameRate: { numerator: 30, denominator: 1 },
      frameSize: { width: 320, height: 180 },
      assets: [{ id: 'source', path: input, duration: 2, videoCodec: 'h264', audioCodec: 'aac' }],
      tracks: [{ id: 'video', type: 'video', order: 0 }, { id: 'audio', type: 'audio', order: 0 }],
      clips: [
        { id: 'picture', kind: 'video', trackId: 'video', assetId: 'source', start: 0, duration: 2, trimStart: 0, trimEnd: 2, audioLinked: true, volume: 0.8 },
        { id: 'sound', kind: 'audio', trackId: 'audio', assetId: 'source', linkedClipId: 'picture', start: 0, duration: 2, trimStart: 0, trimEnd: 2, volume: 0.8 },
      ],
      subtitle: { enabled: true, cues: [] },
    }
    const plan = buildExportArguments({ preset: 'lossless', format: 'mkv', project }, output)
    await execFileAsync(ffmpeg, plan.args, { maxBuffer: 8 * 1024 * 1024 })
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])
    const metadata = JSON.parse(stdout)
    expect(metadata.streams.filter((stream) => stream.codec_type === 'video')).toHaveLength(1)
    expect(metadata.streams.filter((stream) => stream.codec_type === 'audio')).toHaveLength(1)
    expect(Number(metadata.format.duration)).toBeGreaterThanOrEqual(1.9)
  }, 30_000)

  it('omits muted linked source audio in stream-copy exports', async () => {
    const input = path.join(folder, 'source.mp4')
    const output = path.join(folder, 'muted-source-audio.partial.mp4')
    const project = {
      duration: 2,
      frameRate: { numerator: 30, denominator: 1 },
      frameSize: { width: 320, height: 180 },
      assets: [{ id: 'source', path: input, duration: 2, videoCodec: 'h264', audioCodec: 'aac' }],
      tracks: [{ id: 'video', type: 'video', order: 0 }, { id: 'audio', type: 'audio', order: 0 }],
      clips: [
        { id: 'picture', kind: 'video', trackId: 'video', assetId: 'source', start: 0, duration: 2, audioLinked: true, volume: 0 },
        { id: 'sound', kind: 'audio', trackId: 'audio', assetId: 'source', linkedClipId: 'picture', start: 0, duration: 2, volume: 0 },
      ],
    }
    const plan = buildExportArguments({ preset: 'stream-copy', format: 'mp4', project }, output)
    await execFileAsync(ffmpeg, plan.args, { maxBuffer: 8 * 1024 * 1024 })
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output])
    expect(JSON.parse(stdout).streams.filter((stream) => stream.codec_type)).toEqual(expect.arrayContaining([
      expect.objectContaining({ codec_type: 'video' }),
    ]))
    expect(JSON.parse(stdout).streams.filter((stream) => stream.codec_type === 'audio')).toHaveLength(0)
  }, 30_000)

  it('applies subtitle-track offsets without mutating the source subtitle cues', () => {
    const ass = createAss([{ start: 4, end: 6, text: 'subtitle' }], { width: 320, height: 180 })
    expect(ass).toContain('Dialogue: 0,0:00:04.00,0:00:06.00')
    expect(ass).toContain('subtitle')
  })

  it('renders stacked picture, title, subtitles, music ducking, and fade filters', async () => {
    const input = path.join(folder, 'source.mp4')
    const music = path.join(folder, 'music.wav')
    const output = path.join(folder, 'composed.partial.mkv')
    const subtitlePath = path.join(folder, 'subtitles.ass')
    await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=2', music])
    await writeFile(subtitlePath, createAss([{ start: 0.3, end: 1.6, text: '你好，Videome' }], { width: 320, height: 180 }))
    const project = {
      duration: 2,
      frameRate: { numerator: 30, denominator: 1 },
      frameSize: { width: 320, height: 180 },
      assets: [
        { id: 'source', path: input, duration: 2, videoCodec: 'h264', audioCodec: 'aac' },
        { id: 'music', path: music, duration: 2, audioCodec: 'pcm_s16le' },
      ],
      tracks: [
        { id: 'video', type: 'video', order: 0 },
        { id: 'overlay', type: 'video', order: 1 },
        { id: 'titles', type: 'graphics', order: 2 },
        { id: 'dialogue', type: 'audio', order: 0 },
        { id: 'music', type: 'audio', order: 1 },
      ],
      clips: [
        { id: 'picture', kind: 'video', trackId: 'video', assetId: 'source', start: 0, duration: 2, trimStart: 0, trimEnd: 2, audioLinked: true, volume: 0.8 },
        { id: 'linked-audio', kind: 'audio', trackId: 'dialogue', assetId: 'source', linkedClipId: 'picture', start: 0, duration: 2, trimStart: 0, trimEnd: 2, volume: 0.8 },
        { id: 'overlay-video', kind: 'video', trackId: 'overlay', assetId: 'source', start: 0.4, duration: 1.1, trimStart: 0.2, trimEnd: 1.3, scale: 0.45, x: 0.25, audioLinked: false },
        { id: 'title', kind: 'graphics', trackId: 'titles', start: 0.2, duration: 1.5, text: '标题' },
        { id: 'music-clip', kind: 'audio', trackId: 'music', assetId: 'music', start: 0, duration: 2, trimStart: 0, trimEnd: 2, volume: 0.2, isMusic: true, autoDuck: true, fadeIn: 0.2, fadeOut: 0.5 },
      ],
      subtitle: { enabled: true, cues: [{ id: 'cue', start: 0.3, end: 1.6, text: '你好，Videome' }] },
    }
    const plan = buildExportArguments({ preset: 'lossless', format: 'mkv', project }, output, subtitlePath)
    await execFileAsync(ffmpeg, plan.args, { maxBuffer: 8 * 1024 * 1024 })
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])
    const metadata = JSON.parse(stdout)
    expect(metadata.streams.filter((stream) => stream.codec_type === 'video')).toHaveLength(1)
    expect(metadata.streams.filter((stream) => stream.codec_type === 'audio')).toHaveLength(1)
    expect(Number(metadata.format.duration)).toBeGreaterThanOrEqual(1.9)
  }, 30_000)
})
