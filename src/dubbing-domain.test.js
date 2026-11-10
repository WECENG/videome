import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { applyDubbingResult, applyDubbingResults, repairDubbingPlaybackState, resolveDubbingSource, resolveDubbingSources } from './dubbing-domain.js'
import { createSrt, timelineExportSnapshot } from './domain.js'

const { buildSubtitles } = createRequire(import.meta.url)('../electron/export.cjs')

const project = () => ({ projectId: 'project', duration: 20, assets: [{ id: 'asset', path: '/source.mp4', audioCodec: 'aac' }],
  tracks: [{ id: 'v', type: 'video', locked: true }, { id: 'a', type: 'audio' }, { id: 'm', type: 'audio' }],
  clips: [
    { id: 'v', kind: 'video', assetId: 'asset', trackId: 'v', start: 5, duration: 6, trimStart: 2, volume: 0 },
    { id: 'a', kind: 'audio', assetId: 'asset', linkedClipId: 'v', trackId: 'a', start: 5, duration: 6, trimStart: 2, volume: 0.82 },
    { id: 'music', kind: 'audio', assetId: 'music', trackId: 'm', start: 0, duration: 20, volume: 0.2 },
  ] })
const result = (source, selected = 'v') => ({ id: 'task', projectId: 'project', status: 'ready', source: resolveDubbingSource(source, selected), backgroundPath: '/background.wav',
  cues: [{ id: 'cue-0', start: 1, end: 3, translation: '中文对白', audioPath: '/chinese.wav', status: 'ready' }] })

