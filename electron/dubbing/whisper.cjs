const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { run } = require('./process.cjs')
const { download, digest } = require('./models.cjs')
const { proxyEnvironment, redactNetworkError } = require('./network.cjs')
const { locateTool } = require('../runtime.cjs')

async function hasAudiblePcmWav(file, signal) {
  signal?.throwIfAborted()
  const handle = await fs.open(file, 'r')
  try {
    const header = Buffer.alloc(12)
    if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length
      || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('音频转换结果无效，无法识别。')
    const fileSize = (await handle.stat()).size
    let offset = 12, dataOffset = -1, dataSize = 0, audioFormat = 0, bitsPerSample = 0
    while (offset + 8 <= fileSize) {
      signal?.throwIfAborted()
      const chunk = Buffer.alloc(8)
      if ((await handle.read(chunk, 0, 8, offset)).bytesRead !== 8) break
      const name = chunk.toString('ascii', 0, 4), size = chunk.readUInt32LE(4)
      if (name === 'fmt ') {
        const format = Buffer.alloc(Math.min(size, 40))
        if (size < 16 || (await handle.read(format, 0, format.length, offset + 8)).bytesRead !== format.length) throw new Error('音频格式头无效，无法识别。')
        audioFormat = format.readUInt16LE(0); bitsPerSample = format.readUInt16LE(14)
      } else if (name === 'data') { dataOffset = offset + 8; dataSize = size; break }
      offset += 8 + size + (size & 1)
    }
    if (dataOffset < 0 || dataSize < 2) throw new Error('所选片段没有可读取的音频数据。')
    if (audioFormat !== 1 || bitsPerSample !== 16) return true
    const block = Buffer.alloc(64 * 1024)
    for (let position = 0; position + 1 < dataSize;) {
      signal?.throwIfAborted()
      const bytes = Math.min(block.length, dataSize - position) & ~1
      const read = await handle.read(block, 0, bytes, dataOffset + position)
      if (!read.bytesRead) break
      for (let index = 0; index + 1 < read.bytesRead; index += 2) {
        if (Math.abs(block.readInt16LE(index)) > 1) return true
      }
      position += read.bytesRead
    }
    return false
  } finally { await handle.close() }
}

function requirementsForWhisper(source) {
  const selected = new Set(['certifi', 'charset-normalizer', 'idna', 'numpy', 'platformdirs', 'pywhispercpp', 'requests', 'tqdm', 'urllib3'])
  const blocks = source.match(/^[\w.-]+==[^\n]*\\\n(?:^[ \t]+--hash=[^\n]*\\?\n)*/gm) || []
  const requirements = blocks.filter((block) => selected.has(block.match(/^([\w.-]+)==/)[1].toLowerCase().replaceAll('_', '-')))
  const included = new Set(requirements.map((block) => block.match(/^([\w.-]+)==/)[1].toLowerCase().replaceAll('_', '-')))
  if ([...selected].some((name) => !included.has(name))) throw new Error('Whisper 安装依赖锁文件不完整。')
  return requirements.join('')
}

