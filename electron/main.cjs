const { app, BrowserWindow, dialog, ipcMain, protocol, shell, safeStorage } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { buildExportArguments, buildSubtitles, classifyAsset } = require('./export.cjs')
const { buildPreviewProxyArguments } = require('./preview.cjs')
const { managePreviewWindow } = require('./preview-window.cjs')
const { createProjectWriteQueue, normalizeProjectForPersistence, normalizeProjectName, projectBackupSourcePath, projectFileName, withProjectExtension, writeProjectBackup, writeProjectSnapshot } = require('./project.cjs')
const { BatchMixManager, ResourceGate, BackgroundLane } = require('./batch/manager.cjs')
const { registerBatchMixIpc } = require('./batch/ipc.cjs')
const { BatchSegmentManager } = require('./segment/manager.cjs')
const { registerBatchSegmentIpc } = require('./segment/ipc.cjs')
const { locateTool, fontResources, encoderFor, hardwareFailure, filterPath } = require('./runtime.cjs')
const { stopChild } = require('./processes.cjs')
const { DubbingModels } = require('./dubbing/models.cjs')
const { DubbingManager } = require('./dubbing/manager.cjs')
const { registerDubbingIpc } = require('./dubbing/ipc.cjs')
const { WhisperManager } = require('./dubbing/whisper.cjs')
const { TtsNetworkSettings } = require('./dubbing/tts-network.cjs')
const { MusicAnalysisService } = require('./music-analysis.cjs')
const { registerMusicAnalysisIpc } = require('./music-analysis-ipc.cjs')

const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173'
const projectFilter = [{ name: 'Videome 工程', extensions: ['videome'] }]
let exportProcess = null
const activeJobs = new Set()
const previewWindows = new Set()
const thumbnailRoots = new Set()
const previewProxyJobs = new Map()
const queueProjectWrite = createProjectWriteQueue()
const exportGate = new ResourceGate()
const backgroundLane = new BackgroundLane(exportGate)
const broadcastMusicAnalysis = (payload) => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('videome:music-analysis-progress', payload)
}
const musicAnalysisService = app.whenReady().then(async () => {
  const [ffmpeg, ffprobe] = await Promise.all([locateBinary('ffmpeg'), locateBinary('ffprobe')])
  const service = new MusicAnalysisService({ root: path.join(app.getPath('userData'), 'music-analysis'), ffmpeg, ffprobe, gate: exportGate })
  service.on('progress', broadcastMusicAnalysis)
  await service.initialized
  return service
})
registerMusicAnalysisIpc({ ipcMain, service: musicAnalysisService, authorize: authorizeExistingMedia })
const batchManager = app.whenReady().then(async () => {
  const [ffmpeg, ffprobe] = await Promise.all([locateBinary('ffmpeg'), locateBinary('ffprobe')])
  const service = new BatchMixManager({ root: path.join(app.getPath('userData'), 'batch-mix'), ffmpeg, ffprobe, gate: exportGate, hooks: { onGateReleased: () => { void batchSegmentManager.then((segmentService) => segmentService.pump()) } } })
  await service.initialized
  service.on('progress', (job) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('videome:batch-progress', job)
    }
  })
  return service
})
registerBatchMixIpc({ ipcMain, app, dialog, shell, manager: batchManager, authorize: authorizeExistingMedia, openProjectPath })
const batchSegmentManager = app.whenReady().then(async () => {
  const [ffmpeg, ffprobe] = await Promise.all([locateBinary('ffmpeg'), locateBinary('ffprobe')])
  const service = new BatchSegmentManager({ root: path.join(app.getPath('userData'), 'batch-segment'), ffmpeg, ffprobe, gate: exportGate, hooks: { onGateReleased: () => { void batchManager.then((mixService) => mixService.pump()) } } })
  await service.initialized
  service.on('progress', (job) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('videome:segment-progress', job)
  })
  return service
})
registerBatchSegmentIpc({ ipcMain, app, dialog, shell, manager: batchSegmentManager, authorize: authorizeExistingMedia })
const dubbingResources = app.isPackaged ? path.join(process.resourcesPath, 'dubbing') : path.join(__dirname, '..', 'resources', 'dubbing')
const broadcastDubbing = (payload) => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('videome:dubbing-progress', payload)
}
const dubbingModels = app.whenReady().then(() => {
  const models = new DubbingModels({ root: path.join(app.getPath('userData'), 'dubbing-models'), resources: dubbingResources, secureStorage: safeStorage })
  models.ttsNetwork = new TtsNetworkSettings(path.join(app.getPath('userData'), 'dubbing-assets'), safeStorage)
  models.on('progress', (state) => broadcastDubbing({ models: state }))
  return models
})
const whisperManager = app.whenReady().then(async () => {
  const [models, ffmpeg] = await Promise.all([dubbingModels, locateBinary('ffmpeg')])
  const whisper = new WhisperManager({ root: models.root, resources: dubbingResources, models, ffmpeg, gate: exportGate,
    onGateReleased: () => { void batchManager.then((service) => service.pump()); void batchSegmentManager.then((segmentService) => segmentService.pump()) },
  })
  whisper.on('progress', (state) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('videome:whisper-progress', state)
  })
  return whisper
})
const dubbingManager = app.whenReady().then(async () => {
  const [models, ffmpeg, ffprobe] = await Promise.all([dubbingModels, locateBinary('ffmpeg'), locateBinary('ffprobe')])
  const service = new DubbingManager({ root: path.join(app.getPath('userData'), 'dubbing-assets'), models, ffmpeg, ffprobe, resources: dubbingResources, gate: exportGate })
  await service.initialized
  service.on('progress', (job) => broadcastDubbing({ job }))
  service.on('removed', (removed) => broadcastDubbing({ removed }))
  return service
})
registerDubbingIpc({ ipcMain, service: dubbingManager, models: dubbingModels, whisper: whisperManager, authorize: authorizeExistingMedia, hasAudioTrack: async (mediaPath) => {
  const ffprobe = await locateBinary('ffprobe')
  if (!ffprobe) throw new Error('字幕识别需要 ffprobe。')
  const metadata = await probeMedia(mediaPath, ffprobe)
  if (!metadata.streams.some((stream) => stream.codec_type === 'audio')) throw new Error('所选素材没有可读取的音轨。')
  return true
} })
let pendingProjectPath = process.argv.find((argument) => argument.toLowerCase().endsWith('.videome')) || null
const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) {
  app.quit()
}

