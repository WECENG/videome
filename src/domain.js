export const defaultProject = {
  schemaVersion: 1,
  name: '未命名工程',
  projectDirectory: '',
  profile: '1920×1080 · 30 fps',
  frameRate: { numerator: 30, denominator: 1 },
  frameSize: { width: 1920, height: 1080 },
  duration: 60,
  playhead: 0,
  assets: [],
  clips: [],
  tracks: [
    { id: 'video-main', type: 'video', label: '主视频', accent: 'lime', order: 0, locked: false, muted: false },
    { id: 'video-overlay', type: 'video', label: '画面叠加', accent: 'rose', order: 1, locked: false, muted: false },
    { id: 'title', type: 'graphics', label: '标题图文', accent: 'amber', order: 2, locked: false, muted: false },
    { id: 'subtitles', type: 'subtitle', label: '字幕', accent: 'violet', order: 3, locked: false, muted: false },
    { id: 'audio-dialogue', type: 'audio', label: '原声 · 配音', accent: 'cyan', order: 0, locked: false, muted: false },
    { id: 'audio-music', type: 'audio', label: '背景音乐', accent: 'blue', order: 1, locked: false, muted: false },
  ],
  subtitle: {
    enabled: true,
    text: '',
    language: '简体中文',
    fontSize: 42,
    bottomPadding: 98,
    background: false,
    cues: [],
  },
  history: [],
  exportSettings: { preset: 'high', format: 'mp4', videoCodec: 'h264', videoBitrateMbps: 12, audioBitrateKbps: 256 },
}

export const sampleProject = {
  ...defaultProject,
  name: '海岛慢游 · 界面示例',
  duration: 148,
  playhead: 0,
  subtitle: {
    ...defaultProject.subtitle,
    text: '沿着海岸，寻找夏天的颜色。',
    cues: [
      { id: 'caption-1', start: 46, end: 50.9, text: '沿着海岸，寻找夏天的颜色。', edited: true },
      { id: 'caption-2', start: 53.2, end: 56.4, text: '也听见浪花写下的故事。', edited: false },
      { id: 'caption-3', start: 89.1, end: 93.4, text: '把这一刻，留给风和海。', edited: false },
    ],
  },
  clips: [
    { id: 'sample-1', trackId: 'video-main', assetId: 'sample-footage-1', name: '海岸晨光 · 航拍', start: 0, duration: 30, trimStart: 0, trimEnd: 30, sourceDuration: 30, color: 'lime', kind: 'video', hasAudio: true, previewColor: 'ocean' },
    { id: 'sample-2', trackId: 'video-main', assetId: 'sample-footage-2', name: '棕榈树影 · 片段 04', start: 32.2, duration: 21, trimStart: 0, trimEnd: 21, sourceDuration: 21, color: 'lime', kind: 'video', hasAudio: true, previewColor: 'palms' },
    { id: 'sample-3', trackId: 'video-main', assetId: 'sample-footage-3', name: '沿岸漫步 · 手持', start: 57, duration: 41, trimStart: 0, trimEnd: 41, sourceDuration: 41, color: 'lime', kind: 'video', hasAudio: true, previewColor: 'shore' },
    { id: 'sample-4', trackId: 'video-main', assetId: 'sample-footage-4', name: '落日水色 · 慢动作', start: 100, duration: 26, trimStart: 0, trimEnd: 26, sourceDuration: 26, color: 'lime', kind: 'video', hasAudio: true, previewColor: 'sunset' },
    { id: 'sample-5', trackId: 'video-overlay', assetId: 'sample-inset', name: '细节镜头 · 叠画', start: 73, duration: 12, trimStart: 0, trimEnd: 12, sourceDuration: 12, color: 'rose', kind: 'video', hasAudio: false, x: 0.28, y: -0.18, scale: 0.35, previewColor: 'boardwalk' },
    { id: 'sample-6', trackId: 'title', assetId: 'sample-title', name: 'SUMMER · 夏日序曲', start: 4, duration: 6.8, color: 'amber', kind: 'graphics', previewColor: 'orange' },
    { id: 'sample-7', trackId: 'title', assetId: 'sample-location', name: '海岸慢游 · 2026', start: 57, duration: 5.8, color: 'amber', kind: 'graphics', previewColor: 'green' },
    { id: 'sample-8', trackId: 'subtitles', assetId: 'caption-1', name: '沿着海岸，寻找夏天的颜色。', start: 46, duration: 4.9, color: 'violet', kind: 'subtitle' },
    { id: 'sample-9', trackId: 'subtitles', assetId: 'caption-2', name: '也听见浪花写下的故事。', start: 53.2, duration: 3.2, color: 'violet', kind: 'subtitle' },
    { id: 'sample-10', trackId: 'audio-dialogue', assetId: 'sample-dialogue', name: '环境声 · 原始录音', start: 0, duration: 104, color: 'cyan', kind: 'audio', volume: 0.75 },
    { id: 'sample-11', trackId: 'audio-music', assetId: 'sample-music', name: 'Saltwater Sun · 02:28', start: 0, duration: 140, color: 'blue', kind: 'audio', volume: 0.24, isMusic: true, fadeOut: 4.5 },
  ],
}

export const formatTime = (seconds, { milliseconds = false } = {}) => {
  const safe = Math.max(0, Number(seconds) || 0)
  const totalMilliseconds = Math.round(safe * 1000)
  const totalSeconds = milliseconds ? Math.floor(totalMilliseconds / 1000) : Math.floor(safe)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const wholeSeconds = totalSeconds % 60
  const fraction = totalMilliseconds % 1000
  const base = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}`
  return milliseconds ? `${base},${String(fraction).padStart(3, '0')}` : base
}

export const formatCompactTime = (seconds) => {
  const safe = Math.max(0, Number(seconds) || 0)
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}`
}

export const formatFileSize = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

export const fileUrl = (source) => {
  if (!source) return null
  if (/^(?:https?:|data:|blob:|file:|videome:)/i.test(source)) return source
  const normalized = String(source).replace(/\\/g, '/')
  return `http://127.0.0.1:4179/__videome/media?path=${encodeURIComponent(normalized)}`
}

