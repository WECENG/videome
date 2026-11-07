import { describe, expect, it } from 'vitest'
const { analyzeProsody, normalizeProsodyPlan, normalizeStyle, splitProsodyText } = require('./prosody.cjs')

describe('dubbing prosody planning', () => {
  it('splits Chinese punctuation into phrase segments', () => {
    expect(splitProsodyText('你好，世界！准备好了吗？')).toEqual(['你好，', '世界！', '准备好了吗？'])
  })
  it('derives different pauses and rates from punctuation and emotion', () => {
    const plan = analyzeProsody('慢慢来。现在开始！', { emotion: 'excited', rate: 1, pause: 'strong' })
    expect(plan.segments[0].pauseAfterMs).toBeGreaterThan(plan.segments[1].pauseAfterMs)
    expect(plan.segments[1].rate).toBeGreaterThan(plan.segments[0].rate)
  })
  it('clamps user controls and falls back to neutral defaults', () => {
    expect(normalizeStyle({ emotion: 'unknown', rate: 3, pause: 'unknown' })).toEqual({ emotion: 'neutral', rate: 1.18, pause: 'normal' })
    expect(normalizeProsodyPlan('你好。', { segments: [{ text: '你好。', rate: 0.2, pauseAfterMs: 2000 }] })).toMatchObject({ segments: [{ rate: 0.78, pauseAfterMs: 900 }] })
  })
})
