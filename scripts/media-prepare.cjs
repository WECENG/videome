const fs = require('node:fs/promises')
const path = require('node:path')
const { root, exec, download, digest, files, checkMedia } = require('./media-tools.cjs')
const manifest = require('../resources/media-sources.json')

async function prepare() {
  if (!['darwin-arm64', 'win32-x64'].includes(`${process.platform}-${process.arch}`)) throw new Error('本轮仅支持 darwin-arm64 和 win32-x64。')
  const destination = path.join(root, 'media-bin', `${process.platform}-${process.arch}`)
  const cache = path.join(root, 'output', 'media-downloads')
  const fonts = path.join(root, 'resources', 'fonts')
  await fs.mkdir(fonts, { recursive: true })
  await download(manifest.font.url, path.join(fonts, 'NotoSansCJKsc-Regular.otf'), manifest.font.sha256)
  await download(manifest.font.licenseUrl, path.join(fonts, 'LICENSE.txt'), manifest.font.licenseSha256)
  if (process.env.VIDEOME_MEDIA_IMPORT) {
    const source = await fs.realpath(process.env.VIDEOME_MEDIA_IMPORT)
    if (source === path.resolve(destination)) throw new Error('导入资源不能与目标目录相同。')
    await checkMedia(process.env.VIDEOME_MEDIA_IMPORT)
    await fs.rm(destination, { recursive: true, force: true })
    await fs.cp(process.env.VIDEOME_MEDIA_IMPORT, destination, { recursive: true })
  } else if (process.platform === 'win32') {
    const source = manifest.windows
    const archive = await download(source.url, path.join(cache, `ffmpeg-${source.version}-win64.zip`), source.sha256)
    const extracted = path.join(cache, 'windows-extracted')
    await fs.rm(extracted, { recursive: true, force: true })
    await fs.mkdir(extracted, { recursive: true })
    await exec('tar.exe', ['-xf', archive, '-C', extracted])
    const candidates = await files(extracted)
    await fs.rm(destination, { recursive: true, force: true })
    await fs.mkdir(destination, { recursive: true })
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      const sourceFile = candidates.find((file) => path.basename(file) === name)
      if (!sourceFile) throw new Error(`媒体资源缺少 ${name}`)
      await fs.copyFile(sourceFile, path.join(destination, name))
    }
    await fs.mkdir(path.join(destination, 'licenses'), { recursive: true })
    for (const file of candidates.filter((file) => /(?:license|copying|readme)/i.test(path.basename(file)))) await fs.copyFile(file, path.join(destination, 'licenses', path.basename(file)))
    await fs.writeFile(path.join(destination, 'build-info.json'), JSON.stringify(source, null, 2))
  } else {
    // A clean sequoia bottle tree also lets a newer Mac prepare macOS 15-compatible binaries.
    const cellar = path.join(cache, 'macos15-cellar')
    const formulae = new Map()
    const lock = require('../resources/macos-media-lock.json')
    for (const record of lock.bottles) formulae.set(record.name, { name: record.name, versions: { stable: record.version }, revision: record.revision || 0, bottle: { stable: { files: { arm64_sequoia: { url: record.url, sha256: record.sha256 } } } }, urls: { stable: record.source }, license: record.license })
    const records = []
    // Bound downloads to avoid saturating the workstation or Actions runner.
    const pending = [...formulae.values()]
    await fs.mkdir(cellar, { recursive: true })
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (pending.length) {
        const formula = pending.shift()
        const bottle = formula.bottle?.stable?.files?.arm64_sequoia || formula.bottle?.stable?.files?.all
        if (!bottle) throw new Error(`缺少 macOS 15 arm64 bottle：${formula.name}`)
        const archive = await download(bottle.url, path.join(cache, `${formula.name}-${bottle.sha256}.tar.gz`), bottle.sha256)
        await exec('/usr/bin/tar', ['-xzf', archive, '-C', cellar])
        records.push({ name: formula.name, version: formula.versions.stable, revision: formula.revision || 0, url: bottle.url, sha256: bottle.sha256, source: formula.urls.stable, license: formula.license })
      }
    }))
    const { bundle } = require('./bundle-media.cjs')
    const directories = new Map()
    for (const name of formulae.keys()) {
      const formula = formulae.get(name)
      const version = formula.versions.stable + (formula.revision ? `_${formula.revision}` : '')
      const directory = path.join(cellar, name, version)
      await fs.access(directory)
      directories.set(name, directory)
    }
    await bundle({ destination, ffmpeg: path.join(directories.get('ffmpeg-full'), 'bin', 'ffmpeg'), ffprobe: path.join(directories.get('ffmpeg-full'), 'bin', 'ffprobe'), directories })
    await fs.mkdir(path.join(destination, 'licenses'), { recursive: true })
    for (const [name, directory] of directories) for (const file of await fs.readdir(directory)) if (/^(?:LICENSE|COPYING|NOTICE)/i.test(file) && (await fs.stat(path.join(directory, file))).isFile()) await fs.copyFile(path.join(directory, file), path.join(destination, 'licenses', `${name}-${file}`))
    await fs.writeFile(path.join(destination, 'build-info.json'), JSON.stringify({ minimumMacOS: '15.0', bottles: records }, null, 2))
  }
  await checkMedia(destination)
  console.log(`媒体资源已准备：${destination}; font SHA-256 ${await digest(path.join(fonts, 'NotoSansCJKsc-Regular.otf'))}`)
}
prepare().catch((error) => { console.error(error); process.exitCode = 1 })
