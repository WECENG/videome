const fs = require('node:fs/promises')
const path = require('node:path')
const { exec } = require('./media-tools.cjs')
const { locateTool } = require('../electron/runtime.cjs')
async function main() {
  const folder = path.resolve(process.argv[2] || 'output/manual-acceptance/素材 空格')
  await fs.mkdir(folder, { recursive: true })
  await exec(locateTool('ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=90', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=90', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(folder, '长视频 测试.mp4')])
  console.log(folder)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