export const getPreviewUrl = (asset, previewAssets = []) => {
  if (asset?.previewUrl) return asset.previewUrl
  const preview = previewAssets.find((item) => item.sourcePath === asset?.path || item.path === asset?.proxyPath)
  return preview?.proxyUrl || (preview?.proxyPath ? fileUrl(preview.proxyPath) : fileUrl(asset?.path || asset?.url))
}

export const findStreamCopyIssue = ({ preset, format, clip, track, subtitle }) => {
  if (preset !== 'stream-copy') return null
  if (track?.type === 'video' && clip.transition) return '转场会改变输出画面，需要重新编码。'
  if (track?.type === 'video' && (clip.crop || clip.rotation || clip.scale !== 1 || clip.opacity !== 1)) return '裁剪、旋转、缩放或透明度会改变画面，需要重新编码。'
  if (track?.type === 'video' && subtitle?.enabled && clipHasSubtitle(clip, subtitle.cues)) return '烧录字幕需要重新编码视频。'
  if (track?.type === 'audio' && Number(clip.volume ?? 1) !== 1) return '音量调整会重新编码音频；单独处理音频时可保留视频原码流。'
  if (format === 'mp4' && !['h264', 'hevc', 'mpeg4', 'aac', 'alac', 'mp3', 'mov_text'].includes(clip.codec)) return `编码 ${clip.codec || '未知'} 与 MP4 不兼容，无法仅通过换封装修复。`
  return null
}

export const clipHasSubtitle = (clip, cues) => cues.some((cue) => clip.start < cue.end && clip.start + clip.duration > cue.start)

