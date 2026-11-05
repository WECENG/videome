const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { exec } = require('./media-tools.cjs')
const { locateTool } = require('../electron/runtime.cjs')
async function main() {
  const result = { collectedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, os: os.release(), node: process.version, appVersion: require('../package.json').version, tools: {}, jobs: [] }
  for (const name of ['ffmpeg', 'ffprobe']) {
    const binary = locateTool(name)
    result.tools[name] = { path: binary, version: binary ? await exec(binary, ['-version']).then((value) => value.stdout.split('\n')[0]).catch((error) => error.message) : null }
  }
  const userData = process.env.VIDEOME_USER_DATA || (process.platform === 'win32' ? path.join(process.env.APPDATA, 'videome') : path.join(os.homedir(), 'Library/Application Support/videome'))
  try {
    for (const entry of await fs.readdir(path.join(userData, 'batch-mix'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue
      try {
        const job = JSON.parse(await fs.readFile(path.join(userData, 'batch-mix', entry.name, 'job.json'), 'utf8'))
        result.jobs.push({ id: job.id, status: job.status, error: job.error, sourceHash: job.source?.sha256, options: job.options, items: job.items.map(({ index, status, encoder, error, signature, verification }) => ({ index, status, encoder, error, signature, verification })) })
      } catch (error) { result.jobs.push({ id: entry.name, error: error.message }) }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const target = path.resolve(process.argv[2] || 'output/diagnostics.json')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify(result, null, 2))
  console.log(`诊断文件：${target}（发送前可检查素材路径及错误详情）`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
