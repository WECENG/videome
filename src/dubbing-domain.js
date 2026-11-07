// Dubbing provenance deliberately uses dubbingSource, never linkedClipId.
const fields = ['id', 'assetId', 'trackId', 'kind', 'start', 'duration', 'trimStart', 'trimEnd', 'volume', 'muted', 'audioLinked', 'suppressEmbeddedAudio', 'linkedClipId']
const signature = (clip) => Object.fromEntries(fields.map((key) => [key, clip[key] ?? null]))
const audible = (clip, tracks) => !clip.muted && !tracks.find((track) => track.id === clip.trackId)?.muted && Number(clip.volume ?? 0.82) > 0

export function resolveDubbingSource(project, clipId) {
  const selected = project.clips.find((clip) => clip.id === clipId)
  if (!selected || !['video', 'audio'].includes(selected.kind)) throw new Error('请选择一个含英文对白的视频或音频片段。')
  const asset = project.assets.find((item) => item.id === selected.assetId)
  if (!asset?.path || asset.missing || !asset.audioCodec) throw new Error('所选片段没有可读取的源音轨。')
  let audio = selected
  if (selected.kind === 'video') {
    const candidates = project.clips.filter((clip) => clip.kind === 'audio' && clip.linkedClipId === selected.id)
    if (candidates.length !== 1 || candidates[0].assetId !== selected.assetId
      || Math.abs(candidates[0].start - selected.start) > 0.001 || Math.abs(candidates[0].duration - selected.duration) > 0.001
      || Math.abs(Number(candidates[0].trimStart || 0) - Number(selected.trimStart || 0)) > 0.001) {
      throw new Error('原声音轨已分割、删除或解除联动，无法唯一确定对白区间。请改选具体的音频片段。')
    }
    audio = candidates[0]
  }
  if (!Number.isFinite(selected.start) || !(selected.duration > 0) || selected.duration > 1800) throw new Error('首版每次处理不超过 30 分钟的片段。')
  const related = [audio, ...(selected.kind === 'video' ? [selected] : project.clips.filter((clip) => clip.id === audio.linkedClipId))]
  return {
    selectedClipId: selected.id, audioClipId: audio.id, name: selected.name, path: asset.path,
    start: selected.start, duration: selected.duration, trimStart: Number(audio.trimStart || 0),
    gain: Number(audio.volume ?? 0.82),
    snapshot: JSON.stringify({ path: asset.path, clips: related.map(signature) }),
  }
}

export function resolveDubbingSources(project, clipIds) {
  const sources = []; const issues = []; const seen = new Set()
  const ids = [...new Set(clipIds)]
  // Concrete audio is the most precise choice when its linked video is also selected.
  const ordered = ids.map((id) => project.clips.find((clip) => clip.id === id)).filter(Boolean)
    .sort((a, b) => a.start - b.start || (a.kind === 'audio' ? -1 : 1))
  for (const clip of ordered) {
    if (clip.kind === 'video' && ordered.some((item) => item.kind === 'audio' && item.linkedClipId === clip.id)) continue
    try {
      const source = resolveDubbingSource(project, clip.id)
      if (!seen.has(source.audioClipId)) { sources.push(source); seen.add(source.audioClipId) }
    } catch (error) { issues.push({ id: clip.id, name: clip.name, reason: error.message }) }
  }
  for (const id of ids.filter((id) => !project.clips.some((clip) => clip.id === id))) issues.push({ id, name: '已删除片段', reason: '来源片段已不存在。' })
  return { sources, issues, selectedCount: ids.length, duplicateCount: ids.length - sources.length - issues.length }
}

export function applyDubbingResults(project, jobs) {
  if (!jobs.length) throw new Error('请先选择已校对并试听的配音草稿。')
  const audioIds = new Set()
  for (const job of jobs) {
    if (audioIds.has(job.source.audioClipId)) throw new Error('所选草稿包含同一来源的重复配音，请只保留一条。')
    audioIds.add(job.source.audioClipId)
    applyDubbingResult(project, job)
  }
  let next = applyDubbingResult(project, jobs[0])
  const tracks = next.tracks.filter((track) => track.label === '中文配音' || track.label === '保留背景')
    .sort((first, second) => first.label === '中文配音' ? -1 : second.label === '中文配音' ? 1 : 0)
  for (const job of jobs.slice(1)) next = applyDubbingResult(next, job, { tracks })
  return next
}

