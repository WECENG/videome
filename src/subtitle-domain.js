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
