import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  normalizeProjectName,
  createProjectWriteQueue,
  projectFileName,
  projectPathMatchesName,
  preserveProjectBeforeEmptyWrite,
  withProjectExtension,
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
