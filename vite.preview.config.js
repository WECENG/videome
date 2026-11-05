import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createReadStream } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildExportArguments } = require('./electron/export.cjs')
const { toolCandidates, fontResources, nativePath, encoderFor, hardwareFailure } = require('./electron/runtime.cjs')
const { stopChild } = require('./electron/processes.cjs')
const { createAss } = await import('./src/domain.js')

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url))
const PATH_ROOTS = new Set([PROJECT_ROOT])
const SESSION_KEY = randomBytes(32).toString('hex')
const EXPORT_JOBS = new Map()

function normalizeFilePath(requestPath) {
  return path.resolve(nativePath(requestPath))
}

function withinAnyRoot(targetPath) {
  return [...PATH_ROOTS, os.tmpdir(), path.join(os.homedir(), 'Movies'), path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Downloads')]
    .some((root) => {
      const relative = path.relative(path.resolve(root), targetPath)
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    })
}

function guessMime(filePath) {
  return ({
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  })[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function command(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `${binary} exited ${code}`)))
  })
}

function resolveTool(name) {
  return toolCandidates(name)
}

function withTimeout(operation, ms = 60_000) {
  return Promise.race([operation, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('本地媒体操作超时。')), ms))])
}

function createPreviewApi() {
  return {
    name: 'videome-local-preview',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!String(request.url || '').startsWith('/__videome/api')) { next(); return }
        const url = new URL(request.url || '/', 'http://localhost')
        const endpoint = url.pathname.replace(/^\/__videome\/api/, '')
        const respond = (status, value) => {
          response.statusCode = status
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(JSON.stringify(value))
        }

        try {
          if (!isLocalOrigin(request)) { respond(403, { error: 'The local media API only accepts same-origin requests.' }); return }
          const publicEndpoint = endpoint === '/health' || endpoint === '/tools'
          if (!publicEndpoint && !checkSession(request)) { respond(403, { error: 'This request is not authorized for the local media session.' }); return }

          if (endpoint === '/health') {
            respond(200, { ok: true, mode: 'local-preview', token: SESSION_KEY })
            return
          }

          if (endpoint === '/tools') {
            const rows = await Promise.all(['ffmpeg', 'ffprobe'].map(async (name) => {
              for (const binary of resolveTool(name)) {
                try {
                  await fs.access(binary)
                  const { stdout } = await command(binary, ['-version'])
                  return { name, path: binary, version: stdout.trim().split('\n')[0] || null }
                } catch {
                  // Check remaining local package manager or system locations.
                }
              }
              return { name, path: null, version: null }
            }))
            respond(200, rows)
            return
          }

          if (endpoint === '/media' && request.method === 'POST') {
            const { paths = [], path: suppliedPath } = await readJson(request)
            const requestedPaths = paths.length ? paths : [suppliedPath]
            const results = await Promise.all(requestedPaths.map(async (requestedPath) => {
              try {
                const mediaPath = await resolveReadableMediaPath(requestedPath)
                const ffprobePath = await firstAvailableTool('ffprobe')
                if (!ffprobePath) throw new Error('未找到 ffprobe；请在桌面版中体验视频导入。')
                const { stdout } = await withTimeout(command(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mediaPath]))
                const metadata = JSON.parse(stdout)
                const video = metadata.streams.find((stream) => stream.codec_type === 'video')
                const audio = metadata.streams.find((stream) => stream.codec_type === 'audio')
                const stat = await fs.stat(mediaPath)
                const cache = path.join(os.tmpdir(), 'videome-preview', 'thumbnails', `${hash(mediaPath)}.jpg`)
                let poster = null
                const ffmpegPath = video ? await firstAvailableTool('ffmpeg') : null
                if (ffmpegPath) {
                  try { await fs.access(cache) } catch {
                    await fs.mkdir(path.dirname(cache), { recursive: true })
                    try { await withTimeout(command(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.5', '-i', mediaPath, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=420:-2', '-q:v', '4', cache])) } catch {}
                  }
                  try { await fs.access(cache); poster = signedMediaUrl(cache) } catch {}
                }
                const signature = createHmac('sha256', SESSION_KEY).update(mediaPath).digest('hex')
                const url = signedMediaUrl(mediaPath)
                return { path: mediaPath, ok: true, url, name: path.basename(mediaPath), size: stat.size, duration: Number(metadata.format.duration || video?.duration || audio?.duration || 0), width: video?.width || null, height: video?.height || null, videoCodec: video?.codec_name || null, audioCodec: audio?.codec_name || null, codec: video?.codec_name || audio?.codec_name || null, frameRate: video?.avg_frame_rate || null, pixelFormat: video?.pix_fmt || null, rotation: Number(video?.tags?.rotate || 0), kind: video ? 'video' : audio ? 'audio' : 'image', thumbnail: poster, poster, signature }
              } catch (error) { return { path: requestedPath, ok: false, name: path.basename(requestedPath), reason: error.message } }
            }))
            respond(200, results)
            return
          }

          if (endpoint === '/media' && request.method === 'GET') {
            const requestedPath = url.searchParams.get('path') || ''
            const mediaPath = await resolveReadableMediaPath(requestedPath)
            const signature = createHmac('sha256', SESSION_KEY).update(mediaPath).digest('hex')
            if (signature !== url.searchParams.get('sig')) { respond(403, { error: 'Media URLs expire when the local session closes.' }); return }
            const publicUrl = pathToUrl(`/__videome/media?path=${encodeURIComponent(mediaPath)}&sig=${signature}`)
            respond(200, { path: mediaPath, url: publicUrl })
            return
          }

          if (endpoint === '/frame' && request.method === 'GET') {
            const mediaPath = await resolveReadableMediaPath(url.searchParams.get('path'))
            const signature = createHmac('sha256', SESSION_KEY).update(mediaPath).digest('hex')
            if (signature !== url.searchParams.get('sig')) { respond(403, { error: 'This preview link has expired.' }); return }
            const time = Math.max(0, Math.min(86400, Number(url.searchParams.get('time') || 0)))
            const ffmpegPath = await firstAvailableTool('ffmpeg')
            if (!ffmpegPath) { respond(503, { error: 'FFmpeg is required for local frame previews.' }); return }
            const key = createHmac('sha256', SESSION_KEY).update(`${mediaPath}\0${Math.floor(time * 2) / 2}`).digest('hex')
            const framePath = path.join(os.tmpdir(), 'videome-preview', 'frames', `${key}.jpg`)
            try { await fs.access(framePath) } catch {
              await fs.mkdir(path.dirname(framePath), { recursive: true })
              await withTimeout(command(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(Math.floor(time * 2) / 2), '-i', mediaPath, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', framePath]))
            }
            response.statusCode = 200
            response.setHeader('Content-Type', 'image/jpeg')
            response.setHeader('Cache-Control', 'no-store')
            response.setHeader('Content-Length', String((await fs.stat(framePath)).size))
            createReadStream(framePath).pipe(response)
            return
          }

          if (endpoint === '/export' && request.method === 'POST') {
            const payload = await readJson(request)
            const token = request.headers['x-videome-session']
            if (token !== SESSION_KEY) { respond(403, { error: 'The local media session has expired.' }); return }
            const inputPaths = new Set(PATH_ROOTS)
            for (const asset of payload.project?.assets || []) {
              if (!asset.path) continue
              const mediaPath = await resolveReadableMediaPath(asset.path)
              inputPaths.add(mediaPath)
            }
            const tracks = payload.project?.tracks || []
            const project = { ...payload.project, tracks: tracks.map((track, index) => ({ ...track, order: index })) }
            const job = createJob(project, payload.settings || {}, inputPaths)
            respond(200, { ok: true, job: { id: job.id, state: job.state, progress: job.progress, fileName: `${safeOutputName(project.name)}.${job.format}`, expectedSizeBytes: job.plan.expectedSizeBytes, warnings: job.plan.warnings } })
            return
          }

          const jobRoute = endpoint.match(/^\/jobs\/([a-f\d]{32})(?:\/(cancel|download))?$/)
          if (jobRoute && request.method === 'GET') {
            const job = EXPORT_JOBS.get(jobRoute[1])
            if (!job) { respond(404, { error: '导出任务不存在或本地服务已关闭。' }); return }
            if (jobRoute[2] === 'cancel') {
              if (job.child && job.state === 'running') {
                job.state = 'cancelling'
                stopChild(job.child)
              } else {
                clearJob(job)
                job.state = 'cancelled'
              }
              respond(200, { ok: true })
              return
            }
            if (jobRoute[2] === 'download') {
              if (job.state !== 'complete') { respond(409, { error: '导出任务还没有完成。' }); return }
              const stat = await fs.stat(job.outputPath)
              response.statusCode = 200
              response.setHeader('Content-Type', guessMime(job.outputPath))
              response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.fileName)}"`)
              response.setHeader('Content-Length', String(stat.size))
              createReadStream(job.outputPath).pipe(response)
              return
            }
            respond(200, { id: job.id, state: job.state, progress: job.progress, error: job.error, fileName: job.fileName, size: job.size || 0, expectedSizeBytes: job.plan.expectedSizeBytes })
            return
          }

          respond(404, { error: 'Not found' })
        } catch (error) {
          respond(422, { error: error.message })
        }
      })

      server.middlewares.use(async (request, response, next) => {
        if (!String(request.url || '').startsWith('/__videome/media')) { next(); return }
        try {
          const url = new URL(request.url || '/', 'http://localhost')
          const mediaPath = await resolveReadableMediaPath(url.searchParams.get('path'))
          const signature = createHmac('sha256', SESSION_KEY).update(mediaPath).digest('hex')
          // Older projects can contain unsigned preview URLs. They remain restricted to
          // directories already authorized by a media probe/import in this session.
          if (url.searchParams.get('sig') && signature !== url.searchParams.get('sig')) { response.statusCode = 403; response.end(); return }
          if (!withinAnyRoot(mediaPath)) { response.statusCode = 403; response.end(); return }
          const stat = await fs.stat(mediaPath)
          const type = guessMime(mediaPath)
          const match = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
          const start = match ? Number(match[1] || 0) : 0
          const end = match && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
          if (start >= stat.size || start > end) { response.statusCode = 416; response.setHeader('Content-Range', `bytes */${stat.size}`); response.end(); return }
          response.statusCode = match ? 206 : 200
          response.setHeader('Content-Type', type)
          response.setHeader('Accept-Ranges', 'bytes')
          response.setHeader('Content-Length', String(end - start + 1))
          if (match) response.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
          await new Promise((resolve, reject) => {
            const stream = createReadStream(mediaPath, { start, end })
            stream.on('error', reject)
            stream.on('end', resolve)
            stream.pipe(response)
          })
        } catch {
          if (!response.headersSent) { response.statusCode = 404; response.end() }
        }
        void next
      })
    },
  }
}

