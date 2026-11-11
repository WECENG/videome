const { fork } = require('node:child_process')
const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { terminateTree } = require('../processes.cjs')
const { encoderFor, hardwareFailure } = require('../runtime.cjs')

function run(binary, args, { signal, onLine = () => {}, onChild = () => {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const child = fork(path.join(__dirname, 'process.cjs'), [binary, ...args], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    onChild(child)
    let stdout = ''
    let stderr = ''
    let pending = ''
    let killTimer
    let timedOut = false
    const abort = () => {
      if (child.connected) child.send({ type: 'stop' }, () => {})
      else terminateTree(child)
      killTimer ||= setTimeout(() => terminateTree(child, true), 5000)
    }
    const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-4 * 1024 * 1024)
      pending += chunk.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      lines.forEach(onLine)
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-64000) })
    let spawnError
    child.on('error', (error) => { spawnError = error })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      onChild(null, child)
      if (signal?.aborted) reject(signal.reason || new Error('任务已取消。'))
      else if (timedOut) reject(new Error('媒体任务执行超时。'))
      else if (spawnError) reject(spawnError)
      else if (code !== 0) reject(new Error(stderr.trim() || `媒体进程退出 (${code})`))
      else resolve({ stdout, stderr })
    })
  })
}

async function fingerprint(filePath, signal) {
  const before = await fs.stat(filePath)
  if (!before.isFile()) throw new Error('源路径必须为文件。')
  const digest = crypto.createHash('sha256')
  const stream = createReadStream(filePath, { signal })
  for await (const chunk of stream) digest.update(chunk)
  const after = await fs.stat(filePath)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('读取期间源文件发生变化，请重新分析。')
  return { sha256: digest.digest('hex'), size: after.size, mtimeMs: after.mtimeMs }
}

