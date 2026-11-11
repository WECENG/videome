const path = require('node:path')
const fs = require('node:fs/promises')
const { buildRepresentativeProject } = require('./planning.cjs')
const { writeProjectSnapshot } = require('../project.cjs')

function registerBatchMixIpc({ ipcMain, app, dialog, shell, manager, authorize, openProjectPath }) {
  const handle = (channel, operation) => ipcMain.handle(`videome:batch-${channel}`, async (_event, payload) => {
    try { return await operation(await manager, payload) }
    catch (error) { return { ok: false, reason: error.message } }
  })
  handle('pick-directory', async () => {
    const selection = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('videos') })
    return selection.canceled ? null : { path: selection.filePaths[0] }
  })
  handle('analyze', async (service, payload) => {
    const sourcePath = await authorize(payload?.sourcePath)
    if (!sourcePath) throw new Error('源视频不存在或无法读取。')
    let backgroundAudio = payload?.backgroundAudio
    if (backgroundAudio?.path) {
      const backgroundPath = await authorize(backgroundAudio.path)
      if (!backgroundPath) throw new Error('背景音乐不存在或无法读取。')
      backgroundAudio = { ...backgroundAudio, path: backgroundPath }
    }
    return { ok: true, ...await service.create({ ...payload, sourcePath, backgroundAudio }) }
  })
  handle('probe-audio', async (service, rawPath) => {
    const audioPath = await authorize(rawPath)
    if (!audioPath) throw new Error('背景音乐不存在或无法读取。')
    const metadata = await service.engine.probe(service.ffprobe, audioPath)
    const stream = metadata.streams?.find((item) => item.codec_type === 'audio')
    if (!stream) throw new Error('所选文件没有可用的音频流。')
    const rate = (value) => { const [numerator, denominator = 1] = String(value || '0').split('/').map(Number); return denominator ? numerator / denominator : 0 }
    const duration = Number(stream.duration) || Number(stream.duration_ts) * rate(stream.time_base) || Number(metadata.format?.duration)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取背景音乐时长。')
    const fingerprint = await service.engine.fingerprint(audioPath)
    return { ok: true, path: audioPath, name: path.basename(audioPath), duration, codec: stream.codec_name, sampleRate: Number(stream.sample_rate) || null, channels: Number(stream.channels) || null, ...fingerprint }
  })
  handle('get', (service, id) => service.get(id))
  handle('list', (service) => service.list())
  handle('start', (service, id) => service.start(id))
  handle('pause', (service, id) => service.pause(id))
  handle('resume', async (service, payload) => {
    let backgroundAudioPath = payload?.backgroundAudioPath
    if (backgroundAudioPath) backgroundAudioPath = await authorize(backgroundAudioPath)
    return service.resume(payload.jobId, { sourcePath: payload.sourcePath, backgroundAudioPath })
  })
  handle('retry', (service, id) => service.resume(id, { failedOnly: true }))
  handle('cancel', (service, id) => service.cancel(id))
  handle('remove', (service, id) => service.remove(id))
  handle('clear-cache', (service) => service.clearCache())
  handle('open-directory', async (service, id) => {
    const job = await service.get(id)
    const error = await shell.openPath(job.outputDirectory)
    if (error) throw new Error(error)
    return { ok: true }
  })
  handle('create-project', async (service, { jobId, index, currentProject }) => {
    const job = service.requireJob(jobId)
    const item = job.items.find((entry) => entry.index === index && entry.status === 'completed')
    if (!item) throw new Error('请选择已完成的输出。')
    const fingerprint = await service.engine.fingerprint(job.source.path)
    if (fingerprint.sha256 !== job.source.sha256) throw new Error('源视频已变化，无法创建原始切片工程。')
    const project = buildRepresentativeProject(job, item)
    const recoveryDirectory = path.join(app.getPath('userData'), 'batch-project-recovery')
    await fs.mkdir(recoveryDirectory, { recursive: true })
    const recoveryPath = path.join(recoveryDirectory, `${Date.now()}-${jobId}.videome`)
    if (currentProject) await writeProjectSnapshot(recoveryPath, currentProject)
    project.name = `${project.name}-${Date.now()}`
    const projectPath = path.join(job.outputDirectory, `${project.name}.videome`)
    const exclusive = await fs.open(projectPath, 'wx')
    await exclusive.close()
    await writeProjectSnapshot(projectPath, project)
    const opened = await openProjectPath(projectPath)
    if (!opened) throw new Error('代表工程创建后无法打开。')
    return { ok: true, ...opened, recoveryPath }
  })
}

module.exports = { registerBatchMixIpc }