export function applyDubbingResult(project, job, { tracks: sharedTracks } = {}) {
  if (project.projectId !== job.projectId) throw new Error('当前工程已切换，请回到任务来源工程。')
  if (project.clips.some((clip) => clip.dubbingSource?.taskId === job.id)) throw new Error('此配音已入轨，可撤销后重新应用。')
  const source = resolveDubbingSource(project, job.source.selectedClipId)
  if (source.snapshot !== job.source.snapshot) throw new Error('来源片段或裁剪区间已变化，请重新创建配音任务。')
  if (job.status !== 'ready' || !job.cues?.length || job.cues.some((cue) => !cue.audioPath || cue.status !== 'ready')) throw new Error('请先生成全部配音并处理过长译文。')
  const sourceAudio = project.clips.find((clip) => clip.id === source.audioClipId)
  // The linked lane already owns source-audio routing in preview and export.
  // Muting its video would also mute unrelated portions of that video.
  const targets = [sourceAudio]
  for (const clip of targets) {
    if (audible(clip, project.tracks) && project.tracks.find((track) => track.id === clip.trackId)?.locked) throw new Error('需要静音的原声所在轨道已锁定，请先解锁。')
  }
  const start = source.start
  const end = start + source.duration
  const clips = project.clips.flatMap((clip) => {
    if (!targets.some((target) => target.id === clip.id) || !audible(clip, project.tracks)) return [clip]
    if (clip.start >= start && clip.start + clip.duration <= end) return [{ ...clip, volume: 0 }]
    // Preserve source outside the selected range, including its trim offsets.
    const points = [clip.start, Math.max(clip.start, start), Math.min(clip.start + clip.duration, end), clip.start + clip.duration]
    return points.slice(0, -1).flatMap((point, index) => {
      const until = points[index + 1]
      if (until <= point) return []
      const trimStart = Number(clip.trimStart || 0) + point - clip.start
      return [{ ...clip, id: index === 1 && points[0] === points[1] && points[2] === points[3] ? clip.id : `${clip.id}-${job.id}-${index}`,
        start: point, duration: until - point, trimStart, trimEnd: trimStart + until - point,
        volume: point >= start && until <= end ? 0 : clip.volume }]
    })
  })
  const existingDubbingTrack = project.tracks.find((track) => track.type === 'audio' && track.label === '中文配音' && !track.locked)
  const existingBackgroundTrack = project.tracks.find((track) => track.type === 'audio' && track.label === '保留背景' && !track.locked)
  const tracks = sharedTracks || [
    existingDubbingTrack || { id: `dubbing-${job.id}`, type: 'audio', label: '中文配音', accent: 'cyan', order: project.tracks.length, locked: false, muted: false },
    existingBackgroundTrack || { id: `background-${job.id}`, type: 'audio', label: '保留背景', accent: 'green', order: project.tracks.length + 1, locked: false, muted: false },
  ].map((track) => ({ ...track, muted: false }))
  const sourceGain = Number(source.gain)
  const dubbingGain = Number.isFinite(sourceGain) && sourceGain > 0 ? sourceGain : 0.82
  const provenance = { taskId: job.id, sourceClipId: source.selectedClipId, sourcePath: source.path, trimStart: source.trimStart, duration: source.duration, models: job.models, backend: job.backend || 'kokoro-fast', style: job.style || { emotion: 'neutral', rate: 1, pause: 'normal' } }
  const entries = [...job.cues.map((cue) => ({ id: cue.id, path: cue.audioPath, name: cue.translation, duration: cue.end - cue.start, offset: cue.start, track: tracks[0], cue })),
    { id: 'background', path: job.backgroundPath, name: `${source.name} · 保留背景`, duration: source.duration, offset: 0, track: tracks[1] }]
  const assets = entries.map((entry) => ({ id: `dub-asset-${job.id}-${entry.id}`, name: `${entry.name.slice(0, 60)}.wav`, path: entry.path,
    kind: 'audio', codec: 'pcm_s16le', audioCodec: 'pcm_s16le', duration: entry.duration, sourceDuration: entry.duration,
    missing: false, dubbingSource: { ...provenance, cueId: entry.cue?.id || null } }))
  const additions = entries.map((entry, index) => ({ id: `dub-clip-${job.id}-${entry.id}`, assetId: assets[index].id, path: entry.path,
    trackId: entry.track.id, name: entry.name, kind: 'audio', start: start + entry.offset, duration: entry.duration,
    trimStart: 0, trimEnd: entry.duration, sourceDuration: entry.duration, color: entry.track.accent,
    volume: dubbingGain, muted: false, isMusic: false, dubbingSource: { ...provenance, cueId: entry.cue?.id || null } }))
  const trackIds = new Set(tracks.map((track) => track.id))
  const dubbingTrackIds = new Set(project.tracks.filter((track) => track.type === 'audio' && (track.label === '中文配音' || track.label === '保留背景')).map((track) => track.id))
  const nextTracks = sharedTracks
    ? project.tracks.map((track) => trackIds.has(track.id) || dubbingTrackIds.has(track.id) ? { ...track, muted: false } : track)
    : tracks.reduce((current, track) => current.some((item) => item.id === track.id)
      ? current.map((item) => item.id === track.id ? { ...item, muted: false } : item)
      : [...current, track], project.tracks)
  const nextClips = [...clips, ...additions].map((clip) => clip.dubbingSource && dubbingTrackIds.has(clip.trackId)
    ? { ...clip, muted: false }
    : clip)
  return { ...project, assets: [...project.assets, ...assets], tracks: nextTracks, clips: nextClips }
}