export const makeMediaAsset = (path, metadata = {}) => ({
  id: metadata.id || `asset-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
  name: metadata.name || path.split(/[\\/]/).pop() || '未命名素材',
  path: metadata.path === undefined ? path : metadata.path,
  size: metadata.size || 0,
  mtimeMs: metadata.mtimeMs || null,
  duration: metadata.duration || 0,
  sourceDuration: metadata.sourceDuration || metadata.duration || 0,
  width: metadata.width || null,
  height: metadata.height || null,
  codec: metadata.videoCodec || metadata.audioCodec || null,
  videoCodec: metadata.videoCodec || null,
  audioCodec: metadata.audioCodec || null,
  kind: metadata.kind || guessMediaKind(path, metadata),
  previewUrl: metadata.previewUrl || null,
  rotation: metadata.rotation || 0,
  frameRate: metadata.frameRate || null,
  pixelFormat: metadata.pixelFormat || null,
  thumbnail: metadata.thumbnail || null,
  poster: metadata.poster || metadata.thumbnail || null,
  proxyPath: metadata.proxyPath || null,
  proxyUrl: metadata.proxyUrl || null,
  missing: false,
})

/**
 * Resolves media duration from container or stream timing fields. Some valid
 * videos omit format.duration and stream.duration but still expose timestamps
 * or frame counts; treating those as unknown previously truncated clips to the
 * ten-second UI fallback.
 */
export const resolveMediaDurationSeconds = (metadata = {}) => {
  const parseRational = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0
    const [numerator, denominator] = String(value || '').split('/').map(Number)
    if (!Number.isFinite(numerator)) return 0
    const result = numerator / (Number.isFinite(denominator) && denominator !== 0 ? denominator : 1)
    return Number.isFinite(result) && result > 0 ? result : 0
  }
  const streams = Array.isArray(metadata.streams) ? metadata.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video') || metadata.videoStream || metadata
  const audio = streams.find((stream) => stream.codec_type === 'audio') || metadata.audioStream || null
  const formatDuration = Number(metadata.format?.duration ?? metadata.duration)
  const streamDuration = Math.max(Number(video?.duration) || 0, Number(audio?.duration) || 0)
  const timestampDuration = Math.max(
    (Number(video?.duration_ts) || 0) * parseRational(video?.time_base),
    (Number(audio?.duration_ts) || 0) * parseRational(audio?.time_base),
  )
  const durationFromFrames = (stream, rate) => {
    const frames = Number(stream?.nb_frames) || 0
    const framesPerSecond = parseRational(rate)
    return frames > 0 && framesPerSecond > 0 ? frames / framesPerSecond : 0
  }
  const frameDuration = Math.max(
    durationFromFrames(video, video?.avg_frame_rate || video?.r_frame_rate),
    durationFromFrames(audio, audio?.avg_frame_rate),
  )
  return Math.max(0, Number.isFinite(formatDuration) ? formatDuration : 0, streamDuration, timestampDuration, frameDuration)
}

/**
 * Repairs clips created while duration probing fell back to the ten-second
 * placeholder. It only upgrades clip durations that are still near that
 * placeholder, leaving deliberate trims of longer clips untouched.
 */
export const repairPlaceholderDurationClips = (clips, assetId, sourceDuration) => {
  const actualDuration = Number(sourceDuration) || 0
  if (actualDuration <= 10.5) return clips
  const repairedVideoIds = new Set()
  const repaired = clips.map((clip) => {
    if (clip.assetId !== assetId || clip.kind !== 'video' || clip.batchMixClip) return clip
    const oldSourceDuration = Number(clip.sourceDuration) || 0
    if (Number(clip.duration) > 10.5) return clip
    if (oldSourceDuration > 10.5 && Math.abs(oldSourceDuration - actualDuration) > 0.5) return clip
    repairedVideoIds.add(clip.id)
    return {
      ...clip,
      duration: actualDuration,
      sourceDuration: actualDuration,
      trimStart: Number(clip.trimStart) || 0,
      trimEnd: (Number(clip.trimStart) || 0) + actualDuration,
    }
  })
  if (!repairedVideoIds.size) return clips
  return repaired.map((clip) => {
    if (clip.kind !== 'audio' || !repairedVideoIds.has(clip.linkedClipId)) return clip
    const video = repaired.find((item) => item.id === clip.linkedClipId)
    if (!video) return clip
    return { ...clip, duration: video.duration, sourceDuration: video.sourceDuration, trimStart: video.trimStart, trimEnd: video.trimEnd }
  })
}

export const guessMediaKind = (path, metadata = {}) => {
  if (metadata.width || metadata.videoCodec || /\.(mp4|mov|m4v|mkv|webm|avi|mts|mxf)$/i.test(path)) return 'video'
  if (metadata.audioCodec || /\.(mp3|wav|m4a|aac|flac|aiff|ogg)$/i.test(path)) return 'audio'
  if (/\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(path)) return 'image'
  return 'video'
}

export const mergeAssetsByPath = (existing, additions) => {
  const byPath = new Map(existing.filter((asset) => asset.path).map((asset) => [asset.path, asset]))
  const browserAssets = new Map(existing.filter((asset) => !asset.path).map((asset) => [asset.id, asset]))
  for (const addition of additions) {
    if (addition.path && byPath.has(addition.path)) {
      const previous = byPath.get(addition.path)
      const merged = { ...previous, ...addition, id: previous.id }
      byPath.set(merged.path, merged)
    } else if (addition.path) {
      byPath.set(addition.path, addition)
    } else {
      browserAssets.set(addition.id, { ...browserAssets.get(addition.id), ...addition })
    }
  }
  return [...byPath.values(), ...browserAssets.values()]
}

/**
 * Reconciles the per-project and persistent media library inventories. This
 * merge only adds or refreshes records and never treats importing one file as
 * replacing the rest of the library.
 */
export const mergeAssetLibraries = (...libraries) => libraries.reduce(
  (merged, library) => mergeAssetsByPath(merged, library || []),
  [],
)

/**
 * Returns assets in the exact order represented by a user's selection ids.
 * The library itself may be sorted by import time, so filtering it directly
 * would silently replace the user's sequence with library order.
 */
export const orderAssetsByIds = (assets, ids) => {
  const byId = new Map((Array.isArray(assets) ? assets : []).map((asset) => [asset.id, asset]))
  return (Array.isArray(ids) ? ids : []).map((id) => byId.get(id)).filter(Boolean)
}

export const toggleOrderedSelection = (ids, id) => {
  const current = Array.isArray(ids) ? ids : []
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
}

/**
 * Replaces only one asset in a library while preserving every unrelated
 * record, including browser-backed items that have no filesystem path.
 */
export const replaceAssetById = (assets, assetId, replacement) => {
  const list = Array.isArray(assets) ? assets : []
  if (!list.some((asset) => asset.id === assetId)) return mergeAssetsByPath(list, [replacement])
  return list.map((asset) => asset.id === assetId ? { ...asset, ...replacement, id: assetId } : asset)
}

/**
 * Removes an asset from a project together with every timeline clip that
 * references it. Linked companion clips are removed as well so an original
 * audio lane cannot be left behind after its video is deleted.
 */
export const removeAssetReferences = (project, assetId) => {
  const sourceClips = Array.isArray(project?.clips) ? project.clips : []
  const removedClipIds = new Set(sourceClips.filter((clip) => clip.assetId === assetId).map((clip) => clip.id))
  const clips = sourceClips.filter((clip) => clip.assetId !== assetId && !removedClipIds.has(clip.linkedClipId))
  return {
    ...project,
    assets: (project?.assets || []).filter((asset) => asset.id !== assetId),
    clips,
  }
}

export const timelineExportSnapshot = (project) => {
  const tracks = project.tracks || []
  const assets = project.assets || []
  const trackMap = new Map(tracks.map((track, index) => [track.id, { ...track, order: index }]))
  const clips = (project.clips || []).map((clip) => {
    const track = trackMap.get(clip.trackId)
    if (!track || clip.linkedClipId || track.muted || clip.muted) return null
    if (['video', 'audio', 'image'].includes(clip.kind)) return { ...clip, muted: false, path: assets.find((asset) => asset.id === clip.assetId)?.path || clip.path || null, trackId: track.id, track: { type: track.type, order: track.order, muted: false } }
    if (clip.kind === 'subtitle') return { ...clip, muted: false, path: `subtitle:${clip.sourceCueId || clip.id}`, text: clip.text || clip.name, trackId: track.id, track: { type: 'subtitle', order: track.order, muted: false } }
    if (clip.kind === 'graphics') return { ...clip, muted: false, path: `graphics:${clip.id}`, text: clip.text || clip.name, trackId: track.id, track: { type: 'graphics', order: track.order, muted: false } }
    return null
  }).filter(Boolean)
  const visibleTrackClips = project.subtitle?.enabled === false ? clips.filter((clip) => clip.kind !== 'subtitle') : clips
  return { ...project, tracks: tracks.map((track, index) => ({ ...track, order: index })), assets, clips: visibleTrackClips }
}

/**
 * Returns the topmost unmuted visual clip at a timeline time. Playback and the
 * preview use the same half-open interval so clips never leak across gaps.
 */
export const findActiveVisualClip = (project, time) => {
  const trackById = new Map((project?.tracks || []).map((track) => [track.id, track]))
  return (project?.clips || [])
    .filter((clip) => {
      const track = trackById.get(clip.trackId)
      const start = Number(clip.start)
      const end = start + Number(clip.duration)
      return ['video', 'image'].includes(clip.kind)
        && !clip.muted
        && !track?.muted
        && Number.isFinite(start)
        && Number.isFinite(end)
        && time >= start
        && time < end
    })
    .sort((first, second) => (trackById.get(second.trackId)?.order ?? 0) - (trackById.get(first.trackId)?.order ?? 0)
      || second.start - first.start)[0] || null
}

/**
 * Recognizes the pre-audio preview proxy cache format so old silent files can
 * be regenerated once after the proxy now preserves the source audio stream.
 */
export const isLegacySilentPreviewProxy = (url) => {
  if (typeof url !== 'string') return false
  let decoded = url
  try { decoded = decodeURIComponent(url) } catch {}
  return decoded.includes('/proxies/') && decoded.endsWith('.mp4') && !decoded.endsWith('-av2.mp4')
}

/**
 * Prefer the browser-compatible proxy for timeline audio; the source video may
 * have an audio codec Chromium cannot decode even when FFmpeg can read it.
 */
export const audioPreviewUrl = (asset, clip = {}) => asset?.proxyUrl || asset?.previewUrl || (asset?.path ? fileUrl(asset.path) : clip.path ? fileUrl(clip.path) : null)

export const trackTypes = [
  { type: 'video', label: '视频轨道', prefix: '视频轨', accents: ['lime', 'rose', 'amber', 'violet'] },
  { type: 'audio', label: '音频轨道', prefix: '音频轨', accents: ['cyan', 'blue', 'rose', 'green'] },
  { type: 'graphics', label: '标题图文轨道', prefix: '图文轨', accents: ['amber'] },
  { type: 'subtitle', label: '字幕轨道', prefix: '字幕轨', accents: ['violet'] },
]

export const createMediaClips = ({ assets, track, clips, playhead, duration, tracks }) => {
  const nextClips = []
  let nextTracks = [...tracks]
  let insertAt = Math.max(0, playhead)

  for (const asset of assets) {
    const kind = asset.kind === 'image' ? 'image' : asset.kind
    let targetTrack = kind === 'audio'
      ? (track?.type === 'audio' && !track.locked && !track.muted ? track : nextTracks.find((item) => item.type === 'audio' && !item.locked && !item.muted)) || makeTrack(nextTracks, 'audio')
      : (track?.type === 'video' && !track.locked ? track : nextTracks.find((item) => item.type === 'video' && !item.locked)) || makeTrack(nextTracks, 'video')
    const resolvedSourceDuration = Number(asset.sourceDuration ?? asset.duration) || 0
    const assetDuration = Number(asset.duration) || 0
    // Older imports could store a ten-second placeholder beside the measured
    // full duration. Prefer the latter only for that known placeholder case.
    const measuredDuration = assetDuration > 0 && assetDuration <= 10.5 && resolvedSourceDuration > 10.5
      ? resolvedSourceDuration
      : assetDuration || resolvedSourceDuration || Number(asset.audioDuration) || 0
    const clipDuration = kind === 'image'
      ? Math.max(5, Math.min(duration - insertAt, 8))
      : measuredDuration
    const clipId = `clip-${globalThis.crypto?.randomUUID?.() || Date.now()}-${nextClips.length}`

    if (clipDuration <= 0) continue
    nextClips.push({
      id: clipId,
      assetId: asset.id,
      path: asset.path,
      trackId: targetTrack.id,
      name: asset.name.replace(/\.[^.]+$/, ''),
      start: insertAt,
      duration: clipDuration,
      trimStart: 0,
      trimEnd: clipDuration,
      sourceDuration: kind === 'video' ? Math.max(clipDuration, resolvedSourceDuration) : clipDuration,
      color: targetTrack.accent,
      kind,
      hasAudio: Boolean(asset.audioCodec),
      codec: asset.videoCodec || asset.audioCodec || asset.codec,
      volume: kind === 'audio' ? 0.82 : kind === 'video' && asset.audioCodec ? 0 : 1,
      isMusic: false,
      audioLinked: kind === 'video' && Boolean(asset.audioCodec),
      previewColor: ['ocean', 'shore', 'sunset', 'palms', 'boardwalk', 'seafoam'][nextClips.length % 6],
      thumbnail: asset.thumbnail,
    })

    if (kind === 'video' && asset.audioCodec) {
      let audioTrack = nextTracks.find((item) => item.type === 'audio' && /原声|配音/i.test(item.label))
      if (!audioTrack) {
        audioTrack = makeTrack(nextTracks, 'audio')
        nextTracks = nextTracks.map((item) => item.id === audioTrack.id ? { ...item, label: '原声 · 配音' } : item)
        audioTrack = nextTracks.find((item) => item.id === audioTrack.id)
      }
      if (/^音频轨 \d+$/.test(audioTrack.label)) audioTrack.label = '原声 · 配音'
      nextClips.push({
        id: `${clipId}-source-audio`,
        linkedClipId: clipId,
        assetId: asset.id,
        path: asset.path,
        trackId: audioTrack.id,
        name: `${asset.name.replace(/\.[^.]+$/, '')} · 原声`,
        start: insertAt,
        duration: clipDuration,
        trimStart: 0,
        trimEnd: clipDuration,
        sourceDuration: Math.max(clipDuration, resolvedSourceDuration),
        color: audioTrack.accent,
        kind: 'audio',
        hasAudio: true,
        codec: asset.audioCodec,
        volume: 0.82,
        isMusic: false,
        audioLinked: true,
      })
    }
    insertAt += clipDuration + 0.3
  }

  const timelineEnd = Math.max(duration, ...nextClips.map((clip) => clip.start + clip.duration))
  return { clips: [...clips, ...nextClips], tracks: nextTracks, duration: timelineEnd, inserted: nextClips.filter((clip) => !clip.linkedClipId) }
}

export function createSubtitleTrack(tracks, id = `subtitle-${globalThis.crypto?.randomUUID?.() || Date.now()}`) {
  const count = tracks.filter((track) => track.type === 'subtitle').length + 1
  return { id, type: 'subtitle', label: count === 1 ? '字幕' : `字幕 ${count}`, accent: 'violet', order: tracks.length, locked: false, muted: false }
}

function makeTrack(tracks, type) {
  const definition = trackTypes.find((item) => item.type === type)
  if (!definition) throw new TypeError(`不支持的轨道类型：${type}`)
  let count = tracks.filter((track) => track.type === type).length + 1
  while (tracks.some((track) => track.label === `${definition.prefix} ${count}`)) count += 1
  const accent = definition.accents[(count - 1) % definition.accents.length]
  const order = Math.max(tracks.length, ...tracks.map((track) => (Number(track.order) || 0) + 1))
  const track = { id: `${type}-${globalThis.crypto?.randomUUID?.() || Date.now()}`, type, accent, label: `${definition.prefix} ${count}`, order, muted: false, locked: false }
  tracks.push(track)
  return track
}

export const addTrack = (tracks, type) => {
  const nextTracks = [...tracks]
  makeTrack(nextTracks, type)
  return nextTracks
}

export const moveClip = (clips, clipId, start, trackId = null) => {
  const clip = clips.find((item) => item.id === clipId)
  if (!clip) return clips
  const nextStart = Math.max(0, start)
  const delta = nextStart - clip.start
  return clips.map((item) => {
    if (item.id === clip.id) return { ...item, start: nextStart, ...(trackId ? { trackId } : {}) }
    if (item.linkedClipId === clipId || clip.linkedClipId === item.id) return { ...item, start: Math.max(0, item.start + delta) }
    return item
  })
}

/**
 * Moves a clip to a new start time and keeps every linked audio companion at
 * the same timeline position, regardless of which side of the link is moved.
 */
export const moveClipWithLinked = (clips, clipId, start, trackId = null) => {
  const selected = clips.find((clip) => clip.id === clipId)
  if (!selected) return clips
  const parentId = selected.linkedClipId || selected.id
  const parent = clips.find((clip) => clip.id === parentId)
  if (!parent) return clips
  const nextStart = Math.max(0, start)

  return clips.map((clip) => {
    if (clip.id === selected.id) return { ...clip, start: nextStart, ...(trackId ? { trackId } : {}) }
    if (clip.id === parentId || clip.linkedClipId === parentId) return { ...clip, start: nextStart }
    return clip
  })
}

const isSplitAudioDuplicate = (clip, parent) => clip?.kind === 'audio' && parent?.kind === 'audio'
  && clip.trackId === parent.trackId && clip.assetId === parent.assetId && clip.path === parent.path
  && Number(clip.start) === Number(parent.start) && Number(clip.duration) === Number(parent.duration)
  && Number(clip.trimStart || 0) === Number(parent.trimStart || 0)
  && Number(clip.trimEnd ?? Number(clip.trimStart || 0) + Number(clip.duration)) === Number(parent.trimEnd ?? Number(parent.trimStart || 0) + Number(parent.duration))

export const repairSplitAudioDuplicates = (clips) => {
  const byId = new Map()
  for (const clip of clips) {
    if (!byId.has(clip.id) || (byId.get(clip.id).linkedClipId === clip.id && clip.linkedClipId !== clip.id)) byId.set(clip.id, clip)
  }
  const duplicateIds = new Set()
  const aliases = new Set()
  for (const clip of clips) {
    const parent = clip.linkedClipId && byId.get(clip.linkedClipId)
    if (!isSplitAudioDuplicate(clip, parent)) continue
    duplicateIds.add(parent.id)
    duplicateIds.add(clip.id)
    if (clip.id !== parent.id) aliases.add(clip.id)
  }
  if (!duplicateIds.size) return clips
  const seen = new Set()
  return clips.flatMap((clip) => {
    if (!duplicateIds.has(clip.id)) return [clip]
    if (aliases.has(clip.id) || seen.has(clip.id)) return []
    seen.add(clip.id)
    const canonical = byId.get(clip.id)
    return [canonical.linkedClipId === canonical.id ? { ...canonical, linkedClipId: null, audioLinked: false } : canonical]
  })
}

export const splitClips = (clips, playhead, trackIds) => {
  const sourceClips = repairSplitAudioDuplicates(clips)
  const result = []
  const processed = new Set()
  const splitId = () => `clip-${globalThis.crypto?.randomUUID?.() || Date.now()}`
  const splitOne = (clip, secondId) => {
    const firstDuration = playhead - clip.start
    const secondDuration = clip.duration - firstDuration
    return [
      { ...clip, duration: firstDuration, trimEnd: (clip.trimStart || 0) + firstDuration },
      { ...clip, id: secondId, name: `${clip.name} · 后段`, start: playhead, trimStart: (clip.trimStart || 0) + firstDuration, ...(clip.sourceStart != null ? { sourceStart: clip.sourceStart + firstDuration } : {}), duration: secondDuration, trimEnd: (clip.trimStart || 0) + clip.duration },
    ]
  }

  sourceClips.forEach((clip) => {
    if (processed.has(clip.id)) return
    const parent = clip.kind === 'audio' && clip.linkedClipId
      ? sourceClips.find((candidate) => candidate.id === clip.linkedClipId && candidate.kind === 'video')
      : null
    const companion = clip.kind === 'video'
      ? sourceClips.find((candidate) => candidate.kind === 'audio' && candidate.linkedClipId === clip.id)
      : null
    const pair = parent ? [parent, clip] : companion ? [clip, companion] : [clip]
    const videoClip = parent || clip
    const start = Number(videoClip.start)
    const boundary = playhead - start
    const audioClip = pair.length > 1 ? pair.find((item) => item.kind === 'audio') : null
    const editablePair = pair.filter((item) => trackIds.includes(item.trackId))
    if (pair.length > 1 && editablePair.length === 1) {
      const editableClip = editablePair[0]
      const editableBoundary = playhead - editableClip.start
      if (editableBoundary > 1 / 240 && editableBoundary < Number(editableClip.duration) - 1 / 240) {
        const splitEditable = splitOne(editableClip, splitId()).map((item) => ({ ...item, linkedClipId: null, audioLinked: false }))
        result.push(...pair.filter((item) => item.id !== editableClip.id), ...splitEditable)
        pair.forEach((item) => processed.add(item.id))
        return
      }
    }
    if (!editablePair.length) {
      result.push(...pair)
      pair.forEach((item) => processed.add(item.id))
      return
    }
    const lockedPair = pair.some((item) => !trackIds.includes(item.trackId))
    const canSplit = !lockedPair && boundary > 1 / 240 && boundary < Number(videoClip.duration) - 1 / 240
    if (!canSplit) {
      result.push(...pair)
      pair.forEach((item) => processed.add(item.id))
      return
    }

    const secondVideoId = splitId()
    const splitVideo = splitOne(videoClip, secondVideoId)
    if (audioClip) {
      const secondAudioId = splitId()
      const splitAudio = splitOne(audioClip, secondAudioId)
      splitAudio[0].linkedClipId = splitVideo[0].id
      splitAudio[1].linkedClipId = splitVideo[1].id
      result.push(...splitVideo, ...splitAudio)
    } else {
      result.push(...splitVideo)
    }
    pair.forEach((item) => processed.add(item.id))
  })
  return result
}

export const unlinkClipPair = (clips, clipId) => {
  const selected = clips.find((clip) => clip.id === clipId)
  if (!selected) return clips
  const parentId = selected.linkedClipId || selected.id
  const pairedIds = new Set([parentId, ...clips.filter((clip) => clip.linkedClipId === parentId).map((clip) => clip.id)])
  return clips.map((clip) => pairedIds.has(clip.id)
    ? { ...clip, linkedClipId: null, audioLinked: false }
    : clip)
}

export const removeClip = (clips, id, ripple = false, tracks = []) => {
  let selected = clips.find((clip) => clip.id === id)
  const visited = new Set()
  while (selected?.linkedClipId && !visited.has(selected.id)) {
    visited.add(selected.id)
    const parent = clips.find((clip) => clip.id === selected.linkedClipId)
    if (!isSplitAudioDuplicate(selected, parent)) break
    selected = parent
  }
  const sourceClips = repairSplitAudioDuplicates(clips)
  const removed = sourceClips.find((clip) => clip.id === selected?.id)
  if (!removed) return clips
  const lockedTrackIds = new Set(tracks.filter((track) => track.locked).map((track) => track.id))
  if (lockedTrackIds.has(removed.trackId)) return clips
  const removeIds = new Set([removed.id])
  if (!removed.linkedClipId) sourceClips.filter((item) => item.linkedClipId === removed.id && !lockedTrackIds.has(item.trackId)).forEach((item) => removeIds.add(item.id))
  const filtered = sourceClips.filter((clip) => !removeIds.has(clip.id)).map((clip) => removeIds.has(clip.linkedClipId)
    ? { ...clip, linkedClipId: null, audioLinked: false }
    : clip)
  if (!ripple) return filtered

  return filtered.map((clip) => {
    if (lockedTrackIds.has(clip.trackId)) return clip
    const rippleSameTrack = clip.trackId === removed.trackId && clip.start >= removed.start + removed.duration - 1 / 240
    const parent = removed.linkedClipId ? sourceClips.find((candidate) => candidate.id === removed.linkedClipId) : removed
    const rippleLinkedTrack = Boolean(!removed.linkedClipId && (parent?.audioLinked || removed.audioLinked) && parent?.assetId === clip.assetId && clip.kind === 'audio' && clip.start >= removed.start + removed.duration - 1 / 240)
    return rippleSameTrack || rippleLinkedTrack ? { ...clip, start: Math.max(0, clip.start - removed.duration) } : clip
  })
}

/**
 * Removes every clip assigned to one track and keeps linked picture/audio
 * pairs consistent when a companion clip lives on another track.
 */
export const removeTrackClips = (clips, trackId) => {
  const sourceClips = Array.isArray(clips) ? clips : []
  const directClips = sourceClips.filter((clip) => clip.trackId === trackId)
  if (!directClips.length) return sourceClips

  const removeIds = new Set(directClips.map((clip) => clip.id))
  directClips.forEach((clip) => {
    const parentId = clip.linkedClipId || clip.id
    removeIds.add(parentId)
    sourceClips.filter((candidate) => candidate.linkedClipId === parentId).forEach((candidate) => removeIds.add(candidate.id))
  })
  return sourceClips.filter((clip) => !removeIds.has(clip.id))
}

export const removeTrack = (project, trackId) => {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track || track.locked) return project
  const clips = removeTrackClips(project.clips, trackId)
  const retainedIds = new Set(clips.map((clip) => clip.id))
  const removedClips = project.clips.filter((clip) => !retainedIds.has(clip.id))
  const lockedTrackIds = new Set(project.tracks.filter((item) => item.locked).map((item) => item.id))
  if (removedClips.some((clip) => lockedTrackIds.has(clip.trackId))) return project

  const tracks = project.tracks.filter((item) => item.id !== trackId).map((item, order) => ({ ...item, order }))
  const cueId = (clip) => clip.sourceCueId || clip.assetId
  const removedCueIds = new Set(removedClips.filter((clip) => clip.kind === 'subtitle').map(cueId))
  const retainedCueIds = new Set(clips.filter((clip) => clip.kind === 'subtitle').map(cueId))
  const removedLastSubtitleTrack = track.type === 'subtitle' && !tracks.some((item) => item.type === 'subtitle')
  const cues = (project.subtitle?.cues || []).filter((cue) => retainedCueIds.has(cue.id)
    || (!removedCueIds.has(cue.id) && !removedLastSubtitleTrack))
  return {
    ...project,
    tracks,
    clips,
    subtitle: cues.length === (project.subtitle?.cues || []).length
      ? project.subtitle
      : { ...project.subtitle, cues, text: cues.map((cue) => cue.text).join('\n') },
  }
}

export const createSrt = (cues) => cues
  .filter((cue) => cue.text.trim() && cue.end > cue.start)
  .sort((first, second) => first.start - second.start)
  .map((cue, index) => `${index + 1}\n${formatTime(cue.start, { milliseconds: true })} --> ${formatTime(cue.end, { milliseconds: true })}\n${cue.text}`)
  .join('\n\n')

export const parseSrt = (content) => {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r/g, '').trim()
  if (!normalized) return []
  return normalized.split(/\n{2,}/).map((block, index) => {
    const lines = block.split('\n').filter(Boolean)
    const timingIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingIndex < 0) return null
    const [start, end] = lines[timingIndex].split('-->').map((value) => parseSrtTime(value.trim()))
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
    return { id: `subtitle-${Date.now()}-${index}`, start, end, text: lines.slice(timingIndex + 1).join('\n'), edited: true, source: 'import' }
  }).filter(Boolean)
}

export const parseSubtitleFile = (content, extension = 'srt') => {
  const lowerExtension = String(extension).toLowerCase()
  if (lowerExtension === 'srt') return parseSrt(content)

  const lines = String(content).replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')
  if (lowerExtension === 'vtt') {
    const blocks = String(content).replace(/^\uFEFF/, '').replace(/^WEBVTT[^\n]*\n/i, '').replace(/\r/g, '').trim().split(/\n{2,}/)
    return blocks.flatMap((block, index) => {
      const cueLines = block.split('\n').filter(Boolean)
      const timingIndex = cueLines.findIndex((line) => line.includes('-->'))
      if (timingIndex < 0) return []
      const [start, end] = cueLines[timingIndex].split('-->').map((value) => parseSubtitleTimestamp(value.trim()))
      const text = cueLines.slice(timingIndex + 1).join('\n')
      return end > start && text.trim() ? [{ id: `subtitle-${Date.now()}-${index}`, start, end, text, edited: true, source: 'import' }] : []
    })
  }

  const style = {}
  const cues = []
  const timestamps = parseSubtitleTimestamp
  let entry = null

  for (const line of lines) {
    if (line.startsWith('Style:')) {
      const fields = line.slice(6).split(',')
      const fieldNames = ['name', 'fontName', 'fontSize', 'primaryColor', 'secondaryColor', 'outlineColor', 'backColor', 'bold', 'italic', 'underline', 'strikeOut', 'scaleX', 'scaleY', 'spacing', 'angle', 'borderStyle', 'outline', 'shadow', 'alignment', 'marginL', 'marginR', 'marginV', 'encoding']
      fieldNames.forEach((fieldName, index) => { style[fieldName] = fields[index]?.trim() })
      continue
    }

    if (line.startsWith('Dialogue:')) {
      if (entry && entry.text) cues.push(entry)
      const fields = line.slice(9).split(',')
      if (fields.length < 10) { entry = null; continue }
      const start = timestamps(fields[1])
      const end = timestamps(fields[2])
      const position = Number(fields[8])
      const margin = Number(fields[7])
      const overrideText = fields.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').trim()
      const alignment = Number.isFinite(position) ? position : Number(style.alignment || 2)
      const fontSize = Number(style.fontSize) || 42
      entry = end > start && overrideText ? { id: `subtitle-${Date.now()}-${cues.length}`, start, end, text: overrideText, edited: true, source: 'import', fontSize, titlePosition: alignment >= 7 ? 'top' : alignment >= 4 ? 'center' : 'bottom', bottomPadding: margin } : null
      continue
    }

    if (line.startsWith('WEBVTT') || line.startsWith('Format:') || line.startsWith('ScriptType:') || line.startsWith('PlayRes')) continue
  }

  if (entry && entry.text) cues.push(entry)
  return cues
}

export const createAss = (cues, { width = 1920, height = 1080, fontSize = 42, bottomPadding = 92, background = false, family = 'Noto Sans CJK SC' } = {}) => {
  const playX = Math.max(1, Math.round(Number(width) || 1920))
  const playY = Math.max(1, Math.round(Number(height) || 1080))
  const size = Math.max(12, Math.round(Number(fontSize) * playY / 1080 || 42))
  const margin = Math.max(8, Math.round(Number(bottomPadding) * playY / 1080 || 92))
  const escapedFamily = String(family).replace(/[,\\]/g, '')
  const eventTime = (time) => {
    const centiseconds = Math.round(Math.max(0, Number(time) || 0) * 100)
    return `${Math.floor(centiseconds / 360000)}:${String(Math.floor((centiseconds % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((centiseconds % 6000) / 100)).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
  }
  const escapeText = (text) => String(text).replace(/[{}]/g, '').replace(/\r\n?/g, '\n').replace(/\n/g, '\\N')
  const rows = cues.filter((cue) => cue.text.trim() && cue.end > cue.start).sort((first, second) => first.start - second.start)
  const alignment = background ? 2 : 2
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${playX}`, `PlayResY: ${playY}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${escapedFamily},${size},&H00FFFFFF,&H0000FFFF,&H0015161A,${background ? '&H980C0D0F' : '&H00000000'},0,0,0,0,100,100,0,0,${background ? 3 : 1},${background ? 0 : 3},0.5,${alignment},50,50,${margin},1`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...rows.map((cue) => `Dialogue: 0,${eventTime(cue.start)},${eventTime(cue.end)},Default,,0,0,0,,${escapeText(cue.text)}`),
  ].join('\n')
}

function parseSubtitleTimestamp(value) {
  const match = String(value).match(/(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})/)
  if (!match) return Number.NaN
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000
}

function parseSrtTime(value) {
  const match = value.match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/)
  if (!match) return Number.NaN
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000
}

export const renderSrt = createSrt

export const exportEstimate = ({ duration, bitrateMbps = 12, preset = 'high', audioBitrateKbps = 256 }) => {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  if (preset === 'lossless') return Math.ceil(duration * 0.3 * 1920 * 1080)
  if (preset === 'stream-copy') return 0
  return Math.ceil(duration * ((bitrateMbps * 1_000_000 + audioBitrateKbps * 1000) / 8))
}

export const assessExport = ({ assets, clips, tracks = [], preset, format, frameSize }) => {
  const primaryVideos = clips.filter((clip) => clip.kind === 'video')
  const realVideos = primaryVideos.filter((clip) => assets.some((asset) => asset.id === clip.assetId && asset.path && !asset.missing))
  const issues = []
  const visibleClips = clips.filter((clip) => !clip.muted && !tracks.find((track) => track.id === clip.trackId)?.muted)
  if (!realVideos.length) issues.push({ severity: 'error', title: '先导入一段真实视频', detail: '示例素材仅用于界面体验；导出需要由你导入的真实视频文件。' })
  if (preset === 'stream-copy' && (realVideos.length !== 1 || visibleClips.some((clip) => !['video', 'audio'].includes(clip.kind)) || visibleClips.some((clip) => clip.kind === 'audio' && Number(clip.volume ?? 1) !== 1))) issues.push({ severity: 'error', title: '原码流保留条件不满足', detail: '仅支持单段原视频的安全复制；多个片段、字幕、额外音轨和画面叠加需要重新编码。' })
  if (preset === 'stream-copy' && realVideos.some((clip) => clip.codec && format === 'mp4' && !['h264', 'hevc', 'mpeg4'].includes(clip.codec))) issues.push({ severity: 'error', title: '当前编码不支持 MP4 直接封装', detail: '请切换 MKV 或使用日常高质量重新编码。' })
  if (preset !== 'stream-copy' && clips.some((clip) => clip.missing || (!clip.assetId && clip.kind !== 'subtitle'))) issues.push({ severity: 'error', title: '存在未关联或丢失的素材', detail: '重新定位源素材后才能导出。' })
  if (frameSize.width > 1920 || frameSize.height > 1080) issues.push({ severity: 'info', title: '4K 输出会延长渲染时间', detail: '使用已导入素材检查显存、内存和磁盘空间。' })
  return { issues, ready: issues.every((issue) => issue.severity !== 'error') }
}

const musicFeatures = (track = {}) => ({
  ...track,
  ...(track.analysis || {}),
  ...(track.musicOverrides || {}),
  mood: track.musicOverrides?.mood || track.analysis?.mood || track.mood || 'versatile',
  tempo: track.musicOverrides?.tempo || track.analysis?.tempo || track.tempo || 'flexible',
  bpm: track.musicOverrides?.bpm ?? track.analysis?.bpm ?? track.bpm ?? null,
  energy: track.musicOverrides?.energy ?? track.analysis?.energy ?? null,
})

const scorePart = (value, weight, available = true) => available ? { value, weight } : null

export const generateSuggestions = (music, { mood = 'sunny', tempo = 'mid', duration = 148, videoAnalysis = null } = {}) => music
  .map((rawTrack) => {
    const track = musicFeatures(rawTrack)
    const targetBpm = Number(videoAnalysis?.targetBpm) || (tempo === 'slow' ? 72 : tempo === 'fast' ? 124 : 96)
    const targetEnergy = Number(videoAnalysis?.targetEnergy)
    const expectedMood = videoAnalysis?.suggestedMood || mood
    const parts = [
      scorePart(Math.max(0, 15 - Math.abs(Number(track.duration || 0) - duration) / 12), 15, Number(track.duration) > 0),
      scorePart(track.bpm ? Math.max(0, 25 - Math.abs(track.bpm - targetBpm) / 2.2) : (track.tempo === tempo ? 18 : track.tempo === 'flexible' ? 10 : 0), 25, Boolean(track.bpm || track.tempo)),
      scorePart(targetEnergy != null && track.energy != null ? Math.max(0, 20 - Math.abs(track.energy - targetEnergy) * 20) : track.tempo === tempo ? 14 : 9, 20, Boolean(track.energy != null || track.tempo)),
      scorePart(track.mood === expectedMood ? 20 : track.mood === 'versatile' ? 10 : 3, 20, Boolean(track.mood)),
      scorePart(videoAnalysis?.dialogueRatio > 0.45 ? (track.dynamicRange != null ? Math.max(0, 20 - track.dynamicRange * 28) : track.tempo === 'slow' ? 15 : 9) : 14, 20, videoAnalysis?.dialogueRatio != null),
    ].filter(Boolean)
    const score = parts.length ? Math.round(parts.reduce((sum, part) => sum + part.value, 0) / parts.reduce((total, item) => total + item.weight, 0) * 100) : 0
    const reasons = []
    if (track.bpm) reasons.push(Math.abs(track.bpm - targetBpm) < 12 ? 'BPM 接近当前镜头节奏' : '节奏适合镜头变化')
    if (videoAnalysis?.dialogueRatio > 0.45 && (track.dynamicRange == null || track.dynamicRange < 0.35)) reasons.push('对白密度较高，音乐动态较平稳')
    if (track.mood === expectedMood) reasons.push('氛围和画面倾向匹配')
    if (Math.abs(Number(track.duration || 0) - duration) < 20) reasons.push('时长接近当前工程')
    if (!track.analysis && !track.musicOverrides) reasons.push('部分特征尚未完成分析')
    return { ...rawTrack, ...track, score, confidence: track.analysis?.status === 'ready' || track.musicOverrides ? 'high' : 'low', reason: reasons.slice(0, 2).join(' · ') || '可作为情绪备选' }
  })
  .sort((first, second) => second.score - first.score)
  .slice(0, 3)

export const calculateWaveform = (seed, bars = 88) => {
  let state = 0
  for (const character of String(seed)) state = (state * 31 + character.charCodeAt(0)) >>> 0
  return Array.from({ length: bars }, (_, index) => {
    state = (state * 1664525 + 1013904223) >>> 0
    return Math.max(12, Math.min(94, 18 + ((state >>> 16) % 72) + Math.abs(Math.sin(index / 8.5 + (state % 13))) * 34))
  })
}

export const thumbnailForTime = (asset, time) => {
  if (asset?.thumbnail) return asset.thumbnail
  if (asset?.path) return `videome-frame://thumbnail?path=${encodeURIComponent(asset.path)}&time=${encodeURIComponent(time)}`
  return null
}

export const defaultMusic = [
  { id: 'music-ocean', name: 'Saltwater Sun', artist: 'Quiet Tides', duration: 148, mood: 'sunny', tempo: 'mid', genre: 'Indie folk · 器乐', bpm: 92, license: null, type: 'local', volume: 0.22 },
  { id: 'music-piano', name: 'Golden Hourglass', artist: 'Morrow', duration: 136, mood: 'calm', tempo: 'slow', genre: 'Piano · 环境', bpm: 66, license: null, type: 'local', volume: 0.25 },
  { id: 'music-drive', name: 'Soft Current', artist: 'Faint Coast', duration: 164, mood: 'energetic', tempo: 'mid', genre: '电子 · 轻快', bpm: 108, license: null, type: 'local', volume: 0.2 },
  { id: 'music-film', name: 'Blue on Blue', artist: 'The Field Notes', duration: 152, mood: 'dreamy', tempo: 'slow', genre: 'Cinematic · 电影感', bpm: 72, license: null, type: 'local', volume: 0.23 },
]
