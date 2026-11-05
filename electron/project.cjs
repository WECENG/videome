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

function assertProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath) || path.extname(projectPath).toLowerCase() !== PROJECT_EXTENSION) {
    throw new Error('自动备份需要已关联的 .videome 工程路径。')
  }
}

function projectBackupSourcePath(projectPath) {
  assertProjectPath(projectPath)
  const extension = path.extname(projectPath)
  const stem = path.basename(projectPath, path.extname(projectPath))
  const sourceStem = stem.replace(/\.autosave(?:-\d{8}-\d{6})?$/i, '')
  return path.join(path.dirname(projectPath), `${sourceStem}${extension}`)
}

function projectBackupTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('自动备份时间无效。')
  const iso = date.toISOString()
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
}

function projectBackupPath(projectPath, timestamp = new Date()) {
  const sourcePath = projectBackupSourcePath(projectPath)
  const stem = path.basename(sourcePath, path.extname(sourcePath))
  return path.join(path.dirname(sourcePath), `${stem}.autosave-${projectBackupTimestamp(timestamp)}${PROJECT_EXTENSION}`)
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

async function writeProjectData(projectPath, project, { fileSystem = fs } = {}) {
  const temporaryPath = `${projectPath}.${crypto.randomUUID()}.tmp`
  try {
    await fileSystem.mkdir(path.dirname(projectPath), { recursive: true })
    await fileSystem.writeFile(temporaryPath, JSON.stringify(project, null, 2))
    if (fileSystem === fs) await replaceFile(temporaryPath, projectPath)
    else await fileSystem.rename(temporaryPath, projectPath)
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

async function writeProjectSnapshot(projectPath, project, { fileSystem = fs } = {}) {
  const snapshot = normalizeProjectForPersistence(project)
  const backupPath = await preserveProjectBeforeEmptyWrite(projectPath, snapshot, { fileSystem })
  await writeProjectData(projectPath, { ...snapshot, savedAt: new Date().toISOString() }, { fileSystem })
  return { path: projectPath, backupPath }
}

async function removePreviousProjectBackups(projectPath, keepPath, { fileSystem = fs } = {}) {
  const sourcePath = projectBackupSourcePath(projectPath)
  const stem = path.basename(sourcePath, path.extname(sourcePath))
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escapedStem}\\.autosave(?:-\\d{8}-\\d{6})?\\${PROJECT_EXTENSION}$`, 'i')
  let entries
  try {
    entries = await fileSystem.readdir(path.dirname(sourcePath))
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await Promise.all(entries
    .filter((entry) => pattern.test(String(entry)) && path.resolve(path.dirname(sourcePath), entry) !== path.resolve(keepPath))
    .map((entry) => fileSystem.rm(path.join(path.dirname(sourcePath), entry), { force: true })))
}

async function writeProjectBackup(projectPath, project, options = {}) {
  const timestamp = new Date()
  const backupPath = projectBackupPath(projectPath, timestamp)
  const snapshot = normalizeProjectForPersistence(project)
  await writeProjectData(backupPath, { ...snapshot, autosavedAt: timestamp.toISOString() }, options)
  await removePreviousProjectBackups(projectPath, backupPath, options)
  return { path: backupPath }
}

module.exports = {
  createProjectWriteQueue,
  normalizeProjectName,
  normalizeProjectForPersistence,
  projectBackupPath,
  projectBackupSourcePath,
  projectBackupTimestamp,
  projectFileName,
  projectPathMatchesName,
  preserveProjectBeforeEmptyWrite,
  withProjectExtension,
  writeProjectBackup,
  writeProjectSnapshot,
}
