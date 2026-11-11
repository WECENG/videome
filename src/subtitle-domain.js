export function resolveWhisperSelectionClips(clips, ids) {
  const selected = [...new Set(ids)].map((id) => clips.find((clip) => clip.id === id)).filter((clip) => clip && ['audio', 'video'].includes(clip.kind))
  return selected.filter((clip) => !(clip.kind === 'video' && selected.some((other) => other.kind === 'audio' && other.linkedClipId === clip.id)))
}

export function timelineWhisperSourceRange(clip) {
  const duration = Number(clip?.duration) || 0
  if (!(duration > 0)) return null
  return {
    trimStart: Math.max(0, Number(clip.trimStart) || 0),
    duration,
    timelineStart: Math.max(0, Number(clip.start) || 0),
  }
}

export function formatSubtitleTime(value) {
  const milliseconds = Math.max(0, Math.round((Number(value) || 0) * 1000))
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor(milliseconds / 1000) % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`
}

export function parseSubtitleTime(value) {
  const text = String(value).trim()
  if (/^\d+(?:\.\d{1,3})?$/.test(text)) return Number(text)
  const parts = text.split(':')
  if (parts.length < 2 || parts.length > 3 || !/^\d+$/.test(parts[0])) return NaN
  if (!/^[0-5]\d(?:\.\d{1,3})?$/.test(parts.at(-1))) return NaN
  if (parts.length === 3 && !/^[0-5]\d$/.test(parts[1])) return NaN
  return parts.map(Number).reduce((total, part) => total * 60 + part, 0)
}

export function subtitleTimingError(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) return '请输入有效时间，例如 00:26.100。'
  if (end <= start) return '结束时间需要晚于开始时间。'
  return ''
}

export function subtitleOverlapIds(cues) {
  const overlapping = new Set()
  const sorted = [...cues].sort((first, second) => first.start - second.start)
  let previous = null
  for (const cue of sorted) {
    if (previous && cue.start < previous.end - 0.001) {
      overlapping.add(previous.id)
      overlapping.add(cue.id)
    }
    if (!previous || cue.end > previous.end) previous = cue
  }
  return overlapping
}

export function subtitleClipCueId(clip) {
  return clip.sourceCueId || clip.assetId
}

export function timelineSubtitleCues(project) {
  const tracks = new Map((project.tracks || []).map((track) => [track.id, track]))
  const byCue = new Map()
  for (const clip of project.clips || []) {
    if (clip.kind !== 'subtitle') continue
    const id = subtitleClipCueId(clip)
    if (!byCue.has(id)) byCue.set(id, [])
    byCue.get(id).push(clip)
  }
  return (project.subtitle?.cues || []).flatMap((cue) => {
    const clips = byCue.get(cue.id)
    if (!clips?.length) return [{ ...cue, sourceCueId: cue.id }]
    return clips.flatMap((clip) => {
      const offset = Number(clip.start) - Number(clip.sourceStart ?? cue.start)
      const start = Math.max(Number(clip.start), Number(cue.start) + offset)
      const end = Math.min(Number(clip.start) + Number(clip.duration), Number(cue.end) + offset)
      if (!(end > start)) return []
      return [{ ...cue, id: clip.id, sourceCueId: cue.id, clipId: clip.id, start, end, muted: Boolean(clip.muted || tracks.get(clip.trackId)?.muted) }]
    })
  }).sort((a, b) => a.start - b.start || a.end - b.end)
}

export function activeSubtitleAtTime(cues, time, preferredId) {
  // End is exclusive. The tiny tolerance only absorbs binary rounding at a
  // shared boundary; it must not keep the previous sentence on the next one.
  const active = cues.filter((cue) => !cue.muted && time >= cue.start - 1e-7 && time < cue.end - 1e-7)
  return active.find((cue) => cue.id === preferredId) || active.sort((a, b) => b.start - a.start)[0] || null
}

export function refreshSubtitleClipText(project) {
  const cues = new Map((project.subtitle?.cues || []).map((cue) => [cue.id, cue]))
  let changed = false
  const clips = project.clips.map((clip) => {
    const cue = clip.kind === 'subtitle' && cues.get(subtitleClipCueId(clip))
    if (!cue || clip.name === cue.text && (clip.text === undefined || clip.text === cue.text)) return clip
    changed = true
    return { ...clip, name: cue.text, ...(clip.text !== undefined ? { text: cue.text } : {}) }
  })
  return changed ? { ...project, clips } : project
}

// Keep the editor, preview, subtitle clips and exported text on the same data.
export function updateSubtitleCue(project, cueId, patch) {
  const current = project.subtitle.cues.find((cue) => cue.id === cueId)
  if (!current) return project
  const cue = { ...current, ...patch, edited: true }
  if (subtitleTimingError(cue.start, cue.end)) return project
  const cues = project.subtitle.cues.map((item) => item.id === cueId ? cue : item)
  const retimed = patch.start !== undefined || patch.end !== undefined
  const clips = project.clips.map((clip) => clip.kind === 'subtitle' && subtitleClipCueId(clip) === cueId
    ? { ...clip, name: cue.text, ...(clip.text !== undefined ? { text: cue.text } : {}), ...(retimed ? { start: cue.start, duration: cue.end - cue.start, sourceStart: cue.start } : {}) }
    : clip)
  return {
    ...project, clips,
    duration: Math.max(project.duration, cue.end),
    subtitle: { ...project.subtitle, cues, text: cues.map((item) => item.text).join('\n') },
  }
}

export function updateTimelineSubtitleCue(project, entryId, patch) {
  const entry = timelineSubtitleCues(project).find((cue) => cue.id === entryId)
  if (!entry) return project
  if (!entry.clipId) return updateSubtitleCue(project, entry.sourceCueId, patch)
  const next = { ...entry, ...patch }
  if (subtitleTimingError(next.start, next.end)) return project
  let result = patch.text !== undefined ? updateSubtitleCue(project, entry.sourceCueId, { text: patch.text }) : project
  if (patch.start === undefined && patch.end === undefined) return result
  const shared = result.clips.filter((clip) => clip.kind === 'subtitle' && subtitleClipCueId(clip) === entry.sourceCueId).length > 1
  // A split subtitle can share its text with another segment. Retiming one
  // segment must leave the other segment's timing intact.
  const cueId = shared ? `${entry.sourceCueId}-edit-${entry.clipId}` : entry.sourceCueId
  const source = result.subtitle.cues.find((cue) => cue.id === entry.sourceCueId)
  const cue = { ...source, id: cueId, start: next.start, end: next.end, text: next.text, edited: true }
  const cues = shared ? [...result.subtitle.cues, cue] : result.subtitle.cues.map((item) => item.id === cueId ? cue : item)
  return {
    ...result, duration: Math.max(result.duration, cue.end),
    subtitle: { ...result.subtitle, cues, text: cues.map((item) => item.text).join('\n') },
    clips: result.clips.map((clip) => clip.id === entry.clipId ? { ...clip, sourceCueId: cueId, assetId: cueId, sourceStart: cue.start, start: cue.start, duration: cue.end - cue.start } : clip),
  }
}

export function createWhisperSubtitleEdit(project, transcript, { timelineStart, sourceDuration, idPrefix, merge = true }) {
  if (!Array.isArray(transcript)) throw new Error('Whisper 返回了无效识别结果。')
  const cues = transcript.map((item, index) => {
    const start = Number(item.start)
    const end = Number(item.end)
    const text = String(item.text || '').trim()
    const itemDuration = Number(item.sourceDuration ?? sourceDuration)
    const itemTimelineStart = Number(item.timelineStart ?? timelineStart)
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > itemDuration + 0.05 || !Number.isFinite(itemTimelineStart)) return null
    const absoluteStart = itemTimelineStart + Math.min(itemDuration, start)
    const absoluteEnd = itemTimelineStart + Math.min(itemDuration, end)
    if (absoluteEnd <= absoluteStart) return null
    return { id: `${idPrefix}-${index + 1}`, start: absoluteStart, end: absoluteEnd, text, edited: false, source: 'whisper' }
  }).filter(Boolean)
  if (!cues.length) throw new Error('Whisper 没有返回有效字幕片段，请检查音频内容后重试。')
  const availableTrack = project.tracks.find((track) => track.type === 'subtitle' && !track.locked && !track.muted)
  const track = availableTrack || { id: `${idPrefix}-track`, type: 'subtitle', label: '字幕', accent: 'violet', order: project.tracks.length, locked: false, muted: false }
  const clips = cues.map((cue) => ({ id: `${idPrefix}-clip-${cue.id}`, assetId: cue.id, trackId: track.id, kind: 'subtitle', name: cue.text,
    start: cue.start, duration: cue.end - cue.start, color: track.accent, sourceCueId: cue.id, sourceStart: cue.start, missing: false, muted: false, source: 'whisper' }))
  const baseCues = merge ? (project.subtitle?.cues || []) : []
  const baseClips = merge ? project.clips : project.clips.filter((clip) => clip.kind !== 'subtitle')
  const nextCues = [...baseCues, ...cues].sort((first, second) => first.start - second.start || first.end - second.end)
  const next = {
    ...project,
    tracks: availableTrack ? project.tracks : [...project.tracks, track],
    clips: [...baseClips, ...clips],
    duration: Math.max(Number(project.duration) || 0, ...clips.map((clip) => clip.start + clip.duration)),
    subtitle: { ...project.subtitle, enabled: true, cues: nextCues, text: nextCues.map((cue) => cue.text).join('\n') },
  }
  return { project: next, cues }
}
