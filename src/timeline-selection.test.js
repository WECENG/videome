import { describe, expect, it } from 'vitest'
import { moveTimelineClips, removeTimelineClips, selectTimelineClips, timelineMoveIds } from './timeline-selection.js'

const clips = [
  { id: 'video', kind: 'video', trackId: 'v', assetId: 'source', start: 2, duration: 2, audioLinked: true },
  { id: 'original', kind: 'audio', trackId: 'a', assetId: 'source', start: 2, duration: 2, linkedClipId: 'video' },
  { id: 'dub-1', kind: 'audio', trackId: 'a', start: 6, duration: 2, dubbingSource: { jobId: 'job' } },
  { id: 'dub-2', kind: 'audio', trackId: 'a', start: 10, duration: 2 },
  { id: 'music', kind: 'audio', trackId: 'm', start: 0, duration: 30 },
]

describe('timeline selection', () => {
  it('selects one clip, toggles linked audio without dropping it, and discards stale ids', () => {
    expect(selectTimelineClips(clips, ['dub-1', 'dub-2'], 'original')).toEqual(['original'])
    expect(selectTimelineClips(clips, ['missing', 'original'], 'dub-1', { toggle: true })).toEqual(['original', 'dub-1'])
    expect(selectTimelineClips(clips, ['original', 'dub-1'], 'original', { toggle: true })).toEqual(['dub-1'])
  })

  it('selects a same-track range by time in either direction and keeps a stable anchor', () => {
    expect(selectTimelineClips([...clips].reverse(), [], 'dub-2', { range: true, anchorId: 'original' })).toEqual(['original', 'dub-1', 'dub-2'])
    expect(selectTimelineClips(clips, ['original', 'dub-1', 'dub-2'], 'dub-1', { range: true, anchorId: 'original' })).toEqual(['original', 'dub-1'])
    expect(selectTimelineClips(clips, ['music'], 'original', { range: true, anchorId: 'dub-2', toggle: true })).toEqual(['music', 'original', 'dub-1', 'dub-2'])
    expect(selectTimelineClips(clips, ['music'], 'dub-1', { range: true, anchorId: 'music' })).toEqual(['dub-1'])
  })

  it('moves selected audio and linked families once, preserving gaps and unselected music', () => {
    expect(timelineMoveIds(clips, ['video', 'original', 'dub-1'])).toEqual(['video', 'original', 'dub-1'])
    const result = moveTimelineClips(clips, ['video', 'original', 'dub-1'], 3)
    expect(result.map((clip) => clip.start)).toEqual([5, 5, 9, 10, 0])
    expect(result[4]).toBe(clips[4])
    expect(clips.map((clip) => clip.start)).toEqual([2, 2, 6, 10, 0])
  })

  it('clamps the entire group at zero and preserves staggered linked offsets', () => {
    const staggered = clips.map((clip) => clip.id === 'original' ? { ...clip, start: 3 } : clip)
    expect(moveTimelineClips(staggered, ['original', 'dub-1'], -8).map((clip) => clip.start)).toEqual([0, 1, 4, 10, 0])
  })

  it('blocks group movement if any selected or linked track is locked', () => {
    expect(moveTimelineClips(clips, ['original', 'dub-1'], 3, [{ id: 'v', locked: true }])).toBe(clips)
    expect(moveTimelineClips(clips, ['dub-1', 'music'], 3, [{ id: 'm', locked: true }])).toBe(clips)
  })

  it('deletes multiple audio clips while keeping their source video and unrelated music', () => {
    expect(removeTimelineClips(clips, ['original', 'dub-1']).map((clip) => clip.id)).toEqual(['video', 'dub-2', 'music'])
    expect(removeTimelineClips(clips, ['dub-1', 'music'], false, [{ id: 'm', locked: true }])).toBe(clips)
    const result = removeTimelineClips(clips, ['video', 'dub-1'], false, [{ id: 'a', locked: true }])
    expect(result).toBe(clips)
    expect(removeTimelineClips(clips, ['video'], false, [{ id: 'a', locked: true }])[0]).toMatchObject({ id: 'original', linkedClipId: null })
  })

  it('ripples multiple intervals once even when both sides of a linked pair are selected', () => {
    const tail = [
      { ...clips[0], id: 'video-tail', start: 14 },
      { ...clips[1], id: 'audio-tail', linkedClipId: 'video-tail', start: 14 },
    ]
    const result = removeTimelineClips([...clips, ...tail], ['video', 'original', 'dub-1'], true)
    expect(result.map((clip) => [clip.id, clip.start])).toEqual([['dub-2', 6], ['music', 0], ['video-tail', 12], ['audio-tail', 10]])
  })

  it('merges overlapping ripple intervals rather than closing the overlap twice', () => {
    const overlapping = [clips[2], { ...clips[3], start: 7 }, { ...clips[3], id: 'tail', start: 12 }]
    expect(removeTimelineClips(overlapping, ['dub-1', 'dub-2'], true)).toEqual([{ ...overlapping[2], start: 9 }])
  })
})
