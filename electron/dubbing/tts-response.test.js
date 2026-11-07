import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
const { readCloudAudio } = createRequire(import.meta.url)('./tts-response.cjs')

describe('OpenAI-compatible TTS response parsing', () => {
  it('rejects HTML as a retryable invalid audio response', async () => {
    const response = new Response('<!doctype html><html><body>Sub2API</body></html>', { headers: { 'content-type': 'text/html' } })
    await expect(readCloudAudio(response)).rejects.toMatchObject({ code: 'INVALID_AUDIO_RESPONSE' })
  })
  it('accepts binary WAV responses', async () => {
    const wav = Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'binary')
    await expect(readCloudAudio(new Response(wav, { headers: { 'content-type': 'audio/wav' } }))).resolves.toEqual(wav)
  })
})