function readProjectPathArgument(argv = []) {
  return argv.find((argument) => typeof argument === 'string' && argument.toLowerCase().endsWith('.videome')) || null
}

function projectPayloadToOpenPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const project = payload.project && typeof payload.project === 'object' ? payload.project : payload
  return { ...payload, data: project }
}

async function openProjectPath(projectPath) {
  if (!projectPath) return null
  try {
    const resolvedPath = path.resolve(projectPath)
    const project = JSON.parse(await fs.readFile(resolvedPath, 'utf8'))
    const roots = [...new Set((project.assets || []).filter((asset) => asset?.path).map((asset) => path.dirname(asset.path)))]
    roots.push(path.dirname(resolvedPath))
    roots.forEach((root) => thumbnailRoots.add(root))
    return { path: resolvedPath, data: project }
  } catch (error) {
    console.error(`[Videome] failed to open project argument: ${error.message}`)
    return null
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'videome-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'videome-frame', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

function makeWindow() {
  const window = new BrowserWindow({
    width: 1680,
    height: 1080,
    minWidth: 1120,
    minHeight: 780,
    backgroundColor: '#f7f5f0',
    title: 'Videome',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 19 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (app.isPackaged) window.loadFile(path.join(__dirname, '../dist/index.html'))
  else {
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error(`[Videome] renderer load failed (${errorCode}): ${errorDescription} @ ${validatedURL}`)
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('[Videome] renderer process gone:', details)
    })
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level >= 2) console.error(`[Videome renderer] ${message} (${sourceId}:${line})`)
    })
    window.loadURL(devServerUrl)
  }

  return window
}

function locateBinary(name) {
  return Promise.resolve(locateTool(name, { packaged: app.isPackaged }))
}

function readVersion(binary, argument = '-version') {
  return new Promise((resolve) => {
    if (!binary) {
      resolve(null)
      return
    }

    const child = spawn(binary, [argument], { stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 2500)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      clearTimeout(timer)
      resolve(output.trim().split('\n')[0] || null)
    })
  })
}

async function identifyBinaries() {
  return Promise.all(['ffmpeg', 'ffprobe', 'melt'].map(async (name) => {
    const binary = await locateBinary(name)
    return { name, path: binary, version: await readVersion(binary, name === 'melt' ? '--version' : '-version') }
  }))
}

function probeMedia(filePath, ffprobePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe 已退出 (${code})`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function mediaDigest(filePath) {
  const stat = require('node:fs').statSync(filePath)
  return sha(`${filePath}\u0000${stat.size}\u0000${stat.mtimeMs}`)
}

function fileUrl(filePath) {
  return require('node:url').pathToFileURL(filePath).href
}

function parseRotation(videoStream) {
  const rotate = Number(videoStream?.tags?.rotate)
  if (Number.isFinite(rotate)) return ((rotate % 360) + 360) % 360
  const sideData = videoStream?.side_data_list?.find((item) => item.rotation !== undefined)
  const sideRotation = Number(sideData?.rotation)
  return Number.isFinite(sideRotation) ? ((Math.round(sideRotation) % 360) + 360) % 360 : 0
}

function resolveProbeDuration(metadata, videoStream, audioStream) {
  const streams = [videoStream, audioStream].filter(Boolean)
  const formatDuration = Number(metadata.format?.duration) || 0
  const streamDuration = Math.max(0, ...streams.map((stream) => Number(stream.duration) || 0))
  const timestampDuration = Math.max(0, ...streams.map((stream) => {
    const durationTs = Number(stream.duration_ts) || 0
    const [numerator, denominator] = String(stream.time_base || '').split('/').map(Number)
    const base = Number.isFinite(numerator) ? numerator / (Number.isFinite(denominator) && denominator !== 0 ? denominator : 1) : 0
    return durationTs * base
  }))
  const videoRate = videoStream ? rateValue(videoStream.avg_frame_rate || videoStream.r_frame_rate) : 0
  const frameDuration = videoRate > 0 ? (Number(videoStream.nb_frames) || 0) / videoRate : 0
  return Math.max(formatDuration, streamDuration, timestampDuration, frameDuration)
}

function rateValue(value) {
  const [numerator, denominator] = String(value || '').split('/').map(Number)
  if (!Number.isFinite(numerator)) return 0
  const rate = numerator / (Number.isFinite(denominator) && denominator !== 0 ? denominator : 1)
  return Number.isFinite(rate) && rate > 0 ? rate : 0
}

function makeThumbnail(mediaPath, ffmpegPath) {
  return backgroundLane.run(() => new Promise(async (resolve) => {
    const folder = path.join(app.getPath('cache'), 'videome', 'thumbnails')
    const target = path.join(folder, `${mediaDigest(mediaPath)}.jpg`)

    try {
      await fs.access(target)
      resolve(fileUrl(target))
      return
    } catch {
      await fs.mkdir(folder, { recursive: true })
      const child = spawn(ffmpegPath, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', '0.3', '-i', mediaPath,
        '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=420:-2', '-q:v', '4', target,
      ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })

      activeJobs.add(child)
      child.on('error', () => {
        activeJobs.delete(child)
        resolve(null)
      })
      child.on('close', (code) => {
        activeJobs.delete(child)
        resolve(code === 0 ? fileUrl(target) : null)
      })
    }
  }))
}

function getPosterUrl(filePath, ffmpegPath) {
  if (!ffmpegPath) return null
  const clean = filePath
  const key = sha(clean)
  thumbnailRoots.add(path.dirname(clean))
  return `videome-frame://thumbnail?path=${encodeURIComponent(clean)}&key=${key}`
}

