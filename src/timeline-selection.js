import { removeClip, toggleOrderedSelection } from './domain.js'

export function selectTimelineClips(clips, selectedIds, targetId, { toggle = false, range = false, anchorId = null } = {}) {
  const target = clips.find((clip) => clip.id === targetId)
  if (!target) return []
  const validIds = [...new Set(selectedIds)].filter((id) => clips.some((clip) => clip.id === id))
  if (range) {
    const trackClips = clips.filter((clip) => clip.trackId === target.trackId).sort((a, b) => a.start - b.start)
    const anchorIndex = trackClips.findIndex((clip) => clip.id === anchorId)
    const targetIndex = trackClips.findIndex((clip) => clip.id === targetId)
    if (anchorIndex >= 0) {
      const [start, end] = [anchorIndex, targetIndex].sort((a, b) => a - b)
      const rangeIds = trackClips.slice(start, end + 1).map((clip) => clip.id)
      return toggle ? [...new Set([...validIds, ...rangeIds])] : rangeIds
    }
  }
  return toggle ? toggleOrderedSelection(validIds, targetId) : [targetId]
}

// A linked family participates once even when both its video and audio are selected.
export function timelineMoveIds(clips, selectedIds) {
  const selected = new Set(selectedIds)
  const families = new Set(clips.filter((clip) => selected.has(clip.id)).map((clip) => clip.linkedClipId || clip.id))
  return clips.filter((clip) => families.has(clip.linkedClipId || clip.id)).map((clip) => clip.id)
}

export function moveTimelineClips(clips, selectedIds, delta, tracks = []) {
  const movingIds = new Set(timelineMoveIds(clips, selectedIds))
  const moving = clips.filter((clip) => movingIds.has(clip.id))
  const locked = new Set(tracks.filter((track) => track.locked).map((track) => track.id))
  if (!moving.length || !Number.isFinite(delta) || moving.some((clip) => locked.has(clip.trackId))) return clips
  const offset = Math.max(delta, -Math.min(...moving.map((clip) => clip.start)))
  if (!offset) return clips
  return clips.map((clip) => movingIds.has(clip.id) ? { ...clip, start: clip.start + offset } : clip)
}

export function removeTimelineClips(clips, selectedIds, ripple = false, tracks = []) {
  const ids = new Set(selectedIds)
  const selected = clips.filter((clip) => ids.has(clip.id))
  const locked = new Set(tracks.filter((track) => track.locked).map((track) => track.id))
  if (!selected.length || selected.some((clip) => locked.has(clip.trackId))) return clips
  // Deleting video already removes its unlocked companions. Do not ripple them twice.
  const roots = selected.filter((clip) => !clip.linkedClipId || !ids.has(clip.linkedClipId))
  const remaining = roots.reduce((result, clip) => removeClip(result, clip.id, false, tracks), clips)
  if (!ripple) return remaining
  return remaining.map((clip) => {
    if (locked.has(clip.trackId)) return clip
    const intervals = selected.filter((removed) => clip.trackId === removed.trackId
      || (!removed.linkedClipId && removed.audioLinked && removed.assetId === clip.assetId && clip.kind === 'audio'))
      .map((removed) => [removed.start, removed.start + removed.duration])
      .sort((a, b) => a[0] - b[0])
    const merged = []
    for (const interval of intervals) {
      const previous = merged.at(-1)
      if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
      else merged.push([...interval])
    }
    const offset = merged.filter(([, end]) => clip.start >= end - 1 / 240).reduce((sum, [start, end]) => sum + end - start, 0)
    return offset ? { ...clip, start: Math.max(0, clip.start - offset) } : clip
  })
}
