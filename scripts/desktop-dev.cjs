const { spawn } = require('node:child_process')
const path = require('node:path')
const { stopChild } = require('../electron/processes.cjs')

const root = path.resolve(__dirname, '..')
const server = spawn(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: root, stdio: 'inherit', windowsHide: true })
let desktop
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  if (desktop) stopChild(desktop)
  stopChild(server)
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
server.on('error', (error) => { console.error(error.message); stop(1) })
server.on('exit', (code) => stop(code || 0))
async function launch() {
  const deadline = Date.now() + 60000
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        desktop = spawn(require('electron'), ['.'], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' } })
        desktop.on('error', (error) => { console.error(error.message); stop(1) })
        desktop.on('exit', (code) => stop(code || 0))
        return
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!stopping) { console.error('Vite 启动超时。'); stop(1) }
}
void launch()
