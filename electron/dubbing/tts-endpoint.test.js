import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
const { ttsEndpointCandidates, transcriptionEndpointCandidates, planningEndpointCandidates } = createRequire(import.meta.url)('./tts-endpoint.cjs')

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
  it('builds transcription and planning endpoint candidates', () => {
    expect(transcriptionEndpointCandidates('https://tts.example/v1')).toEqual([
      'https://tts.example/v1/audio/transcriptions',
      'https://tts.example/audio/transcriptions',
    ])
    expect(planningEndpointCandidates('https://tts.example')).toEqual([
      'https://tts.example/chat/completions',
      'https://tts.example/v1/chat/completions',
    ])
  })
})