function safeName(value) {
  return value.normalize('NFKD').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 58) || 'media'
}

function validateContainedPath(rawPath, roots) {
  const resolvedPath = path.resolve(String(rawPath || ''))
  const allowed = [...roots, os.tmpdir(), app.getPath('cache')]
  return allowed.some((root) => {
    const normalizedRoot = path.resolve(root)
    const relative = path.relative(normalizedRoot, resolvedPath)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  })
}

async function authorizeExistingMedia(rawPath) {
  const mediaPath = path.resolve(String(rawPath || ''))
  try {
    const stat = await fs.stat(mediaPath)
    if (!stat.isFile()) return null
    thumbnailRoots.add(path.dirname(mediaPath))
    return mediaPath
  } catch {
    return null
  }
}

app.whenReady().then(() => {
  if (!singleInstanceLock) return
  protocol.handle('videome-media', async (request) => {
    try {
      const url = new URL(request.url)
      const assetPath = url.searchParams.get('path') || decodeURIComponent(url.pathname)
      if (!validateContainedPath(assetPath, thumbnailRoots)) {
        return new Response('Forbidden', { status: 403 })
      }
      const stat = await fs.stat(assetPath)
      const extension = path.extname(assetPath).toLowerCase()
      const mime = ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[extension] || 'application/octet-stream'
      const rangeHeader = request.headers.get('range')
      const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/)
      const start = match ? Number(match[1] || 0) : 0
      const end = match && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
      if (start >= stat.size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
      }
      const handle = await fs.open(assetPath, 'r')
      const bytes = Buffer.alloc(end - start + 1)
      try {
        await handle.read(bytes, 0, bytes.length, start)
      } finally {
        await handle.close()
      }
      return new Response(bytes, {
        status: match ? 206 : 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(bytes.length),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          ...(match ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  protocol.handle('videome-frame', async (request) => {
    const url = new URL(request.url)
    const originalPath = url.searchParams.get('path')
    const timestamp = Math.max(0, Number(url.searchParams.get('time') || 0))
    const expectedKey = url.searchParams.get('key')
    const ffmpegPath = await locateBinary('ffmpeg')
    const ffprobePath = await locateBinary('ffprobe')

    if (!originalPath || !ffmpegPath || !ffprobePath || (expectedKey && sha(originalPath) !== expectedKey) || !validateContainedPath(originalPath, thumbnailRoots)) {
      return new Response('Invalid preview source', { status: 400 })
    }

    try {
      const digest = mediaDigest(originalPath)
      const safeTime = Math.floor(timestamp * 2) / 2
      const cacheFolder = path.join(app.getPath('cache'), 'videome', 'frames', safeName(path.basename(originalPath)), digest)
      const posterPath = path.join(cacheFolder, `${safeTime.toFixed(1)}.jpg`)
      thumbnailRoots.add(path.dirname(originalPath))

      try {
        await fs.access(posterPath)
      } catch {
        await fs.mkdir(cacheFolder, { recursive: true })
        await backgroundLane.run(() => new Promise((resolve, reject) => {
          const child = spawn(ffmpegPath, [
            '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(safeTime), '-i', originalPath,
            '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', posterPath,
          ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
          let output = ''
          child.stderr.on('data', (chunk) => { output += chunk.toString() })
          child.on('error', reject)
          child.on('close', (code) => code === 0 ? resolve() : reject(new Error(output)))
        }))
      }

      return new Response(await fs.readFile(posterPath), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000' } })
    } catch {
      return new Response('Unable to render video preview', { status: 422 })
    }
  })

  const mainWindow = makeWindow()
  if (pendingProjectPath) {
    const projectPath = pendingProjectPath
    pendingProjectPath = null
    mainWindow.webContents.once('did-finish-load', async () => {
      const opened = await openProjectPath(projectPath)
      if (opened && !mainWindow.isDestroyed()) mainWindow.webContents.send('videome:open-project-file', opened)
    })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length !== 0) return
    const window = makeWindow()
    if (!pendingProjectPath) return
    const projectPath = pendingProjectPath
    pendingProjectPath = null
    window.webContents.once('did-finish-load', async () => {
      const opened = await openProjectPath(projectPath)
      if (opened && !window.isDestroyed()) window.webContents.send('videome:open-project-file', opened)
    })
  })
})

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  pendingProjectPath = filePath
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) {
    if (app.isReady()) app.emit('activate')
    return
  }
  if (window.isMinimized()) window.restore()
  window.focus()
  openProjectPath(filePath).then((opened) => {
    if (opened && !window.isDestroyed()) window.webContents.send('videome:open-project-file', opened)
  })
})

app.on('second-instance', (_event, commandLine) => {
  const filePath = readProjectPathArgument(commandLine)
  const window = BrowserWindow.getAllWindows()[0]
  if (!filePath) return
  if (!window) {
    pendingProjectPath = filePath
    app.emit('activate')
    return
  }
  if (window.isMinimized()) window.restore()
  window.focus()
  openProjectPath(filePath).then((opened) => {
    if (opened && !window.isDestroyed()) window.webContents.send('videome:open-project-file', opened)
  })
})

ipcMain.handle('videome:media-tools', identifyBinaries)

ipcMain.handle('videome:pick-media', async (_event, extensions = []) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: extensions.length
      ? [{ name: '媒体素材', extensions }]
      : [{ name: '媒体与图片素材', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'mxf', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'aiff', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] }],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('videome:pick-audio', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音频素材', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'aiff', 'ogg'] }],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('videome:request-media', async (_event, requestedPaths) => {
  const mediaPaths = [...new Set((requestedPaths || []).map((value) => path.resolve(String(value || ''))).filter(Boolean))]
  if (!mediaPaths.length) {
    return { ok: false, reason: '没有可用的本地素材路径。' }
  }
  const authorizedPaths = await Promise.all(mediaPaths.map(async (mediaPath) => {
    if (validateContainedPath(mediaPath, thumbnailRoots)) return mediaPath
    return authorizeExistingMedia(mediaPath)
  }))
  if (authorizedPaths.some((mediaPath) => !mediaPath)) {
    return { ok: false, reason: '素材文件不存在或当前应用无法读取该路径。' }
  }
  authorizedPaths.forEach((mediaPath) => thumbnailRoots.add(path.dirname(mediaPath)))
  return { ok: true, files: await Promise.all(authorizedPaths.map(async (mediaPath) => ({ path: mediaPath, url: `videome-media://local?path=${encodeURIComponent(mediaPath)}`, mime: path.extname(mediaPath).toLowerCase() }))) }
})

ipcMain.handle('videome:create-preview-proxy', async (_event, rawPath) => {
  const sourcePath = path.resolve(String(rawPath || ''))
  if (!sourcePath) return { ok: false, reason: '源素材路径为空。' }
  if (!validateContainedPath(sourcePath, thumbnailRoots) && !(await authorizeExistingMedia(sourcePath))) {
    return { ok: false, reason: '源素材文件不存在或当前应用无法读取该路径。' }
  }

  const ffmpegPath = await locateBinary('ffmpeg')
  if (!ffmpegPath) return { ok: false, reason: '未找到 FFmpeg，无法创建兼容预览。' }

  const cacheFolder = path.join(app.getPath('cache'), 'videome', 'proxies')
  // Bump the cache key because earlier preview proxies omitted the source audio.
  const proxyPath = path.join(cacheFolder, `${mediaDigest(sourcePath)}-av2.mp4`)
  try {
    await fs.access(proxyPath)
    return { ok: true, url: `videome-media://local?path=${encodeURIComponent(proxyPath)}` }
  } catch {
    // Generate a cached H.264 proxy only when Chromium cannot decode the source.
  }

  const digest = mediaDigest(sourcePath)
  let job = previewProxyJobs.get(digest)
  if (!job) {
    job = (async () => {
      await fs.mkdir(cacheFolder, { recursive: true })
      const partialPath = `${proxyPath}.partial.mp4`
      try {
        await backgroundLane.run(() => new Promise((resolve, reject) => {
          const child = spawn(ffmpegPath, buildPreviewProxyArguments(sourcePath, partialPath), {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
          })
          let stderr = ''
          activeJobs.add(child)
          child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
          child.on('error', (error) => {
            activeJobs.delete(child)
            reject(error)
          })
          child.on('close', (code) => {
            activeJobs.delete(child)
            if (code === 0) resolve()
            else reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || `FFmpeg 退出 (${code})`))
          })
        }))
        const stat = await fs.stat(partialPath)
        if (!stat.size) throw new Error('预览代理文件为空。')
        await fs.rename(partialPath, proxyPath)
        return proxyPath
      } catch (error) {
        await fs.rm(partialPath, { force: true }).catch(() => {})
        throw error
      }
    })().finally(() => previewProxyJobs.delete(digest))
    previewProxyJobs.set(digest, job)
  }

  try {
    const generatedPath = await job
    return { ok: true, url: `videome-media://local?path=${encodeURIComponent(generatedPath)}` }
  } catch (error) {
    await fs.rm(proxyPath, { force: true }).catch(() => {})
    return { ok: false, reason: error.message || '创建兼容预览失败。' }
  }
})

