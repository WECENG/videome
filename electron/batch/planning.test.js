import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { normalizeOptions, planSegments, planOutputs, buildRepresentativeProject } = require('./planning.cjs')

describe('batch mix deterministic planning', () => {
  it('produces 200 unique reproducible sequences with an exact frame budget', async () => {
    const options = normalizeOptions({ count: 200, seed: 'stable' })
    const segments = planSegments(60, options, [3.2, 6.1])
    expect(segments[0].sourceEnd).toBe(3.2)
    const first = await planOutputs(segments, options)
    expect(await planOutputs(segments, options)).toEqual(first)
    expect(new Set(first.map((item) => item.signature)).size).toBe(200)
    for (const item of first) expect(item.sequence.reduce((sum, clip) => sum + clip.frames, 0)).toBe(900)
    expect(segments.at(-1).sourceEnd).toBe(60)
    for (let index = 1; index < segments.length; index += 1) expect(segments[index].sourceStart).toBe(segments[index - 1].sourceEnd)
  })

  it('finishes with an actionable error when unique combinations run out', async () => {
    const options = normalizeOptions({ count: 200 })
    await expect(planOutputs(planSegments(1, options), options)).rejects.toMatchObject({ uniqueCount: 1 })
  })

  it('reuses short sources and rejects excessive per-output inputs', async () => {
    const options = normalizeOptions({ count: 1, targetSeconds: 5 })
    const items = await planOutputs(planSegments(1, options), options)
    expect(items[0].sequence).toHaveLength(5)
    const tooLong = normalizeOptions({ count: 1, targetSeconds: 100, segmentSeconds: 0.5 })
    await expect(planOutputs(planSegments(1, tooLong), tooLong)).rejects.toThrow('64')
  })

  it('aligns fractional requests and reconstructs a continuous source-based project', async () => {
    const options = normalizeOptions({ count: 1, targetSeconds: 6.01, seed: 'one' })
    expect(options.targetFrames).toBe(180)
    const [item] = await planOutputs(planSegments(30, options), options)
    const project = buildRepresentativeProject({ id: 'job', source: { path: '/source.mp4', name: 'source.mp4', duration: 30, videoOffset: 0, sha256: 'abc', width: 320, height: 180, codec: 'h264', audio: { offset: 0, containerOffset: 0, duration: 30, codec: 'aac' } }, options }, item)
    const clips = project.clips.filter((clip) => clip.kind === 'video')
    expect(clips[0].start).toBe(0)
    expect(clips[1].start).toBe(clips[0].duration)
    expect(project.duration).toBe(6)
    expect(project.clips.filter((clip) => clip.kind === 'audio').every((clip) => clip.volume === 1)).toBe(true)
  })

  it('rejects malformed limits and honours cancellation', async () => {
    expect(() => normalizeOptions()).toThrow('生成数量')
    expect(() => normalizeOptions({ count: '' })).toThrow('生成数量')
    expect(() => normalizeOptions({ count: 2.5 })).toThrow('生成数量')
    expect(() => normalizeOptions({ count: 1001 })).toThrow()
    expect(() => normalizeOptions({ concurrency: 9 })).toThrow()
    expect(() => normalizeOptions({ fps: 29.97 })).toThrow()
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    const options = normalizeOptions({ count: 1 })
    await expect(planOutputs(planSegments(60, options), options, { signal: controller.signal })).rejects.toThrow('stop')
  })

  it('uses the requested count rather than a fixed batch size', async () => {
    for (const count of [1, 7, 35]) {
      const options = normalizeOptions({ count, seed: 'user-quantity' })
      const items = await planOutputs(planSegments(60, options), options)
      expect(items).toHaveLength(count)
      expect(items.at(-1).index).toBe(count)
    }
  })
})
