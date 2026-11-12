const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { syncDirectory, replaceFile } = require('../filesystem.cjs')

async function atomicJson(target, data, backup = true) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx')
  try {
    await handle.writeFile(JSON.stringify(data, null, 2))
    await handle.sync()
  } finally { await handle.close() }
  try {
    if (backup) {
      let validPrevious = false
      try { JSON.parse(await fs.readFile(target, 'utf8')); validPrevious = true }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
      if (validPrevious) await fs.copyFile(target, `${target}.bak`)
    }
    await replaceFile(temporary, target)
    await syncDirectory(path.dirname(target))
  } finally { await fs.rm(temporary, { force: true }) }
}

class JobStore {
  constructor(root) { this.root = root; this.writes = Promise.resolve() }

  save(job) {
    job.revision = (job.revision || 0) + 1
    job.updatedAt = new Date().toISOString()
    const snapshot = structuredClone(job)
    const write = this.writes.catch(() => {}).then(async () => {
      await atomicJson(path.join(this.root, snapshot.id, 'job.json'), snapshot)
      if (snapshot.outputDirectory && snapshot.items?.length) {
        await atomicJson(path.join(snapshot.outputDirectory, 'batch-manifest.json'), snapshot)
        const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
        const rows = [['index', 'sourceStart', 'sourceEnd', 'duration', 'status', 'output', 'signature', 'encoder', 'error'], ...snapshot.items.map((item) => [item.index, item.sourceStart, item.sourceEnd, item.verification?.duration ?? item.duration, item.status, item.outputPath, item.signature, item.encoder, item.error])]
        const target = path.join(snapshot.outputDirectory, 'batch-manifest.csv')
        const temporary = `${target}.${crypto.randomUUID()}.tmp`
        try { await fs.writeFile(temporary, '\uFEFF' + rows.map((row) => row.map(quote).join(',')).join('\n')); await replaceFile(temporary, target) }
        finally { await fs.rm(temporary, { force: true }) }
      }
    })
    this.writes = write
    return write
  }

  async loadAll() {
    await fs.mkdir(this.root, { recursive: true })
    const jobs = []
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('_')) continue
      for (const suffix of ['', '.bak']) {
        try {
          const job = JSON.parse(await fs.readFile(path.join(this.root, entry.name, `job.json${suffix}`), 'utf8'))
          if (job.id !== entry.name || job.schemaVersion !== 1 || !Array.isArray(job.items)) throw new Error('批次清单格式无效。')
          jobs.push(job)
          break
        } catch (error) {
          if (suffix) console.error(`[Videome batch] unable to restore ${entry.name}: ${error.message}`)
        }
      }
    }
    return jobs
  }
}

module.exports = { atomicJson, JobStore }