ipcMain.handle('videome:pick-srt', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: '字幕文件', extensions: ['srt', 'ass', 'ssa', 'vtt'] }],
  })
  return result.canceled || !result.filePaths[0] ? null : { path: result.filePaths[0], content: await fs.readFile(result.filePaths[0], 'utf8') }
})

ipcMain.handle('videome:probe-media', async (_event, paths, options = {}) => {
  const [ffprobePath, ffmpegPath] = await Promise.all([locateBinary('ffprobe'), locateBinary('ffmpeg')])
  if (!ffprobePath) return paths.map((filePath) => ({ path: filePath, ok: false, reason: '未找到 ffprobe。请安装 FFmpeg 后重启应用。' }))

  return Promise.all(paths.map(async (filePath) => {
    try {
      thumbnailRoots.add(path.dirname(filePath))
      const [metadata, stat] = await Promise.all([probeMedia(filePath, ffprobePath), fs.stat(filePath)])
      const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video')
      const audioStream = metadata.streams.find((stream) => stream.codec_type === 'audio')
      const classify = classifyAsset({ path: filePath })
      let audioDuration = null

      if (audioStream?.duration) audioDuration = Number(audioStream.duration)
      else if (audioStream && videoStream && audioStream.sample_rate && audioStream.channels) audioDuration = Number(metadata.format.duration || 0)

      return {
        path: filePath,
        ok: true,
        name: path.basename(filePath),
        size: stat.size,
        duration: resolveProbeDuration(metadata, videoStream, audioStream),
        audioDuration,
        width: videoStream?.width || null,
        height: videoStream?.height || null,
        videoCodec: videoStream?.codec_name || null,
        audioCodec: audioStream?.codec_name || null,
        codec: videoStream?.codec_name || audioStream?.codec_name || null,
        frameRate: videoStream?.avg_frame_rate || videoStream?.r_frame_rate || null,
        pixelFormat: videoStream?.pix_fmt || null,
        rotation: parseRotation(videoStream),
        kind: classify,
        thumbnail: options.metadataOnly ? null : videoStream ? await makeThumbnail(filePath, ffmpegPath) : null,
        poster: options.metadataOnly ? null : videoStream ? getPosterUrl(filePath, ffmpegPath) : null,
      }
    } catch (error) {
      return { path: filePath, ok: false, name: path.basename(filePath), reason: error.message }
    }
  }))
})

