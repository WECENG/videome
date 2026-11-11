import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const testPython = ['python3', 'python'].find((binary) => spawnSync(binary, ['-c', 'import sys; sys.exit(sys.version_info < (3, 9))'], { stdio: 'ignore' }).status === 0)
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
          options.onOutput('whisper: loading model\n{"progress": 6')
          options.onOutput('0, "stage": "正在识别整段音频"}\n{"progress": 99}')
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
    expect(events.some((event) => event.recognitionProgress === 60 && event.stage === '正在识别整段音频')).toBe(true)
    expect(events.some((event) => event.recognitionProgress === 99)).toBe(true)
    expect(events.at(-1)).toMatchObject({ recognizing: false, ready: true })
    const transcriptionRoot = path.join(root, 'transcription')
    expect(await fs.readdir(transcriptionRoot)).toEqual([])
  })

  it.skipIf(!testPython).each([
    { multilingual: true, amplitude: 0.1, language: 'zh' },
    { multilingual: true, amplitude: 0.00001, language: 'zh' },
    { multilingual: true, amplitude: 0, language: 'auto' },
    { multilingual: false, amplitude: 0.1, language: 'en' },
  ])('decodes the entire recording once with multilingual=$multilingual and amplitude=$amplitude', async ({ multilingual, amplitude, language }) => {
    const root = await makeRoot()
    // Exercise the actual worker entry point without installing inference packages.
    // Only the numpy operations used for language sampling and the model are faked.
    const harness = `
import math, runpy, sys, types
worker, output, multilingual, amplitude, language = sys.argv[1:]
multilingual = multilingual == "true"
amplitude = float(amplitude)
class Audio(list):
    @property
    def size(self): return len(self)
    def __getitem__(self, key):
        value = super().__getitem__(key)
        return Audio(value) if isinstance(key, slice) else value
audio = Audio([0.0] * (48 * 16000))
audio[35 * 16000:38 * 16000] = [amplitude] * (3 * 16000)
numpy = types.ModuleType("numpy")
numpy.float64 = float
numpy.sqrt = math.sqrt
numpy.square = lambda values, **kwargs: [value * value for value in values]
numpy.mean = lambda values: sum(values) / len(values)
numpy.pad = lambda values, padding: Audio([0.0] * padding[0] + list(values) + [0.0] * padding[1])
sys.modules["numpy"] = numpy
calls, probes = [], []
class Model:
    def __init__(self, *args, **kwargs): pass
    def _load_audio(self, path): return audio
    def auto_detect_language(self, window, **kwargs):
        assert window.size <= 6 * 16000
        assert any(window)
        probes.append(window.size)
        return (("zh", 0.9), {"zh": 0.9, "en": 0.1})
    def transcribe(self, full_audio, **params):
        assert full_audio is audio, "transcription must receive the complete audio"
        assert params["language"] == language
        calls.append(params)
        # Match whisper.cpp: detect_language=True returns without decoding.
        if params["detect_language"]: return []
        segments = [types.SimpleNamespace(t0=3500, t1=3800, text=" 后半段对白 ")] if amplitude else []
        for segment in segments: params["new_segment_callback"](segment)
        return segments
package = types.ModuleType("pywhispercpp")
module = types.ModuleType("pywhispercpp.model")
module.Model = Model
sys.modules["pywhispercpp"] = package
sys.modules["pywhispercpp.model"] = module
sys.argv = [worker, "transcribe", "--models", output, "--input", "sparse.wav", "--output", output, "--duration", "48"]
if multilingual: sys.argv += ["--multilingual", "--model", "small.bin"]
runpy.run_path(worker, run_name="__main__")
assert len(calls) == 1
assert bool(probes) == (multilingual and amplitude > 0)
`
    const { stdout } = await execute(testPython, ['-c', harness, path.resolve(__dirname, '../../resources/dubbing/worker.py'), root, String(multilingual), String(amplitude), language])
    const transcript = JSON.parse(await fs.readFile(path.join(root, 'transcript.json'), 'utf8'))
    expect(transcript).toEqual(amplitude ? [{ id: 'cue-0', start: 35, end: 38, text: '后半段对白', translation: '', status: 'draft' }] : [])
    const progress = stdout.trim().split('\n').map((line) => JSON.parse(line).progress)
    expect(progress.at(-1)).toBe(100)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  })

  it('rejects recognition until the model and inference dependency are ready', async () => {
    const root = await makeRoot()
    const resources = path.resolve(__dirname, '../../resources/dubbing')
    const models = new DubbingModels({ root, resources })
    const whisper = new WhisperManager({ root, resources, models, checkDependencies: async () => false, checkPythonRuntime: async () => false })
    whisper.initialized = whisper.refreshStatus()
    await expect(whisper.recognize({ path: '/source.wav', duration: 1 })).rejects.toThrow('请先在字幕面板安装')
  })

  it.each([
    { output: '[]', error: '已完整识别所选片段' },
    { output: '{}', error: '返回了无效的字幕结果' },
  ])('cleans up after a worker result of $output', async ({ output, error }) => {
    const root = await makeRoot()
    const resources = path.resolve(__dirname, '../../resources/dubbing')
    const models = new DubbingModels({ root, resources })
    const gate = { owner: null, acquire(owner) { if (this.owner) return false; this.owner = owner; return true }, release(owner) { if (this.owner === owner) this.owner = null } }
    const whisper = new WhisperManager({ root, resources, models, ffmpeg: '/media/ffmpeg', gate,
      checkDependencies: async () => true, checkPythonRuntime: async () => true,
      runProcess: async (binary, args) => {
        if (binary === '/media/ffmpeg') {
          const wav = Buffer.alloc(44 + 8)
          wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8)
          wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
          wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
          wav.write('data', 36); wav.writeUInt32LE(8, 40); wav.writeInt16LE(10, 44)
          await fs.writeFile(args.at(-1), wav)
        }
        if (args[0]?.includes('worker.py')) await fs.writeFile(path.join(args[args.indexOf('--output') + 1], 'transcript.json'), output)
        return ''
      },
    })
    await fs.mkdir(models.directory, { recursive: true })
    await fs.mkdir(path.dirname(whisper.python), { recursive: true })
    await fs.writeFile(whisper.python, 'python')
    await fs.writeFile(whisper.model, Buffer.alloc(models.manifest.subtitleWhisper.size))
    await fs.writeFile(whisper.marker, JSON.stringify({ version: models.manifest.version, modelSha256: models.manifest.subtitleWhisper.sha256, pythonRuntimeSha256: whisper.runtimeAsset.sha256 }))
    whisper.hashFile = async () => models.manifest.subtitleWhisper.sha256
    whisper.initialized = whisper.refreshStatus()
    await whisper.initialized
    await expect(whisper.recognize({ path: '/source.wav', duration: 4 })).rejects.toThrow(error)
    expect(gate.owner).toBeNull()
    expect(await fs.readdir(path.join(root, 'transcription'))).toEqual([])
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
