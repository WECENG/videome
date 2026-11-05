import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import os from 'node:os'
import { afterAll, beforeAll, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { BatchMixManager } = require('./manager.cjs')
const media = require('./media.cjs')
const { locateTool } = require('../runtime.cjs')
let folder
let source

beforeAll(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'videome-crash-'))
  source = path.join(folder, 'source.mp4')
  await media.run(locateTool('ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=8', '-c:v', 'libx264', '-threads', '2', source])
}, 30000)
afterAll(async () => { await rm(folder, { recursive: true, force: true }) })

for (const phase of ['beforeRender', 'duringVerify', 'beforePublish', 'afterPublish']) {
  it(`recovers a forced process exit at ${phase}`, async () => {
    const root = path.join(folder, phase)
    const child = fork(path.resolve('scripts/batch-crash-worker.cjs'), [root, source, folder, phase], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let errors = ''
    child.stderr.on('data', (chunk) => { errors += chunk.toString() })
    const [message] = await once(child, 'message')
    const [, signal] = await once(child, 'exit')
    if (process.platform !== 'win32') expect(signal, errors).toBe('SIGKILL')
    else expect(message.jobId).toBeTruthy()
    const manager = new BatchMixManager({ root, ffmpeg: locateTool('ffmpeg'), ffprobe: locateTool('ffprobe') })
    try {
      await manager.initialized
      const interrupted = await manager.get(message.jobId)
      expect(interrupted.status).toBe('interrupted')
      const published = phase === 'afterPublish' ? await stat(interrupted.items[0].outputPath) : null
      await manager.resume(message.jobId)
      let finished
      for (let attempt = 0; attempt < 600; attempt += 1) {
        finished = await manager.get(message.jobId)
        if (['completed', 'partial_failed', 'paused'].includes(finished.status)) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(finished.status, finished.error || finished.items.find((item) => item.error)?.error).toBe('completed')
      expect(finished.counts.completed).toBe(2)
      expect((await readdir(finished.outputDirectory)).some((name) => name.includes('.partial'))).toBe(false)
      if (published) expect((await stat(finished.items[0].outputPath)).mtimeMs).toBe(published.mtimeMs)
    } finally { await manager.shutdown() }
  }, 90000)
}