ipcMain.handle('videome:emit-preview-frames', async (event, paths = []) => {
  const accepted = []
  const ffmpegPath = await locateBinary('ffmpeg')
  const ffprobePath = await locateBinary('ffprobe')
  if (!ffmpegPath || !ffprobePath) return { ok: false, reason: '创建本地预览需要 FFmpeg 和 ffprobe。' }

  for (const rawPath of [...new Set(paths)]) {
    try {
      const mediaPath = path.resolve(String(rawPath))
      if (!validateContainedPath(mediaPath, thumbnailRoots)) continue
      const metadata = await probeMedia(mediaPath, ffprobePath)
      const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video')
      if (!videoStream) continue
      const root = path.join(app.getPath('cache'), 'videome', 'previews', sha(mediaPath))
      await fs.mkdir(root, { recursive: true })
      thumbnailRoots.add(root)
      const item = { path: mediaPath, width: videoStream.width || null, height: videoStream.height || null, duration: Number(metadata.format.duration || videoStream.duration || 0), frames: [] }
      const sampleCount = item.duration > 50 ? 15 : 10
      for (let index = 0; index < sampleCount; index += 1) {
        const time = Math.min(Math.max(0, item.duration - .05), index * item.duration / sampleCount)
        const framePath = path.join(root, `${index}.jpg`)
        try {
          await fs.access(framePath)
        } catch {
          await backgroundLane.run(() => new Promise((resolve) => {
            const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, time)), '-i', mediaPath, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '4', framePath], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
            child.on('error', () => resolve(false))
            child.on('close', (code) => resolve(code === 0))
          }))
        }
        try {
          await fs.access(framePath)
          item.frames.push({ time, url: pathToFileURL(framePath).href })
          thumbnailRoots.add(path.dirname(framePath))
        } catch {
          // Keep the usable portions of a media file even if an isolated seek fails.
        }
      }
      accepted.push(item)
    } catch (error) {
      accepted.push({ path: rawPath, error: error.message })
    }
  }

  if (!event.sender.isDestroyed()) event.sender.send('videome:preview-event', { frames: accepted })
  return { ok: true, items: accepted.map(({ path: mediaPath, frames, error }) => ({ path: mediaPath, frameCount: frames?.length || 0, error })) }
})

function safeProjectBase() {
  return app.getPath('documents')
}

ipcMain.handle('videome:storage-locations', () => ({
  dataDirectory: app.getPath('userData'),
  defaultProjectDirectory: safeProjectBase(),
  platform: process.platform,
}))

ipcMain.handle('videome:show-project-in-folder', async (_event, filePath) => {
  try {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.videome') throw new Error('请先保存工程文件。')
    const resolved = await fs.realpath(filePath)
    if (!(await fs.stat(resolved)).isFile()) throw new Error('工程文件不存在。')
    shell.showItemInFolder(resolved)
    return { ok: true }
  } catch (error) { return { ok: false, reason: error.message } }
})

ipcMain.handle('videome:open-project', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [...projectFilter, { name: '所有文件', extensions: ['*'] }],
  })
  if (result.canceled || !result.filePaths[0]) return null

  return openProjectPath(result.filePaths[0])
})

ipcMain.handle('videome:save-project', async (_event, payload = {}) => {
  const { project, currentPath = null, defaultDirectory = null } = payload || {}
  const safeProject = normalizeProjectForPersistence(project)
  const baseDirectory = defaultDirectory ? path.resolve(String(defaultDirectory)) : safeProjectBase()
  const defaultPath = currentPath || path.join(baseDirectory, `${projectFileName(safeProject.name)}.videome`)
  const result = currentPath
    ? { canceled: false, filePath: currentPath }
    : await dialog.showSaveDialog({ defaultPath, filters: projectFilter })
  if (result.canceled || !result.filePath) return null

  const selectedPath = withProjectExtension(result.filePath)
  return queueProjectWrite(selectedPath, async () => {
    const roots = [...new Set((safeProject.assets || []).filter((asset) => asset.path).map((asset) => path.dirname(asset.path)))]
    roots.push(path.dirname(selectedPath))
    roots.forEach((root) => thumbnailRoots.add(root))
    return writeProjectSnapshot(selectedPath, safeProject)
  })
})

