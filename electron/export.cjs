const path = require('node:path')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mts', '.mxf'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.aiff', '.ogg'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'])

const number = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '0'
  return parsed.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

function classifyAsset(asset) {
  if (asset.kind === 'video' || VIDEO_EXTENSIONS.has(path.extname(asset.path || '').toLowerCase())) return 'video'
  if (asset.kind === 'image' || IMAGE_EXTENSIONS.has(path.extname(asset.path || '').toLowerCase())) return 'image'
  if (asset.kind === 'audio' || AUDIO_EXTENSIONS.has(path.extname(asset.path || '').toLowerCase())) return 'audio'
  return null
}

function escapeFilterString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\n/g, ' ')
}

function subtitleFilterPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,')
}

function buildSubtitles(project, frameSize) {
  const subtitles = project.subtitle || {}
  const trackMap = new Map((project.tracks || []).map((track) => [track.id, track]))
  const subtitleClips = (project.clips || []).filter((clip) => clip.kind === 'subtitle' && clip.sourceCueId)
  const dialogue = subtitles.enabled === false
    ? []
    : (subtitles.cues || [])
      .filter((cue) => typeof cue.text === 'string' && cue.text.trim() && Number(cue.end) > Number(cue.start))
      .flatMap((cue, index) => {
        const clip = subtitleClips.find((candidate) => candidate.sourceCueId === cue.id)
        const track = clip ? trackMap.get(clip.trackId) : null
        if ((clip && (clip.muted || track?.muted)) || (!clip && [...trackMap.values()].some((item) => item.type === 'subtitle' && item.muted))) return []
        const sourceStart = Number(clip?.sourceStart ?? cue.start)
        const start = clip ? Number(clip.start) + Number(cue.start) - sourceStart : Number(cue.start)
        const end = clip ? Number(clip.start) + Number(cue.end) - sourceStart : Number(cue.end)
        const visibleStart = clip ? Math.max(start, Number(clip.start)) : start
        const visibleEnd = clip ? Math.min(end, Number(clip.start) + Number(clip.duration)) : end
        return visibleEnd > visibleStart ? [{ id: `cue${index}`, start: visibleStart, duration: visibleEnd - visibleStart, text: cue.text.trim() }] : []
      })
  const scale = Number(frameSize.height || 1080) / 1080

  return dialogue
    .filter((cue) => cue.text && cue.duration > 0 && cue.start >= 0)
    .map((cue) => ({
      ...cue,
      fontSize: Math.max(16, Math.min(160, Math.round((Number(subtitles.fontSize) || 42) * scale))),
      bottom: Math.max(16, Math.round((Number(subtitles.bottomPadding) || 92) * scale)),
      background: Boolean(subtitles.background),
    }))
}

