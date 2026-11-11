import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createSrt, createSubtitleTrack, splitClips } from './domain.js'
import { activeSubtitleAtTime, createWhisperSubtitleEdit, formatSubtitleTime, parseSubtitleTime, refreshSubtitleClipText, resolveWhisperSelectionClips, subtitleOverlapIds, subtitleTimingError, timelineSubtitleCues, timelineWhisperSourceRange, updateSubtitleCue, updateTimelineSubtitleCue } from './subtitle-domain.js'
const { buildSubtitles } = createRequire(import.meta.url)('../electron/export.cjs')

const project = () => ({
  duration: 20,
  tracks: [{ id: 'video', type: 'video', order: 0 }, { id: 'captions', type: 'subtitle', order: 1, locked: false, muted: false }],
  clips: [{ id: 'video-clip', kind: 'video', trackId: 'video', assetId: 'video-asset', start: 8, duration: 5 }],
  subtitle: { enabled: false, text: '已有字幕', fontSize: 48, cues: [{ id: 'manual', start: 1, end: 2, text: '已有字幕', edited: true }] },
})

describe('Whisper subtitle timeline edit', () => {
  it('shows the next sentence at a shared boundary and uses the selected entry for genuine overlaps', () => {
    const cues = [{ id: 'first', start: 0, end: 53.2, text: '上一句' }, { id: 'second', start: 53.2, end: 61.34, text: '选中的下一句' }]
    expect(activeSubtitleAtTime(cues, 53.2, 'first')?.id).toBe('second')
    expect(activeSubtitleAtTime(cues, 53.2 - 1e-10)?.id).toBe('second')
    expect(activeSubtitleAtTime(cues, 61.34)).toBeNull()
    const overlapping = [{ ...cues[0], end: 54 }, cues[1]]
    expect(activeSubtitleAtTime(overlapping, 53.2, 'second')?.id).toBe('second')
    expect(activeSubtitleAtTime(overlapping, 53.2)?.id).toBe('second')
  })

  it('uses moved and trimmed timeline positions for preview, editor, SRT and burn-in', () => {
    const source = project()
    source.subtitle.enabled = true
    source.subtitle.cues = [{ id: 'manual', start: 1, end: 5, text: '已校对文字' }]
    source.clips.push({ id: 'moved', kind: 'subtitle', sourceCueId: 'manual', trackId: 'captions', start: 53.2, duration: 2, sourceStart: 2, name: '旧文字' })
    const cues = timelineSubtitleCues(source)
    expect(cues).toMatchObject([{ id: 'moved', sourceCueId: 'manual', start: 53.2, end: 55.2, text: '已校对文字' }])
    expect(activeSubtitleAtTime(cues, 53.2)?.text).toBe('已校对文字')
    expect(activeSubtitleAtTime(cues, 1)).toBeNull()
    expect(createSrt(cues)).toContain('00:00:53,200 --> 00:00:55,200')
    expect(buildSubtitles(source, { height: 1080 })).toMatchObject([{ start: 53.2, duration: 2, text: '已校对文字' }])
    const edited = updateTimelineSubtitleCue(source, 'moved', { text: '最新的手动修改' })
    expect(edited.clips.at(-1)).toMatchObject({ start: 53.2, duration: 2, sourceStart: 2, name: '最新的手动修改' })
    expect(timelineSubtitleCues(edited)[0]).toMatchObject({ start: 53.2, end: 55.2, text: '最新的手动修改' })
    const retimed = updateTimelineSubtitleCue(edited, 'moved', { start: 53.3, end: 55.1 })
    expect(retimed.clips.at(-1)).toMatchObject({ start: 53.3, sourceStart: 53.3 })
    expect(timelineSubtitleCues(retimed)[0]).toMatchObject({ start: 53.3, end: 55.1 })
  })

  it('refreshes stale labels in old projects and edits split entries without merging their time ranges', () => {
    const source = project()
    source.subtitle.enabled = true
    source.subtitle.cues = [{ id: 'manual', start: 1, end: 5, text: '手动修改后的文本' }]
    source.clips.push({ id: 'caption', kind: 'subtitle', assetId: 'manual', sourceStart: 1, trackId: 'captions', start: 1, duration: 4, name: '旧文本', text: '旧文本' })
    const refreshed = refreshSubtitleClipText(source)
    expect(refreshed.clips.at(-1)).toMatchObject({ name: '手动修改后的文本', text: '手动修改后的文本' })
    expect(refreshSubtitleClipText(refreshed)).toBe(refreshed)
    const split = { ...refreshed, clips: splitClips(refreshed.clips, 3, ['captions']) }
    const entries = timelineSubtitleCues(split)
    expect(entries.map((cue) => [cue.start, cue.end])).toEqual([[1, 3], [3, 5]])
    expect(buildSubtitles(split, { height: 1080 }).map((cue) => [cue.start, cue.duration])).toEqual([[1, 2], [3, 2]])
    const edited = updateTimelineSubtitleCue(split, entries[1].id, { text: '新的共享文字' })
    expect(edited.clips.filter((clip) => clip.kind === 'subtitle').map((clip) => clip.name)).toEqual(['新的共享文字', '新的共享文字'])
    expect(timelineSubtitleCues(edited).map((cue) => [cue.start, cue.end])).toEqual([[1, 3], [3, 5]])
    const retimed = updateTimelineSubtitleCue(edited, entries[1].id, { start: 3.1, end: 5.2 })
    expect(timelineSubtitleCues(retimed).map((cue) => [cue.start, cue.end])).toEqual([[1, 3], [3.1, 5.2]])
    expect(buildSubtitles(retimed, { height: 1080 }).map((cue) => cue.start)).toEqual([1, 3.1])
  })

  it('omits muted subtitle tracks from playback and burn-in without hiding their editor rows', () => {
    const source = project()
    source.subtitle.enabled = true
    source.tracks[1].muted = true
    source.clips.push({ id: 'caption', kind: 'subtitle', sourceCueId: 'manual', trackId: 'captions', start: 1, duration: 1 })
    expect(timelineSubtitleCues(source)).toHaveLength(1)
    expect(activeSubtitleAtTime(timelineSubtitleCues(source), 1.5)).toBeNull()
    expect(buildSubtitles(source, { height: 1080 })).toEqual([])
  })

  it('accepts precise time drafts and rejects incomplete or out-of-range times', () => {
    expect(formatSubtitleTime(59.9996)).toBe('01:00.000')
    expect(formatSubtitleTime(3661.123)).toBe('61:01.123')
    expect(parseSubtitleTime('01:02:03.456')).toBe(3723.456)
    expect(parseSubtitleTime('61:01.123')).toBe(3661.123)
    expect(parseSubtitleTime('26.1')).toBe(26.1)
    expect(createSrt([{ start: 7.6, end: 59.9996, text: '毫秒精度' }])).toContain('00:00:07,600 --> 00:01:00,000')
    for (const invalid of ['', '00:', '00:60.000', '01:61:02', '-1', '00:01.1234']) expect(Number.isNaN(parseSubtitleTime(invalid))).toBe(true)
    expect(subtitleTimingError(3, 3)).toContain('晚于')
    expect(subtitleTimingError(3, 3.1)).toBe('')
  })

  it('updates caption clips, preview text and SRT from one edit without touching media clips', () => {
    const source = project()
    source.clips.push({ id: 'caption', kind: 'subtitle', sourceCueId: 'manual', start: 1, duration: 1, sourceStart: 1, name: '已有字幕' })
    source.clips.push({ id: 'legacy-caption', kind: 'subtitle', assetId: 'manual', start: 1, duration: 1, text: '已有字幕' })
    const result = updateSubtitleCue(source, 'manual', { start: 20.1, end: 21.234, text: '校对后的字幕' })
    expect(result.subtitle.cues[0]).toMatchObject({ start: 20.1, end: 21.234, text: '校对后的字幕', edited: true })
    expect(result.subtitle.text).toBe('校对后的字幕')
    expect(result.clips[0]).toBe(source.clips[0])
    for (const clip of result.clips.slice(1)) {
      expect(clip).toMatchObject({ start: 20.1, sourceStart: 20.1, name: '校对后的字幕' })
      expect(clip.duration).toBeCloseTo(1.134)
    }
    expect(result.clips[2].text).toBe('校对后的字幕')
    expect(result.duration).toBe(21.234)
    expect(createSrt(result.subtitle.cues)).toContain('00:00:20,100 --> 00:00:21,234')
    expect(source.subtitle.cues[0].text).toBe('已有字幕')
    expect(updateSubtitleCue(source, 'manual', { end: 0 })).toBe(source)
    expect(updateSubtitleCue(source, 'missing', { text: 'x' })).toBe(source)
  })

  it('marks both sides of overlapping intervals, including nested subtitles, but permits adjacent lines', () => {
    expect([...subtitleOverlapIds([
      { id: 'outer', start: 0, end: 10 }, { id: 'inner', start: 1, end: 2 },
      { id: 'later', start: 3, end: 4 }, { id: 'adjacent', start: 10, end: 11 },
    ])]).toEqual(['outer', 'inner', 'later'])
  })

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
