const { execFile } = require('node:child_process')

function terminateTree(child, force = false) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return
  if (process.platform === 'win32') {
    // Only target a PID created by this application; never kill by executable name.
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true }, () => {})
  } else child.kill(force ? 'SIGKILL' : 'SIGTERM')
}

function stopChild(child) {
  terminateTree(child)
  const timer = setTimeout(() => terminateTree(child, true), 5000)
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}

module.exports = { terminateTree, stopChild }
