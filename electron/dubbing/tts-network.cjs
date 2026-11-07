const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { ttsEndpointCandidates, transcriptionEndpointCandidates, planningEndpointCandidates } = require('./tts-endpoint.cjs')
const { readCloudAudio } = require('./tts-response.cjs')

const DEFAULT_SETTINGS = { baseUrl: '', transcriptionModel: '', plannerModel: 'gpt-6-luna', ttsModel: '', voice: '', apiKey: '' }

class TtsNetworkSettings {
  constructor(root, secureStorage) { this.file = path.join(root, 'tts-settings.json'); this.secureStorage = secureStorage; this.current = null }
  async read() {
    if (this.current) return { ...this.current }
    let stored
    try { stored = JSON.parse(await fs.readFile(this.file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_SETTINGS }; throw new Error('无法读取云端配音设置。') }
    let auth = {}
    if (stored.encryptedApiKey) {
      try { auth.apiKey = this.secureStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')) } catch { throw new Error('无法解密云端配音 API Key，请重新保存。') }
    }
    this.current = { ...DEFAULT_SETTINGS, ...stored, ...auth }; delete this.current.encryptedApiKey
    return { ...this.current }
  }
  async publicSettings() { const value = await this.read(); return { baseUrl: value.baseUrl, transcriptionModel: value.transcriptionModel, plannerModel: value.plannerModel, ttsModel: value.ttsModel || value.model, model: value.model, voice: value.voice, hasApiKey: Boolean(value.apiKey) } }
  async test(input = {}) {
    const previous = await this.read()
    const baseUrl = String(input.baseUrl || '').trim().replace(/\/$/, '')
    const model = String(input.ttsModel || input.model || '').trim()
    const voice = String(input.voice || '').trim()
    const apiKey = String(input.apiKey || '') || (input.keepApiKey ? previous.apiKey : '')
    if (!/^https?:\/\//i.test(baseUrl) || !model || !voice || !apiKey) throw new Error('请先填写接口地址、TTS 模型、云端音色和 API Key。')
    const startedAt = Date.now()
    let response
    let lastError
    let sawNotFound = false
    try {
      for (const endpoint of ttsEndpointCandidates(baseUrl)) {
        response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, input: '这是云端配音测试。', voice, response_format: 'wav', speed: 1 }) })
        if (response.status === 404 || response.status === 405) { sawNotFound = true; lastError = new Error(`云端接口返回 HTTP ${response.status}。`); continue }
        if (!response.ok) break
        try {
          const audio = await readCloudAudio(response)
          return { latencyMs: Date.now() - startedAt, bytes: audio.length, contentType: 'audio/wav' }
        } catch (error) {
          if (error.code !== 'INVALID_AUDIO_RESPONSE') throw error
          lastError = error
        }
      }
    } catch (error) { throw new Error(`云端连接失败：${error.message}`) }
    if (sawNotFound && lastError) throw new Error('云端网关未提供 OpenAI 兼容的语音接口（POST /v1/audio/speech）。请在网关中启用 TTS 路由，或填写实际的 TTS 服务地址。')
    if (lastError && !response?.ok) throw lastError
    if (!response?.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`云端接口返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 180)}` : ''}`)
    }
    throw lastError || new Error('云端接口未返回音频数据。')
  }
  async save(input = {}) {
    const baseUrl = String(input.baseUrl || '').trim().replace(/\/$/, '')
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('云端配音地址必须是 HTTP/HTTPS URL。')
    const model = String(input.ttsModel || input.model || '').trim(); const voice = String(input.voice || '').trim()
    let apiKey = String(input.apiKey || '')
    const previous = await this.read()
    if (!apiKey && input.keepApiKey) apiKey = previous.apiKey
    if (!baseUrl || !model || !voice) throw new Error('请填写云端配音地址、TTS 模型和音色。')
    if (!this.secureStorage?.isEncryptionAvailable?.() || this.secureStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统安全存储不可用，无法保存云端 API Key。')
    const stored = { baseUrl, transcriptionModel: String(input.transcriptionModel || '').trim(), plannerModel: String(input.plannerModel || DEFAULT_SETTINGS.plannerModel).trim(), ttsModel: model, model, voice, encryptedApiKey: this.secureStorage.encryptString(apiKey).toString('base64') }
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(this.file), { recursive: true }); await fs.writeFile(temporary, JSON.stringify(stored, null, 2), { mode: 0o600 }); await fs.rename(temporary, this.file)
    this.current = { ...stored, baseUrl, transcriptionModel: stored.transcriptionModel, plannerModel: stored.plannerModel, ttsModel: model, model, voice, apiKey }; return this.publicSettings()
  }
}

module.exports = { TtsNetworkSettings, DEFAULT_SETTINGS }
