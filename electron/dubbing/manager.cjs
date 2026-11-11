const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { run } = require('./process.cjs')
const { translationPrompt, translationArguments, parseTranslation } = require('./translation.cjs')
const { analyzeProsody, normalizeProsodyPlan, normalizeStyle } = require('./prosody.cjs')
const { ttsEndpointCandidates, transcriptionEndpointCandidates, planningEndpointCandidates } = require('./tts-endpoint.cjs')
const { readCloudAudio } = require('./tts-response.cjs')

const activeStatuses = new Set(['extracting', 'separating', 'recognizing', 'translating', 'generating'])
const snapshot = (value) => JSON.parse(JSON.stringify(value))
function timing(natural, available) {
  if (!(natural > 0) || !(available > 0)) throw new Error('配音或句子时长无效。')
  const speed = Math.max(1, natural / available)
  return { speed, fits: speed <= 1.25 + 1e-6 }
}
function normalizedCues(cues, duration) {
  let previous = 0
  return cues.flatMap((cue, index) => {
    const start = Math.max(previous, Math.min(duration, Number(cue.start) || 0))
    const end = Math.min(duration, Number(cue.end) || 0)
    if (end <= start || !String(cue.text || '').trim() || /^\s*[\[(].*[\])]\s*$/.test(cue.text)) return []
    previous = end
    return [{ ...cue, id: `cue-${index}`, start, end, text: String(cue.text).trim() }]
  })
}
function prosodyInstructions(prosody = {}) {
  const emotion = ({ warm: 'warm and gentle', serious: 'serious and restrained', excited: 'energetic and excited', sad: 'low and reflective', calm: 'calm and relaxed' })[prosody.emotion]
  const pause = prosody.pause === 'strong' ? 'Use clearly noticeable pauses between phrases.' : prosody.pause === 'light' ? 'Keep pauses between phrases short and light.' : 'Use natural pauses between phrases.'
  return [emotion ? `Speak with a ${emotion} delivery.` : 'Use a neutral delivery.', pause].join(' ')
}
function sameValue(left, right) { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null) }

