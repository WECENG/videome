const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const exec = promisify(execFile)
const root = path.resolve(__dirname, '..')

async function download(url, target, expectedSha256) {
  try {
    if (expectedSha256 && await digest(target) === expectedSha256) return target
  } catch {}
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.download`
  let response = await fetch(url, { signal: AbortSignal.timeout(180000), headers: { 'User-Agent': 'Videome-build' } })
  if (response.status === 401 && url.startsWith('https://ghcr.io/')) {
    const challenge = response.headers.get('www-authenticate') || ''
    const fields = Object.fromEntries([...challenge.matchAll(/(realm|service|scope)="([^"]+)"/g)].map((match) => [match[1], match[2]]))
    if (!fields.realm || !fields.scope || !fields.realm.startsWith('https://ghcr.io/')) throw new Error('无法获取 Homebrew bottle 只读令牌。')
    const tokenUrl = new URL(fields.realm); tokenUrl.searchParams.set('service', fields.service); tokenUrl.searchParams.set('scope', fields.scope)
    const token = await fetch(tokenUrl).then((value) => value.json())
    response = await fetch(url, { signal: AbortSignal.timeout(180000), headers: { Authorization: `Bearer ${token.token}` } })
  }
  if (!response.ok) throw new Error(`下载失败 (${response.status}): ${url}`)
  const handle = await fs.open(temporary, 'w')
  try { for await (const chunk of response.body) await handle.writeFile(chunk) } finally { await handle.close() }
  if (expectedSha256 && await digest(temporary) !== expectedSha256) { await fs.rm(temporary, { force: true }); throw new Error(`SHA-256 不匹配：${url}`) }
  await fs.rename(temporary, target)
  return target
}
async function digest(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of require('node:fs').createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function files(directory) {
  return (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(async (entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? files(file) : [file]
  }))).flat()
}
async function extractWindowsZip(archive, destination, { env = process.env, run = exec } = {}) {
  // Git Bash's tar treats the colon in D:\... as a remote-host separator.
  // Select Windows' bsdtar explicitly rather than resolving tar.exe via PATH.
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.WINDIR
  if (!systemRoot) throw new Error('无法定位 Windows 系统目录（SystemRoot）。')
  const binary = path.win32.join(systemRoot, 'System32', 'tar.exe')
  await run(binary, ['-xf', archive, '-C', destination], { windowsHide: true })
}
async function inspectMacBinary(file, minimum = 15) {
  const { stdout: architecture } = await exec('/usr/bin/lipo', ['-archs', file])
  if (architecture.trim() !== 'arm64') throw new Error(`媒体依赖架构错误：${file}: ${architecture}`)
  const { stdout } = await exec('/usr/bin/xcrun', ['vtool', '-show-build', file])
  const versions = [...stdout.matchAll(/minos\s+([\d.]+)/g)].map((match) => match[1].split('.').map(Number))
  if (!versions.length || versions.some(([major, minor = 0]) => major > minimum || (major === minimum && minor > 0))) throw new Error(`媒体依赖最低系统超过 macOS ${minimum} 或无法识别：${file}`)
  const { stdout: dependencies } = await exec('/usr/bin/otool', ['-L', file])
  if (/@@HOMEBREW_|\/opt\/homebrew\/|\/usr\/local\/|\/Cellar\//.test(dependencies)) throw new Error(`仍依赖外部 Homebrew：${file}`)
  for (const line of dependencies.split('\n').slice(1)) {
    const dependency = line.trim().split(' (')[0]
    if (dependency.startsWith('/') && !dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/')) throw new Error(`媒体依赖仍引用应用外文件：${dependency}`)
  }
}
async function inspectWindowsBinary(file) {
  const handle = await fs.open(file, 'r')
  try {
    const header = Buffer.alloc(64)
    await handle.read(header, 0, header.length, 0)
    if (header.readUInt16LE(0) !== 0x5a4d) throw new Error(`不是 Windows 可执行文件：${file}`)
    const pe = Buffer.alloc(6)
    await handle.read(pe, 0, pe.length, header.readUInt32LE(60))
    if (pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) throw new Error(`媒体工具不是 Windows x64：${file}`)
  } finally { await handle.close() }
}
async function checkMedia(directory, { execute = true, platform = process.platform, minimum = 15 } = {}) {
  if (platform === 'darwin') for (const file of await files(directory)) if (!/\.json$/.test(file) && !file.includes(`${path.sep}licenses${path.sep}`)) await inspectMacBinary(file, minimum)
  if (platform === 'win32') for (const name of ['ffmpeg.exe', 'ffprobe.exe']) await inspectWindowsBinary(path.join(directory, name))
  if (!execute) return
  const suffix = platform === 'win32' ? '.exe' : ''
  const ffmpeg = path.join(directory, `ffmpeg${suffix}`)
  const ffprobe = path.join(directory, `ffprobe${suffix}`)
  const { stdout: encoders } = await exec(ffmpeg, ['-hide_banner', '-encoders'], { maxBuffer: 8e6, windowsHide: true })
  const { stdout: filters } = await exec(ffmpeg, ['-hide_banner', '-filters'], { maxBuffer: 8e6, windowsHide: true })
  for (const name of ['libx264', 'libx265', 'aac', 'libvpx-vp9', 'libopus', 'ffv1']) if (!encoders.includes(name)) throw new Error(`缺少编码器 ${name}`)
  for (const name of ['drawtext', 'subtitles', 'concat', 'select', 'aresample']) if (!filters.includes(name)) throw new Error(`缺少滤镜 ${name}`)
  for (const tool of [ffmpeg, ffprobe]) {
    const { stdout } = await exec(tool, ['-version'], { windowsHide: true })
    console.log(stdout.split('\n')[0])
  }
}
module.exports = { root, exec, download, digest, files, extractWindowsZip, checkMedia, inspectWindowsBinary }
