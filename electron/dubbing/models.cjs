const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { run } = require('./process.cjs')
const { DubbingNetworkSettings, DEFAULT_SETTINGS, proxyEnvironment, usesProxy, redactNetworkError } = require('./network.cjs')

async function digest(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadWithCurl(asset, partial, { signal, progress, network = DEFAULT_SETTINGS } = {}) {
  // Electron's undici fetch can fail on long Hugging Face/GitHub transfers
  // even when the system network stack is healthy. curl uses the user's
  // configured proxy/TLS stack and has mature retry/resume behavior.
  const curl = process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl'
  let timer
  try {
    timer = setInterval(async () => {
      const loaded = await fs.stat(partial).then((stat) => stat.size).catch(() => 0)
      progress?.({ loaded, total: 0 })
    }, 500)
    await run(curl, [
      '-q', '--location', '--fail', '--silent', '--show-error', '--retry', '5', '--retry-delay', '2', '--retry-all-errors',
      ...(network.mode === 'direct' ? ['--proxy', '', '--noproxy', '*'] : []),
      '--connect-timeout', '30', '--continue-at', '-', '--output', partial, asset.url,
    ], { signal, timeout: 90 * 60_000, env: proxyEnvironment(network), inheritEnv: false })
  } finally {
    if (timer) clearInterval(timer)
  }
}

// A .partial survives connection failures. Only a verified file is published.
async function download(asset, target, { signal, progress, network = DEFAULT_SETTINGS } = {}) {
  try { if (await digest(target) === asset.sha256) return } catch {}
  const partial = `${target}.partial`
  try {
    await downloadWithCurl(asset, partial, { signal, progress, network })
    if (await digest(partial) === asset.sha256) {
      await fs.rename(partial, target)
      progress?.({ loaded: (await fs.stat(target)).size, total: (await fs.stat(target)).size })
      return
    }
    throw new Error(`${asset.name} 下载完成但 SHA-256 校验失败。`)
  } catch (error) {
    if (signal?.aborted) throw error
    // Native fetch does not reliably honor proxy variables. Never bypass a
    // configured proxy after a failed proxied transfer.
    if (network.mode !== 'environment' || usesProxy(network)) {
      const hint = network.mode === 'direct' ? '网络连接' : '代理配置'
      throw new Error(`${asset.name} 下载失败：${redactNetworkError(error, network)}。请检查${hint}，断点文件已保留。`)
    }
    // Keep the partial file and fall through to the Node downloader. This
    // also handles environments where curl is unavailable or blocked.
    const detail = redactNetworkError(error, network)
    progress?.({ networkWarning: `${asset.name}：${detail}；正在切换下载器。` })
  }
  let offset = await fs.stat(partial).then((stat) => stat.size).catch(() => 0)
  let loaded = offset; let total = 0; let last = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    signal?.throwIfAborted()
    let response
    try { response = await fetch(asset.url, { signal, headers: offset ? { Range: `bytes=${offset}-` } : {} }) }
    catch (error) {
      if (signal?.aborted || attempt === 4) throw new Error(`${asset.name} 下载失败：${error?.message || '网络连接失败'}。已保留断点文件，请重试。`)
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1))); continue
    }
    if (response.status === 416) {
      if (await digest(partial) === asset.sha256) { await fs.rename(partial, target); return }
      await fs.rm(partial, { force: true }); offset = 0; continue
    }
    if (!response.ok) throw new Error(`下载 ${asset.name} 失败 (${response.status})。可重试继续下载。`)
    if (response.status !== 206) offset = 0
    loaded = offset; total = offset + Number(response.headers.get('content-length') || 0)
    const handle = await fs.open(partial, offset ? 'a' : 'w')
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted()
        await handle.writeFile(chunk); loaded += chunk.length
        if (Date.now() - last > 200) { progress?.({ loaded, total }); last = Date.now() }
      }
      await handle.close()
      break
    } catch (error) {
      await handle.close().catch(() => {})
      offset = await fs.stat(partial).then((stat) => stat.size).catch(() => loaded)
      if (signal?.aborted || attempt === 4) throw new Error(`${asset.name} 下载失败：${error?.message || '网络连接中断'}。已保留断点文件，请重试。`)
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
    }
  }
  progress?.({ loaded, total })
  if (await digest(partial) !== asset.sha256) {
    await fs.rm(partial, { force: true })
    throw new Error(`${asset.name} SHA-256 校验失败，请重试。`)
  }
  await fs.rename(partial, target)
}

