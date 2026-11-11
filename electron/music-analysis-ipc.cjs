const path = require('node:path')

function registerMusicAnalysisIpc({ ipcMain, service, authorize }) {
  const handle = (name, operation) => ipcMain.handle(`videome:music-${name}`, async (_event, payload) => {
    try { return { ok: true, value: await operation(payload) } }
    catch (error) { return { ok: false, reason: error.message } }
  })

  handle('status', async () => (await service).status())
  handle('analyze-assets', async (payload = {}) => {
    const paths = []
    for (const rawPath of Array.isArray(payload.paths) ? payload.paths : []) {
      const resolved = await authorize(rawPath)
      if (resolved) paths.push(path.resolve(resolved))
    }
    return (await service).enqueueAssets(paths)
  })
  handle('analyze-video', async (payload = {}) => {
    const videos = []
    for (const item of Array.isArray(payload.videos) ? payload.videos : []) {
      const resolved = await authorize(item?.path)
      if (resolved) videos.push({ ...item, path: path.resolve(resolved) })
    }
    const manager = await service
    return manager.analyzeVideo({ ...payload, videos })
  })
  handle('cancel-analysis', async () => (await service).cancel())
}

module.exports = { registerMusicAnalysisIpc }
