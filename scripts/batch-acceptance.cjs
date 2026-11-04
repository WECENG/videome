const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { BatchMixManager } = require('../electron/batch/manager.cjs')
const { atomicJson } = require('../electron/batch/store.cjs')
const exec = promisify(execFile)

async function main() {
  const [sourcePath, destination] = process.argv.slice(2)
  if (!sourcePath || !destination) throw new Error('Usage: node scripts/batch-acceptance.cjs SOURCE OUTPUT_DIRECTORY')
  await fs.mkdir(destination, { recursive: true })
  const manager = new BatchMixManager({ root: path.join(destination, 'jobs'), ffmpeg: process.env.VIDEOME_FFMPEG || '/opt/homebrew/bin/ffmpeg', ffprobe: process.env.VIDEOME_FFPROBE || '/opt/homebrew/bin/ffprobe' })
  const report = { startedAt: new Date().toISOString(), sourcePath, width: 640, height: 360, targetSeconds: 30, runs: [] }
  let peakRssKiB = 0
  const sampler = setInterval(async () => {
    try {
      const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss='])
      const processes = stdout.split('\n').map((line) => line.trim().split(/\s+/).map(Number))
      const descendants = new Set([process.pid])
      for (let depth = 0; depth < 5; depth += 1) for (const [pid, parent] of processes) if (descendants.has(parent)) descendants.add(pid)
      const rss = processes.reduce((sum, [pid, _parent, memory]) => descendants.has(pid) ? sum + memory : sum, 0)
      peakRssKiB = Math.max(peakRssKiB, rss)
    } catch {}
  }, 1000)
  const wait = async (id, statuses) => {
    while (true) {
      const job = await manager.get(id)
      if (statuses.includes(job.status)) return job
      if (['analysis_failed', 'paused', 'partial_failed', 'cancelled'].includes(job.status)) throw new Error(`${job.status}: ${job.error || job.items.find((item) => item.error)?.error}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  try {
    for (const [concurrency, count] of [[1, 4], [2, 4], [4, 4], [2, 200]]) {
      peakRssKiB = 0
      const { jobId } = await manager.create({ sourcePath: path.resolve(sourcePath), outputDirectory: path.resolve(destination), count, concurrency,
        width: 640, height: 360, segmentSeconds: 3, targetSeconds: 30, seed: 'acceptance-fixed-seed', alignScenes: true })
      await wait(jobId, ['ready'])
      const started = Date.now()
      await manager.start(jobId)
      let lastPrinted = -1
      const progress = setInterval(async () => {
        const snapshot = await manager.get(jobId)
        if (snapshot.counts.completed !== lastPrinted) {
          lastPrinted = snapshot.counts.completed
          console.log(JSON.stringify({ concurrency, count, completed: lastPrinted, failed: snapshot.counts.failed, elapsedSeconds: Math.round((Date.now() - started) / 1000) }))
        }
      }, 10000)
      let job
      try { job = await wait(jobId, ['completed']) } finally { clearInterval(progress) }
      const elapsedSeconds = (Date.now() - started) / 1000
      const run = { jobId, concurrency, count, elapsedSeconds, outputsPerMinute: count / elapsedSeconds * 60,
        peakRssMiB: peakRssKiB / 1024, failed: job.counts.failed, uniqueSignatures: new Set(job.items.map((item) => item.signature)).size,
        outputBytes: job.items.reduce((sum, item) => sum + item.verification.size, 0), directory: job.outputDirectory,
        frames: [...new Set(job.items.map((item) => item.verification.frames))], encoders: [...new Set(job.items.map((item) => item.encoder))] }
      report.runs.push(run)
      await atomicJson(path.join(destination, 'acceptance-report.json'), report)
      console.log(JSON.stringify(run))
    }
  } finally {
    clearInterval(sampler)
    await manager.shutdown()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
