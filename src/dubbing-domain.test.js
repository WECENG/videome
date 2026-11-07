import { describe, expect, it } from 'vitest'
import { applyDubbingResult, applyDubbingResults, resolveDubbingSource, resolveDubbingSources } from './dubbing-domain.js'

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
    expect(next.tracks.slice(-2).map((track) => track.label)).toEqual(['中文配音', '保留背景'])
    expect(next.clips.slice(-2).map((clip) => [clip.start, clip.duration])).toEqual([[6, 2], [5, 6]])
    expect(next.clips.slice(-2).every((clip) => !clip.linkedClipId && clip.dubbingSource.taskId === 'task')).toBe(true)
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
    expect(next.tracks.slice(-2).map((track) => track.label)).toEqual(['中文配音', '保留背景'])
    expect(next.tracks.filter((track) => track.label === '中文配音')).toHaveLength(1)
    expect(next.clips.filter((clip) => clip.dubbingSource?.taskId === 'task-2').map((clip) => clip.start)).toEqual([13.5, 13])
    expect(next.clips.filter((clip) => clip.dubbingSource?.taskId === 'task')).toHaveLength(2)
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
})
