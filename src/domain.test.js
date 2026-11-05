import { describe, expect, it } from 'vitest'
import {
  addTrack,
  assessExport,
  audioPreviewUrl,
  createMediaClips,
  createSrt,
  findActiveVisualClip,
  isLegacySilentPreviewProxy,
  mergeAssetLibraries,
  mergeAssetsByPath,
  orderAssetsByIds,
  toggleOrderedSelection,
  moveClipWithLinked,
  removeClip,
  parseSrt,
  removeAssetReferences,
  removeTrack,
  replaceAssetById,
  repairSplitAudioDuplicates,
  repairPlaceholderDurationClips,
  resolveMediaDurationSeconds,
  splitClips,
  unlinkClipPair,
} from './domain.js'

describe('track management', () => {
  it.each([
    ['video', '视频轨 1', 'lime'],
    ['audio', '音频轨 1', 'cyan'],
    ['graphics', '图文轨 1', 'amber'],
    ['subtitle', '字幕轨 1', 'violet'],
  ])('adds a %s track without mutating the previous undo snapshot', (type, label, accent) => {
    const tracks = Object.freeze([])
    const result = addTrack(tracks, type)
    expect(tracks).toHaveLength(0)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type, label, accent, locked: false, muted: false })
  })

  it('avoids duplicate names after deleting a middle track and keeps new tracks on top', () => {
    const tracks = [
      { id: 'first', type: 'video', label: '视频轨 1', order: 0 },
      { id: 'third', type: 'video', label: '视频轨 3', order: 6 },
    ]
    const result = addTrack(tracks, 'video')
    expect(result.at(-1)).toMatchObject({ label: '视频轨 4', order: 7 })
    expect(tracks).toHaveLength(2)
    expect(() => addTrack(tracks, 'other')).toThrow('不支持的轨道类型')
  })

  const linkedProject = () => ({
    tracks: [{ id: 'video', type: 'video', order: 0 }, { id: 'audio', type: 'audio', order: 1 }, { id: 'music', type: 'audio', order: 2 }],
    clips: [
      { id: 'picture', trackId: 'video', kind: 'video', assetId: 'source', audioLinked: true },
      { id: 'sound', trackId: 'audio', kind: 'audio', assetId: 'source', linkedClipId: 'picture' },
      { id: 'song', trackId: 'music', kind: 'audio', assetId: 'song' },
    ],
    assets: [{ id: 'source' }, { id: 'song' }],
  })

  it.each(['video', 'audio'])('deletes the %s track with linked clips while preserving source assets', (trackId) => {
    const project = linkedProject()
    const next = removeTrack(project, trackId)
    expect(next.tracks.map((track) => track.id)).toEqual(project.tracks.filter((track) => track.id !== trackId).map((track) => track.id))
    expect(next.tracks.map((track) => track.order)).toEqual([0, 1])
    expect(next.clips.map((clip) => clip.id)).toEqual(['song'])
    expect(next.assets).toBe(project.assets)
    expect(project.clips).toHaveLength(3)
    expect(project.tracks).toHaveLength(3)
  })

  it('protects locked tracks and locked linked companions from deletion', () => {
    const project = linkedProject()
    project.tracks[1].locked = true
    expect(removeTrack(project, 'audio')).toBe(project)
    expect(removeTrack(project, 'video')).toBe(project)
    expect(removeTrack(project, 'missing')).toBe(project)
  })

  it('removes only deleted subtitle cues and preserves cues still used on another track', () => {
    const project = {
      tracks: [{ id: 'one', type: 'subtitle' }, { id: 'two', type: 'subtitle' }],
      clips: [
        { id: 'first', kind: 'subtitle', trackId: 'one', sourceCueId: 'first' },
        { id: 'shared-one', kind: 'subtitle', trackId: 'one', sourceCueId: 'shared' },
        { id: 'shared-two', kind: 'subtitle', trackId: 'two', sourceCueId: 'shared' },
      ],
      subtitle: { text: '第一行\n保留行', cues: [{ id: 'first', text: '第一行' }, { id: 'shared', text: '保留行' }] },
    }
    const next = removeTrack(project, 'one')
    expect(next.subtitle).toMatchObject({ text: '保留行', cues: [{ id: 'shared', text: '保留行' }] })
    expect(next.clips.map((clip) => clip.id)).toEqual(['shared-two'])
  })

  it('clears orphaned legacy cues when deleting the last subtitle track', () => {
    const project = {
      tracks: [{ id: 'subtitles', type: 'subtitle' }],
      clips: [],
      subtitle: { cues: [{ id: 'legacy', text: '旧字幕' }], text: '旧字幕' },
    }
    expect(removeTrack(project, 'subtitles')).toMatchObject({ tracks: [], clips: [], subtitle: { cues: [], text: '' } })
  })

  it('recreates a video track when inserting media after all tracks have been deleted', () => {
    const result = createMediaClips({
      assets: [{ id: 'video', name: 'source.mp4', kind: 'video', duration: 3, audioCodec: 'aac' }],
      track: undefined, tracks: [], clips: [], playhead: 0, duration: 60,
    })
    expect(result.tracks.map((track) => track.type)).toEqual(['video', 'audio'])
    expect(result.clips).toHaveLength(2)
    expect(result.clips.every((clip) => result.tracks.some((track) => track.id === clip.trackId))).toBe(true)
  })

  it('defaults video source audio to muted while keeping imported audio clips audible', () => {
    const tracks = [{ id: 'video', type: 'video' }, { id: 'audio', type: 'audio', label: '原声 · 配音' }]
    const result = createMediaClips({
      assets: [
        { id: 'video-asset', name: 'video.mp4', kind: 'video', duration: 3, audioCodec: 'aac' },
        { id: 'audio-asset', name: 'audio.wav', kind: 'audio', duration: 3 },
      ],
      track: tracks[0], clips: [], playhead: 0, duration: 60, tracks,
    })
    expect(result.inserted.map((clip) => clip.volume)).toEqual([0, 0.82])
    expect(result.clips.find((clip) => clip.linkedClipId === result.inserted[0].id).volume).toBe(0.82)
  })

  it('inserts audio into the chosen compatible track', () => {
    const tracks = [{ id: 'first', type: 'audio' }, { id: 'chosen', type: 'audio' }]
    const result = createMediaClips({
      assets: [{ id: 'audio', name: 'sound.wav', kind: 'audio', duration: 3 }],
      track: tracks[1], tracks, clips: [], playhead: 0, duration: 60,
    })
    expect(result.inserted[0].trackId).toBe('chosen')
  })
})