class DubbingManager extends EventEmitter {
  constructor({ root, models, ffmpeg, ffprobe, resources, gate }) {
    super(); Object.assign(this, { root, models, ffmpeg, ffprobe, resources, gate })
    this.ttsNetwork = models?.ttsNetwork
    this.jobs = new Map(); this.removing = new Set(); this.pending = []; this.pendingActions = new Map(); this.active = null; this.draining = false; this.saveChains = new Map(); this.initialized = this.load()
  }
  async load() {
    await fs.mkdir(this.root, { recursive: true })
    for (const name of await fs.readdir(this.root)) {
      try {
        // A deletion marker takes precedence over the main record and its
        // recovery backup. Generated media in this folder may still be in use.
        if (await fs.stat(path.join(this.root, name, '.deleted')).then(() => true).catch(() => false)) continue
        let job
        try { job = JSON.parse(await fs.readFile(path.join(this.root, name, 'job.json'), 'utf8')) }
        catch { job = JSON.parse(await fs.readFile(path.join(this.root, name, 'job.json.bak'), 'utf8')) }
        if (job.id !== name) continue
        job.backend = job.backend || 'kokoro-fast'
        job.style = normalizeStyle(job.style)
        if (activeStatuses.has(job.status) || job.status === 'created') { job.status = 'interrupted'; job.error = '应用退出中断了任务，可继续处理。' }
        this.jobs.set(job.id, job)
      } catch { /* A partial directory is not a recoverable task. */ }
    }
  }
  get(id) { const job = this.jobs.get(id); if (!job) throw new Error('配音任务不存在。'); return snapshot(job) }
  async ttsSettings() { return this.ttsNetwork?.publicSettings?.() || { baseUrl: '', transcriptionModel: '', plannerModel: 'gpt-6-luna', ttsModel: '', model: '', voice: '', hasApiKey: false } }
  async saveTtsSettings(settings) { if (!this.ttsNetwork) throw new Error('云端配音配置不可用。'); return this.ttsNetwork.save(settings) }
  async testTtsSettings(settings) { if (!this.ttsNetwork) throw new Error('云端配音配置不可用。'); return this.ttsNetwork.test(settings) }
  list(projectId) { return [...this.jobs.values()].filter((job) => job.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(snapshot) }
  async save(job) {
    job.updatedAt = new Date().toISOString()
    const file = path.join(this.root, job.id, 'job.json')
    const previous = this.saveChains.get(job.id) || Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      await fs.copyFile(file, `${file}.bak`).catch(() => {})
      const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
      await fs.writeFile(temporary, JSON.stringify(job, null, 2)); await fs.rename(temporary, file)
    })
    this.saveChains.set(job.id, next)
    await next
    if (this.saveChains.get(job.id) === next) this.saveChains.delete(job.id)
    if (this.jobs.get(job.id) === job && !this.removing.has(job.id)) this.emit('progress', snapshot(job))
  }
  async remove({ id, projectId } = {}) {
    await this.initialized
    const job = this.jobs.get(id)
    if (!job || job.projectId !== projectId || !projectId) throw new Error('当前工程中没有这条配音草稿。')
    return this.removeDrafts(projectId, [job])
  }
  async clear(projectId) {
    await this.initialized
    if (typeof projectId !== 'string' || !projectId) throw new Error('请先打开需要清空配音草稿的工程。')
    return this.removeDrafts(projectId, [...this.jobs.values()].filter((job) => job.projectId === projectId))
  }
  async removeDrafts(projectId, jobs) {
    // Reserve the whole selection before writing anything, so clear cannot
    // partially delete a list containing a running or concurrently removed job.
    for (const job of jobs) {
      if (this.active?.id === job.id || activeStatuses.has(job.status) || job.status === 'created') throw new Error('有配音任务正在运行，请先取消并等待停止后再删除草稿。')
      if (this.removing.has(job.id)) throw new Error('正在删除配音草稿，请稍后。')
    }
    jobs.forEach((job) => this.removing.add(job.id))
    const ids = []; const failures = []
    try {
      for (const job of jobs) {
        try {
          const folder = path.join(this.root, job.id)
          await fs.writeFile(path.join(folder, '.deleted'), new Date().toISOString(), { flag: 'w' })
          this.jobs.delete(job.id); ids.push(job.id)
          // Only remove draft records. Never delete a source or generated WAV:
          // saved projects and undo snapshots may reference these file paths.
          await Promise.all(['job.json', 'job.json.bak', 'job.json.tmp'].map((name) => fs.rm(path.join(folder, name), { force: true }).catch(() => {})))
        } catch (error) { failures.push({ id: job.id, reason: error.message }) }
      }
      if (ids.length) this.emit('removed', { projectId, ids })
      return { projectId, ids, failures }
    } finally { jobs.forEach((job) => this.removing.delete(job.id)) }
  }
  async create({ source, projectId, voice = 3, action = 'analyze', backend = 'kokoro-fast', style = {} }) {
    if (!['analyze', 'auto'].includes(action)) throw new Error('未知配音流程。')
    if (backend !== 'openai-cloud' && !(await this.models.status()).ready) throw new Error('请先安装本地配音模型。')
    if (!projectId || !source?.path || !path.isAbsolute(source.path) || !source.snapshot || !(source.duration > 0) || source.duration > 1800 || !Number.isFinite(source.trimStart) || source.trimStart < 0 || !Number.isFinite(source.start) || source.start < 0) throw new Error('来源片段参数无效。')
    const stat = await fs.stat(source.path)
    const selectedBackend = ['kokoro-fast', 'local-expressive', 'openai-compatible', 'openai-cloud'].includes(backend) ? backend : 'kokoro-fast'
    if (selectedBackend === 'openai-compatible' || selectedBackend === 'openai-cloud') {
      const cloud = await this.ttsNetwork?.read?.()
      if (!cloud?.baseUrl || !(cloud.ttsModel || cloud.model) || !cloud.voice || !cloud.apiKey) throw new Error('OpenAI 兼容云端尚未配置，请先配置接口地址、TTS 模型、音色和 API Key。')
      if (selectedBackend === 'openai-cloud' && (!cloud.transcriptionModel || !cloud.plannerModel)) throw new Error('云端全流程还需要配置转写模型和规划模型。')
    }
    const job = { id: crypto.randomUUID(), projectId, source, fingerprint: { size: stat.size, mtimeMs: stat.mtimeMs }, voice: selectedBackend === 'openai-cloud' ? 3 : this.voice(voice), backend: selectedBackend, style: normalizeStyle(style),
      models: { version: this.models.manifest.version, mrx: '19b3de8', whisper: 'small.en / pywhispercpp 1.5.1', qwen: 'Qwen3-4B-Q4_K_M / llama b5401', kokoro: 'v1.1-zh / sherpa-onnx 2.0.1' },
      status: 'created', stage: '等待提取音频', cues: [], createdAt: new Date().toISOString() }
    await fs.mkdir(path.join(this.root, job.id)); this.jobs.set(job.id, job); await this.save(job)
    if (this.active || this.pending.length) {
      if (!this.pending.includes(job.id)) this.pending.push(job.id)
      this.pendingActions.set(job.id, action)
      job.stage = '排队等待前一个配音任务完成'; await this.save(job)
      await this.drainPending()
    } else this.start(job.id, action)
    return snapshot(job)
  }
  voice(value) { const voice = Number(value); if (!Number.isInteger(voice) || voice < 3 || voice > 102) throw new Error('请选择中文预设音色。'); return voice }
  async update({ id, cues, voice, backend, style }) {
    const job = this.jobs.get(id); if (!job || this.active?.id === id || this.removing.has(id)) throw new Error('任务正在运行或删除，稍后再修改。')
    const nextVoice = job.backend === 'openai-cloud' ? 3 : (voice === undefined ? job.voice : this.voice(voice))
    const nextBackend = backend && ['kokoro-fast', 'local-expressive', 'openai-compatible', 'openai-cloud'].includes(backend) ? backend : job.backend
    const nextStyle = style ? normalizeStyle(style) : job.style
    const voiceChanged = nextVoice !== job.voice
    const backendChanged = nextBackend !== job.backend
    const styleChanged = !sameValue(nextStyle, job.style)
    if (voiceChanged) {
      job.voice = nextVoice; job.cues = job.cues.map((cue) => ({ ...cue, status: 'draft', audioPath: null }))
    }
    job.style = nextStyle
    job.backend = nextBackend
    if (cues) {
      if (!Array.isArray(cues) || cues.length !== job.cues.length) throw new Error('校对句子数量无效。')
      job.cues = job.cues.map((cue) => {
        const incoming = cues.find((item) => item.id === cue.id)
        const translation = String(incoming?.translation ?? cue.translation).trim()
        if (translation.length > 1000) throw new Error('每句译文不能超过 1000 字。')
        const hasIncomingProsody = Boolean(incoming?.prosody)
        const prosody = hasIncomingProsody
          ? analyzeProsody(translation, normalizeStyle({ ...(cue.prosody || {}), ...incoming.prosody }))
          : !styleChanged && translation === cue.translation
            ? cue.prosody
            : analyzeProsody(translation, job.style)
        const cueChanged = voiceChanged || backendChanged || styleChanged || translation !== cue.translation || (hasIncomingProsody && !sameValue(prosody, cue.prosody))
        return { ...cue, translation, prosody, status: cueChanged ? 'draft' : cue.status, audioPath: cueChanged ? null : cue.audioPath }
      })
    }
    if ((voiceChanged || backendChanged || styleChanged) && !cues) job.cues = job.cues.map((cue) => ({ ...cue, prosody: analyzeProsody(cue.translation || cue.text, job.style), status: 'draft', audioPath: null }))
    job.status = 'review'; job.mixPath = null; await this.save(job); return snapshot(job)
  }
  start(id, action, cueId = null) {
    const job = this.jobs.get(id); if (!job) throw new Error('任务不存在。')
    if (this.removing.has(id)) throw new Error('正在删除此配音草稿。')
    if (!['analyze', 'translate', 'generate', 'auto'].includes(action)) throw new Error('未知配音任务操作。')
    if (action === 'translate' && (!job.cues.length || !job.backgroundPath)) throw new Error('请先完成英文识别和背景分离。')
    if (action === 'generate' && (!job.cues.length || job.cues.some((cue) => !cue.translation?.trim()))) throw new Error('请先校对并填写全部中文译文。')
    if (cueId && !job.cues.some((cue) => cue.id === cueId)) throw new Error('句子不存在。')
    if (this.active) {
      if (!this.pending.includes(id)) throw new Error('已有本地配音任务正在运行，请等待当前任务完成。')
      return { id, queued: true }
    }
    if (this.gate && !this.gate.acquire('dubbing')) throw new Error('正在导出或批量混剪，请完成后再生成配音。')
    const controller = new AbortController(); this.active = { id, controller }
    const promise = (async () => {
      try {
        if (job.backend !== 'openai-cloud' && !(await this.models.status()).ready) throw new Error('本地配音模型不可用，请检查安装。')
        const stat = await fs.stat(job.source.path)
        if (stat.size !== job.fingerprint.size || stat.mtimeMs !== job.fingerprint.mtimeMs) throw new Error('源文件已变化，请重新创建任务。')
        const disk = await fs.statfs(this.root)
        if (Number(disk.bavail) * Number(disk.bsize) < 1e9 + job.source.duration * 2e6) throw new Error('配音生成可用磁盘空间不足，请释放空间后重试。')
        if (action === 'analyze' || action === 'auto') await (job.backend === 'openai-cloud' ? this.analyzeCloud(job, controller.signal) : this.analyze(job, controller.signal))
        else if (action === 'translate') await this.translate(job, controller.signal)
        if (action === 'generate' || action === 'auto') await this.generate(job, controller.signal, cueId)
        job.error = null
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message
      } finally {
        await this.save(job); this.active = null; this.gate?.release('dubbing')
        void this.drainPending()
      }
    })()
    this.active.promise = promise
    return { id }
  }
  async cancel(id) {
    if (this.active?.id === id) { const { controller, promise } = this.active; controller.abort(); await promise }
    const index = this.pending.indexOf(id)
    if (index >= 0) {
      this.pending.splice(index, 1)
      this.pendingActions.delete(id)
      const job = this.jobs.get(id)
      if (job) { job.status = 'cancelled'; job.stage = '已取消'; await this.save(job) }
    }
    return this.get(id)
  }
  async drainPending() {
    if (this.draining || this.active) return
    this.draining = true
    try {
      while (!this.active && this.pending.length) {
        const id = this.pending.shift()
        const job = this.jobs.get(id)
        if (!job || this.removing.has(id) || job.status === 'cancelled') continue
        try {
          const action = this.pendingActions.get(id) || 'analyze'
          this.pendingActions.delete(id)
          this.start(id, action)
        } catch (error) {
          job.status = 'failed'; job.error = error.message; await this.save(job)
        }
      }
    } finally { this.draining = false }
  }
  async shutdown() { this.models.cancel(); this.pending = []; this.pendingActions.clear(); if (this.active) await this.cancel(this.active.id) }
  async phase(job, status, stage) { job.status = status; job.stage = stage; job.percent = 0; await this.save(job) }
  async media(args, signal) { return run(this.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { signal }) }
  async duration(file, signal) {
    const value = JSON.parse(await run(this.ffprobe, ['-v', 'error', '-show_format', '-of', 'json', file], { signal }))
    return Number(value.format.duration)
  }
  async worker(stage, input, folder, signal, voice) {
    return run(this.models.python, [path.join(this.resources, 'worker.py'), stage, '--models', this.models.directory, '--input', input, '--output', folder, '--voice', String(voice || 3)], { signal, env: { PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1', PYTHONPATH: this.models.directory } })
  }
  async cloudTranscribe(inputPath, signal) {
    const settings = await this.ttsNetwork?.read?.()
    if (!settings?.baseUrl || !settings.transcriptionModel || !settings.apiKey) throw new Error('云端转写模型尚未配置。')
    const bytes = await fs.readFile(inputPath)
    let lastError
    for (const endpoint of transcriptionEndpointCandidates(settings.baseUrl)) {
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(inputPath))
      form.append('model', settings.transcriptionModel)
      form.append('response_format', 'verbose_json')
      let response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${settings.apiKey}` }, body: form, signal })
      if (response.status === 400) {
        const fallback = new FormData()
        fallback.append('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(inputPath))
        fallback.append('model', settings.transcriptionModel)
        response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${settings.apiKey}` }, body: fallback, signal })
      }
      if (response.status === 404 || response.status === 405) { lastError = new Error(`云端转写接口返回 HTTP ${response.status}。`); continue }
      if (!response.ok) throw new Error(`云端转写失败（HTTP ${response.status}）。`)
      const payload = await response.json().catch(() => null)
      if (!payload?.text && !payload?.segments?.length) throw new Error('云端转写未返回有效文本。')
      return payload
    }
    throw lastError || new Error('云端转写接口不可用。')
  }
  async cloudPlan(transcript, duration, signal) {
    const settings = await this.ttsNetwork?.read?.()
    if (!settings?.baseUrl || !settings.plannerModel || !settings.apiKey) throw new Error('云端规划模型尚未配置。')
    const prompt = `你是影视配音编导。请把英文转写内容翻译成自然简体中文，并按时间切成适合配音的句子。只返回 JSON，不要 Markdown。格式：{"cues":[{"start":0,"end":1.2,"text":"英文","translation":"中文","emotion":"neutral","rate":1,"pauseAfterMs":80}]}。总时长 ${duration} 秒。英文转写：${JSON.stringify(transcript)}`
    const request = { model: settings.plannerModel, messages: [{ role: 'system', content: '只输出合法 JSON。' }, { role: 'user', content: prompt }], temperature: 0.2, response_format: { type: 'json_object' } }
    let lastError
    for (const endpoint of planningEndpointCandidates(settings.baseUrl)) {
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(request), signal })
      if (response.status === 404 || response.status === 405) { lastError = new Error(`云端规划接口返回 HTTP ${response.status}。`); continue }
      if (response.status === 400) {
        const fallback = { ...request }; delete fallback.response_format
        response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(fallback), signal })
      }
      if (!response.ok) throw new Error(`云端规划失败（HTTP ${response.status}）。`)
      const payload = await response.json().catch(() => null)
      const content = payload?.choices?.[0]?.message?.content
      let parsed
      try { parsed = JSON.parse(typeof content === 'string' ? content : JSON.stringify(content || {})) } catch { throw new Error('云端规划返回了无法解析的 JSON。') }
      if (!Array.isArray(parsed.cues) || !parsed.cues.length) throw new Error('云端规划未返回有效句子。')
      return parsed.cues
    }
    throw lastError || new Error('云端规划接口不可用。')
  }
  async cloudTts(text, output, signal, prosody = {}) {
    const settings = await this.ttsNetwork?.read?.()
    const ttsModel = settings?.ttsModel || settings?.model
    if (!settings?.baseUrl || !ttsModel || !settings.voice || !settings.apiKey) throw new Error('OpenAI 兼容云端尚未配置，请先配置接口地址、TTS 模型、音色和 API Key。')
    const requestBody = {
      model: ttsModel, input: text, voice: settings.voice, response_format: 'wav',
      speed: Math.max(0.25, Math.min(4, Number(prosody.rate) || 1)),
      instructions: prosodyInstructions(prosody),
    }
    const request = {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }
    let lastError
    let sawNotFound = false
    for (const endpoint of ttsEndpointCandidates(settings.baseUrl)) {
      const response = await fetch(endpoint, request)
      if (response.status === 404 || response.status === 405) { sawNotFound = true; lastError = new Error(`云端配音请求失败（HTTP ${response.status}）。`); continue }
      if (!response.ok) throw new Error(`云端配音请求失败（HTTP ${response.status}）。`)
      try {
        await fs.writeFile(output, await readCloudAudio(response))
        return
      } catch (error) {
        // Some OpenAI-compatible gateways implement speech but reject the
        // optional instructions field. Retry the same endpoint once with the
        // portable request shape before trying the next URL.
        if (response.status === 400 && requestBody.instructions) {
          const portable = { ...request, body: JSON.stringify({ ...requestBody, instructions: undefined }) }
          const retry = await fetch(endpoint, portable)
          if (retry.ok) {
            try { await fs.writeFile(output, await readCloudAudio(retry)); return } catch (retryError) { lastError = retryError }
          }
        }
        if (error.code !== 'INVALID_AUDIO_RESPONSE') throw error
        lastError = error
      }
    }
    if (sawNotFound) throw new Error('云端网关未提供 OpenAI 兼容的语音接口（POST /v1/audio/speech）。请在网关中启用 TTS 路由，或填写实际的 TTS 服务地址。')
    throw lastError || new Error('云端配音接口没有可用的语音路径。')
  }
  async analyze(job, signal) {
    const folder = path.join(this.root, job.id)
    const extracted = path.join(folder, 'source.wav')
    const speech = path.join(folder, 'speech.wav')
    const background = path.join(folder, 'background.wav')
    if (!job.extracted) {
      await this.phase(job, 'extracting', '提取所选裁剪区间')
      await this.media(['-ss', String(job.source.trimStart), '-i', job.source.path, '-t', String(job.source.duration), '-vn', '-map', '0:a:0', '-ac', '2', '-ar', '44100', extracted], signal)
      const actual = await this.duration(extracted, signal)
      if (Math.abs(actual - job.source.duration) > 0.05) throw new Error('原声音轨不足以覆盖所选区间，请改选具体音频片段。')
      job.extracted = true; await this.save(job)
    }
    if (!job.backgroundPath) {
      await this.phase(job, 'separating', '本地分离对白、音乐与环境声 · CPU')
      await this.worker('separate', extracted, folder, signal)
      await this.media(['-i', path.join(folder, 'background-raw.wav'), '-af', `aresample=48000,apad,atrim=duration=${job.source.duration}`, '-c:a', 'pcm_s16le', background], signal)
      job.backgroundPath = background; await this.save(job)
    }
    if (!job.cues.length) {
      await this.phase(job, 'recognizing', '本地识别英文对白 · Whisper small.en')
      const asr = path.join(folder, 'asr.wav')
      await this.media(['-i', speech, '-ar', '16000', '-ac', '1', asr], signal)
      await this.worker('transcribe', asr, folder, signal)
      job.cues = normalizedCues(JSON.parse(await fs.readFile(path.join(folder, 'transcript.json'), 'utf8')), job.source.duration)
      if (!job.cues.length) throw new Error('未识别到有效英文对白，请试听原音或选择其他片段。')
      await this.save(job)
    }
    for (const cue of job.cues) cue.prosody = cue.prosody || analyzeProsody(cue.translation || cue.text, job.style)
    await this.translate(job, signal)
  }
  async analyzeCloud(job, signal) {
    const folder = path.join(this.root, job.id)
    const extracted = path.join(folder, 'source.wav')
    const speech = path.join(folder, 'speech.wav')
    const background = path.join(folder, 'background.wav')
    if (!job.extracted) {
      await this.phase(job, 'extracting', '准备云端识别音频')
      await this.media(['-ss', String(job.source.trimStart), '-i', job.source.path, '-t', String(job.source.duration), '-vn', '-map', '0:a:0', '-ac', '2', '-ar', '44100', extracted], signal)
      job.extracted = true; await this.save(job)
    }
    if (!job.backgroundPath) {
      await this.phase(job, 'separating', '准备背景音 · 云端全流程')
      // A pure cloud setup may not have the local separation model. Keep the
      // extracted source as the background fallback; a configured local
      // separator can still be used by the local workflow.
      await this.media(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(job.source.duration), '-c:a', 'pcm_s16le', background], signal)
      job.backgroundPath = background; await this.save(job)
    }
    await this.media(['-i', extracted, '-ar', '16000', '-ac', '1', speech], signal)
    await this.phase(job, 'recognizing', '云端语音识别')
    const transcript = await this.cloudTranscribe(speech, signal)
    await this.phase(job, 'translating', `云端翻译与韵律规划 · ${((await this.ttsNetwork.read()).plannerModel) || 'Sol/Luna'}`)
    const planned = await this.cloudPlan(transcript, job.source.duration, signal)
    const plannedRows = planned.map((cue) => ({ plan: cue, start: cue.start, end: cue.end, text: cue.text || cue.sourceText })).filter((row) => row.text)
    job.cues = normalizedCues(plannedRows, job.source.duration)
      .map((cue, index) => {
        const plan = plannedRows[index]?.plan || {}
        const translation = String(plan.translation || '').trim()
        if (!translation) throw new Error('云端规划未返回有效中文译文。')
        const prosody = analyzeProsody(translation, { emotion: plan.emotion || job.style.emotion, rate: Number(plan.rate) || job.style.rate, pause: plan.pause || job.style.pause })
        return { ...cue, translation, prosody, status: 'draft', audioPath: null }
      })
    if (!job.cues.length) throw new Error('云端未识别到有效对白。')
    job.status = 'review'; job.stage = '云端规划完成，准备生成语音'; job.percent = 100; job.error = null; await this.save(job)
  }
  async translate(job, signal) {
    const folder = path.join(this.root, job.id)
    await this.phase(job, 'translating', '本地翻译中文 · Qwen3 4B')
    for (let index = 0; index < job.cues.length; index += 1) {
      const cue = job.cues[index]; if (cue.translation) continue
      job.stage = `本地翻译中文 · Qwen3 4B · ${index + 1}/${job.cues.length}`; await this.save(job)
      const promptPath = path.join(folder, 'translation-prompt.txt')
      await fs.writeFile(promptPath, translationPrompt(job.cues, index))
      const output = await run(this.models.llama, [...(this.models.llamaArgs || []), ...translationArguments(this.models.directory, promptPath)], { signal, timeout: 5 * 60_000 })
      await fs.writeFile(path.join(folder, 'translation-output.txt'), output)
      cue.translation = parseTranslation(output)
      cue.prosody = analyzeProsody(cue.translation, job.style)
      job.percent = (index + 1) / job.cues.length * 100; await this.save(job)
    }
    job.status = 'review'; job.stage = '请校对中文译文后生成配音'; job.percent = 100; job.error = null
  }
  async generate(job, signal, cueId) {
    const folder = path.join(this.root, job.id)
    const generationStage = job.backend === 'openai-compatible' || job.backend === 'openai-cloud'
      ? '云端生成中文配音 · OpenAI 兼容接口'
      : job.backend === 'kokoro-fast'
        ? '本地生成中文配音 · Kokoro v1.1-zh'
        : '本地生成中文配音 · 韵律增强'
    await this.phase(job, 'generating', generationStage)
    const cues = job.cues.filter((cue) => cueId ? cue.id === cueId : cue.status !== 'ready')
    const input = path.join(folder, 'tts-input.json'); await fs.writeFile(input, JSON.stringify(cues))
    if (cues.length && job.backend !== 'openai-compatible' && job.backend !== 'openai-cloud') await this.worker('tts', input, folder, signal, job.voice)
    for (const cue of cues) {
      const natural = path.join(folder, `${cue.id}-natural.wav`)
      if (job.backend === 'openai-compatible' || job.backend === 'openai-cloud') await this.cloudTts(cue.translation, natural, signal, cue.prosody || {})
      cue.naturalDuration = await this.duration(natural, signal)
      const { speed, fits } = timing(cue.naturalDuration, cue.end - cue.start)
      cue.speed = speed; cue.audioPath = null
      if (!fits) { cue.status = 'too-long'; await this.save(job); continue }
      const output = path.join(folder, `${cue.id}-${crypto.randomUUID()}.wav`)
      await this.media(['-i', natural, '-af', `atempo=${speed},aresample=48000,apad,atrim=duration=${cue.end - cue.start}`, '-ac', '2', '-c:a', 'pcm_s16le', output], signal)
      cue.audioPath = output; cue.status = 'ready'; await this.save(job)
    }
    if (job.cues.every((cue) => cue.status === 'ready')) {
      const output = path.join(folder, `mix-${crypto.randomUUID()}.wav`)
      const args = ['-i', job.backgroundPath, ...job.cues.flatMap((cue) => ['-i', cue.audioPath])]
      const filters = job.cues.map((cue, index) => `[${index + 1}:a]adelay=${Math.round(cue.start * 1000)}:all=1[a${index}]`)
      filters.push(`[0:a]${job.cues.map((_, index) => `[a${index}]`).join('')}amix=inputs=${job.cues.length + 1}:duration=longest:normalize=0,aresample=48000,alimiter=limit=0.98:latency=1,apad,atrim=duration=${job.source.duration}[mix]`)
      await this.media([...args, '-filter_complex', filters.join(';'), '-map', '[mix]', '-c:a', 'pcm_s16le', output], signal)
      job.mixPath = output; job.status = 'ready'; job.stage = '试听确认后入轨'
    } else {
      const tooLong = job.cues.filter((cue) => cue.status === 'too-long')
      const pending = job.cues.filter((cue) => cue.status !== 'ready' && cue.status !== 'too-long')
      job.status = 'review'
      if (tooLong.length) {
        job.stage = `${tooLong.length} 句配音超过原句时长上限，请缩短译文或减弱停顿后重试`
      } else if (pending.length) {
        job.stage = `还有 ${pending.length} 句尚未生成，请逐句生成后再试听`
      } else {
        job.stage = '配音未完成，请检查当前句后重试'
      }
    }
  }
}
module.exports = { DubbingManager, timing, normalizedCues, activeStatuses, prosodyInstructions }