async function firstAvailableTool(name) {
  for (const candidate of resolveTool(name)) {
    try { await fs.access(candidate); return candidate } catch {}
  }
  return null
}

async function resolveReadableMediaPath(rawPath) {
  const normalized = normalizeFilePath(rawPath)
  if (!withinAnyRoot(normalized)) throw new Error('此本机文件路径不在授权浏览目录内。')
  await fs.access(normalized)
  PATH_ROOTS.add(path.dirname(normalized))
  return normalized
}

function hash(value) {
  return createHmac('sha256', SESSION_KEY).update(value).digest('hex')
}

function checkSession(request) {
  const supplied = request.headers['x-videome-session']
  return typeof supplied === 'string' && supplied === SESSION_KEY
}

function isLocalOrigin(request) {
  const origin = request.headers.origin
  return !origin || origin === 'http://127.0.0.1:4179' || origin === 'http://localhost:4179'
}

function safeOutputName(value) {
  return String(value || 'Videome').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 96) || 'Videome'
}

function createJob(project, settings, inputPaths) {
  const jobId = randomBytes(16).toString('hex')
  const format = String(settings.format || 'mp4').toLowerCase()
  const preset = settings.preset || 'high'
  const outputDir = path.join(os.tmpdir(), 'videome-preview', 'exports')
  fsSyncMkdir(outputDir)
  const outputPath = path.join(outputDir, `${jobId}.${format}`)
  const partialPath = path.join(outputDir, `${jobId}.partial.${format}`)
  const subtitlePath = project.subtitle?.enabled === false ? null : path.join(outputDir, `${jobId}.ass`)

  const normalizedProject = {
    ...project,
    assets: project.assets.map((asset) => {
      const resolvedPath = path.resolve(String(asset.path || ''))
      if (asset.path && !inputPaths.has(resolvedPath)) throw new Error(`素材「${asset.name}」尚未在本机预览会话中导入。`)
      return { ...asset, path: asset.path ? resolvedPath : null }
    }),
  }

  for (const clip of normalizedProject.clips) {
    if (clip.linkedClipId) continue
    if (['video', 'audio', 'image'].includes(clip.kind) && !normalizedProject.assets.some((asset) => asset.id === clip.assetId && asset.path)) {
      throw new Error(`素材「${clip.name}」没有本地来源。请重新导入视频或音频。`)
    }
  }

  const snapshot = {
    ...normalizedProject,
    clips: normalizedProject.clips.filter((clip) => !clip.linkedClipId || clip.kind === 'audio'),
  }

  if (subtitlePath && snapshot.subtitle?.cues?.length) {
    const projectSize = snapshot.frameSize || { width: 1920, height: 1080 }
    fsSyncMkdir(outputDir)
    require('node:fs').writeFileSync(subtitlePath, createAss(snapshot.subtitle.cues, {
      width: projectSize.width,
      height: projectSize.height,
      fontSize: snapshot.subtitle.fontSize || 42,
      bottomPadding: snapshot.subtitle.bottomPadding || 92,
      background: snapshot.subtitle.background,
      family: fontResources().fontFamily,
    }))
  } else if (subtitlePath) {
    fsSyncMkdir(outputDir)
  }

  let plan
  try {
    plan = buildExportArguments({ ...settings, project: snapshot, preset, format }, partialPath, subtitlePath)
  } catch (error) {
    if (subtitlePath) require('node:fs').rmSync(subtitlePath, { force: true })
    throw error
  }

  const ffmpegPath = resolveTool('ffmpeg').find((binary) => {
    try { require('node:fs').accessSync(binary); return true } catch { return false }
  })
  if (!ffmpegPath) throw new Error('未检测到 FFmpeg；请安装 FFmpeg 后重启本地预览服务。')
  const job = { settings: { ...settings, project: snapshot, preset, format }, retried: false, id: jobId, state: 'running', progress: 0, outputPath, partialPath, subtitlePath, format, fileName: `${safeOutputName(project.name)}.${format}`, plan, startedAt: Date.now(), error: null, child: null }
  EXPORT_JOBS.set(jobId, job)
  runJob(job, ffmpegPath)
  return job
}