describe('local dubbing source and timeline application', () => {
  it('uses the exact source trim and timeline position', () => {
    expect(resolveDubbingSource(project(), 'v')).toMatchObject({ audioClipId: 'a', trimStart: 2, start: 5, duration: 6, gain: 0.82 })
  })
  it('resolves multiple selected clips in timeline order and de-duplicates linked video/audio', () => {
    const source = project()
    source.clips.push({ id: 'a2', kind: 'audio', assetId: 'asset', trackId: 'a', start: 13, duration: 4, trimStart: 10, volume: 0.82 })
    const result = resolveDubbingSources(source, ['v', 'a', 'a2'])
    expect(result.sources.map((item) => item.audioClipId)).toEqual(['a', 'a2'])
    expect(result.issues).toEqual([])
    expect(result.duplicateCount).toBe(1)
  })
  it('rejects deleted, split, unlinked or mismatched source lanes', () => {
    for (const clips of [project().clips.filter((clip) => clip.id !== 'a'), [...project().clips, { ...project().clips[1], id: 'a2' }],
      project().clips.map((clip) => clip.id === 'a' ? { ...clip, duration: 3 } : clip)]) {
      expect(() => resolveDubbingSource({ ...project(), clips }, 'v')).toThrow('改选具体')
    }
  })
  it('mutes only the selected audio, preserves video locks, music, duration and metadata', () => {
    const source = project(); const job = result(source)
    const next = applyDubbingResult(source, job)
    expect(next.duration).toBe(20)
    expect(next.clips.find((clip) => clip.id === 'a').volume).toBe(0)
    expect(next.clips.find((clip) => clip.id === 'v')).toEqual(source.clips[0])
    expect(next.clips.find((clip) => clip.id === 'music')).toEqual(source.clips[2])
    expect(next.tracks.slice(-3).map((track) => track.label)).toEqual(['中文配音', '保留背景', '配音字幕'])
    expect(next.clips.slice(-3).map((clip) => [clip.start, clip.duration])).toEqual([[6, 2], [5, 6], [6, 2]])
    expect(next.clips.slice(-3).every((clip) => !clip.linkedClipId && clip.dubbingSource.taskId === 'task')).toBe(true)
    expect(source.clips[1].volume).toBe(0.82)
    expect(JSON.parse(JSON.stringify(next))).toEqual(next)
  })
  it('allows concrete split audio and preserves its siblings and parent video', () => {
    const source = project()
    source.clips[1].duration = 3
    source.clips.push({ ...source.clips[1], id: 'a2', start: 8, trimStart: 5 })
    const next = applyDubbingResult(source, result(source, 'a'))
    expect(next.clips.find((clip) => clip.id === 'a2')).toEqual(source.clips[3])
    expect(next.clips[0]).toEqual(source.clips[0])
  })
  it('blocks locked audible source lanes but allows already muted locked lanes', () => {
    const source = project(); source.tracks[1].locked = true
    expect(() => applyDubbingResult(source, result(source))).toThrow('解锁')
    source.clips[1].volume = 0
    expect(applyDubbingResult(source, result(source)).clips[1]).toEqual(source.clips[1])
  })
  it('blocks other projects, changed sources, incomplete results and repeated insertion', () => {
    const source = project(); const job = result(source)
    expect(() => applyDubbingResult({ ...source, projectId: 'other' }, job)).toThrow('工程已切换')
    expect(() => applyDubbingResult({ ...source, clips: source.clips.map((clip) => ({ ...clip, start: clip.start + 1 })) }, job)).toThrow('已变化')
    expect(() => applyDubbingResult(source, { ...job, status: 'review' })).toThrow('全部配音')
    const next = applyDubbingResult(source, job)
    // Restore source gain to demonstrate duplicate provenance detection independently.
    next.clips[1].volume = 0.82
    expect(() => applyDubbingResult(next, job)).toThrow('已入轨')
  })
  it('applies several ready jobs to shared dubbing/background tracks in one timeline edit', () => {
    const source = project()
    source.clips.push({ id: 'a2', kind: 'audio', assetId: 'asset', trackId: 'a', start: 13, duration: 4, trimStart: 10, volume: 0.82 })
    const first = result(source, 'a')
    const second = { ...result(source, 'a2'), id: 'task-2', source: resolveDubbingSource(source, 'a2'), cues: [{ id: 'cue-1', start: 0.5, end: 2, translation: '第二句', audioPath: '/second.wav', status: 'ready' }], backgroundPath: '/background-2.wav' }
    const next = applyDubbingResults(source, [first, second])
    expect(next.tracks.slice(-3).map((track) => track.label)).toEqual(['中文配音', '保留背景', '配音字幕'])
    expect(next.tracks.filter((track) => track.label === '中文配音')).toHaveLength(1)
    expect(next.clips.filter((clip) => clip.dubbingSource?.taskId === 'task-2').map((clip) => clip.start)).toEqual([13.5, 13, 13.5])
    expect(next.clips.filter((clip) => clip.dubbingSource?.taskId === 'task')).toHaveLength(3)
  })
  it('reuses existing dubbing tracks and clears accidental mute state on later insertions', () => {
    const source = project()
    source.clips.push({ ...source.clips[1], id: 'a2', start: 13, trimStart: 10, duration: 4 })
    const first = applyDubbingResult(source, result(source, 'a'))
    const secondJob = { ...result(source, 'a2'), id: 'task-2', source: resolveDubbingSource(source, 'a2') }
    const muted = { ...first, tracks: first.tracks.map((track) => track.label === '中文配音' || track.label === '保留背景' ? { ...track, muted: true } : track) }
    const next = applyDubbingResult(muted, secondJob)
    expect(next.tracks.filter((track) => track.label === '中文配音' || track.label === '保留背景')).toHaveLength(2)
    expect(next.tracks.filter((track) => track.label === '中文配音' || track.label === '保留背景').every((track) => track.muted === false)).toBe(true)
    expect(next.clips.filter((clip) => clip.dubbingSource?.taskId === 'task-2').every((clip) => clip.muted === false)).toBe(true)
    expect(next.clips.find((clip) => clip.dubbingSource?.taskId === 'task-2')?.trackId).toBe(first.tracks.find((track) => track.label === '中文配音')?.id)
  })
  it('uses the default dubbing gain when the source lane was muted', () => {
    const source = project()
    source.clips[1].volume = 0
    const next = applyDubbingResult(source, result(source))
    expect(next.clips.find((clip) => clip.dubbingSource?.taskId === 'task' && clip.dubbingSource.cueId)?.volume).toBe(0.82)
  })
  it('repairs muted historical dubbing clips when reopening a project', () => {
    const repaired = repairDubbingPlaybackState({
      tracks: [{ id: 'dub', type: 'audio', label: '中文配音', muted: true }],
      clips: [{ id: 'clip', trackId: 'dub', kind: 'audio', volume: 0, muted: false, dubbingSource: { taskId: 'old' } }],
    })
    expect(repaired.tracks[0].muted).toBe(false)
    expect(repaired.clips[0]).toMatchObject({ volume: 0.82, muted: false })
  })
  it('adds editable Chinese captions aligned to each dubbing clip and exports them as SRT and video subtitles', () => {
    const source = project()
    const next = applyDubbingResult(source, result(source))
    const [cue] = next.subtitle.cues
    const clip = next.clips.find((item) => item.kind === 'subtitle')
    expect(cue).toMatchObject({ start: 6, end: 8, text: '中文对白', source: 'dubbing' })
    expect(clip).toMatchObject({ assetId: cue.id, sourceCueId: cue.id, sourceStart: 6, start: 6, duration: 2, name: cue.text })
    expect(next.subtitle.enabled).toBe(true)
    expect(source.subtitle).toBeUndefined()
    expect(source.tracks).toHaveLength(3)
    expect(source.clips).toHaveLength(3)
    expect(createSrt(next.subtitle.cues)).toContain('00:00:06,000 --> 00:00:08,000\n中文对白')
    expect(buildSubtitles(timelineExportSnapshot(next), { height: 1080 })).toEqual([
      expect.objectContaining({ start: 6, duration: 2, text: '中文对白' }),
    ])
  })
  it('preserves existing captions and their styles while appending in timeline order', () => {
    const source = project()
    source.tracks.push({ id: 'captions', type: 'subtitle', label: '字幕', locked: false, muted: false })
    source.subtitle = { enabled: false, fontSize: 58, bottomPadding: 110, background: true, cues: [{ id: 'manual', start: 12, end: 14, text: '手工字幕', edited: true }] }
    const next = applyDubbingResult(source, result(source))
    expect(next.subtitle).toMatchObject({ enabled: true, fontSize: 58, bottomPadding: 110, background: true })
    expect(next.subtitle.cues.map((cue) => cue.text)).toEqual(['中文对白', '手工字幕'])
    expect(next.subtitle.cues[1]).toEqual(source.subtitle.cues[0])
    expect(next.clips.find((clip) => clip.kind === 'subtitle').trackId).toBe('captions')
    expect(next.tracks.filter((track) => track.type === 'subtitle')).toHaveLength(1)
    expect(source.subtitle.enabled).toBe(false)
  })
  it.each([{ locked: true }, { muted: true }])('creates a visible caption track without modifying an unavailable track (%j)', (state) => {
    const source = project()
    const existing = { id: 'captions', type: 'subtitle', label: '字幕', locked: false, muted: false, ...state }
    source.tracks.push(existing)
    const next = applyDubbingResult(source, result(source))
    expect(next.tracks.find((track) => track.id === existing.id)).toEqual(existing)
    const track = next.tracks.find((item) => item.id === next.clips.find((clip) => clip.kind === 'subtitle').trackId)
    expect(track.id).not.toBe(existing.id)
    expect(track).toMatchObject({ type: 'subtitle', locked: false, muted: false })
  })
  it('allows captions to be disabled for single and batch insertions', () => {
    const source = project()
    source.subtitle = { enabled: false, cues: [] }
    for (const next of [applyDubbingResult(source, result(source), { includeSubtitles: false }), applyDubbingResults(source, [result(source)], { includeSubtitles: false })]) {
      expect(next.subtitle).toBe(source.subtitle)
      expect(next.clips.some((clip) => clip.kind === 'subtitle')).toBe(false)
      expect(next.tracks.some((track) => track.type === 'subtitle')).toBe(false)
    }
  })
  it('keeps cue IDs unique across batches that reuse local cue IDs and reuses one caption track', () => {
    const source = project()
    source.clips.push({ ...source.clips[1], id: 'a2', start: 13, trimStart: 10, duration: 4 })
    const second = { ...result(source, 'a2'), id: 'task-2' }
    const next = applyDubbingResults(source, [second, result(source, 'a')])
    expect(next.subtitle.cues.map((cue) => cue.start)).toEqual([6, 14])
    expect(new Set(next.subtitle.cues.map((cue) => cue.id)).size).toBe(2)
    expect(next.tracks.filter((track) => track.type === 'subtitle')).toHaveLength(1)
    expect(next.clips.filter((clip) => clip.kind === 'subtitle')).toHaveLength(2)
    const withoutCaptions = applyDubbingResults(source, [result(source, 'a'), second], { includeSubtitles: false })
    expect(withoutCaptions.clips.some((clip) => clip.kind === 'subtitle')).toBe(false)
  })
  it('rejects invalid caption text and timing without mutating the source project', () => {
    const source = project()
    const before = structuredClone(source)
    for (const patch of [{ translation: ' ' }, { start: -1 }, { end: 7 }, { end: 1 }]) {
      const job = result(source)
      job.cues[0] = { ...job.cues[0], ...patch }
      expect(() => applyDubbingResult(source, job)).toThrow(/译文为空|时间范围无效/)
      expect(source).toEqual(before)
    }
  })
})