ipcMain.handle('videome:choose-project-location', async (_event, project) => {
  const result = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('documents'), `${projectFileName(project?.name || 'Videome 项目')}.videome`),
    filters: projectFilter,
  })
  if (result.canceled || !result.filePath) return null
  return { path: withProjectExtension(result.filePath) }
})

ipcMain.handle('videome:write-project', async (_event, payload = {}) => {
  const { project, path: selectedPath } = payload || {}
  if (!selectedPath) return null
  const safeProject = normalizeProjectForPersistence(project)
  const root = path.dirname(selectedPath)
  return queueProjectWrite(selectedPath, async () => {
    const roots = [...new Set((safeProject.assets || []).filter((asset) => asset.path).map((asset) => path.dirname(asset.path)))]
    roots.push(root)
    roots.forEach((entry) => thumbnailRoots.add(entry))
    return writeProjectSnapshot(selectedPath, safeProject)
  })
})

ipcMain.handle('videome:backup-project', async (_event, payload = {}) => {
  const { project, path: projectPath } = payload || {}
  const safeProject = normalizeProjectForPersistence(project)
  return queueProjectWrite(projectBackupSourcePath(projectPath), () => writeProjectBackup(projectPath, safeProject))
})

ipcMain.handle('videome:save-strings', async (_event, { content, defaultFileName, type = 'srt' }) => {
  const result = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath(type === 'png' ? 'pictures' : 'documents'), defaultFileName),
    filters: [{ name: type.toUpperCase(), extensions: [type] }],
  })
  if (result.canceled || !result.filePath) return null
  const outputPath = result.filePath.endsWith(`.${type}`) ? result.filePath : `${result.filePath}.${type}`
  await fs.writeFile(outputPath, content)
  return { path: outputPath }
})