function fsSyncMkdir(directory) {
  require('node:fs').mkdirSync(directory, { recursive: true })
}

function runJob(job, ffmpegPath) {
  const child = spawn(ffmpegPath, job.plan.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  job.child = child
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
    const rows = stdout.split(/\r?\n/)
    stdout = rows.pop() || ''
    for (const row of rows) {
      const index = row.indexOf('=')
      if (index < 0 || row.slice(0, index) !== 'out_time_ms') continue
      const currentTime = Number(row.slice(index + 1)) / 1_000_000
      job.progress = Number.isFinite(currentTime) ? Math.max(job.progress, Math.min(99, Math.floor(currentTime / Math.max(job.plan.duration, .001) * 100))) : job.progress
    }
  })
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-6000) })
  const statTimer = setInterval(async () => {
    try { job.size = (await fs.stat(job.partialPath)).size } catch {}
  }, 500)
  child.on('error', (error) => {
    clearInterval(statTimer)
    job.spawnError = error.message
  })
  child.on('close', async (code) => {
    clearInterval(statTimer)
    job.child = null
    if (job.spawnError) { job.error = job.spawnError; job.state = 'error'; clearJob(job); return }
    if (job.state === 'cancelling') {
      clearJob(job)
      job.state = 'cancelled'
      return
    }
    if (code !== 0 && !job.retried && /videotoolbox$/.test(job.plan.encoder || '') && hardwareFailure(new Error(stderr))) {
      job.retried = true
      await fs.rm(job.partialPath, { force: true })
      job.plan = buildExportArguments(job.settings, job.partialPath, job.subtitlePath, { ...fontResources(), encoder: encoderFor(job.settings.videoCodec, process.platform, true) })
      runJob(job, ffmpegPath)
      return
    }
    if (code === 0) {
      try {
        const ffprobe = await firstAvailableTool('ffprobe')
        if (!ffprobe) throw new Error('未找到 ffprobe，无法验证导出文件。')
        const { stdout } = await command(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', job.partialPath])
        const verification = JSON.parse(stdout)
        if (!verification.streams?.some((stream) => stream.codec_type === 'video')) throw new Error('导出结果中没有可读取的视频流。')
        await fs.rename(job.partialPath, job.outputPath)
        job.size = Number((await fs.stat(job.outputPath)).size)
        job.progress = 100
        job.state = 'complete'
      } catch (error) {
        job.error = error.message
        job.state = 'error'
        clearJob(job)
      }
    } else {
      job.error = stderr.split(/\r?\n/).filter((line) => line.trim()).at(-1) || `FFmpeg exited with code ${code}`
      job.state = 'error'
      clearJob(job)
    }
  })
}

function clearJob(job) {
  require('node:fs').rmSync(job.partialPath, { force: true })
  if (job.subtitlePath) require('node:fs').rmSync(job.subtitlePath, { force: true })
}

function pathToUrl(value) {
  return `http://127.0.0.1:4179${value}`
}

function signedMediaUrl(mediaPath) {
  const signature = createHmac('sha256', SESSION_KEY).update(path.resolve(mediaPath)).digest('hex')
  return pathToUrl(`/__videome/media?path=${encodeURIComponent(mediaPath)}&sig=${signature}`)
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString() })
    request.on('error', reject)
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) } catch (error) { reject(error) }
    })
  })
}

export default defineConfig({
  plugins: [react(), createPreviewApi()],
  base: '/',
  build: { outDir: 'dist-preview' },
  server: { host: '127.0.0.1', port: 4179, strictPort: true },
})
