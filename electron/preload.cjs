const { contextBridge, ipcRenderer } = require('electron')

const openProjectListeners = new Set()
const pendingOpenProjects = []

ipcRenderer.on('videome:open-project-file', (_event, payload) => {
  if (!openProjectListeners.size) {
    pendingOpenProjects.push(payload)
    return
  }
  openProjectListeners.forEach((listener) => listener(payload))
})

contextBridge.exposeInMainWorld('videome', {
  getMediaTools: () => ipcRenderer.invoke('videome:media-tools'),
  pickMedia: (extensions) => ipcRenderer.invoke('videome:pick-media', extensions),
  pickAudio: () => ipcRenderer.invoke('videome:pick-audio'),
  pickSubtitles: () => ipcRenderer.invoke('videome:pick-srt'),
  saveText: (payload) => ipcRenderer.invoke('videome:save-strings', payload),
  probeMedia: (paths, options) => ipcRenderer.invoke('videome:probe-media', paths, options),
  requestMedia: (paths) => ipcRenderer.invoke('videome:request-media', paths),
  createPreviewProxy: (sourcePath) => ipcRenderer.invoke('videome:create-preview-proxy', sourcePath),
  generatePreviewFrames: (paths) => ipcRenderer.invoke('videome:emit-preview-frames', paths),
  exportFrame: (payload) => ipcRenderer.invoke('videome:export-frame', payload),
  openProject: () => ipcRenderer.invoke('videome:open-project'),
  saveProject: (payload) => ipcRenderer.invoke('videome:save-project', payload),
  saveProjectFile: (payload) => ipcRenderer.invoke('videome:write-project', payload),
  backupProject: (payload) => ipcRenderer.invoke('videome:backup-project', payload),
  chooseProjectLocation: (payload) => ipcRenderer.invoke('videome:choose-project-location', payload),
  getStorageLocations: () => ipcRenderer.invoke('videome:storage-locations'),
  showProjectInFolder: (filePath) => ipcRenderer.invoke('videome:show-project-in-folder', filePath),
  exportMedia: (payload) => ipcRenderer.invoke('videome:export', payload),
  cancelExport: () => ipcRenderer.invoke('videome:cancel-export'),
  openPreview: (asset) => ipcRenderer.invoke('videome:open-preview', asset),
  pickBatchOutputDirectory: () => ipcRenderer.invoke('videome:batch-pick-directory'),
  createBatchMixAnalysis: (payload) => ipcRenderer.invoke('videome:batch-analyze', payload),
  getBatchMixJob: (id) => ipcRenderer.invoke('videome:batch-get', id),
  listBatchMixJobs: () => ipcRenderer.invoke('videome:batch-list'),
  startBatchMix: (id) => ipcRenderer.invoke('videome:batch-start', id),
  pauseBatchMix: (id) => ipcRenderer.invoke('videome:batch-pause', id),
  resumeBatchMix: (payload) => ipcRenderer.invoke('videome:batch-resume', payload),
  retryBatchMix: (id) => ipcRenderer.invoke('videome:batch-retry', id),
  cancelBatchMix: (id) => ipcRenderer.invoke('videome:batch-cancel', id),
  removeBatchMix: (id) => ipcRenderer.invoke('videome:batch-remove', id),
  clearBatchMixCache: () => ipcRenderer.invoke('videome:batch-clear-cache'),
  openBatchDirectory: (id) => ipcRenderer.invoke('videome:batch-open-directory', id),
  createBatchMixProject: (payload) => ipcRenderer.invoke('videome:batch-create-project', payload),
  onBatchMixProgress(callback) {
    const handler = (_event, job) => callback(job)
    ipcRenderer.on('videome:batch-progress', handler)
    return () => ipcRenderer.removeListener('videome:batch-progress', handler)
  },
  onExportProgress(callback) {
    const handler = (_event, progress) => callback(progress)
    ipcRenderer.on('videome:export-progress', handler)
    return () => ipcRenderer.removeListener('videome:export-progress', handler)
  },
  onPreviewEvent(callback) {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('videome:preview-event', handler)
    return () => ipcRenderer.removeListener('videome:preview-event', handler)
  },
  onOpenProjectFile(callback) {
    openProjectListeners.add(callback)
    while (pendingOpenProjects.length) callback(pendingOpenProjects.shift())
    return () => openProjectListeners.delete(callback)
  },
})
