const path = require('node:path')

function registerBatchSegmentIpc({ ipcMain, app, dialog, shell, manager, authorize }) {
  const handle = (channel, operation) => ipcMain.handle(`videome:segment-${channel}`, async (_event, payload) => {
    try { return await operation(await manager, payload) }
    catch (error) { return { ok: false, reason: error.message } }
  })
  handle('pick-directory', async () => {
    const selection = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('videos') })
    return selection.canceled ? null : { path: selection.filePaths[0] }
  })
  handle('create', async (service, payload) => {
    const sourcePath = await authorize(payload?.sourcePath)
    if (!sourcePath) throw new Error('源视频不存在或无法读取。')
    return { ok: true, ...await service.create({ ...payload, sourcePath }) }
  })
  handle('get', (service, id) => service.get(id))
  handle('list', (service) => service.list())
  handle('start', (service, id) => service.start(id))
  handle('pause', (service, id) => service.pause(id))
  handle('cancel', (service, id) => service.cancel(id))
  handle('remove', (service, id) => service.remove(id))
  handle('open-directory', async (service, id) => {
    const job = await service.get(id)
    const error = await shell.openPath(job.outputDirectory)
    if (error) throw new Error(error)
    return { ok: true }
  })
}

module.exports = { registerBatchSegmentIpc }
