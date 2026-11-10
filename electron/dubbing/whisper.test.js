import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { DubbingModels } = require('./models.cjs')
const { WhisperManager, requirementsForWhisper, hasAudiblePcmWav } = require('./whisper.cjs')

let temporaryRoots = []
const makeRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-whisper-test-'))
  temporaryRoots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
  temporaryRoots = []
})

describe('independent multilingual Whisper service', () => {
  it('selects only Whisper dependencies from the shared hash lock', async () => {
    const source = await fs.readFile(path.join(__dirname, '../../resources/dubbing/requirements.lock'), 'utf8')
    const requirements = requirementsForWhisper(source)
    expect([...requirements.matchAll(/^([\w.-]+)==/gm)].map((match) => match[1])).toEqual([
      'certifi', 'charset-normalizer', 'idna', 'numpy', 'platformdirs', 'pywhispercpp', 'requests', 'tqdm', 'urllib3',
    ])
    expect(requirements).not.toContain('torch==')
    expect(requirements).not.toContain('sherpa-onnx==')
  })

  it('reports missing and corrupted multilingual model separately from the dubbing model set', async () => {
    const root = await makeRoot()
    const resources = path.resolve(__dirname, '../../resources/dubbing')
    const models = new DubbingModels({ root, resources })
    const whisper = new WhisperManager({ root, resources, models,
      checkDependencies: async () => true,
      checkPythonRuntime: async () => fs.access(models.python).then(() => true).catch(() => false),
    })
    expect(await whisper.status()).toMatchObject({ supported: true, ready: false, modelReady: false, runtimeReady: false })
    await fs.mkdir(models.directory, { recursive: true })
    await fs.mkdir(path.dirname(whisper.python), { recursive: true })
    await fs.writeFile(whisper.python, 'python')
    await fs.writeFile(whisper.model, Buffer.alloc(models.manifest.subtitleWhisper.size))
    await fs.writeFile(whisper.marker, JSON.stringify({ version: models.manifest.version, modelSha256: models.manifest.subtitleWhisper.sha256, pythonRuntimeSha256: whisper.runtimeAsset.sha256 }))
    whisper.hashFile = async () => models.manifest.subtitleWhisper.sha256
    expect(await whisper.refreshStatus()).toMatchObject({ ready: true, modelReady: true, runtimeReady: true, dependenciesReady: true })
    whisper.hashFile = async () => 'invalid'
    expect(await whisper.refreshStatus()).toMatchObject({ ready: false, modelReady: false, runtimeReady: true })
  })

  it('installs only the multilingual asset and Python runtime when needed with visible progress and verification', async () => {
    const root = await makeRoot()
    const resources = path.resolve(__dirname, '../../resources/dubbing')
    const models = new DubbingModels({ root, resources })
    const events = []
    const downloaded = []
    let installedRequirements = ''
    let pythonReady = false
    const whisper = new WhisperManager({ root, resources, models, checkPythonRuntime: async () => pythonReady, checkDependencies: async () => installedRequirements === 'installed',
      hashFile: async () => models.manifest.subtitleWhisper.sha256,
      downloadAsset: async (asset, target, { progress }) => {
        downloaded.push(asset.id)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, asset.id === 'python' ? 'python archive' : Buffer.alloc(asset.size))
        progress({ loaded: asset.size, total: asset.size })
      },
      runProcess: async (binary, args) => {
        if (args.includes('-m') && args.includes('pip')) installedRequirements = 'installed'
        if (args.at(-1) && String(args.at(-1)).endsWith('small.bin')) await fs.writeFile(whisper.marker, JSON.stringify({ version: models.manifest.version, modelSha256: models.manifest.subtitleWhisper.sha256, pythonRuntimeSha256: whisper.runtimeAsset.sha256 }))
        if (binary === '/usr/bin/tar') {
          await fs.mkdir(path.dirname(models.python), { recursive: true }).then(() => fs.writeFile(models.python, 'python'))
          pythonReady = true
        }
        return ''
      },
    })
    whisper.on('progress', (state) => events.push(state))
    whisper.dependenciesReady = async () => installedRequirements === 'installed'
    whisper.installDependencies = async () => { installedRequirements = 'installed' }
    await fs.mkdir(root, { recursive: true })
    whisper.performInstall = whisper.performInstall.bind(whisper)
    const result = await whisper.install()
    expect(downloaded).toEqual(['python', 'whisper-multilingual'])
    expect(result).toMatchObject({ installing: false })
    expect(whisper.state).toMatchObject({ ready: true, modelReady: true, runtimeReady: true, dependenciesReady: true })
    expect(events.some((event) => event.installing && event.totalBytes > 0 && event.stage === 'Whisper small 多语言（字幕识别）')).toBe(true)
    expect(events.at(-1)).toMatchObject({ ready: true, stage: '多语言 Whisper 已就绪，可离线识别' })
  })

  it('keeps proxy credentials redacted in installation progress errors', async () => {
    const root = await makeRoot()
    const resources = path.resolve(__dirname, '../../resources/dubbing')
    const models = new DubbingModels({ root, resources })
    const secret = 'private-proxy-pass'
    models.network.read = async () => ({ mode: 'manual', url: 'http://127.0.0.1:7890', username: 'proxy-user', password: secret })
    const whisper = new WhisperManager({ root, resources, models, checkPythonRuntime: async () => false,
      downloadAsset: async () => { throw new Error(`connect http://proxy-user:${secret}@127.0.0.1:7890 failed`) },
    })
    const installation = whisper.install()
    await expect(installation).rejects.toThrow('***')
    expect(whisper.state.error).not.toContain(secret)
    expect(whisper.state.error).not.toContain('proxy-user')
  })

  it('reuses a working private Python runtime without downloading the dubbing model bundle', async () => {
    const root = await makeRoot()
    const resources = path.resolve(__dirname, '../../resources/dubbing')
    const models = new DubbingModels({ root, resources })
    const downloaded = []
    const whisper = new WhisperManager({ root, resources, models, checkPythonRuntime: async () => true, checkDependencies: async () => false,
      hashFile: async () => models.manifest.subtitleWhisper.sha256,
      downloadAsset: async (asset, target) => {
        downloaded.push(asset.id)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, Buffer.alloc(asset.size))
      },
      runProcess: async (binary, args) => {
        if (args.at(-1) && String(args.at(-1)).endsWith('small.bin')) await fs.writeFile(whisper.marker, JSON.stringify({ version: models.manifest.version, modelSha256: models.manifest.subtitleWhisper.sha256, pythonRuntimeSha256: whisper.runtimeAsset.sha256 }))
        return ''
      },
    })
    let dependenciesReady = false
    whisper.dependenciesReady = async () => dependenciesReady
    whisper.installDependencies = async () => { dependenciesReady = true }
    await fs.mkdir(models.directory, { recursive: true })
    await fs.mkdir(path.dirname(whisper.python), { recursive: true })
    await fs.writeFile(whisper.python, 'python')
    await whisper.install()
    expect(downloaded).toEqual(['whisper-multilingual'])
    expect(whisper.state).toMatchObject({ ready: true, modelReady: true, runtimeReady: true, dependenciesReady: true })
  })

  it('recognizes only the selected trim, publishes progress, returns cues and cleans temporary audio', async () => {
    const root = await makeRoot()
    const resources = path.resolve(__dirname, '../../resources/dubbing')
    const models = new DubbingModels({ root, resources })
    const runCalls = []
    const whisper = new WhisperManager({ root, resources, models, checkDependencies: async () => true, checkPythonRuntime: async () => true,
      runProcess: async (binary, args, options) => {
        runCalls.push({ binary, args, options })
        if (binary === '/media/ffmpeg') {
          const output = args.at(-1)
          const audio = Buffer.alloc(8)
          audio.writeInt16LE(18, 0); audio.writeInt16LE(-9, 2)
          const header = Buffer.alloc(44)
          header.write('RIFF', 0); header.writeUInt32LE(36 + audio.length, 4); header.write('WAVE', 8)
          header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
          header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
          header.write('data', 36); header.writeUInt32LE(audio.length, 40)
          await fs.writeFile(output, Buffer.concat([header, audio]))
        }
        if (args[0]?.includes('worker.py')) {
          options.onOutput('{"progress": 60}\n')
          await fs.writeFile(path.join(args[args.indexOf('--output') + 1], 'transcript.json'), JSON.stringify([
            { id: 'cue-0', start: 0.5, end: 1.5, text: '你好', translation: '', status: 'draft' },
          ]))
        }
        return ''
      },
    })
    whisper.ffmpeg = '/media/ffmpeg'
    const events = []
    whisper.on('progress', (state) => events.push(state))
    await fs.mkdir(models.directory, { recursive: true })
    await fs.mkdir(path.dirname(whisper.python), { recursive: true })
    await fs.writeFile(whisper.python, 'python')
    await fs.writeFile(whisper.model, Buffer.alloc(models.manifest.subtitleWhisper.size))
    await fs.writeFile(whisper.marker, JSON.stringify({ version: models.manifest.version, modelSha256: models.manifest.subtitleWhisper.sha256, pythonRuntimeSha256: whisper.runtimeAsset.sha256 }))
    whisper.hashFile = async () => models.manifest.subtitleWhisper.sha256
    whisper.initialized = whisper.refreshStatus()
    await whisper.initialized
    expect(whisper.state).toMatchObject({ ready: true, modelReady: true, runtimeReady: true, dependenciesReady: true })
    const result = await whisper.recognize({ path: '/source/clip.mp4', trimStart: 3, duration: 8 })
    expect(result).toMatchObject([{ start: 0.5, end: 1.5, text: '你好' }])
    expect(runCalls[0].args).toContain('-ss')
    expect(runCalls[0].args[runCalls[0].args.indexOf('-ss') + 1]).toBe('3')
    expect(runCalls[0].args[runCalls[0].args.indexOf('-t') + 1]).toBe('8')
    expect(runCalls[1].args).toContain('--multilingual')
    expect(events.some((event) => event.recognitionProgress === 60)).toBe(true)
    expect(events.at(-1)).toMatchObject({ recognizing: false, ready: true })
    const transcriptionRoot = path.join(root, 'transcription')
    expect(await fs.readdir(transcriptionRoot)).toEqual([])
  })

  it('rejects recognition until the model and inference dependency are ready', async () => {
    const root = await makeRoot()
    const resources = path.resolve(__dirname, '../../resources/dubbing')
    const models = new DubbingModels({ root, resources })
    const whisper = new WhisperManager({ root, resources, models, checkDependencies: async () => false, checkPythonRuntime: async () => false })
    whisper.initialized = whisper.refreshStatus()
    await expect(whisper.recognize({ path: '/source.wav', duration: 1 })).rejects.toThrow('请先在字幕面板安装')
  })

  it('distinguishes audible, silent, malformed and empty converted WAV audio', async () => {
    const root = await makeRoot()
    const wav = path.join(root, 'sample.wav')
    const writeWav = async (samples) => {
      const data = Buffer.alloc(samples.length * 2)
      samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2))
      const header = Buffer.alloc(44)
      header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
      header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
      header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
      header.write('data', 36); header.writeUInt32LE(data.length, 40)
      await fs.writeFile(wav, Buffer.concat([header, data]))
    }
    await writeWav([0, 0, 0, 0])
    expect(await hasAudiblePcmWav(wav)).toBe(false)
    await writeWav([0, 18, -9, 0])
    expect(await hasAudiblePcmWav(wav)).toBe(true)
    await fs.writeFile(wav, Buffer.alloc(5))
    await expect(hasAudiblePcmWav(wav)).rejects.toThrow('无效')
    await writeWav([])
    await expect(hasAudiblePcmWav(wav)).rejects.toThrow('没有可读取的音频数据')
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(hasAudiblePcmWav(wav, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
