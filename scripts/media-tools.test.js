import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { exec, extractWindowsZip } = require('./media-tools.cjs')

describe('Windows media extraction', () => {
  it('bypasses PATH tar and passes drive paths using encoded Unicode literals', async () => {
    const calls = []
    await extractWindowsZip("D:\\视频 素材\\it's ffmpeg.zip", 'D:\\输出 目录', {
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Program Files\\Git\\usr\\bin' },
      run: async (...args) => { calls.push(args) },
    })
    expect(calls).toHaveLength(1)
    const [binary, args, options] = calls[0]
    expect(binary).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(Buffer.from(args[3], 'base64').toString('utf16le')).toBe("$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('D:\\视频 素材\\it''s ffmpeg.zip', 'D:\\输出 目录')")
    expect(options).toEqual({ windowsHide: true })
  })

  it.runIf(process.platform === 'win32')('extracts an actual ZIP with Unicode paths despite PATH shadowing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'videome-解压 空格-'))
    try {
      const source = path.join(directory, '素材 文件.txt')
      const destination = path.join(directory, '输出 目录')
      const archive = path.join(directory, "it's 媒体 资源.zip")
      await mkdir(destination)
      // A fixed UTF-8 ZIP isolates extraction from fixture generation.
      await writeFile(archive, Buffer.from('UEsDBBQAAAgAAAAAZV0a/PlfFAAAABQAAAARAAAA57Sg5p2QIOaWh+S7ti50eHRWaWRlb21lIOS4reaWh+i3r+W+hFBLAQIUAxQAAAgAAAAAZV0a/PlfFAAAABQAAAARAAAAAAAAAAAAAACAAQAAAADntKDmnZAg5paH5Lu2LnR4dFBLBQYAAAAAAQABAD8AAABDAAAAAAA=', 'base64'))
      await extractWindowsZip(archive, destination, { run: (binary, args, options) => exec(binary, args, {
        ...options, env: { ...process.env, PATH: directory },
      }) })
      expect(await readFile(path.join(destination, path.basename(source)), 'utf8')).toBe('Videome 中文路径')
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 30000)
})
