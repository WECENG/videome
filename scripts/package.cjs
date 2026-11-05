const path = require('node:path')
const { spawn } = require('node:child_process')
const { root, checkMedia } = require('./media-tools.cjs')
async function main() {
  const target = process.argv[2]
  if ((target === 'mac' && process.platform !== 'darwin') || (target === 'win' && process.platform !== 'win32')) throw new Error('请在目标平台执行原生构建，Windows 使用 GitHub Actions。')
  await checkMedia(path.join(root, 'media-bin', `${process.platform}-${process.arch}`))
  const child = spawn(process.execPath, [require.resolve('electron-builder/cli.js'), `--${target}`, target === 'mac' ? '--arm64' : '--x64', '--publish', 'never'], { stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
  child.on('error', (error) => { console.error(error); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code || 0 })
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
