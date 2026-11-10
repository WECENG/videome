function registerDubbingIpc({ ipcMain, service, models, whisper, authorize, hasAudioTrack }) {
  const handle = (name, operation) => ipcMain.handle(`videome:dubbing-${name}`, async (_event, payload) => {
    try { return { ok: true, value: await operation(payload) } }
    catch (error) { return { ok: false, reason: error.message } }
  })
  handle('models', () => models.then((value) => value.status()))
  handle('network', async () => (await models).networkSettings())
  handle('save-network', async (settings) => (await models).saveNetworkSettings(settings))
  handle('test-network', async () => (await models).testNetwork())
  handle('install', async () => {
    const model = await models
    void model.install().catch(() => {})
    return model.status()
  })
  handle('cancel-install', async () => { const model = await models; model.cancel(); return model.status() })
  handle('list', async (projectId) => (await service).list(projectId))
  handle('get', async (id) => (await service).get(id))
  handle('remove', async (payload) => (await service).remove(payload))
  handle('clear', async (projectId) => (await service).clear(projectId))
  handle('create', async (payload) => {
    if (!await authorize(payload?.source?.path)) throw new Error('源文件不可读取。')
    return (await service).create(payload)
  })
  handle('update', async (payload) => (await service).update(payload))
  handle('start', async ({ id, action, cueId }) => (await service).start(id, action, cueId))
  handle('cancel', async (id) => (await service).cancel(id))
  handle('tts-settings', async () => (await service).ttsSettings())
  handle('save-tts-settings', async (settings) => (await service).saveTtsSettings(settings))
  handle('test-tts-settings', async (settings) => (await service).testTtsSettings(settings))
  handle('whisper-status', async () => (await whisper).status())
  handle('whisper-install', async () => { const manager = await whisper; void manager.install().catch(() => {}); return manager.status() })
  handle('whisper-cancel-install', async () => { const manager = await whisper; manager.cancelInstall(); return manager.status() })
  handle('whisper-cancel-recognition', async () => { const manager = await whisper; manager.cancelRecognition(); return manager.status() })
  handle('whisper-recognize', async ({ source }) => {
    const manager = await whisper
    const sourcePath = await authorize(source?.path)
    if (!sourcePath) throw new Error('源文件不可读取，请重新选择媒体素材。')
    if (hasAudioTrack && !await hasAudioTrack(sourcePath)) throw new Error('所选素材没有可读取的音轨。')
    return manager.recognize({ ...source, path: sourcePath })
  })
}
module.exports = { registerDubbingIpc }
