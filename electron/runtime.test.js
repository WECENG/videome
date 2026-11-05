import { createRequire } from 'node:module'
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
const require = createRequire(import.meta.url)
const { toolCandidates, encoderFor, safeFileName, nativePath, filterPath } = require('./runtime.cjs')
const { atomicJson } = require('./batch/store.cjs')
const { publishExclusive, checkOutputDirectory, syncDirectory } = require('./filesystem.cjs')
const media = require('./batch/media.cjs')

describe('cross-platform runtime', () => {
  it('uses only bundled tools in packaged apps and applies Windows executable suffix', () => {
    const options = { platform: 'win32', packaged: true, resourcesPath: '/app/resources', env: { VIDEOME_FFMPEG: '/override' } }
    expect(toolCandidates('ffmpeg', options)).toEqual([path.join('/app/resources', 'media-bin/ffmpeg.exe')])
    const candidates = toolCandidates('ffmpeg', { platform: 'win32', env: { VIDEOME_FFMPEG: '/explicit.exe', PATH: 'C:/tools;D:/媒体 工具' } })
    expect(candidates[0]).toBe('/explicit.exe')
    expect(candidates).toContain(path.join('D:/媒体 工具', 'ffmpeg.exe'))
  })
  it('chooses portable software encoders and Mac hardware encoders', () => {
    expect(encoderFor('h264', 'win32')).toBe('libx264')
    expect(encoderFor('hevc', 'win32')).toBe('libx265')
    expect(encoderFor('hevc', 'darwin')).toBe('hevc_videotoolbox')
    expect(encoderFor('hevc', 'darwin', true)).toBe('libx265')
  })
  it('normalizes filenames and preserves drive paths', () => {
    expect(safeFileName('CON.txt')).toBe('_CON.txt')
    expect(safeFileName('章节:<第一集>. ')).toBe('章节--第一集-')
    expect(nativePath('/C:/素材 空格/视频.mp4', 'win32')).toBe('C:/素材 空格/视频.mp4')
    expect(filterPath('C:\\素材\\字幕.ass')).toBe('C\\\\:/素材/字幕.ass')
  })
  it('persists valid snapshots and refuses to overwrite published output', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'videome-files-'))
    try {
      await checkOutputDirectory(directory)
      const target = path.join(directory, 'job.json')
      await atomicJson(target, { revision: 1 })
      await atomicJson(target, { revision: 2 })
      expect(JSON.parse(await readFile(`${target}.bak`, 'utf8')).revision).toBe(1)
      expect(JSON.parse(await readFile(target, 'utf8')).revision).toBe(2)
      const partial = path.join(directory, 'partial')
      const output = path.join(directory, 'output')
      await writeFile(partial, 'first'); await publishExclusive(partial, output)
      await writeFile(partial, 'second')
      await expect(publishExclusive(partial, output)).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(output, 'utf8')).toBe('first')
      expect((await readdir(directory)).some((name) => name.startsWith('.videome-check'))).toBe(false)
      await syncDirectory(directory, 'win32')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('cancels a guarded child without waiting for the long-running operation', async () => {
    const controller = new AbortController()
    const running = media.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, onLine: () => {} })
    setTimeout(() => controller.abort(new Error('cancelled by test')), 300)
    await expect(running).rejects.toThrow('cancelled by test')
  }, 15000)
})