ipcMain.handle('videome:export-frame', async (_event, { asset, time, width, height, subtitle }) => {
  const ffmpegPath = await locateBinary('ffmpeg')
  if (!ffmpegPath) return { ok: false, reason: '未找到 FFmpeg。' }
  const result = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('pictures'), 'videome-cover.png'),
    filters: [{ name: 'PNG 图像', extensions: ['png'] }],
  })
  if (result.canceled || !result.filePath) return null

  const outputPath = result.filePath.endsWith('.png') ? result.filePath : `${result.filePath}.png`
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-ss', String(Math.max(0, Number(time) || 0)), '-i', asset.path, '-frames:v', '1']
  const w = Math.max(2, Math.round((Number(width) || 1920) / 2) * 2)
  const h = Math.max(2, Math.round((Number(height) || 1080) / 2) * 2)
  const videoFilters = [`scale=${w}:${h}:force_original_aspect_ratio=decrease`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`]
  if (subtitle?.text?.trim()) videoFilters.push(`drawtext=fontfile=${filterPath(fontResources({ packaged: app.isPackaged }).fontFile)}:text='${require('./export.cjs').escapeFilterString(subtitle.text)}':fontcolor=white:fontsize=${Math.max(18, Number(subtitle.fontSize) || 42)}:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-text_h-${Math.max(24, Number(subtitle.bottomPadding) || 90)}`)
  args.push('-vf', videoFilters.join(','), outputPath)

  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let errors = ''
    child.stderr.on('data', (chunk) => { errors += chunk.toString() })
    child.on('error', (error) => resolve({ ok: false, reason: error.message }))
    child.on('close', async (code) => {
      if (code === 0) {
        try {
          await fs.access(outputPath)
          resolve({ ok: true, path: outputPath })
        } catch (error) {
          resolve({ ok: false, reason: error.message })
        }
      } else {
        resolve({ ok: false, reason: errors.split(/\r?\n/).filter(Boolean).at(-1) || `ffmpeg exit ${code}` })
      }
    })
  })
})

ipcMain.handle('videome:export', async (event, { settings, project }) => {
  if (!exportGate.acquire('ordinary')) return { ok: false, reason: '已有普通导出或批量混剪正在运行。' }
  try {

  for (const asset of project.assets || []) {
    if (!asset.path) continue
    const normalized = path.resolve(asset.path)
    if (validateContainedPath(normalized, thumbnailRoots)) thumbnailRoots.add(path.dirname(normalized))
  }

  const ffmpegPath = await locateBinary('ffmpeg')
  const ffprobePath = await locateBinary('ffprobe')
  if (!ffmpegPath || !ffprobePath) return { ok: false, reason: '导出需要已安装的 FFmpeg 和 ffprobe。请先安装 FFmpeg 并重启应用。' }

  const size = Number(settings.expectedSizeBytes || 0)

  const defaultPath = path.join(app.getPath('videos'), `${projectFileName(settings.fileName || project.name || 'Videome')}-export.${settings.format}`)
  const save = await dialog.showSaveDialog({
    defaultPath,
    filters: [{ name: String(settings.format || 'mp4').toUpperCase(), extensions: [String(settings.format || 'mp4')] }],
  })
  if (save.canceled || !save.filePath) return null

  const format = String(settings.format || 'mp4').toLowerCase()
  const outputPath = save.filePath.toLowerCase().endsWith(`.${format}`) ? save.filePath : `${save.filePath}.${format}`
  const disk = await fs.statfs(path.dirname(outputPath))
  if (size && Number(disk.bavail) * Number(disk.bsize) < size * 1.16) return { ok: false, reason: '导出目标磁盘空间不足。' }
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${Date.now()}.partial.${format}`)
  const subtitles = buildSubtitles(project, project.frameSize || { width: 1920, height: 1080 }).map((cue) => ({ ...cue, end: cue.start + cue.duration }))
  const subtitlePath = subtitles.length ? path.join(os.tmpdir(), `videome-${crypto.randomUUID()}.ass`) : null
  const escapeAss = (value) => String(value).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N').replace(/[<>]/g, '')

  if (subtitlePath) {
    const height = Number(project.frameSize?.height || 1080)
    const fontSize = Math.round((Number(project.subtitle?.fontSize || 42) * height) / 1080)
    const marginV = Math.max(16, Math.round((Number(project.subtitle?.bottomPadding || 92) * height) / 1080))
    const styleName = 'VideomeDefault'
    const script = [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${Number(project.frameSize?.width || 1920)}`, `PlayResY: ${height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
      '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: ${styleName},${fontResources().fontFamily},${fontSize},&H00FFFFFF,&H0000FFFF,&H0016171B,&H82000000,0,0,0,0,100,100,0,0,1,3,0.5,2,60,60,${marginV},1`, '',
      '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...subtitles.map((cue) => {
        const totalCentiseconds = (seconds) => Math.round(Number(seconds) * 100)
        const convertTime = (seconds) => {
          const value = totalCentiseconds(seconds)
          const hours = Math.floor(value / 360000)
          const minutes = Math.floor((value % 360000) / 6000)
          const secs = Math.floor((value % 6000) / 100)
          const centis = value % 100
          return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
        }
        return `Dialogue: 0,${convertTime(cue.start)},${convertTime(cue.end)},${styleName},,0,0,0,,${escapeAss(cue.text)}`
      }),
    ].join('\n')
    await fs.writeFile(subtitlePath, script, 'utf8')
  }

  let plan
  try {
    plan = buildExportArguments({ ...settings, preset: settings.preset, format, project }, temporaryPath, subtitlePath, fontResources({ packaged: app.isPackaged }))
  } catch (error) {
    if (subtitlePath) await fs.rm(subtitlePath, { force: true })
    return { ok: false, reason: error.message }
  }

  const startedAt = new Date().toISOString()
  const sendProgress = (data) => {
    if (!event.sender.isDestroyed()) event.sender.send('videome:export-progress', data)
  }

  return await new Promise((resolve) => {
    let errors = ''
    let pendingOutput = ''
    let lastSize = null
    let lastGrowth = Date.now()

    let retried = false
    let settled = false
    const settle = (result) => { if (!settled) { settled = true; resolve(result) } }
    const launch = () => {
      exportProcess = spawn(ffmpegPath, plan.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      activeJobs.add(exportProcess)

      const report = (key, value) => {
        if (key === 'out_time_ms') {
          const progress = Math.max(0, Math.min(99, Number(value) / 10_000 / plan.duration * 100))
          sendProgress({ percent: progress, elapsed: Math.round((Date.now() - new Date(startedAt).getTime()) / 1000), output: outputPath })
        } else if (key === 'progress' && value === 'end') {
          sendProgress({ percent: 99.5, output: outputPath })
        }
      }

      const handleStdout = (chunk) => {
        pendingOutput += chunk.toString()
        const lines = pendingOutput.split(/\r?\n/)
        pendingOutput = lines.pop() || ''
        for (const line of lines) {
          const index = line.indexOf('=')
          if (index > 0) report(line.slice(0, index), line.slice(index + 1))
        }
      }

      exportProcess.stdout.on('data', handleStdout)
      exportProcess.stderr.on('data', (chunk) => { errors = `${errors}${chunk.toString()}`.slice(-12000) })
      sendProgress({ percent: 0, output: outputPath })

      const watchdog = setInterval(async () => {
        try {
          const sizeNow = (await fs.stat(temporaryPath)).size
          if (sizeNow > lastSize) {
            lastSize = sizeNow
            lastGrowth = Date.now()
            sendProgress({ percent: 1, indeterminate: true, output: outputPath, size: sizeNow })
          } else if (Date.now() - lastGrowth > 150000) {
            exportProcess && (exportProcess.videomeCancelled = true, stopChild(exportProcess))
          }
        } catch {
          // The output has not been created yet, or the encoder has already exited.
        }
      }, 15000)

      const thisProcess = exportProcess
      let spawnError
      exportProcess.on('error', (error) => { spawnError = error })
      /* cleanup is performed exactly once by close */
      exportProcess.on('close', async (code) => {
        if (settled) return
        try {
          const completedJob = thisProcess
          activeJobs.delete(completedJob)
          if (code !== 0 && !retried && !completedJob.videomeCancelled && !spawnError && /videotoolbox$/.test(plan.encoder || '') && hardwareFailure(new Error(errors))) {
            retried = true
            clearInterval(watchdog)
            await fs.rm(temporaryPath, { force: true })
            plan = buildExportArguments({ ...settings, format, project }, temporaryPath, subtitlePath, { ...fontResources({ packaged: app.isPackaged }), encoder: encoderFor(settings.videoCodec, process.platform, true) })
            errors = ''; pendingOutput = ''; lastGrowth = Date.now(); lastSize = null
            launch()
            return
          }
          exportProcess = null
          if (spawnError) {
            const error = spawnError
            clearInterval(watchdog)
            if (subtitlePath) await fs.rm(subtitlePath, { force: true })
            await fs.rm(temporaryPath, { force: true })
            settle({ ok: false, reason: error.message })
            return
          }
          clearInterval(watchdog)
          if (subtitlePath) await fs.rm(subtitlePath, { force: true })

          if (code === 0) {
            try {
              await fs.rename(temporaryPath, outputPath)
              const verification = await probeMedia(outputPath, ffprobePath)
              if (!verification.streams.some((stream) => stream.codec_type === 'video')) {
                await fs.rm(outputPath, { force: true })
                settle({ ok: false, reason: '導出文件没有可读取的视频流。' })
                return
              }
              sendProgress({ percent: 100, output: outputPath })
              settle({ ok: true, path: outputPath, duration: Number(verification.format.duration || 0), streams: verification.streams.length, encoder: plan.encoder, startedAt })
            } catch (error) {
              await fs.rm(outputPath, { force: true })
              settle({ ok: false, reason: `导出文件验证未通过：${error.message}` })
            }
          } else {
            await fs.rm(temporaryPath, { force: true })
            const issue = errors.split(/\r?\n/).filter((line) => /error|invalid|unable|not found|failed|unrecognized|impossible|no such|unsupported/i.test(line)).at(-1)
            settle({ ok: false, reason: issue?.replace(/^\[[^\]]+\]\s*/, '').trim() || `FFmpeg 处理失败 (exit ${code})` })
          }
        } catch (error) {
          clearInterval(watchdog)
          activeJobs.delete(thisProcess)
          exportProcess = null
          await Promise.all([temporaryPath, subtitlePath].filter(Boolean).map((file) => fs.rm(file, { force: true }).catch(() => {})))
          settle({ ok: false, reason: error.message })
        }
      })
    }
    launch()
  })
  } finally {
    exportGate.release('ordinary')
    void batchManager.then((service) => service.pump()); void batchSegmentManager.then((service) => service.pump())
  }
})

