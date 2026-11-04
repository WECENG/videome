const { spawn } = require('node:child_process')

const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let forcedExit
let timer
let completed = false
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)

function stop() {
  if (completed) return
  forcedExit = true
  child.kill('SIGTERM')
  timer ||= setTimeout(() => child.kill('SIGKILL'), 4000)
}

process.on('disconnect', stop)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
child.on('error', (error) => { process.stderr.write(error.message); process.exitCode = 1 })
child.on('close', (code, signal) => {
  completed = true
  clearTimeout(timer)
  process.exitCode = forcedExit ? 143 : signal ? 1 : code || 0
  if (process.connected) process.disconnect()
})