function buildExportArguments(settings, temporaryOutput, subtitlePath = null) {
  const project = settings.project || {}
  const assets = Array.isArray(project.assets) ? project.assets : []
  const clips = [...(project.clips || [])]
    .filter((clip) => Number(clip.duration) > 0 && Number(clip.start) >= 0)
    .sort((first, second) => Number(first.start) - Number(second.start))
  const trackMap = new Map((project.tracks || []).map((track) => [track.id, track]))
  const getTrack = (clip) => trackMap.get(clip.trackId) || { id: clip.trackId, type: clip.kind === 'audio' ? 'audio' : 'video', order: 0, muted: false }
  const videoClips = clips
    .filter((clip) => ['video', 'image', 'graphics'].includes(clip.kind) || getTrack(clip).type === 'graphics')
    .map((clip) => ({ clip, asset: assets.find((asset) => asset.id === clip.assetId), track: getTrack(clip) }))
    .filter(({ clip, asset, track }) => !clip.muted && !track.muted
      && ['video', 'graphics'].includes(track.type)
      && (clip.kind === 'graphics' || track.type === 'graphics' || (asset && asset.path && !asset.missing && !clip.missing)))
  const audioClips = clips
    .filter((clip) => clip.kind === 'audio' || getTrack(clip).type === 'audio')
    .map((clip) => ({ clip, asset: assets.find((asset) => asset.id === clip.assetId), track: getTrack(clip) }))
    .filter(({ clip, asset, track }) => !clip.muted && !track.muted && asset && asset.path && !asset.missing)

  if (!videoClips.some(({ asset }) => classifyAsset(asset) === 'video')) {
    throw new Error('时间线上需要至少一个真实视频片段。静态图片不能作为视频的替代物导出。')
  }

  const frameSize = project.frameSize || { width: 1920, height: 1080 }
  const width = Math.max(2, Math.ceil(Number(frameSize.width || 1920) / 2) * 2)
  const height = Math.max(2, Math.ceil(Number(frameSize.height || 1080) / 2) * 2)
  const fps = Math.max(1, Number(project.frameRate?.numerator || 30) / Number(project.frameRate?.denominator || 1))
  const duration = Math.max(Number(project.duration) || 0, ...clips.map((clip) => Number(clip.start) + Number(clip.duration)))
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('工程时长为空，无法开始导出。')

  const preset = settings.preset || project.exportSettings?.preset || 'high'
  const format = String(settings.format || project.exportSettings?.format || 'mp4').toLowerCase()
  const subtitles = buildSubtitles(project, frameSize)
  const copyAudioOnly = audioClips.length > 0 && audioClips.every(({ clip }) => clip.linkedClipId && videoClips.some(({ clip: videoClip }) => videoClip.id === clip.linkedClipId))
  const copyEligible = videoClips.length === 1
    && classifyAsset(videoClips[0].asset) === 'video'
    && videoClips[0].clip.start === 0
    && (!audioClips.length || copyAudioOnly)
    && !subtitles.length
    && !clips.some((clip) => ['graphics', 'subtitle'].includes(clip.kind)
      || clip.transition
      || (clip.scale != null && Number(clip.scale) !== 1)
      || (clip.opacity != null && Number(clip.opacity) !== 1)
      || (clip.rotation != null && Number(clip.rotation) % 360 !== 0)
      || clip.crop)

  if (preset === 'stream-copy' && !copyEligible) {
    throw new Error('原码流保留仅支持单一视频片段，不支持字幕、叠加图文、额外音轨和画面效果。请选择「日常高质量」。')
  }

  if (preset === 'stream-copy') {
    const clip = videoClips[0].clip
    const asset = videoClips[0].asset
    const codec = asset.videoCodec || asset.codec
    if ((format === 'mp4' || format === 'mov') && codec && !['h264', 'hevc', 'mpeg4'].includes(codec)) {
      throw new Error(`视频编码 ${codec} 无法直接写入 ${format.toUpperCase()}。请切换到 MKV 或重新编码。`)
    }

    return {
      args: [
        '-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-loglevel', 'error', '-i', asset.path,
        ...(Number(clip.trimStart) > 0 ? ['-ss', number(clip.trimStart)] : []),
        '-t', number(clip.duration), '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
        ...(format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []),
        '-f', format === 'mov' ? 'mov' : format, temporaryOutput,
      ],
      duration,
      expectedSizeBytes: Number(asset.size || 0),
      warnings: ['複製模式依賴編碼器關鍵影格；剪切點可能自動移動到附近關鍵影格。'],
      inputCount: 1,
    }
  }

  if (settings.videoCodec === 'hevc' && format === 'webm') throw new Error('HEVC 与 WebM 容器不兼容；请选择 H.264 的 MP4，或无损 MKV。')

  const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-loglevel', 'error', '-stats_period', '0.25']
  const inputs = []
  const inputForClip = new Map()
  const inputForAudio = new Map()

  const appendInput = (asset, { loop = false, image = false } = {}) => {
    const index = inputs.length
    inputs.push({ asset, image })
    if (image) args.push('-loop', '1', '-framerate', String(fps))
    else if (loop) args.push('-stream_loop', '-1')
    args.push('-i', asset.path)
    return index
  }

  for (const { clip, asset } of videoClips) {
    if (!asset) continue
    const kind = classifyAsset(asset)
    if (kind === 'audio') continue
    inputForClip.set(clip.id, appendInput(asset, { image: kind === 'image' }))
  }
  for (const { clip, asset } of audioClips) {
    inputForAudio.set(clip.id, appendInput(asset, { loop: Boolean(clip.isMusic) }))
  }

  if (![...inputForClip.values()].length) throw new Error('渲染工程需要至少一个可读取的视频或图片轨道片段。')

  const baseIndex = inputs.length
  args.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${number(duration)}`)

  const filters = [`[${baseIndex}:v]format=yuv420p[vbase0]`]
  const videoAudioLabels = []
  const orderedVideo = videoClips
    .sort((first, second) => Number(first.track.order || 0) - Number(second.track.order || 0) || Number(first.clip.start) - Number(second.clip.start))
    .filter(({ clip, asset, track }) => inputForClip.has(clip.id) || (asset && classifyAsset(asset) === 'image') || clip.kind === 'graphics' || track.type === 'graphics')
  orderedVideo.forEach(({ clip, asset }, index) => {
    const input = inputForClip.get(clip.id)
    const start = Number(clip.start)
    const clipDuration = Number(clip.duration)
    const trimStart = Number(clip.trimStart || 0)
    const trimEnd = Math.min(Number(clip.trimEnd || trimStart + clipDuration), trimStart + clipDuration)
    const trimDuration = Math.max(0.001, trimEnd - trimStart)
    const segment = `segment${index}`
    const base = `vbase${index}`
    const next = `vbase${index + 1}`

    if (asset && classifyAsset(asset) === 'image') {
      const endTime = start + clipDuration
      const imageFit = clip.fill === 'cover'
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
        : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
      filters.push(`[${input}:v:0]trim=duration=${number(clipDuration)},setpts=PTS-STARTPTS+${number(start)}/TB,fps=${fps},${imageFit}[${segment}]`)
      filters.push(`[${base}][${segment}]overlay=x=0:y=0:enable='between(t,${number(start)},${number(endTime)})':eof_action=pass[${next}]`)
    } else if (asset && classifyAsset(asset) === 'video') {
      const fit = clip.fill === 'cover'
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
        : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
      let video = `[${input}:v:0]trim=start=${number(trimStart)}:duration=${number(trimDuration)},setpts=PTS-STARTPTS,fps=${fps},${fit},setsar=1`
      const rotation = (Number(asset.rotation || 0) + Number(clip.rotation || 0)) % 360
      if (rotation === 90) video += ',transpose=clock'
      else if (rotation === 180) video += ',hflip,vflip'
      else if (rotation === 270) video += ',transpose=cclock'
      video += `[${segment}]`
      filters.push(video)
      const endTime = start + clipDuration
      const x = Math.round(Number(clip.x || 0) * width)
      const y = Math.round(Number(clip.y || 0) * height)
      const scale = Math.max(0.25, Math.min(3, Number(clip.scale ?? 1)))
      const opacity = Math.max(0, Math.min(1, Number(clip.opacity ?? 1)))
      const hasSeparateAudioClip = clips.some((candidate) => candidate.linkedClipId === clip.id)
      const hasAudio = Boolean(asset.audioCodec && !hasSeparateAudioClip && clip.audioLinked !== false && Number(clip.volume ?? 0.82) > 0)
      if (scale !== 1 || opacity !== 1) {
        // Applying canvas effects to individual layers preserves overlap and cross-track stacking.
        const scaleOutput = `vstyled${index}`
        const filter = `scale=w='iw*${scale}':h='ih*${scale}',format=rgba,colorchannelmixer=aa=${opacity}`
        const newSegment = `styledSeg${index}`
        filters.push(`[${segment}]${filter}[${newSegment}]`)
        filters.push(`[${base}][${newSegment}]overlay=x='(W-w)/2+${x}':y='(H-h)/2+${y}':enable='between(t,${number(start)},${number(endTime)})':eof_action=pass:shortest=0[${scaleOutput}]`)
        filters.push(`[${scaleOutput}]null[${next}]`)
      } else {
        filters.push(`[${base}][${segment}]overlay=x='(W-w)/2+${x}':y='(H-h)/2+${y}':enable='between(t,${number(start)},${number(endTime)})':eof_action=pass:shortest=0[${next}]`)
      }
      if (hasAudio) {
        const audioLabel = `dialogue${index}`
        const gain = Math.max(0, Math.min(3, Number(clip.volume ?? 0.82)))
        filters.push(`[${input}:a:0]atrim=start=${number(trimStart)}:duration=${number(trimDuration)},asetpts=PTS-STARTPTS+${number(start)}/TB,volume=${gain}[${audioLabel}]`)
        videoAudioLabels.push({ label: audioLabel, voice: true, start, end: endTime })
      }
    } else if (clip.kind === 'graphics' || trackMap.get(clip.trackId)?.type === 'graphics') {
      const text = escapeFilterString(clip.text || clip.name || '')
      const output = `textLayer${index}`
      const position = clip.titlePosition === 'top' ? 'h*0.13' : clip.titlePosition === 'center' ? '(h-text_h)/2' : 'h-text_h-100'
      const size = Math.max(18, Math.round(Number(clip.fontSize || project.subtitle?.fontSize || 42) * height / 1080))
      filters.push(`[${base}]drawtext=fontfile='/System/Library/Fonts/Helvetica.ttc':text='${text}':fontcolor=white:fontsize=${size}:borderw=3:bordercolor=black:box=1:boxcolor=black@0.32:x=(w-text_w)/2:y=${position}:enable='between(t,${number(start)},${number(start + clipDuration)})'[${output}]`)
      filters.push(`[${output}]null[${next}]`)
    }
  })

  let videoLabel = `vbase${orderedVideo.length}`

  if (subtitlePath && subtitles.length) {
    const filterPath = subtitleFilterPath(subtitlePath)
    const subtitleOutput = 'captionedVideo'
    filters.push(`[${videoLabel}]subtitles=filename='${filterPath}':fontsdir='/System/Library/Fonts'[${subtitleOutput}]`)
    videoLabel = subtitleOutput
  }

  const audioLabels = videoAudioLabels.map((item) => `[${item.label}]`)
  const dialogueLabels = [...audioLabels]
  const normalizedAudio = audioClips
    .filter(({ clip }) => inputForAudio.has(clip.id))
    .map(({ clip, asset }) => ({ clip, asset, input: inputForAudio.get(clip.id) }))
  normalizedAudio.filter(({ clip }) => !clip.isMusic).forEach(({ clip, input }) => {
    const start = Math.max(0, Number(clip.start))
    const trimStart = Math.max(0, Number(clip.trimStart || 0))
    const effectiveDuration = Math.max(0.001, Math.min(Number(clip.duration), Math.max(0.001, duration - start)))
    const volume = Math.max(0, Math.min(3, Number(clip.volume ?? 0.82)))
    const label = `customAudio${audioLabels.length}`
    let filter = `atrim=start=${number(trimStart)}:duration=${number(effectiveDuration)},asetpts=PTS-STARTPTS+${number(start)}/TB,volume=${volume}`
    const fadeIn = Math.max(0, Number(clip.fadeIn || 0))
    const fadeOut = Math.max(0, Number(clip.fadeOut || 0))
    if (fadeIn && effectiveDuration > fadeIn) filter += `,afade=t=in:st=0:d=${number(fadeIn)}`
    if (fadeOut && effectiveDuration > fadeOut) filter += `,afade=t=out:st=${number(effectiveDuration - fadeOut)}:d=${number(fadeOut)}`
    filters.push(`[${input}:a:0]${filter}[${label}]`)
    audioLabels.push(`[${label}]`)
    dialogueLabels.push(`[${label}]`)
  })

  const voiceMix = dialogueLabels.length > 1 ? 'allVoices' : null
  if (voiceMix) filters.push(`${dialogueLabels.join('')}amix=inputs=${dialogueLabels.length}:duration=longest:normalize=0[${voiceMix}]`)
  normalizedAudio.filter(({ clip }) => clip.isMusic).forEach(({ clip, input }) => {
    const start = Math.max(0, Number(clip.start))
    const trimStart = Math.max(0, Number(clip.trimStart || 0))
    const effectiveDuration = Math.max(0.001, Math.min(Number(clip.duration), Math.max(0.001, duration - start)))
    const volume = Math.max(0, Math.min(3, Number(clip.volume ?? (clip.isMusic ? 0.22 : 0.82))))
    const audio = `customAudio${audioLabels.length}`
    let filter = `atrim=start=${number(trimStart)}:duration=${number(effectiveDuration)},asetpts=PTS-STARTPTS+${number(start)}/TB,volume=${volume}`
    const fadeIn = Math.max(0, Number(clip.fadeIn || 0))
    const fadeOut = Math.max(0, Number(clip.fadeOut || 0))
    if (fadeIn && effectiveDuration > fadeIn) filter += `,afade=t=in:st=0:d=${number(fadeIn)}`
    if (fadeOut && effectiveDuration > fadeOut) filter += `,afade=t=out:st=${number(effectiveDuration - fadeOut)}:d=${number(fadeOut)}`
    if (clip.autoDuck !== false && dialogueLabels.length) {
      const sidechainInput = `sidechainInput${audioLabels.length}`
      const ducked = `ducked${audioLabels.length}`
      const sidechainSource = voiceMix ? `[${voiceMix}]` : dialogueLabels[0]
      filters.push(`[${input}:a:0]${filter}[${sidechainInput}]`)
      filters.push(`[${sidechainInput}]${sidechainSource}sidechaincompress=threshold=0.035:ratio=6:attack=20:release=300:makeup=1[${ducked}]`)
      audioLabels.push(`[${ducked}]`)
      return
    }
    filters.push(`[${input}:a:0]${filter}[${audio}]`)
    audioLabels.push(`[${audio}]`)
  })

  if (audioLabels.length > 1) filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,alimiter=limit=0.94[mixedAudio]`)

  args.push('-filter_complex', filters.join(';'), '-map', `[${videoLabel}]`)
  if (audioLabels.length > 1) args.push('-map', '[mixedAudio]')
  else if (audioLabels.length === 1) args.push('-map', audioLabels[0])
  else args.push('-an')

  if (preset === 'lossless') {
    args.push('-c:v', 'ffv1', '-level', '3')
    if (audioLabels.length) args.push('-c:a', 'pcm_s24le')
  } else if (settings.videoCodec === 'hevc') {
    args.push('-c:v', 'hevc_videotoolbox', '-b:v', `${Math.max(4, Number(settings.videoBitrateMbps || 16))}M`, '-tag:v', 'hvc1')
    if (audioLabels.length) args.push('-c:a', 'aac', '-b:a', `${Math.max(128, Number(settings.audioBitrateKbps || 256))}k`)
  } else if (format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '4', '-crf', String(Math.max(16, 30 - Math.round(Number(settings.videoBitrateMbps || 12) / 2))), '-b:v', '0')
    if (audioLabels.length) args.push('-c:a', 'libopus', '-b:a', `${Math.max(128, Number(settings.audioBitrateKbps || 256))}k`)
  } else {
    args.push('-c:v', 'h264_videotoolbox', '-b:v', `${Math.max(4, Number(settings.videoBitrateMbps || 12))}M`, '-profile:v', 'high', '-tag:v', 'avc1')
    if (audioLabels.length) args.push('-c:a', 'aac', '-b:a', `${Math.max(128, Number(settings.audioBitrateKbps || 256))}k`)
  }

  if (format === 'mp4' || format === 'mov') args.push('-movflags', '+faststart')
  if (format === 'mkv' || format === 'matroska') args.push('-f', 'matroska')
  if (format === 'mov') args.push('-f', 'mov')
  if (format === 'webm') args.push('-f', 'webm')
  args.push('-t', number(duration), '-max_muxing_queue_size', '2048', temporaryOutput)

  return {
    args,
    duration,
    expectedSizeBytes: preset === 'lossless'
      ? Math.ceil(duration * width * height * 0.3)
      : Math.ceil(duration * ((Number(settings.videoBitrateMbps || 12) * 1_000_000 + Number(settings.audioBitrateKbps || 256) * 1000) / 8)),
    warnings: preset === 'lossless' ? ['无损 MKV 保存的是渲染合成后的媒体，不会保留原始压缩码流。'] : [],
    inputCount: inputs.length + 1,
  }
}

module.exports = { buildExportArguments, buildSubtitles, classifyAsset, escapeFilterString }
