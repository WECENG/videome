import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
const { ttsEndpointCandidates } = createRequire(import.meta.url)('./tts-endpoint.cjs')

describe('OpenAI-compatible TTS endpoint candidates', () => {
  it('supports a base URL with or without /v1', () => {
    expect(ttsEndpointCandidates('https://tts.example')).toEqual([
      'https://tts.example/audio/speech',
      'https://tts.example/v1/audio/speech',
    ])
    expect(ttsEndpointCandidates('https://tts.example/v1/')).toEqual([
      'https://tts.example/v1/audio/speech',
      'https://tts.example/audio/speech',
    ])
  })
})