class DubbingModels extends EventEmitter {
  constructor({ root, resources, secureStorage, platform = process.platform, arch = process.arch }) {
    super(); this.root = root; this.resources = resources; this.platform = `${platform}-${arch}`
    this.manifest = require(path.join(resources, 'manifest.json'))
    this.directory = path.join(root, this.manifest.version)
    this.network = new DubbingNetworkSettings(root, secureStorage)
    this.state = { installing: false, ready: false, stage: '', error: null, loaded: 0, total: 0, currentAssetLoaded: 0, currentAssetTotal: 0, downloadedBytes: 0, totalBytes: 0, indeterminate: false }
  }
  get python() { return path.join(this.directory, 'python', 'bin', 'python3.11') }
  get llama() { return path.join(this.directory, 'build', 'bin', 'llama-cli') }
  async status() {
    const supported = this.platform === this.manifest.platform
    const marker = await fs.readFile(path.join(this.directory, 'installed.json'), 'utf8').then(JSON.parse).catch(() => null)
    const required = [this.python, this.llama, 'mrx.pth', 'small.en.bin', 'qwen3-4b.gguf', 'kokoro-multi-lang-v1_1/model.onnx'].map((file) => path.isAbsolute(file) ? file : path.join(this.directory, file))
    const present = await Promise.all(required.map((file) => fs.access(file).then(() => true).catch(() => false)))
    this.state.ready = supported && marker?.version === this.manifest.version && present.every(Boolean)
    return { ...this.state, supported, directory: this.directory, version: this.manifest.version, assets: this.manifest.assets.map(({ id, name }) => ({ id, name })), minimumFreeBytes: this.manifest.minimumFreeBytes }
  }
  notify(patch) { Object.assign(this.state, patch); this.emit('progress', { ...this.state }) }
  async networkSettings() { return this.network.publicSettings() }
  async saveNetworkSettings(settings) {
    if (this.installing) throw new Error('请先取消安装，等待停止后再修改代理。')
    return this.network.save(settings)
  }
  async testNetwork() {
    const settings = await this.network.read()
    const sites = [
      { name: 'GitHub', url: 'https://github.com' },
      { name: 'Hugging Face', url: 'https://huggingface.co' },
      { name: 'PyPI', url: 'https://pypi.org/simple/pip/' },
    ]
    return Promise.all(sites.map(async (site) => {
      try {
        await run(process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl', ['-q', '--head', '--location', '--fail', '--silent', '--show-error',
          '--connect-timeout', '10', '--max-time', '20', ...(settings.mode === 'direct' ? ['--proxy', '', '--noproxy', '*'] : []), site.url],
        { env: proxyEnvironment(settings), inheritEnv: false, timeout: 25_000 })
        return { name: site.name, ok: true }
      } catch (error) { return { name: site.name, ok: false, reason: redactNetworkError(error, settings) } }
    }))
  }
  install() {
    if (this.installing) return this.installing
    this.controller = new AbortController()
    this.installing = this.performInstall(this.controller.signal).catch(async (error) => {
      const settings = await this.network.read().catch(() => DEFAULT_SETTINGS)
      const failure = new Error(redactNetworkError(error, settings))
      this.notify({ installing: false, error: failure.message || '安装已取消。' })
      throw failure
    }).finally(() => { this.installing = null; this.controller = null })
    return this.installing
  }
  cancel() { this.controller?.abort() }
  async performInstall(signal) {
    if (this.platform !== this.manifest.platform) throw new Error('本地智能配音首版仅支持 Apple Silicon Mac。')
    const network = await this.network.read()
    await fs.mkdir(this.directory, { recursive: true })
    const disk = await fs.statfs(this.directory)
    if (Number(disk.bavail) * Number(disk.bsize) < this.manifest.minimumFreeBytes) throw new Error('安装需要至少 10 GB 可用空间。')
    const totalBytes = this.manifest.assets.reduce((sum, asset) => sum + Number(asset.size || 0), 0)
    this.notify({ installing: true, error: null, networkWarning: null, stage: '准备模型', loaded: 0, total: 0, downloadedBytes: 0, totalBytes, indeterminate: false })
    const downloads = path.join(this.root, 'downloads'); await fs.mkdir(downloads, { recursive: true })
    let completedBytes = 0
    for (const asset of this.manifest.assets) {
      signal.throwIfAborted()
      const assetSize = Number(asset.size || 0)
      this.notify({ stage: asset.name, loaded: 0, total: assetSize, currentAssetLoaded: 0, currentAssetTotal: assetSize, downloadedBytes: completedBytes, totalBytes, indeterminate: false })
      const target = asset.archive ? path.join(downloads, `${asset.id}-${asset.sha256}.${asset.archive === 'zip' ? 'zip' : 'tar'}`) : path.join(this.directory, asset.file)
      await download(asset, target, { signal, network, progress: (value) => this.notify({ ...value, loaded: value.loaded, total: assetSize, currentAssetLoaded: Math.min(assetSize, value.loaded || 0), currentAssetTotal: assetSize, downloadedBytes: Math.min(totalBytes, completedBytes + (value.loaded || 0)), totalBytes, indeterminate: false }) })
      completedBytes += assetSize
      this.notify({ loaded: assetSize, total: assetSize, currentAssetLoaded: assetSize, currentAssetTotal: assetSize, downloadedBytes: completedBytes, totalBytes, indeterminate: false })
      if (asset.archive) {
        this.notify({ stage: `解压 ${asset.name}`, indeterminate: true })
        await run(asset.archive === 'zip' ? '/usr/bin/unzip' : '/usr/bin/tar', asset.archive === 'zip' ? ['-qo', target, '-d', this.directory] : ['-xf', target, '-C', this.directory], { signal })
      }
    }
    this.notify({ stage: '安装已锁定的推理依赖', loaded: totalBytes, total: totalBytes, downloadedBytes: totalBytes, totalBytes, indeterminate: true })
    await run(this.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '--only-binary=:all:',
      ...(network.mode === 'direct' ? ['--proxy', ''] : []), '-r', path.join(this.resources, 'requirements.lock')],
    { signal, timeout: 30 * 60_000, env: proxyEnvironment(network), inheritEnv: false })
    this.notify({ stage: '验证本地运行环境', indeterminate: true })
    await run(this.python, ['-c', 'import torch, soundfile, sherpa_onnx; from pywhispercpp.model import Model'], { signal })
    await run(this.llama, ['--version'], { signal })
    await fs.writeFile(path.join(this.directory, 'installed.json'), JSON.stringify({ version: this.manifest.version, installedAt: new Date().toISOString(), assets: this.manifest.assets }))
    this.notify({ installing: false, ready: true, stage: '已安装，可断网使用' })
    return this.status()
  }
}
module.exports = { DubbingModels, download, digest }
