const { spawn } = require('node:child_process')
const { stopChild } = require('../processes.cjs')

function run(binary, args, { signal, onOutput, cwd, env, inheritEnv = true, timeout = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('任务已取消。'))
    const child = spawn(binary, args, { cwd, env: inheritEnv ? { ...process.env, ...env } : env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''; let stderr = ''; let error; let timedOut = false
    const cancel = () => stopChild(child)
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => { timedOut = true; cancel() }, timeout)
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-2e6); onOutput?.(chunk.toString()) })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000); onOutput?.(chunk.toString()) })
    child.on('error', (value) => { error = value })
    child.on('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      if (signal?.aborted) reject(new Error('任务已取消。'))
      else if (timedOut) reject(new Error('本地推理超时，可重试任务。'))
      else if (error || code !== 0) reject(error || new Error(stderr.trim().split('\n').slice(-4).join('\n') || `本地进程退出 (${code})`))
      else resolve(stdout)
    })
  })
}
module.exports = { run }
