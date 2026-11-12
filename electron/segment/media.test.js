import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { buildArguments } = require('./media.cjs')

describe('batch segment media arguments', () => {
  it('keeps source geometry and maps the source audio without background music', () => {
    const args = buildArguments({ path: '/source.mp4', videoOffset: 0.25, videoStream: 0, fps: 30, width: 640, height: 360 }, { sourceStart: 20, duration: 5 }, { videoBitrateMbps: 12 }, '/output.mp4', 'libx264')
    expect(args).toContain('-ss')
    expect(args[args.indexOf('-ss') + 1]).toBe('20.25')
    expect(args).toContain('-map')
    expect(args).toContain('0:a:0?')
    expect(args).not.toContain('-stream_loop')
    expect(args.find((value) => String(value).includes('format=yuv420p'))).toBeTruthy()
    expect(args).toContain('rotate=0')
  })
})
