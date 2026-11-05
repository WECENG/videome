const PROJECT_EXTENSION = '.videome'
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { safeFileName } = require('./runtime.cjs')
const { replaceFile } = require('./filesystem.cjs')

function normalizeProjectName(value) {
  const name = String(value ?? '').trim()
  return name || '未命名项目'
}

function projectFileName(value) {
  return safeFileName(normalizeProjectName(value))
}

function withProjectExtension(value) {
  const selected = String(value || '')
  return /\.videome$/i.test(selected) ? selected : `${selected}${PROJECT_EXTENSION}`
}

function projectPathMatchesName(value, name) {
  const fileName = String(value || '').split(/[\\/]/).pop()?.replace(/\.videome$/i, '') || ''
  const expectedFileName = projectFileName(name)
  return Boolean(fileName) && fileName.normalize('NFC') === expectedFileName.normalize('NFC')
}

function createProjectWriteQueue() {
  const queues = new Map()
  return (projectPath, operation) => {
    const key = path.resolve(projectPath)
    const previous = queues.get(key) || Promise.resolve()
    const next = previous.catch(() => null).then(operation)
    queues.set(key, next)
    return next.finally(() => {
      if (queues.get(key) === next) queues.delete(key)
    })
  }
}

async function preserveProjectBeforeEmptyWrite(projectPath, project, { fileSystem = fs, timestamp = new Date() } = {}) {
  if ((project?.clips || []).length) return null
  try {
    const previous = JSON.parse(await fileSystem.readFile(projectPath, 'utf8'))
    if (!(previous.clips || []).length) return null
    const stamp = timestamp.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
    let backupPath = `${projectPath}.backup-${stamp}`
    let suffix = 1
    while (true) {
      try {
        await fileSystem.access(backupPath)
        backupPath = `${projectPath}.backup-${stamp}-${suffix++}`
      } catch {
        break
      }
    }
    await fileSystem.copyFile(projectPath, backupPath)
    return backupPath
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function normalizeProjectForPersistence(project) {
  const source = project && typeof project === 'object' ? project : {}
  const assets = (Array.isArray(source.assets) ? source.assets : []).filter(Boolean).map((asset, index) => ({
    ...asset,
    id: asset.id || `asset-${index}`,
    name: asset.name || `未命名素材 ${index + 1}`,
  }))
  const tracks = (Array.isArray(source.tracks) ? source.tracks : []).filter(Boolean).map((track, index) => ({
    ...track,
    id: track.id || `track-${index}`,
    label: track.label || `轨道 ${index + 1}`,
  }))
  const clips = (Array.isArray(source.clips) ? source.clips : []).filter(Boolean).map((clip, index) => ({
    ...clip,
    id: clip.id || `clip-${index}`,
    name: clip.name || `片段 ${index + 1}`,
    start: Number(clip.start) || 0,
    duration: Math.max(0, Number(clip.duration) || 0),
  }))
  return { ...source, schemaVersion: 1, name: normalizeProjectName(source.name), assets, tracks, clips }
}

async function writeProjectSnapshot(projectPath, project, { fileSystem = fs } = {}) {
  const snapshot = normalizeProjectForPersistence(project)
  const backupPath = await preserveProjectBeforeEmptyWrite(projectPath, snapshot, { fileSystem })
  const temporaryPath = `${projectPath}.${crypto.randomUUID()}.tmp`
  try {
    await fileSystem.mkdir(path.dirname(projectPath), { recursive: true })
    await fileSystem.writeFile(temporaryPath, JSON.stringify({ ...snapshot, savedAt: new Date().toISOString() }, null, 2))
    if (fileSystem === fs) await replaceFile(temporaryPath, projectPath)
    else await fileSystem.rename(temporaryPath, projectPath)
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
  return { path: projectPath, backupPath }
}

module.exports = {
  createProjectWriteQueue,
  normalizeProjectName,
  normalizeProjectForPersistence,
  projectFileName,
  projectPathMatchesName,
  preserveProjectBeforeEmptyWrite,
  withProjectExtension,
  writeProjectSnapshot,
}
