const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const exec = promisify(execFile)

async function bundle({ destination, ffmpeg, ffprobe, directories } = {}) {
  const root = destination || path.resolve(__dirname, '../media-bin/darwin-arm64')
  await fs.rm(root, { recursive: true, force: true })
  const libraries = path.join(root, 'lib')
  await fs.mkdir(libraries, { recursive: true })
  const visited = new Map()
  const dependencyPaths = new Map()
  async function copyBinary(source, target) {
    let mapped = source.replace('@@HOMEBREW_CELLAR@@', '/opt/homebrew/Cellar').replace('@@HOMEBREW_PREFIX@@', '/opt/homebrew')
    if (directories) {
      const match = mapped.match(/^(?:\/opt\/homebrew|\/usr\/local)\/(?:opt|Cellar)\/([^/]+)\/(.*)/)
      if (match && directories.has(match[1])) {
        let tail = match[2]
        if (mapped.includes('/Cellar/')) tail = tail.replace(/^[^/]+\//, '')
        mapped = path.join(directories.get(match[1]), tail)
      }
    }
    const resolved = await fs.realpath(mapped)
    if (visited.has(resolved)) return visited.get(resolved)
    if (dependencyPaths.has(target) && dependencyPaths.get(target) !== resolved) throw new Error(`动态库文件名冲突：${target}`)
    dependencyPaths.set(target, resolved)
    visited.set(resolved, target)
    await fs.copyFile(resolved, target)
    await fs.chmod(target, 0o755)
    const { stdout } = await exec('otool', ['-L', resolved])
    const commands = await exec('otool', ['-l', resolved])
    const rpaths = [...commands.stdout.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g)].map((match) => match[1].replace('@loader_path', path.dirname(resolved)))
    for (const line of stdout.split('\n').slice(1)) {
      const dependency = line.trim().split(' (')[0]
      if (dependency === resolved) continue
      let dependencySource = dependency
      if (dependency.startsWith('@rpath/')) {
        dependencySource = null
        for (const base of [...rpaths, path.dirname(resolved)]) {
          const candidate = path.join(base, dependency.slice(7))
          try { await fs.access(candidate); dependencySource = candidate; break } catch {}
        }
        if (!dependencySource && directories) {
          for (const directory of directories.values()) {
            const candidate = path.join(directory, 'lib', path.basename(dependency))
            try { await fs.access(candidate); dependencySource = candidate; break } catch {}
          }
        }
        if (!dependencySource) throw new Error(`无法解析 ${resolved} 的依赖 ${dependency}`)
      } else if (dependency.startsWith('@loader_path/')) dependencySource = path.resolve(path.dirname(resolved), dependency.slice(13))
      else if (!dependency.startsWith('/opt/homebrew/') && !dependency.startsWith('/usr/local/') && !dependency.startsWith('@@HOMEBREW_')) continue
      const copied = await copyBinary(dependencySource, path.join(libraries, path.basename(dependencySource)))
      const relative = path.relative(path.dirname(target), copied)
      await exec('install_name_tool', ['-change', dependency, `@loader_path/${relative}`, target])
    }
    if (target.endsWith('.dylib')) await exec('install_name_tool', ['-id', `@loader_path/${path.basename(target)}`, target])
    return target
  }
  for (const name of ['ffmpeg', 'ffprobe']) {
    const source = (name === 'ffmpeg' ? ffmpeg : ffprobe) || process.env[`VIDEOME_${name.toUpperCase()}`] || `/opt/homebrew/bin/${name}`
    await copyBinary(source, path.join(root, name))
  }
  for (const target of visited.values()) await exec('codesign', ['--force', '--sign', '-', target])
  for (const target of visited.values()) {
    const { stdout } = await exec('otool', ['-L', target])
    if (/@@HOMEBREW_|\/opt\/homebrew\/|\/usr\/local\//.test(stdout)) throw new Error(`媒体依赖仍引用本机库：${target}`)
  }
  for (const name of ['ffmpeg', 'ffprobe']) {
    const binary = path.join(root, name)
    const { stdout: dependencies } = await exec('otool', ['-L', binary])
    if (/@@HOMEBREW_|\/opt\/homebrew\/|\/usr\/local\//.test(dependencies)) throw new Error('打包后的媒体工具仍依赖外部 Homebrew 库。')
    const { stdout } = await exec(binary, ['-version'], { env: { PATH: '/usr/bin:/bin' } })
    console.log(stdout.split('\n')[0])
  }
  console.log(`Bundled ${visited.size} binaries and libraries in ${root}`)
}

module.exports = { bundle }
if (require.main === module) bundle().catch((error) => { console.error(error.message); process.exitCode = 1 })