describe('subtitle and timeline helpers', () => {
  it('never expands intentional batch slices into full-length import placeholders', () => {
    const clips = [{ id: 'batch-video', assetId: 'asset', kind: 'video', batchMixClip: true, trimStart: 6, trimEnd: 9, duration: 3, sourceDuration: 40 }]
    expect(repairPlaceholderDurationClips(clips, 'asset', 40)).toBe(clips)
  })
  it('round-trips SRT cues with millisecond timestamps and multiline text', () => {
    const cues = [{ id: 'one', start: 1.234, end: 3.5, text: '第一行\n第二行', edited: true }]
    expect(parseSrt(createSrt(cues)).map(({ start, end, text }) => ({ start, end, text }))).toEqual(cues.map(({ start, end, text }) => ({ start, end, text })))
  })

  it('splits linked picture and source audio at the same frame boundary', () => {
    const clips = [
      { id: 'video', kind: 'video', trackId: 'v', start: 0, duration: 10, trimStart: 2, trimEnd: 12, audioLinked: true },
      { id: 'audio', kind: 'audio', trackId: 'a', start: 0, duration: 10, trimStart: 2, trimEnd: 12, linkedClipId: 'video' },
    ]
    const result = splitClips(clips, 4, ['v', 'a'])
    expect(result).toHaveLength(4)
    expect(result[0].duration).toBe(4)
    expect(result[1].duration).toBe(6)
    expect(result[2].start).toBe(0)
    expect(result[3].start).toBe(4)
    expect(result[3].linkedClipId).toBe(result[1].id)
  })

  it('deletes only the selected split segment and its linked source audio', () => {
    const clips = [
      { id: 'video-first', kind: 'video', trackId: 'v', assetId: 'asset', start: 0, duration: 4, audioLinked: true },
      { id: 'video-second', kind: 'video', trackId: 'v', assetId: 'asset', start: 4, duration: 6, audioLinked: true },
      { id: 'audio-first', kind: 'audio', trackId: 'a', assetId: 'asset', start: 0, duration: 4, linkedClipId: 'video-first' },
      { id: 'audio-second', kind: 'audio', trackId: 'a', assetId: 'asset', start: 4, duration: 6, linkedClipId: 'video-second' },
    ]

    expect(removeClip(clips, 'audio-second')).toEqual([clips[0], clips[1], clips[2]])
    expect(removeClip(clips, 'video-second')).toEqual([clips[0], clips[2]])
    expect(removeClip(clips, 'missing')).toBe(clips)
  })

  it('splits an editable linked audio lane independently when its video track is locked', () => {
    const clips = [
      { id: 'video', kind: 'video', trackId: 'locked-video', start: 0, duration: 10, audioLinked: true },
      { id: 'audio', kind: 'audio', trackId: 'editable-audio', start: 0, duration: 10, linkedClipId: 'video' },
    ]
    const result = splitClips(clips, 4, ['editable-audio'])
    expect(result).toHaveLength(3)
    expect(result.filter((clip) => clip.kind === 'audio').map((clip) => ({ start: clip.start, duration: clip.duration, linked: clip.linkedClipId }))).toEqual([
      { start: 0, duration: 4, linked: null },
      { start: 4, duration: 6, linked: null },
    ])
  })

  it('splits an editable video lane independently when its linked audio track is locked', () => {
    const clips = [
      { id: 'video', kind: 'video', trackId: 'editable-video', start: 0, duration: 10, audioLinked: true },
      { id: 'audio', kind: 'audio', trackId: 'locked-audio', start: 0, duration: 10, linkedClipId: 'video' },
    ]
    const result = splitClips(clips, 4, ['editable-video'])
    expect(result).toHaveLength(3)
    expect(result.filter((clip) => clip.kind === 'video').map((clip) => ({ start: clip.start, duration: clip.duration }))).toEqual([
      { start: 0, duration: 4 },
      { start: 4, duration: 6 },
    ])
    expect(result.find((clip) => clip.id === 'audio')).toEqual(clips[1])
  })

  it('preserves locked source audio when deleting its video segment', () => {
    const tracks = [{ id: 'video', locked: false }, { id: 'audio', locked: true }]
    const video = { id: 'picture', kind: 'video', trackId: 'video', start: 0, duration: 10, audioLinked: true }
    const audio = { id: 'sound', kind: 'audio', trackId: 'audio', start: 0, duration: 10, trimStart: 0, trimEnd: 10, linkedClipId: 'picture' }
    const clips = [video, audio]
    expect(removeClip(clips, 'sound', false, tracks)).toBe(clips)
    expect(removeClip(clips, 'picture', false, tracks)).toEqual([{ ...audio, linkedClipId: null, audioLinked: false }])
    const split = splitClips(clips, 4, ['video'])
    const deleted = removeClip(split, 'picture', false, tracks)
    expect(deleted.find((clip) => clip.id === 'sound')).toEqual({ ...audio, linkedClipId: null, audioLinked: false })
    expect(deleted.filter((clip) => clip.kind === 'video').map((clip) => [clip.start, clip.duration])).toEqual([[4, 6]])
  })

  it('does not ripple locked companion tracks or shift their remaining clips', () => {
    const clips = [
      { id: 'picture', kind: 'video', assetId: 'source', trackId: 'video', start: 0, duration: 4, audioLinked: true },
      { id: 'later-picture', kind: 'video', assetId: 'source', trackId: 'video', start: 4, duration: 6, audioLinked: true },
      { id: 'sound', kind: 'audio', assetId: 'source', trackId: 'audio', start: 0, duration: 4, linkedClipId: 'picture' },
      { id: 'later-sound', kind: 'audio', assetId: 'source', trackId: 'audio', start: 4, duration: 6, linkedClipId: 'later-picture' },
    ]
    const result = removeClip(clips, 'picture', true, [{ id: 'video', locked: false }, { id: 'audio', locked: true }])
    expect(result.find((clip) => clip.id === 'later-picture').start).toBe(0)
    expect(result.find((clip) => clip.id === 'later-sound')).toBe(clips[3])
    expect(result.find((clip) => clip.id === 'sound')).toMatchObject({ start: 0, duration: 4, linkedClipId: null })
    expect(clips[2].linkedClipId).toBe('picture')
  })

  it('keeps audio segments unique through repeated splits and deletes the middle segment', () => {
    const video = { id: 'video', kind: 'video', trackId: 'locked-video', start: 0, duration: 40, audioLinked: true }
    const audio = { id: 'audio', kind: 'audio', trackId: 'audio', assetId: 'source', start: 0, duration: 40, trimStart: 0, trimEnd: 40, linkedClipId: 'video' }
    const first = splitClips([video, audio], 10, ['audio'])
    const second = splitClips(first, 15, ['audio'])
    const third = splitClips(second, 20, ['audio'])
    expect(third).toHaveLength(5)
    expect(new Set(third.map((clip) => clip.id)).size).toBe(third.length)
    expect(third.filter((clip) => clip.kind === 'audio').map((clip) => [clip.start, clip.duration])).toEqual([[0, 10], [10, 5], [15, 5], [20, 20]])
    expect(third.find((clip) => clip.id === 'video')).toBe(video)
    expect(first).toHaveLength(3)
    const middle = third.find((clip) => clip.kind === 'audio' && clip.start === 10)
    const deleted = removeClip(third, middle.id)
    expect(deleted.filter((clip) => clip.kind === 'audio').map((clip) => [clip.start, clip.duration])).toEqual([[0, 10], [15, 5], [20, 20]])
    expect(deleted.find((clip) => clip.id === 'video')).toBe(video)
    expect(JSON.parse(JSON.stringify(deleted))).toHaveLength(4)
  })

  it.each(['audio', 'video', 'graphics', 'subtitle'])('splits a standalone %s without creating a companion of itself', (kind) => {
    const clips = [{ id: 'standalone', kind, trackId: 'editable', start: 0, duration: 10, trimStart: 0, trimEnd: 10 }]
    const result = splitClips(clips, 4, ['editable'])
    expect(result).toHaveLength(2)
    expect(result.map((clip) => [clip.start, clip.duration])).toEqual([[0, 4], [4, 6]])
    expect(result.some((clip) => clip.linkedClipId === clip.id)).toBe(false)
  })

  it('repairs duplicate audio segments produced by the old standalone split and preserves intentional overlays', () => {
    const left = { id: 'left', kind: 'audio', trackId: 'audio', assetId: 'source', start: 10, duration: 5, trimStart: 10, trimEnd: 15 }
    const right = { ...left, id: 'right', start: 15, duration: 25, trimStart: 15, trimEnd: 40 }
    const overlay = { ...left, id: 'intentional-overlay' }
    const corrupted = [left, right, { ...left, linkedClipId: 'left' }, { ...right, id: 'duplicate-right', linkedClipId: 'right' }, overlay]
    expect(repairSplitAudioDuplicates(corrupted)).toEqual([left, right, overlay])
    expect(corrupted).toHaveLength(5)
    const repaired = repairSplitAudioDuplicates(corrupted)
    expect(repairSplitAudioDuplicates(repaired)).toBe(repaired)
    expect(removeClip(corrupted, 'duplicate-right')).toEqual([left, overlay])
  })

  it('allows a single stream-copy video with its linked original audio lane', () => {
    const assets = [{ id: 'asset', path: '/tmp/source.mp4' }]
    const clips = [
      { id: 'video', kind: 'video', trackId: 'v', assetId: 'asset', start: 0, duration: 3 },
      { id: 'audio', kind: 'audio', trackId: 'a', assetId: 'asset', linkedClipId: 'video', start: 0, duration: 3 },
    ]
    expect(assessExport({ assets, clips, tracks: [{ id: 'v', type: 'video' }, { id: 'a', type: 'audio' }], preset: 'stream-copy', format: 'mp4', frameSize: { width: 1920, height: 1080 } }).ready).toBe(true)
  })

  it('unlinks paired clips without deleting their timing or source association', () => {
    const clips = [{ id: 'video', audioLinked: true }, { id: 'audio', linkedClipId: 'video' }]
    expect(unlinkClipPair(clips, 'video')).toEqual([
      { id: 'video', audioLinked: false, linkedClipId: null },
      { id: 'audio', linkedClipId: null, audioLinked: false },
    ])
  })

  it('removes an asset and its linked timeline clips without touching other assets', () => {
    const project = {
      assets: [{ id: 'keep' }, { id: 'remove' }],
      clips: [
        { id: 'video', assetId: 'remove', kind: 'video' },
        { id: 'source-audio', assetId: 'remove', linkedClipId: 'video', kind: 'audio' },
        { id: 'keep-clip', assetId: 'keep', kind: 'video' },
      ],
    }
    expect(removeAssetReferences(project, 'remove')).toEqual({
      assets: [{ id: 'keep' }],
      clips: [{ id: 'keep-clip', assetId: 'keep', kind: 'video' }],
    })
  })

  it('moves video and linked original audio together from either clip', () => {
    const clips = [
      { id: 'video', kind: 'video', start: 2, duration: 10 },
      { id: 'audio', kind: 'audio', linkedClipId: 'video', start: 2, duration: 10 },
      { id: 'music', kind: 'audio', start: 0, duration: 20 },
    ]

    expect(moveClipWithLinked(clips, 'video', 8).slice(0, 2).map((clip) => clip.start)).toEqual([8, 8])
    expect(moveClipWithLinked(clips, 'audio', 8).slice(0, 2).map((clip) => clip.start)).toEqual([8, 8])
    expect(moveClipWithLinked(clips, 'audio', 8)[2]).toEqual(clips[2])
  })

  it('shows a visual only inside its clip interval and selects the topmost visible track', () => {
    const project = {
      tracks: [{ id: 'main', order: 0 }, { id: 'overlay', order: 2 }, { id: 'hidden', order: 3, muted: true }],
      clips: [
        { id: 'base', kind: 'video', trackId: 'main', start: 4, duration: 3 },
        { id: 'top', kind: 'image', trackId: 'overlay', start: 5, duration: 2 },
        { id: 'muted', kind: 'video', trackId: 'hidden', start: 5, duration: 5 },
      ],
    }

    expect(findActiveVisualClip(project, 3.99)).toBeNull()
    expect(findActiveVisualClip(project, 4)?.id).toBe('base')
    expect(findActiveVisualClip(project, 5)?.id).toBe('top')
    expect(findActiveVisualClip(project, 7)).toBeNull()
  })

  it('detects cached silent preview proxies without invalidating original media URLs', () => {
    expect(isLegacySilentPreviewProxy('videome-media://local?path=%2Fcache%2Fvideome%2Fproxies%2Fabc.mp4')).toBe(true)
    expect(isLegacySilentPreviewProxy('videome-media://local?path=%2Fcache%2Fvideome%2Fproxies%2Fabc-av2.mp4')).toBe(false)
    expect(isLegacySilentPreviewProxy('videome-media://local?path=%2Fmedia%2Fsource.mp4')).toBe(false)
  })

  it('preserves existing browser assets without paths when importing another file', () => {
    const existing = [{ id: 'browser-first', path: null, name: 'first.mov' }]
    const imported = [{ id: 'browser-second', path: null, name: 'second.mov' }, { id: 'disk-third', path: '/media/third.mov', name: 'third.mov' }]

    expect(mergeAssetsByPath(existing, imported).map((asset) => asset.id)).toEqual(['disk-third', 'browser-first', 'browser-second'])
  })

  it('reconciles project, in-memory, and persisted libraries without dropping older paths', () => {
    expect(mergeAssetLibraries(
      [{ id: 'project-video', path: '/media/one.mp4', name: 'one.mp4' }],
      [{ id: 'session-video', path: '/media/two.mp4', name: 'two.mp4' }],
      [{ id: 'stored-video', path: '/media/three.mp4', name: 'three.mp4' }],
    ).map((asset) => asset.path)).toEqual(['/media/one.mp4', '/media/two.mp4', '/media/three.mp4'])
  })

  it('keeps the user click order instead of library order', () => {
    const assets = [{ id: 'first', name: '01～03' }, { id: 'third', name: '08～11' }, { id: 'second', name: '04～07' }]
    expect(orderAssetsByIds(assets, ['first', 'second']).map((asset) => asset.name)).toEqual(['01～03', '04～07'])
  })

  it('numbers timeline clips by explicit click order and compacts after deselection', () => {
    let selected = toggleOrderedSelection([], 'video-01-03')
    selected = toggleOrderedSelection(selected, 'video-04-07')
    expect(selected).toEqual(['video-01-03', 'video-04-07'])

    selected = toggleOrderedSelection(selected, 'video-01-03')
    expect(selected).toEqual(['video-04-07'])

    selected = toggleOrderedSelection(selected, 'video-01-03')
    expect(selected).toEqual(['video-04-07', 'video-01-03'])
  })

  it('starts numbering only when a user explicitly clicks a focused clip', () => {
    const focusedClipId = 'video-08-11'
    let selected = toggleOrderedSelection([], focusedClipId)
    expect(selected).toEqual([focusedClipId])
    selected = toggleOrderedSelection(selected, focusedClipId)
    expect(selected).toEqual([])
  })

  it('replaces the relocated asset record without dropping other pathless files', () => {
    const existing = [{ id: 'browser-a', name: 'a.mov', path: null }, { id: 'offline', name: 'offline.mov', path: null }]
    expect(replaceAssetById(existing, 'offline', { id: 'new', name: 'offline.mov', path: '/media/offline.mov' })).toEqual([
      { id: 'browser-a', name: 'a.mov', path: null },
      { id: 'offline', name: 'offline.mov', path: '/media/offline.mov' },
    ])
  })

  it('uses the measured media duration when building both picture and linked audio clips', () => {
    const result = createMediaClips({
      assets: [{ id: 'long-video', path: '/long.mp4', name: 'long.mp4', kind: 'video', duration: 30, sourceDuration: 43, audioCodec: 'aac' }],
      track: { id: 'video', type: 'video', accent: 'lime' },
      clips: [],
      playhead: 0,
      duration: 60,
      tracks: [
        { id: 'video', type: 'video', accent: 'lime', order: 0 },
        { id: 'audio', type: 'audio', label: '原声 · 配音', accent: 'cyan', order: 0 },
      ],
    })

    expect(result.clips.map((clip) => clip.duration)).toEqual([30, 30])
    expect(result.clips.map((clip) => clip.sourceDuration)).toEqual([43, 43])
  })

  it('does not turn an unknown-duration real video into an arbitrary ten-second clip', () => {
    const result = createMediaClips({
      assets: [{ id: 'unknown-duration', path: '/media/unknown.mov', name: 'unknown.mov', kind: 'video' }],
      track: { id: 'video', type: 'video', accent: 'lime' },
      clips: [],
      playhead: 0,
      duration: 60,
      tracks: [{ id: 'video', type: 'video', accent: 'lime', order: 0 }],
    })

    expect(result.inserted).toEqual([])
  })

  it('repairs a ten-second import placeholder from the measured full source duration', () => {
    const result = createMediaClips({
      assets: [{ id: 'long-video', path: '/media/long.mp4', name: 'long.mp4', kind: 'video', duration: 10, sourceDuration: 30, audioCodec: 'aac' }],
      track: { id: 'video', type: 'video', accent: 'lime' },
      clips: [],
      playhead: 0,
      duration: 60,
      tracks: [{ id: 'video', type: 'video', accent: 'lime', order: 0 }, { id: 'audio', type: 'audio', label: '原声 · 配音', accent: 'cyan', order: 0 }],
    })

    expect(result.inserted[0].duration).toBe(30)
    expect(result.clips.find((clip) => clip.linkedClipId)?.duration).toBe(30)
  })

  it('uses the compatible proxy rather than a source-video URL for audio playback', () => {
    expect(audioPreviewUrl({ path: '/original.mov', previewUrl: 'videome-media://source', proxyUrl: 'videome-media://proxy' })).toBe('videome-media://proxy')
    expect(audioPreviewUrl({ path: '/original.wav', previewUrl: 'videome-media://audio' })).toBe('videome-media://audio')
  })

  it('recovers media duration from stream timestamps and frame counts when container duration is missing', () => {
    expect(resolveMediaDurationSeconds({
      format: {},
      streams: [{ codec_type: 'video', duration_ts: 900000, time_base: '1/90000' }],
    })).toBe(10)
    expect(resolveMediaDurationSeconds({
      streams: [{ codec_type: 'video', nb_frames: '600', avg_frame_rate: '30/1' }],
    })).toBe(20)
  })

  it('repairs old ten-second video and linked-audio placeholders to the measured source duration', () => {
    const clips = [
      { id: 'video', kind: 'video', assetId: 'asset', start: 2, duration: 10, trimStart: 0, trimEnd: 10, sourceDuration: 30.016 },
      { id: 'audio', kind: 'audio', assetId: 'asset', linkedClipId: 'video', start: 2, duration: 10, trimStart: 0, trimEnd: 10, sourceDuration: 30.016 },
    ]
    expect(repairPlaceholderDurationClips(clips, 'asset', 30.016).map((clip) => clip.duration)).toEqual([30.016, 30.016])
    expect(repairPlaceholderDurationClips([{ ...clips[0], duration: 7, trimEnd: 7, sourceDuration: 45 }], 'asset', 30)).toEqual([{ ...clips[0], duration: 7, trimEnd: 7, sourceDuration: 45 }])
  })
})
