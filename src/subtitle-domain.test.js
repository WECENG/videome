import { describe, expect, it } from 'vitest'
import { createSubtitleTrack } from './domain.js'
import { createWhisperSubtitleEdit, resolveWhisperSelectionClips, timelineWhisperSourceRange } from './subtitle-domain.js'

const project = () => ({
  duration: 20,
  tracks: [{ id: 'video', type: 'video', order: 0 }, { id: 'captions', type: 'subtitle', order: 1, locked: false, muted: false }],
  clips: [{ id: 'video-clip', kind: 'video', trackId: 'video', assetId: 'video-asset', start: 8, duration: 5 }],
  subtitle: { enabled: false, text: '已有字幕', fontSize: 48, cues: [{ id: 'manual', start: 1, end: 2, text: '已有字幕', edited: true }] },
})

describe('Whisper subtitle timeline edit', () => {
  it('creates a uniquely identified subtitle track without colliding with graphic tracks', () => {
    const tracks = [{ id: 'subtitles', type: 'graphics', order: 0 }, { id: 'existing-captions', type: 'subtitle', label: '字幕', order: 1 }]
    expect(createSubtitleTrack(tracks, 'new-captions')).toMatchObject({ id: 'new-captions', type: 'subtitle', label: '字幕 2', order: 2, locked: false, muted: false })
  })

  it('deduplicates a selected linked video and original-audio pair', () => {
    const clips = [
      { id: 'video', kind: 'video', assetId: 'asset' },
      { id: 'audio', kind: 'audio', assetId: 'asset', linkedClipId: 'video' },
    ]
    expect(resolveWhisperSelectionClips(clips, ['video', 'audio'])).toEqual([clips[1]])
    expect(resolveWhisperSelectionClips(clips, ['video'])).toEqual([clips[0]])
    expect(resolveWhisperSelectionClips(clips, ['video', 'audio', 'other'])).toEqual([clips[1]])
  })

  it('keeps trim and timeline offsets for each selected clip in a multi-clip recognition batch', () => {
    expect(timelineWhisperSourceRange({ start: 6, duration: 4, trimStart: 9 })).toEqual({ timelineStart: 6, duration: 4, trimStart: 9 })
    const source = project()
    const ranges = [
      timelineWhisperSourceRange({ start: 8, duration: 2, trimStart: 9 }),
      timelineWhisperSourceRange({ start: 14, duration: 5, trimStart: 20 }),
    ]
    const transcript = [
      { start: 0.25, end: 0.75, text: 'first' },
      { start: 1, end: 2, text: 'second' },
    ].map((cue, index) => ({ ...cue, sourceDuration: ranges[index].duration, timelineStart: ranges[index].timelineStart }))
    const result = createWhisperSubtitleEdit(source, transcript, { timelineStart: 0, sourceDuration: Number.MAX_SAFE_INTEGER, idPrefix: 'batch' })
    expect(result.cues.map((cue) => [cue.start, cue.end])).toEqual([[8.25, 8.75], [15, 16]])
  })

  it('maps source-relative multilingual timestamps onto the timeline and preserves existing captions', () => {
    const source = project()
    const result = createWhisperSubtitleEdit(source, [
      { start: 0.5, end: 1.75, text: '  Bonjour  ' },
      { start: 5.1, end: 5.2, text: 'outside selected clip' },
      { start: 1, end: 1, text: 'invalid time' },
      { start: 2, end: 3, text: '' },
    ], { timelineStart: 8, sourceDuration: 5, idPrefix: 'recognition-1' })

    expect(result.cues).toEqual([{ id: 'recognition-1-1', start: 8.5, end: 9.75, text: 'Bonjour', edited: false, source: 'whisper' }])
    expect(result.project.subtitle).toMatchObject({ enabled: true, text: '已有字幕\nBonjour', fontSize: 48 })
    expect(result.project.subtitle.cues[0]).toEqual(source.subtitle.cues[0])
    expect(result.project.clips.at(-1)).toMatchObject({ kind: 'subtitle', start: 8.5, duration: 1.25, sourceStart: 8.5, sourceCueId: 'recognition-1-1', trackId: 'captions' })
    expect(result.project.duration).toBe(20)
    expect(source.subtitle.enabled).toBe(false)
    expect(source.clips).toHaveLength(1)
  })

  it('creates an unmuted subtitle track when the existing subtitle tracks are locked or muted', () => {
    const source = project()
    source.tracks[1].locked = true
    const result = createWhisperSubtitleEdit(source, [{ start: 0, end: 1, text: '你好' }], { timelineStart: 3, sourceDuration: 2, idPrefix: 'recognition-2' })

    expect(result.project.tracks.at(-1)).toMatchObject({ type: 'subtitle', label: '字幕', locked: false, muted: false })
    expect(result.project.clips.at(-1).trackId).toBe(result.project.tracks.at(-1).id)
    expect(source.tracks[1].locked).toBe(true)
  })

  it('extends project duration to cover selected source clips that extend past the current sequence', () => {
    const source = { ...project(), duration: 10 }
    const result = createWhisperSubtitleEdit(source, [{ start: 3, end: 5, text: 'tail caption' }], { timelineStart: 8, sourceDuration: 5, idPrefix: 'recognition-3' })
    expect(result.project.duration).toBe(13)
  })

  it('rejects malformed or empty Whisper results before creating timeline edits', () => {
    const source = project()
    expect(() => createWhisperSubtitleEdit(source, [], { timelineStart: 0, sourceDuration: 5, idPrefix: 'empty' })).toThrow('没有返回有效字幕')
    expect(() => createWhisperSubtitleEdit(source, null, { timelineStart: 0, sourceDuration: 5, idPrefix: 'null' })).toThrow('无效识别结果')
    expect(source.clips).toHaveLength(1)
    expect(source.subtitle.cues).toHaveLength(1)
  })

  it('replaces previous subtitle clips when the user disables merge', () => {
    const source = project()
    const result = createWhisperSubtitleEdit(source, [{ start: 0, end: 1, text: '新识别内容' }], { timelineStart: 4, sourceDuration: 2, idPrefix: 'replace', merge: false })
    expect(result.project.subtitle.cues.map((cue) => cue.text)).toEqual(['新识别内容'])
    expect(result.project.clips.some((clip) => clip.id === 'video-clip')).toBe(true)
    expect(result.project.clips.some((clip) => clip.sourceCueId === 'manual')).toBe(false)
    expect(result.project.clips.filter((clip) => clip.kind === 'subtitle')).toHaveLength(1)
    expect(source.clips).toHaveLength(1)
    expect(source.subtitle.cues).toHaveLength(1)
  })

  it('does not delete unrelated clips on tracks typed as subtitle', () => {
    const source = project()
    source.tracks.push({ id: 'subtitle-graphics', type: 'subtitle', locked: false, muted: false })
    source.clips.push({ id: 'sticker', kind: 'graphics', trackId: 'subtitle-graphics', start: 2, duration: 3 })
    source.clips.push({ id: 'manual-caption-clip', kind: 'subtitle', trackId: 'captions', sourceCueId: 'manual', start: 1, duration: 1 })
    const result = createWhisperSubtitleEdit(source, [{ start: 0, end: 1, text: 'new transcript' }], { timelineStart: 4, sourceDuration: 2, idPrefix: 'safe-replace', merge: false })
    expect(result.project.clips.some((clip) => clip.id === 'sticker')).toBe(true)
    expect(result.project.clips.some((clip) => clip.id === 'manual-caption-clip')).toBe(false)
    expect(source.clips).toHaveLength(3)
  })
})
