const fs = require('node:fs/promises')
const path = require('node:path')
const { hardwareFailure, encoderFor } = require('../runtime.cjs')
const batchMedia = require('../batch/media.cjs')

const { run, fingerprint, probe, sourceFromProbe } = batchMedia

function buildArguments(source, segment, options, output, encoder) {
  const fps = Number(source.fps) > 0 ? Number(source.fps) : 30
  const seek = source.videoOffset + segment.sourceStart
  const duration = segment.duration
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', '-stats_period', '0.25',
    '-ss', String(seek), '-t', String(duration), '-i', source.path,
    '-map', `0:${source.videoStream}`, '-map', source.audio ? `0:${source.audio.stream}?` : '0:a:0?',
    '-vf', `scale=${source.width}:${source.height}:force_original_aspect_ratio=decrease,pad=${source.width}:${source.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`, '-fps_mode', 'cfr', '-r', String(fps),
    '-c:v', encoder, '-threads:v', '2', '-pix_fmt', 'yuv420p', '-b:v', `${options.videoBitrateMbps}M`,
    '-c:a', 'aac', '-ar', '48000', '-b:a', '256k', '-af', 'aresample=async=1:first_pts=0',
    '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-metadata:s:v:0', 'rotate=0', output]
  if (encoder === 'libx264') args.splice(args.indexOf('-c:v') + 2, 0, '-preset', 'fast')
  return args
}

async function render(ffmpeg, source, item, options, output, context = {}) {
  const execute = context.run || run
  let encoder = encoderFor('h264')
  const progress = (line) => {
    const match = line.match(/^out_time_us=(\d+)/)
    if (match) context.onProgress?.(Math.min(99, Number(match[1]) / 1e6 / item.duration * 100))
  }
  try {
    await execute(ffmpeg, buildArguments(source, item, options, output, encoder), { ...context, onLine: progress })
  } catch (error) {
    if (context.signal?.aborted || encoder !== 'h264_videotoolbox' || !hardwareFailure(error)) throw error
    context.onHardwareFallback?.()
    await fs.rm(output, { force: true })
    encoder = 'libx264'
    await execute(ffmpeg, buildArguments(source, item, options, output, encoder), { ...context, onLine: progress })
  }
  return encoder
}

async function verify(ffmpeg, ffprobe, filePath, source, item, context = {}) {
  await run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-threads', '1', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], context)
  const metadata = await probe(ffprobe, filePath, context, true)
  const video = metadata.streams.find((stream) => stream.codec_type === 'video')
  const audio = metadata.streams.find((stream) => stream.codec_type === 'audio')
  const expectedFps = Number(source.fps) > 0 ? Number(source.fps) : 30
  const width = Number(video?.width)
  const height = Number(video?.height)
  if (video?.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p' || width !== source.width || height !== source.height || Number(video.nb_read_frames) !== item.frames) throw new Error('分段视频编码、画幅或帧数验证失败。')
  if (!Number.isFinite(Number(video.duration)) || Math.abs(Number(video.duration) - item.duration) > 1 / expectedFps + 1e-4) throw new Error('分段视频时长验证失败。')
  if (Boolean(audio) !== Boolean(source.audio) || (audio && (audio.codec_name !== 'aac' || audio.sample_rate !== '48000' || !Number.isFinite(Number(audio.duration)) || Math.abs(Number(audio.duration) - item.duration) > Math.max(1 / expectedFps, 1024 / 48000) + 1e-4))) throw new Error('分段音频流或音画结束时间验证失败。')
  return { ...await fingerprint(filePath, context.signal), duration: Number(video.duration), frames: Number(video.nb_read_frames), audioDuration: audio ? Number(audio.duration) : null }
}

module.exports = { run, fingerprint, probe, sourceFromProbe, buildArguments, render, verify, path }
