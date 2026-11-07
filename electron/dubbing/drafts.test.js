import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { DubbingManager } = require('./manager.cjs')
const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-drafts-')); roots.push(root)
  const jobs = [
    { id: 'one', projectId: 'p', status: 'ready', createdAt: '2026-11-06T00:00:00Z' },
    { id: 'two', projectId: 'p', status: 'review', createdAt: '2026-11-06T00:01:00Z' },
    { id: 'other', projectId: 'q', status: 'failed', createdAt: '2026-11-06T00:02:00Z' },
  ]
  for (const job of jobs) {
    const folder = path.join(root, job.id); await fs.mkdir(folder)
    job.backgroundPath = path.join(folder, 'background.wav')
    job.cues = [{ id: 'cue', translation: '已有译文', audioPath: path.join(folder, 'cue.wav') }]
    await fs.writeFile(path.join(folder, 'job.json'), JSON.stringify(job))
    await fs.writeFile(path.join(folder, 'job.json.bak'), JSON.stringify(job))
    await fs.writeFile(path.join(folder, 'job.json.tmp'), JSON.stringify(job))
    await fs.writeFile(job.backgroundPath, 'background media')
    await fs.writeFile(job.cues[0].audioPath, 'generated media')
  }
  const manager = new DubbingManager({ root }); await manager.initialized
  return { root, jobs, manager }
}

describe('dubbing draft deletion', () => {
  it('deletes one draft permanently while preserving media and unrelated drafts', async () => {
    const { root, jobs, manager } = await fixture()
    const events = []; manager.on('removed', (event) => events.push(event))
    expect(await manager.remove({ id: 'one', projectId: 'p' })).toEqual({ projectId: 'p', ids: ['one'], failures: [] })
    expect(manager.list('p').map((job) => job.id)).toEqual(['two'])
    expect(() => manager.get('one')).toThrow('不存在')
    expect(events).toEqual([{ projectId: 'p', ids: ['one'] }])
    for (const name of ['job.json', 'job.json.bak', 'job.json.tmp']) {
      await expect(fs.access(path.join(root, 'one', name))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await fs.readFile(jobs[0].backgroundPath, 'utf8')).toBe('background media')
    expect(await fs.readFile(jobs[0].cues[0].audioPath, 'utf8')).toBe('generated media')
    // Even if an old write/backup survives a crash, the tombstone prevents it
    // from returning to the list at the next launch.
    await fs.writeFile(path.join(root, 'one', 'job.json.bak'), JSON.stringify(jobs[0]))
    const reopened = new DubbingManager({ root }); await reopened.initialized
    expect(reopened.list('p').map((job) => job.id)).toEqual(['two'])
    expect(reopened.list('q')).toHaveLength(1)
  })
  it('clears only this project and retains every media file across restart', async () => {
    const { root, jobs, manager } = await fixture()
    const result = await manager.clear('p')
    expect(result.ids.sort()).toEqual(['one', 'two'])
    expect(result.failures).toEqual([])
    expect(manager.list('p')).toEqual([])
    expect(manager.list('q')).toHaveLength(1)
    const reopened = new DubbingManager({ root }); await reopened.initialized
    expect(reopened.list('p')).toEqual([])
    expect(reopened.list('q')).toHaveLength(1)
    for (const job of jobs) {
      await expect(fs.readFile(job.cues[0].audioPath, 'utf8')).resolves.toBe('generated media')
    }
    expect(await reopened.clear('p')).toEqual({ projectId: 'p', ids: [], failures: [] })
  })
  it('rejects running task deletion and whole-list clearing before deleting any records', async () => {
    const { root, manager } = await fixture()
    manager.active = { id: 'two' }
    await expect(manager.remove({ id: 'two', projectId: 'p' })).rejects.toThrow('先取消')
    await expect(manager.clear('p')).rejects.toThrow('先取消')
    expect(manager.list('p')).toHaveLength(2)
    await expect(fs.access(path.join(root, 'one', '.deleted'))).rejects.toMatchObject({ code: 'ENOENT' })
    // An idle draft can be removed while another draft is running.
    await expect(manager.remove({ id: 'one', projectId: 'p' })).resolves.toMatchObject({ ids: ['one'] })
    expect(manager.get('two').id).toBe('two')
  })
  it('validates project scope and prevents an in-flight deletion from restarting', async () => {
    const { manager } = await fixture()
    await expect(manager.remove({ id: 'other', projectId: 'p' })).rejects.toThrow('当前工程')
    await expect(manager.clear('')).rejects.toThrow('工程')
    manager.removing.add('one')
    expect(() => manager.start('one', 'analyze')).toThrow('正在删除')
    await expect(manager.update({ id: 'one' })).rejects.toThrow('删除')
    await expect(manager.clear('p')).rejects.toThrow('正在删除')
    expect(manager.list('p')).toHaveLength(2)
  })
  it('allows deletion of a task left waiting to start by a previous app exit', async () => {
    const { root, jobs } = await fixture()
    await fs.writeFile(path.join(root, 'one', 'job.json'), JSON.stringify({ ...jobs[0], status: 'created' }))
    const reopened = new DubbingManager({ root }); await reopened.initialized
    expect(reopened.get('one').status).toBe('interrupted')
    await expect(reopened.remove({ id: 'one', projectId: 'p' })).resolves.toMatchObject({ ids: ['one'] })
  })
})