ipcMain.handle('videome:cancel-export', () => {
  if (!exportProcess) return false
  exportProcess.videomeCancelled = true
  stopChild(exportProcess)
  return true
})

ipcMain.handle('videome:open-preview', async (event, asset) => {
  try {
    if (!asset?.path) return { ok: false, reason: '没有可预览的本地素材路径。' }
    const mediaPath = await authorizeExistingMedia(asset.path)
    if (!mediaPath) return { ok: false, reason: '找不到素材文件或文件无法访问。' }
    const tools = await identifyBinaries()
    const ffprobePath = tools.find((tool) => tool.name === 'ffprobe')?.path
    const metadata = ffprobePath ? await probeMedia(mediaPath, ffprobePath) : null
    const stream = metadata?.streams?.find((item) => item.codec_type === 'video')
    if (!stream) return { ok: false, reason: '所选素材中没有可预览的视频流。' }
    const width = Number(stream.width || 1280)
    const height = Number(stream.height || 720)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const window = new BrowserWindow({
      width: Math.min(1680, Math.max(720, width)),
      height: Math.min(1120, Math.max(480, height + 84)),
      minWidth: 640,
      minHeight: 420,
      backgroundColor: '#080b10',
      title: asset.name || 'Videome · 预览',
      ...(parent ? { parent } : {}),
      webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
    })
    previewWindows.add(window)
    managePreviewWindow(window, { owner: parent })
    window.once('closed', () => previewWindows.delete(window))
    const escapedUrl = JSON.stringify(`videome-media://local?path=${encodeURIComponent(mediaPath)}`)
    const escapedName = JSON.stringify(asset.name || path.basename(mediaPath))
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${String(asset.name || 'Videome').replace(/[<>"'&]/g, '')}</title><style>*{box-sizing:border-box}body{margin:0;background:#090b0f;color:#ece8df;font:14px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}main{height:100vh;display:flex;flex-direction:column}.bar{height:54px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 14px 0 20px;background:#111419;border-bottom:1px solid #ffffff10}.bar-copy{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar span{opacity:.65;font:11px ui-monospace}.close{flex:0 0 auto;border:1px solid #ffffff24;border-radius:6px;background:#ffffff0d;color:#ece8df;padding:7px 12px;cursor:pointer;font:12px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}.close:hover{background:#ffffff1a}.close:focus-visible{outline:2px solid #9fc5a8;outline-offset:2px}video{width:100%;height:calc(100vh - 54px);object-fit:contain;background:#06080a}video::-webkit-media-controls{filter:invert(.9) hue-rotate(175deg)}</style><main><div class="bar"><div class="bar-copy" id="name"></div><span>LOCAL PREVIEW</span><button class="close" id="close" type="button">关闭预览</button></div><video id="media" controls autoplay playsinline></video></main><script>document.getElementById('media').src=${escapedUrl};document.getElementById('name').textContent=${escapedName};document.getElementById('close').addEventListener('click',()=>window.videome?.closePreviewWindow?.());document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.fullscreenElement)window.videome?.closePreviewWindow?.()})</script></html>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error.message || '无法创建独立预览窗口。' }
  }
})

ipcMain.handle('videome:close-preview-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || !previewWindows.has(window)) return { ok: false, reason: '预览窗口已关闭。' }
  window.close()
  return { ok: true }
})

let finishedShutdown = false
app.on('before-quit', (event) => {
  if (finishedShutdown || !singleInstanceLock) return
  event.preventDefault()
  backgroundLane.stopping = true
  for (const job of activeJobs) { job.videomeCancelled = true; stopChild(job) }
  void Promise.all([batchManager.then((service) => service.shutdown()), batchSegmentManager.then((service) => service.shutdown()), dubbingManager.then((service) => service.shutdown()), whisperManager.then((service) => service.shutdown()), musicAnalysisService.then((service) => service.shutdown())]).finally(() => { finishedShutdown = true; app.quit() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error))
