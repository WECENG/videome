import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { exec, extractWindowsZip } = require('./media-tools.cjs')

describe('Windows media extraction', () => {
  it('bypasses Git Bash tar and passes drive paths as separate arguments', async () => {
    const calls = []
    await extractWindowsZip('D:\\视频 素材\\ffmpeg.zip', 'D:\\输出 目录', {
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Program Files\\Git\\usr\\bin' },
      run: async (...args) => { calls.push(args) },
    })
    expect(calls).toEqual([[
      'C:\\Windows\\System32\\tar.exe',
      ['-xf', 'D:\\视频 素材\\ffmpeg.zip', '-C', 'D:\\输出 目录'],
      { windowsHide: true },
    ]])
  })

  it.runIf(process.platform === 'win32')('extracts an actual ZIP using Windows tar despite PATH shadowing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'videome-解压 空格-'))
    try {
      const source = path.join(directory, '素材 文件.txt')
      const destination = path.join(directory, '输出 目录')
      const archive = path.join(directory, '媒体 资源.zip')
      await writeFile(source, 'Videome 中文路径')
      await mkdir(destination)
      const powershell = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env.VIDEOME_ZIP_SOURCE -DestinationPath $env.VIDEOME_ZIP_ARCHIVE'], {
        env: { ...process.env, VIDEOME_ZIP_SOURCE: source, VIDEOME_ZIP_ARCHIVE: archive }, windowsHide: true,
      })
      await extractWindowsZip(archive, destination, { run: (binary, args, options) => exec(binary, args, {
        ...options, env: { ...process.env, PATH: directory },
      }) })
      expect(await readFile(path.join(destination, path.basename(source)), 'utf8')).toBe('Videome 中文路径')
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 30000)
})