async function probe(ffprobe, filePath, context = {}, countFrames = false) {
  const { stdout } = await run(ffprobe, ['-v', 'error', ...(countFrames ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', filePath], context)
  const metadata = JSON.parse(stdout)
  const video = metadata.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  if (video && !Number(video.duration) && !(Number(video.duration_ts) * rate(video.time_base)) && !Number(video.nb_frames)) {
    let first = Infinity
    let last = -Infinity
    await run(ffprobe, ['-v', 'error', '-select_streams', String(video.index), '-show_packets', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', filePath], {
      ...context, onLine: (line) => {
        const [timestamp, duration] = line.split(',').map(Number)
        if (Number.isFinite(timestamp)) { first = Math.min(first, timestamp); last = Math.max(last, timestamp + (Number.isFinite(duration) ? duration : 0)) }
      },
    })
    if (Number.isFinite(first) && last > first) { video.duration = last - first; video.start_time ??= first }
  }
  return metadata
}

const rate = (value) => {
  const [numerator, denominator = 1] = String(value || '0').split('/').map(Number)
  return denominator ? numerator / denominator : 0
}

function sourceFromProbe(filePath, metadata) {
  const video = metadata.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  const audio = metadata.streams?.find((stream) => stream.codec_type === 'audio')
  if (!video) throw new Error('源文件没有可用的视频流。')
  if (['smpte2084', 'arib-std-b67'].includes(video.color_transfer) || video.side_data_list?.some((entry) => /dovi|dolby vision/i.test(entry.side_data_type))) throw new Error('首版批量混剪支持 SDR；请先将 HDR 素材转换为 SDR。')
  const containerStart = Number(metadata.format?.start_time) || 0
  const start = Number(video.start_time ?? containerStart)
  const duration = Number(video.duration) || Number(video.duration_ts) * rate(video.time_base) || Number(video.nb_frames) / rate(video.avg_frame_rate) || (Number(metadata.format?.duration) - Math.max(0, start - containerStart))
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频有效时长。')
  const rotation = Number(video.tags?.rotate ?? video.side_data_list?.find((entry) => entry.rotation != null)?.rotation ?? 0)
  const portrait = Math.abs(rotation) % 180 === 90
  const audioStart = Number(audio?.start_time ?? containerStart)
  return { path: filePath, name: path.basename(filePath), duration, videoStart: start, containerStart,
    videoOffset: Math.max(0, start - containerStart), videoStream: video.index, codec: video.codec_name,
    fps: rate(video.avg_frame_rate) || rate(video.r_frame_rate), rotation,
    width: portrait ? video.height : video.width, height: portrait ? video.width : video.height,
    colorTransfer: video.color_transfer || null, colorPrimaries: video.color_primaries || null,
    audio: audio ? { stream: audio.index, offset: audioStart - start, containerOffset: Math.max(0, audioStart - containerStart),
      duration: Number(audio.duration) || Number(audio.duration_ts) * rate(audio.time_base) || Number(metadata.format.duration), codec: audio.codec_name } : null }
}

async function analyzeScenes(ffmpeg, source, options, context) {
  const cuts = []
  await run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'info', '-threads', '1', '-ss', String(source.videoOffset), '-i', source.path,
    '-map', `0:${source.videoStream}`, '-an', '-filter_threads', '1', '-vf', `scale=320:-2,select='gt(scene,${options.threshold})',metadata=print:file=-`, '-fps_mode', 'vfr', '-f', 'null', '-'], {
    ...context, onLine: (line) => {
      const match = line.match(/pts_time:([\d.]+)/)
      if (match) cuts.push(Number(match[1]))
    },
  })
  return cuts.filter((cut) => cut > 0 && cut < source.duration)
}

function buildArguments(source, sequence, options, output, encoder) {
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', '-stats_period', '0.25', '-filter_complex_threads', '1']
  const filters = []
  const videoLabels = []
  const audioLabels = []
  let input = 0
  for (const [index, clip] of sequence.entries()) {
    const duration = clip.frames / options.fps
    const videoInput = input++
    args.push('-threads', '1', '-ss', String(source.videoOffset + clip.sourceStart), '-t', String(duration + 1 / options.fps), '-i', source.path)
    filters.push(`[${videoInput}:${source.videoStream}]setpts=PTS-STARTPTS,fps=${options.fps},scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=${1 / options.fps},trim=end_frame=${clip.frames},setpts=N/(${options.fps}*TB)[v${index}]`)
    videoLabels.push(`[v${index}]`)
    if (source.audio) {
      const availableStart = Math.max(clip.sourceStart, source.audio.offset)
      const availableEnd = Math.min(clip.sourceStart + duration, source.audio.offset + source.audio.duration)
      const samples = Math.round(duration * 48000)
      if (availableEnd > availableStart) {
        const audioInput = input++
        args.push('-threads', '1', '-ss', String(source.audio.containerOffset + availableStart - source.audio.offset), '-t', String(availableEnd - availableStart), '-i', source.path)
        const delay = Math.round((availableStart - clip.sourceStart) * 48000)
        filters.push(`[${audioInput}:${source.audio.stream}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB,adelay=${delay}S:all=1,apad,atrim=end_sample=${samples},asetpts=N/SR/TB[a${index}]`)
      } else filters.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[a${index}]`)
      audioLabels.push(`[a${index}]`)
    }
  }
  const hasBackground = Boolean(options.backgroundAudio?.path)
  const concatLabels = sequence.flatMap((_clip, index) => source.audio ? [`[v${index}]`, `[a${index}]`] : [`[v${index}]`])
  filters.push(`${concatLabels.join('')}concat=n=${sequence.length}:v=1:a=${source.audio ? 1 : 0}[video]${source.audio ? '[sourceAudio]' : ''}`)
  if (hasBackground) {
    const backgroundInput = input++
    args.push('-stream_loop', '-1', '-ss', String(options.backgroundAudio.start || 0), '-i', options.backgroundAudio.path)
    const musicTail = Math.max(0, options.actualSeconds - Number(options.backgroundAudio.fadeOut || 0))
    const fade = Number(options.backgroundAudio.fadeOut || 0) > 0 ? `,afade=t=out:st=${musicTail}:d=${Number(options.backgroundAudio.fadeOut)}` : ''
    const musicBase = `[${backgroundInput}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB,volume=${Number(options.backgroundAudio.volume ?? 0.22)},atrim=duration=${options.actualSeconds},asetpts=N/SR/TB${fade}`
    if (options.backgroundAudio.mixMode === 'replace' || !source.audio) filters.push(`${musicBase}[audio]`)
    else if (options.backgroundAudio.ducking === 'auto') filters.push(`${musicBase}[music]`, '[sourceAudio]asplit=2[sourceSidechain][sourceMix]', '[music][sourceSidechain]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[ducked]', `[sourceMix][ducked]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${options.actualSeconds},asetpts=N/SR/TB[audio]`)
    else filters.push(`${musicBase}[music]`, `[sourceAudio][music]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${options.actualSeconds},asetpts=N/SR/TB[audio]`)
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[video]')
  if (hasBackground) args.push('-map', '[audio]', '-c:a', 'aac', '-ar', '48000', '-b:a', '256k')
  else if (source.audio) args.push('-map', '[sourceAudio]', '-c:a', 'aac', '-ar', '48000', '-b:a', '256k')
  else args.push('-an')
  args.push('-c:v', encoder, '-threads:v', '2', '-pix_fmt', 'yuv420p', '-b:v', `${options.videoBitrateMbps}M`)
  if (encoder === 'libx264') args.push('-preset', 'fast')
  args.push('-t', String(options.actualSeconds), '-movflags', '+faststart', '-metadata:s:v:0', 'rotate=0', output)
  return args
}

async function render(ffmpeg, source, item, options, output, context = {}) {
  const execute = context.run || run
  let encoder = encoderFor('h264')
  const progress = (line) => {
    const match = line.match(/^out_time_us=(\d+)/)
    if (match) context.onProgress?.(Math.min(99, Number(match[1]) / 1e6 / options.actualSeconds * 100))
  }
  try {
    await execute(ffmpeg, buildArguments(source, item.sequence, options, output, encoder), { ...context, onLine: progress })
  } catch (error) {
    if (context.signal?.aborted || encoder !== 'h264_videotoolbox' || !hardwareFailure(error)) throw error
    context.onHardwareFallback?.()
    await fs.rm(output, { force: true })
    encoder = 'libx264'
    await execute(ffmpeg, buildArguments(source, item.sequence, options, output, encoder), { ...context, onLine: progress })
  }
  return encoder
}

async function verify(ffmpeg, ffprobe, filePath, options, hasAudio, context = {}) {
  await run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-threads', '1', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], context)
  const metadata = await probe(ffprobe, filePath, context, true)
  const video = metadata.streams.find((stream) => stream.codec_type === 'video')
  const audio = metadata.streams.find((stream) => stream.codec_type === 'audio')
  if (video?.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p' || Number(video.nb_read_frames) !== options.targetFrames || video.width !== options.width || video.height !== options.height) throw new Error('视频编码、画幅或帧数验证失败。')
  if (!Number.isFinite(Number(video.duration)) || Math.abs(Number(video.duration) - options.actualSeconds) > 1 / options.fps + 1e-4) throw new Error('视频流时长不符合帧预算。')
  if (Boolean(audio) !== Boolean(hasAudio) || (audio && (audio.codec_name !== 'aac' || audio.sample_rate !== '48000' || !Number.isFinite(Number(audio.duration)) || Math.abs(Number(audio.duration) - options.actualSeconds) > Math.max(1 / options.fps, 1024 / 48000) + 1e-4))) throw new Error('音频流或音画结束时间验证失败。')
  const digest = await fingerprint(filePath, context.signal)
  return { ...digest, duration: Number(video.duration), frames: Number(video.nb_read_frames), audioDuration: audio ? Number(audio.duration) : null }
}

module.exports = { run, fingerprint, probe, sourceFromProbe, analyzeScenes, buildArguments, render, verify }