class WhisperManager extends EventEmitter {
  constructor({ root, resources, models, ffmpeg, gate, onResourcesAvailable, onGateReleased, platform = process.platform, arch = process.arch, downloadAsset = download, hashFile = digest, runProcess = run, checkDependencies, checkPythonRuntime, findFfmpeg = locateTool }) {
    super()
    this.root = root
    this.resources = resources
    this.models = models
    this.ffmpeg = ffmpeg
    this.gate = gate
    this.onResourcesAvailable = onResourcesAvailable
    this.downloadAsset = downloadAsset
    this.hashFile = hashFile
    this.runProcess = runProcess
    this.checkDependencies = checkDependencies
    this.checkPythonRuntime = checkPythonRuntime
    this.onGateReleased = onGateReleased
    this.findFfmpeg = findFfmpeg
    this.platform = `${platform}-${arch}`
    this.state = { supported: this.platform === models.manifest.platform, ready: false, installing: false, recognizing: false, stage: '', error: null, loaded: 0, total: 0, downloadedBytes: 0, totalBytes: 0, currentAssetLoaded: 0, currentAssetTotal: 0, recognitionProgress: 0, indeterminate: false }
    this.controllers = new Set()
    this.installing = null
    this.recognizing = null
    this.installController = null
    this.recognitionController = null
    this.initialized = this.refreshStatus()
  }
  get directory() { return this.models.directory }
  get python() { return this.models.python }
  get model() { return path.join(this.directory, 'small.bin') }
  get marker() { return path.join(this.directory, 'whisper-installed.json') }
  get asset() { return this.models.manifest.subtitleWhisper }
  get runtimeAsset() { return this.models.manifest.assets.find((asset) => asset.id === 'python') }
  publish(patch) { Object.assign(this.state, patch); this.emit('progress', { ...this.state }) }
  async refreshStatus() {
    const [modelStat, marker] = await Promise.all([
      fs.stat(this.model).catch(() => null),
      fs.readFile(this.marker, 'utf8').then(JSON.parse).catch(() => null),
    ])
    const runtimeReady = await this.pythonRuntimeReady()
    const runtimeMatches = marker?.pythonRuntimeSha256 === this.runtimeAsset?.sha256
    const modelReady = modelStat?.size === Number(this.asset?.size) && marker?.modelSha256 === this.asset?.sha256 && marker?.version === this.models.manifest.version && runtimeMatches
      && await this.hashFile(this.model).then((value) => value === this.asset.sha256).catch(() => false)
    const dependenciesReady = runtimeReady && await this.dependenciesReady()
    this.publish({ supported: this.platform === this.models.manifest.platform, ready: Boolean(modelReady && dependenciesReady), modelPresent: Boolean(modelStat), modelReady: Boolean(modelReady), runtimeReady: Boolean(runtimeReady), dependenciesReady: Boolean(dependenciesReady) })
    return { ...this.state }
  }
  async status() { await this.initialized; return { ...this.state } }
  async dependenciesReady() {
    if (this.checkDependencies) return Boolean(await this.checkDependencies(this.python, this.directory))
    try {
      await this.runProcess(this.python, ['-c', 'import numpy, platformdirs, requests, tqdm; import _pywhispercpp'], {
        timeout: 20_000, env: { PYTHONNOUSERSITE: '1', PYTHONPATH: this.directory }, inheritEnv: false,
      })
      return true
    } catch { return false }
  }
  async pythonRuntimeReady() {
    if (this.checkPythonRuntime) return Boolean(await this.checkPythonRuntime(this.python))
    try {
      await this.runProcess(this.python, ['-c', 'import sys; sys.exit(0)'], {
        timeout: 10_000, env: { PYTHONNOUSERSITE: '1' }, inheritEnv: false,
      })
      return true
    } catch { return false }
  }
  install() {
    if (this.installing) return this.installing
    if (this.models.installing) {
      const error = new Error('智能配音模型正在安装，请完成后再安装 Whisper。')
      this.publish({ installing: false, error: error.message, stage: '无法开始安装' })
      return Promise.reject(error)
    }
    const owner = 'whisper-install'
    if (this.gate && !this.gate.acquire(owner)) {
      const error = new Error('媒体任务正在使用本机模型资源，请完成后再安装 Whisper。')
      this.publish({ installing: false, error: error.message, stage: '无法开始安装' })
      return Promise.reject(error)
    }
    const controller = new AbortController()
    this.installController = controller
    this.controllers.add(controller)
    this.models.whisperInstalling = true
    this.models.whisperManager = this
    this.publish({ installing: true, error: null, stage: '准备多语言 Whisper', loaded: 0, total: 0, downloadedBytes: 0, totalBytes: 0, indeterminate: true })
    this.installing = this.performInstall(controller.signal).catch(async (error) => {
      const network = await this.models.network.read().catch(() => undefined)
      const message = network ? redactNetworkError(error, network) : error.message
      const failure = controller.signal.aborted ? new Error('Whisper 安装已取消。') : new Error(message || 'Whisper 安装失败。')
      this.publish({ installing: false, error: controller.signal.aborted ? null : failure.message, stage: controller.signal.aborted ? '安装已取消' : '安装失败' })
      throw failure
    }).finally(async () => {
      this.installing = null
      this.installController = null
      this.controllers.delete(controller)
      this.models.whisperInstalling = false
      this.models.whisperManager = null
      this.gate?.release(owner)
      await this.refreshStatus().catch(() => {})
      this.onGateReleased?.()
      this.onResourcesAvailable?.()
    })
    return this.installing
  }
  cancelInstall() {
    if (!this.installController) return
    this.installController.abort()
    this.publish({ error: null, stage: '正在取消安装…', indeterminate: true })
  }
  async installDependencies(signal) {
    if (await this.dependenciesReady()) return
    const lockSource = await fs.readFile(path.join(this.resources, 'requirements.lock'), 'utf8')
    const lockPath = path.join(this.directory, 'whisper-requirements.lock')
    await fs.writeFile(lockPath, requirementsForWhisper(lockSource))
    const network = await this.models.network.read()
    try {
      await this.runProcess(this.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '--only-binary=:all:', '--force-reinstall', ...(network.mode === 'direct' ? ['--proxy', ''] : []), '-r', lockPath], {
        signal, timeout: 30 * 60_000, env: proxyEnvironment(network), inheritEnv: false,
      })
    } finally { await fs.rm(lockPath, { force: true }) }
    if (!await this.dependenciesReady()) throw new Error('Whisper 推理组件验证失败，请重试修复。')
  }
  async performInstall(signal) {
    await this.initialized
    if (!this.state.supported) throw new Error('本地多语言 Whisper 首版仅支持 Apple Silicon Mac。')
    if (!this.asset) throw new Error('未找到多语言 Whisper 模型配置。')
    if (await this.dependenciesReady()) this.publish({ dependenciesReady: true, stage: '复用已安装的 Whisper 推理组件' })
    const network = await this.models.network.read()
    await fs.mkdir(this.directory, { recursive: true })
    const disk = await fs.statfs(this.directory)
    const requiredBytes = Number(this.models.manifest.whisperMinimumFreeBytes) || 1_200_000_000
    if (Number(disk.bavail) * Number(disk.bsize) < requiredBytes) throw new Error('独立安装 Whisper 需要约 1.2 GB 可用空间。')
    const pythonAsset = this.runtimeAsset
    const pythonReady = await this.pythonRuntimeReady()
    const assets = [...(!pythonReady && pythonAsset ? [pythonAsset] : []), this.asset]
    const totalBytes = assets.reduce((sum, asset) => sum + Number(asset.size || 0), 0)
    this.publish({ installing: true, error: null, stage: '准备 Whisper 安装', loaded: 0, total: totalBytes, downloadedBytes: 0, totalBytes, currentAssetLoaded: 0, currentAssetTotal: 0, indeterminate: false })
    const downloads = path.join(this.root, 'downloads')
    await fs.mkdir(downloads, { recursive: true })
    let completedBytes = 0
    for (const asset of assets) {
      signal.throwIfAborted()
      const size = Number(asset.size || 0)
      const target = asset.archive ? path.join(downloads, `${asset.id}-${asset.sha256}.${asset.archive === 'zip' ? 'zip' : 'tar'}`) : path.join(this.directory, asset.file)
      this.publish({ stage: asset.name, currentAssetLoaded: 0, currentAssetTotal: size, downloadedBytes: completedBytes, totalBytes, indeterminate: false })
      await this.downloadAsset(asset, target, { signal, network, progress: (value) => this.publish({ currentAssetLoaded: Math.min(size, value.loaded || 0), downloadedBytes: Math.min(totalBytes, completedBytes + (value.loaded || 0)), totalBytes, indeterminate: false, ...(value.networkWarning ? { stage: value.networkWarning } : {}) }) })
      completedBytes += size
      this.publish({ currentAssetLoaded: size, downloadedBytes: completedBytes, totalBytes })
      if (asset.archive) {
        this.publish({ stage: `解压 ${asset.name}`, indeterminate: true })
        await this.runProcess('/usr/bin/tar', ['-xf', target, '-C', this.directory], { signal })
      }
    }
    signal.throwIfAborted()
    this.publish({ stage: '安装 Whisper 推理依赖', downloadedBytes: totalBytes, totalBytes, indeterminate: true })
    await this.installDependencies(signal)
    this.publish({ stage: '验证多语言 Whisper 模型', indeterminate: true, modelReady: false })
    if (await this.hashFile(this.model) !== this.asset.sha256) throw new Error('Whisper 模型校验失败，请重新安装。')
    await this.runProcess(this.python, ['-c', 'import sys; from pywhispercpp.model import Model; Model(sys.argv[1], n_threads=1, print_realtime=False, print_progress=False)', this.model], {
      signal, timeout: 120_000, env: { PYTHONNOUSERSITE: '1', PYTHONPATH: this.directory }, inheritEnv: false,
    })
    await fs.writeFile(this.marker, JSON.stringify({ version: this.models.manifest.version, modelSha256: this.asset.sha256, pythonRuntimeSha256: pythonAsset.sha256, model: this.asset.file, installedAt: new Date().toISOString() }, null, 2))
    this.publish({ installing: false, error: null, stage: '多语言 Whisper 已就绪，可离线识别', downloadedBytes: totalBytes, totalBytes, indeterminate: false })
    return { ...this.state }
  }
  async recognize({ path: sourcePath, trimStart = 0, duration }) {
    await this.initialized
    if (!this.state.ready) throw new Error('请先在字幕面板安装 Whisper 多语言模型。')
    if (this.recognizing) throw new Error('已有字幕识别任务正在运行。')
    if (this.models.installing || this.models.whisperInstalling) throw new Error('模型正在安装，请完成后再识别字幕。')
    if (this.gate && !this.gate.acquire('whisper')) throw new Error('本机媒体资源正在被其他任务使用，请稍后再识别字幕。')
    const controller = new AbortController()
    this.recognitionController = controller
    this.controllers.add(controller)
    this.models.whisperRecognizing = true
    this.models.whisperManager = this
    const folder = path.join(this.root, 'transcription', crypto.randomUUID())
    this.publish({ recognizing: true, error: null, stage: '准备识别音频', recognitionProgress: 0 })
    this.recognizing = (async () => {
      const ffmpeg = this.ffmpeg || this.findFfmpeg('ffmpeg')
      if (!ffmpeg) throw new Error('字幕识别需要 FFmpeg。')
      const numericStart = Number(trimStart), numericDuration = Number(duration)
      if (!Number.isFinite(numericStart) || numericStart < 0 || !Number.isFinite(numericDuration) || numericDuration <= 0 || numericDuration > 1800) throw new Error('所选音频片段时间范围无效。')
      await fs.mkdir(folder, { recursive: true })
      const input = path.join(folder, 'selected-audio.wav')
      await this.runProcess(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(numericStart), '-i', sourcePath, '-t', String(numericDuration), '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', input], { signal: controller.signal, timeout: 20 * 60_000 })
      if (!await hasAudiblePcmWav(input, controller.signal)) throw new Error('所选片段没有检测到有效声音，已跳过静音音频。')
      this.publish({ stage: '正在识别所选片段', recognitionProgress: 0 })
      let progressOutputBuffer = ''
      await this.runProcess(this.python, [path.join(this.resources, 'worker.py'), 'transcribe', '--models', this.directory, '--input', input, '--output', folder, '--model', this.model, '--multilingual', '--duration', String(numericDuration)], {
        signal: controller.signal, timeout: 60 * 60_000, env: { PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1', PYTHONPATH: this.directory }, inheritEnv: false,
        onOutput: (chunk) => {
          const lines = (progressOutputBuffer + chunk).split(/\r?\n/)
          progressOutputBuffer = lines.pop() || ''
          for (const line of lines) {
            try { const value = JSON.parse(line); if (Number.isFinite(value.progress)) this.publish({ stage: '正在识别所选片段', recognitionProgress: Math.max(0, Math.min(100, value.progress)) }) } catch {}
          }
        },
      })
      if (progressOutputBuffer) {
        try { const value = JSON.parse(progressOutputBuffer); if (Number.isFinite(value.progress)) this.publish({ stage: '正在识别所选片段', recognitionProgress: Math.max(0, Math.min(100, value.progress)) }) } catch {}
      }
      const cues = JSON.parse(await fs.readFile(path.join(folder, 'transcript.json'), 'utf8'))
      this.publish({ recognizing: false, stage: '识别完成', recognitionProgress: 100 })
      return cues
    })().catch((error) => {
      this.publish({ recognizing: false, error: controller.signal.aborted ? null : error.message || '字幕识别失败。', stage: controller.signal.aborted ? '识别已取消' : '识别失败' })
      throw error
    }).finally(async () => {
      this.recognizing = null
      this.recognitionController = null
      this.controllers.delete(controller)
      this.models.whisperRecognizing = false
      this.models.whisperManager = null
      this.gate?.release('whisper')
      await fs.rm(folder, { recursive: true, force: true }).catch(() => {})
      await this.refreshStatus()
      this.onGateReleased?.()
      this.onResourcesAvailable?.()
    })
    return this.recognizing
  }
  cancelRecognition() {
    if (!this.recognitionController) return
    this.recognitionController.abort()
    this.publish({ error: null, stage: '正在取消识别…', recognitionProgress: this.state.recognitionProgress || 0 })
  }
  cancelAll() { this.cancelInstall(); this.cancelRecognition() }
  async shutdown() {
    this.cancelAll()
    await Promise.allSettled([this.installing, this.recognizing].filter(Boolean))
  }
}

module.exports = { WhisperManager, requirementsForWhisper, hasAudiblePcmWav }
