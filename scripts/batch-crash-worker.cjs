const { BatchMixManager } = require('../electron/batch/manager.cjs')
const media = require('../electron/batch/media.cjs')

async function main() {
  const [root, sourcePath, outputDirectory, phase] = process.argv.slice(2)
  const crash = () => process.kill(process.pid, 'SIGKILL')
  const manager = new BatchMixManager({ root, ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe', hooks: { [phase]: crash },
    engine: { ...media, verify: async (...args) => { if (phase === 'duringVerify') crash(); return media.verify(...args) } } })
  const { jobId } = await manager.create({ sourcePath, outputDirectory, count: 2, targetSeconds: 2, segmentSeconds: 1, width: 320, height: 180, concurrency: 1, alignScenes: false })
  while ((await manager.get(jobId)).status === 'analyzing') await new Promise((resolve) => setTimeout(resolve, 20))
  process.send?.({ jobId })
  await manager.start(jobId)
}

main().catch((error) => { console.error(error); process.exit(1) })
