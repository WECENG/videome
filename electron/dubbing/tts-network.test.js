import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const { TtsNetworkSettings } = createRequire(import.meta.url)('./tts-network.cjs')
const roots = []
const secure = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'keychain',
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => String(value).replace(/^encrypted:/, ''),
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

describe('OpenAI-compatible TTS settings', () => {
  it('stores the API key encrypted and exposes only hasApiKey', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-tts-settings-')); roots.push(root)
    const settings = new TtsNetworkSettings(root, secure)
    await expect(settings.save({ baseUrl: 'https://tts.example/v1', model: 'voice-1', voice: 'alloy', apiKey: 'secret' })).resolves.toEqual({ baseUrl: 'https://tts.example/v1', model: 'voice-1', voice: 'alloy', hasApiKey: true })
    const stored = await fs.readFile(path.join(root, 'tts-settings.json'), 'utf8')
    expect(stored).not.toContain('secret')
    expect(await settings.read()).toMatchObject({ apiKey: 'secret' })
  })
  it('rejects incomplete or non-http settings', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-tts-settings-')); roots.push(root)
    const settings = new TtsNetworkSettings(root, secure)
    await expect(settings.save({ baseUrl: 'file:///tmp', model: 'x', voice: 'x', apiKey: 'secret' })).rejects.toThrow('HTTP/HTTPS')
    await expect(settings.save({ baseUrl: 'https://tts.example/v1', model: '', voice: 'x', apiKey: 'secret' })).rejects.toThrow('填写')
  })
  it('reuses the saved API key for testing changed endpoint or model', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-tts-settings-')); roots.push(root)
    const settings = new TtsNetworkSettings(root, secure)
    await settings.save({ baseUrl: 'https://old.example/v1', model: 'old-model', voice: 'alloy', apiKey: 'secret' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.from('RIFF....WAVE'), { status: 200, headers: { 'content-type': 'audio/wav' } }))
    await expect(settings.test({ baseUrl: 'https://new.example/v1', model: 'new-model', voice: 'coral', keepApiKey: true })).resolves.toMatchObject({ bytes: 12 })
    expect(fetchMock).toHaveBeenCalledWith('https://new.example/v1/audio/speech', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer secret' }) }))
    fetchMock.mockRestore()
  })
  it('tries both /v1 and non-/v1 speech endpoints after a 404', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-tts-settings-')); roots.push(root)
    const settings = new TtsNetworkSettings(root, secure)
    await settings.save({ baseUrl: 'https://tts.example', model: 'voice-1', voice: 'alloy', apiKey: 'secret' })
    const calls = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      calls.push(url)
      if (calls.length === 1) return new Response('not found', { status: 404 })
      return new Response(Buffer.from('RIFF....WAVE'), { status: 200, headers: { 'content-type': 'audio/wav' } })
    })
    await expect(settings.test({ baseUrl: 'https://tts.example', model: 'voice-1', voice: 'alloy', keepApiKey: true })).resolves.toMatchObject({ bytes: 12 })
    expect(calls).toEqual(['https://tts.example/audio/speech', 'https://tts.example/v1/audio/speech'])
    fetchMock.mockRestore()
  })
  it('explains when the gateway has no speech endpoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-tts-settings-')); roots.push(root)
    const settings = new TtsNetworkSettings(root, secure)
    await settings.save({ baseUrl: 'https://tts.example', model: 'voice-1', voice: 'alloy', apiKey: 'secret' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('404 page not found', { status: 404 }))
    await expect(settings.test({ baseUrl: 'https://tts.example', model: 'voice-1', voice: 'alloy', keepApiKey: true })).rejects.toThrow('未提供 OpenAI 兼容的语音接口')
    fetchMock.mockRestore()
  })
})
