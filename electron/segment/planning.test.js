import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { normalizeOptions, planSegments, estimateBytes } = require('./planning.cjs')

describe('batch segment planning', () => {
  it('plans complete fixed-duration segments and preserves a short tail', () => {
    const options = normalizeOptions({ segmentSeconds: 20 })
    const segments = planSegments(125, 30, options.segmentSeconds)
    expect(segments).toHaveLength(7)
    expect(segments.slice(0, 6).every((segment) => segment.duration === 20)).toBe(true)
    expect(segments.at(-1)).toMatchObject({ index: 7, sourceStart: 120, sourceEnd: 125, duration: 5, frames: 150 })
    expect(segments[0].sourceStart).toBe(0)
    for (let index = 1; index < segments.length; index += 1) expect(segments[index].sourceStart).toBe(segments[index - 1].sourceEnd)
  })

  it('creates one segment when requested duration exceeds the source', () => {
    const segments = planSegments(12, 25, normalizeOptions({ segmentSeconds: 20 }).segmentSeconds)
    expect(segments).toEqual([{ index: 1, sourceStart: 0, sourceEnd: 12, duration: 12, frames: 300 }])
  })

  it('aligns fractional boundaries to the source frame rate and estimates space', () => {
    const segments = planSegments(3, 30, normalizeOptions({ segmentSeconds: 0.7 }).segmentSeconds)
    expect(segments.map((segment) => segment.frames)).toEqual([21, 21, 21, 21, 6])
    expect(segments.reduce((sum, segment) => sum + segment.frames, 0)).toBe(90)
    expect(estimateBytes(segments, 12, true)).toBeGreaterThan(0)
  })
})
