import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildPreviewProxyArguments } = require('./preview.cjs')

describe('browser-compatible preview proxy', () => {
  it('creates an H.264 video-only proxy without modifying the original media', () => {
    const args = buildPreviewProxyArguments('/source/original.mov', '/cache/proxy.mp4')

    expect(args).toContain('/source/original.mov')
    expect(args).toContain('/cache/proxy.mp4')
    expect(args).toContain('0:v:0')
    expect(args).toContain('libx264')
    expect(args).toContain('yuv420p')
    expect(args).toContain('0:a:0?')
    expect(args).toContain('aac')
    expect(args).toContain('+faststart')
  })
})
