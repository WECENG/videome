const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const exec = promisify(execFile)

async function bundle() {
  const root = path.resolve(__dirname, '../media-bin')
  const libraries = path.join(root, 'lib')
  await fs.mkdir(libraries, { recursive: true })
  const visited = new Map()
  const dependencyPaths = new Map()
  async function copyBinary(source, target) {
    const resolved = await fs.realpath(source)
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
        if (!dependencySource) throw new Error(`无法解析 ${resolved} 的依赖 ${dependency}`)
      } else if (dependency.startsWith('@loader_path/')) dependencySource = path.resolve(path.dirname(resolved), dependency.slice(13))
      else if (!dependency.startsWith('/opt/homebrew/') && !dependency.startsWith('/usr/local/')) continue
      const copied = await copyBinary(dependencySource, path.join(libraries, path.basename(dependencySource)))
      const relative = path.relative(path.dirname(target), copied)
      await exec('install_name_tool', ['-change', dependency, `@loader_path/${relative}`, target])
    }
    if (target.endsWith('.dylib')) await exec('install_name_tool', ['-id', `@loader_path/${path.basename(target)}`, target])
    return target
  }
  for (const name of ['ffmpeg', 'ffprobe']) {
    const source = process.env[`VIDEOME_${name.toUpperCase()}`] || `/opt/homebrew/bin/${name}`
    await copyBinary(source, path.join(root, name))
  }
  for (const target of visited.values()) await exec('codesign', ['--force', '--sign', '-', target])
  for (const target of visited.values()) {
    const { stdout } = await exec('otool', ['-L', target])
    if (/\/opt\/homebrew\/|\/usr\/local\//.test(stdout)) throw new Error(`媒体依赖仍引用本机库：${target}`)
  }
  for (const name of ['ffmpeg', 'ffprobe']) {
    const binary = path.join(root, name)
    const { stdout: dependencies } = await exec('otool', ['-L', binary])
    if (/\/opt\/homebrew\/|\/usr\/local\//.test(dependencies)) throw new Error('打包后的媒体工具仍依赖外部 Homebrew 库。')
    const { stdout } = await exec(binary, ['-version'], { env: { PATH: '/usr/bin:/bin' } })
    console.log(stdout.split('\n')[0])
  }
  console.log(`Bundled ${visited.size} binaries and libraries in ${root}`)
}

bundle().catch((error) => { console.error(error.message); process.exitCode = 1 })
