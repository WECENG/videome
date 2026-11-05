import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const {
  normalizeProjectName,
  createProjectWriteQueue,
  projectBackupPath,
  projectBackupSourcePath,
  projectBackupTimestamp,
  projectFileName,
  projectPathMatchesName,
  preserveProjectBeforeEmptyWrite,
  withProjectExtension,
  writeProjectBackup,
  writeProjectSnapshot,
} = require('./project.cjs')

describe('Videome project filenames', () => {
  it('preserves a complete Unicode project name', () => {
    const name = '奥雷里亚诺·布恩迪亚上校'
    expect(normalizeProjectName(name)).toBe(name)
    expect(projectFileName(name)).toBe(name)
    expect(withProjectExtension(`${name}.videome`)).toBe(`${name}.videome`)
  })

  it('recognizes an existing path even when Unicode uses another normalization form', () => {
    const name = '奥雷里亚诺·布恩迪亚上校'
    expect(projectPathMatchesName(`/tmp/${name}.videome`, name)).toBe(true)
  })

  it('does not treat a renamed project as the old file', () => {
    expect(projectPathMatchesName('/tmp/上校.videome', '奥雷里亚诺·布恩迪亚上校')).toBe(false)
  })

  it('only replaces path separators when making a filename', () => {
    expect(projectFileName('章节/第一集')).toBe('章节-第一集')
    expect(projectPathMatchesName('/tmp/章节-第一集.videome', '章节/第一集')).toBe(true)
  })

  it('serializes writes to the same project path', async () => {
    const queue = createProjectWriteQueue()
    const events = []
    let releaseFirst
    const gate = new Promise((resolve) => { releaseFirst = resolve })
    const first = queue('/tmp/project.videome', async () => {
      events.push('first-start')
      await gate
      events.push('first-end')
    })
    const second = queue('/tmp/project.videome', async () => events.push('second'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first-start', 'first-end', 'second'])
  })

  it('backs up an existing timeline before an empty save', async () => {
    const files = new Map([['/tmp/project.videome', JSON.stringify({ clips: [{ id: 'clip' }] })]])
    const fileSystem = {
      async readFile(path) {
        if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return files.get(path)
      },
      async access(path) {
        if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      async copyFile(source, target) { files.set(target, files.get(source)) },
    }
    const backup = await preserveProjectBeforeEmptyWrite('/tmp/project.videome', { clips: [] }, {
      fileSystem,
      timestamp: new Date('2026-11-03T10:00:00.000Z'),
    })
    expect(backup).toBe('/tmp/project.videome.backup-20261103100000')
    expect(JSON.parse(files.get(backup)).clips).toEqual([{ id: 'clip' }])
  })
})

describe('Videome project write safety', () => {
  it('serializes writes targeting the same project path', async () => {
    const queue = createProjectWriteQueue()
    const events = []
    let finishFirst
    const firstGate = new Promise((resolve) => { finishFirst = resolve })
    const first = queue('/tmp/project.videome', async () => {
      events.push('first-start')
      await firstGate
      events.push('first-end')
    })
    const second = queue('/tmp/project.videome', async () => events.push('second'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toEqual(['first-start'])
    finishFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first-start', 'first-end', 'second'])
  })

  it('keeps the existing timeline before an empty save overwrites it', async () => {
    const files = new Map([['/tmp/project.videome', JSON.stringify({ clips: [{ id: 'clip' }] })]])
    const fileSystem = {
      async readFile(path) { if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(path) },
      async access(path) { if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
      async copyFile(source, target) { files.set(target, files.get(source)) },
    }
    const backup = await preserveProjectBeforeEmptyWrite('/tmp/project.videome', { clips: [] }, { fileSystem, timestamp: new Date('2026-11-03T10:00:00.000Z') })
    expect(backup).toBe('/tmp/project.videome.backup-20261103100000')
    expect(JSON.parse(files.get(backup)).clips).toEqual([{ id: 'clip' }])
  })
})

describe('Videome automatic backups', () => {
  const workspaces = []

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
  })

  async function createWorkspace() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-backup-test-'))
    workspaces.push(directory)
    return { directory, projectPath: path.join(directory, '我的工程.videome') }
  }

  it('uses a stable sibling filename independent of the edited project name', async () => {
    const { projectPath } = await createWorkspace()
    const timestamp = new Date('2026-11-06T01:02:03.000Z')
    expect(projectBackupTimestamp(timestamp)).toBe('20261106-010203')
    expect(projectBackupSourcePath(projectPath)).toBe(projectPath)
    expect(projectBackupPath(projectPath, timestamp)).toBe(path.join(path.dirname(projectPath), '我的工程.autosave-20261106-010203.videome'))
    expect(projectBackupSourcePath(projectBackupPath(projectPath, timestamp))).toBe(projectPath)
    const uppercasePath = projectPath.replace('.videome', '.VIDEOME')
    expect(projectBackupSourcePath(uppercasePath)).toBe(uppercasePath)
    expect(projectBackupPath(uppercasePath, timestamp)).toBe(path.join(path.dirname(projectPath), '我的工程.autosave-20261106-010203.videome'))
    const autosaveNamedProject = path.join(path.dirname(projectPath), '我的工程.autosave.videome')
    expect(projectBackupSourcePath(autosaveNamedProject)).toBe(projectPath)
    expect(projectBackupPath(autosaveNamedProject, timestamp)).toBe(path.join(path.dirname(projectPath), '我的工程.autosave-20261106-010203.videome'))
    for (const invalidPath of [null, '', 'relative.videome', path.join(path.dirname(projectPath), 'file.json')]) {
      expect(() => projectBackupPath(invalidPath)).toThrow('自动备份需要已关联的 .videome 工程路径。')
    }
  })

  it('backs up the current edits without changing the original contents or modification time', async () => {
    const { projectPath } = await createWorkspace()
    const original = JSON.stringify({ name: '我的工程', clips: [{ id: 'saved-clip' }] })
    await fs.writeFile(projectPath, original)
    const before = await fs.stat(projectPath)
    const project = { name: '重命名后的工程', clips: [{ id: 'new-clip', duration: 5 }], savedAt: '2026-11-05T00:00:00.000Z' }
    const result = await writeProjectBackup(projectPath, project)
    expect(result.path).toMatch(/我的工程\.autosave-\d{8}-\d{6}\.videome$/)
    expect(JSON.parse(await fs.readFile(result.path, 'utf8'))).toMatchObject({ ...project, schemaVersion: 1, autosavedAt: expect.any(String) })
    expect(await fs.readFile(projectPath, 'utf8')).toBe(original)
    expect((await fs.stat(projectPath)).mtimeMs).toBe(before.mtimeMs)
    expect(project).not.toHaveProperty('autosavedAt')
  })

  it('keeps only the latest copy, including when the timeline becomes empty', async () => {
    const { directory, projectPath } = await createWorkspace()
    const original = JSON.stringify({ clips: [{ id: 'saved-clip' }] })
    await fs.writeFile(projectPath, original)
    await writeProjectBackup(projectPath, { clips: [{ id: 'first-edit' }] })
    await writeProjectBackup(projectPath, { clips: [] })
    const latest = await writeProjectBackup(projectPath, { clips: [{ id: 'latest-edit' }] })
    expect(JSON.parse(await fs.readFile(latest.path, 'utf8')).clips).toEqual([expect.objectContaining({ id: 'latest-edit' })])
    expect((await fs.readdir(directory)).sort()).toEqual([path.basename(latest.path), '我的工程.videome'])
    expect(await fs.readFile(projectPath, 'utf8')).toBe(original)
  })

  it('does not recreate a missing original project file during backup', async () => {
    const { directory, projectPath } = await createWorkspace()
    await writeProjectBackup(projectPath, { name: '我的工程', clips: [] })
    expect((await fs.readdir(directory))[0]).toMatch(/^我的工程\.autosave-\d{8}-\d{6}\.videome$/)
  })

  it('preserves the latest backup on a failed write and removes the temporary file', async () => {
    const { directory, projectPath } = await createWorkspace()
    await fs.writeFile(projectPath, 'original')
    const previousPath = (await writeProjectBackup(projectPath, { clips: [{ id: 'previous-edit' }] })).path
    const previous = await fs.readFile(previousPath, 'utf8')
    const fileSystem = {
      ...fs,
      async writeFile(temporaryPath, contents) {
        await fs.writeFile(temporaryPath, contents.slice(0, 10))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      },
    }
    await expect(writeProjectBackup(projectPath, { clips: [] }, { fileSystem })).rejects.toThrow('disk full')
    expect(await fs.readFile(previousPath, 'utf8')).toBe(previous)
    expect(await fs.readFile(projectPath, 'utf8')).toBe('original')
    expect((await fs.readdir(directory)).sort()).toEqual([path.basename(previousPath), '我的工程.videome'])
  })

  it('still preserves the safety copy when manually saving an empty timeline', async () => {
    const { projectPath } = await createWorkspace()
    const original = JSON.stringify({ name: '我的工程', clips: [{ id: 'saved-clip' }] })
    await fs.writeFile(projectPath, original)
    const result = await writeProjectSnapshot(projectPath, { name: '我的工程', clips: [] })
    expect(result.path).toBe(projectPath)
    expect(result.backupPath).toMatch(/\.videome\.backup-\d+$/)
    expect(await fs.readFile(result.backupPath, 'utf8')).toBe(original)
    expect(JSON.parse(await fs.readFile(projectPath, 'utf8'))).toMatchObject({ clips: [], savedAt: expect.any(String) })
  })
})
