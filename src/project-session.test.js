import { describe, it, expect } from 'vitest'
import { createBlankProject, isExampleProject, readProjectSession, writeProjectSession } from './project-session.js'
import { sampleProject } from './domain.js'

function storage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

describe('project session recovery', () => {
  it('starts clean without demonstration clips, captions or names', () => {
    const { project, path } = readProjectSession(storage())
    expect(project.name).toBe('未命名工程')
    expect(project.clips).toEqual([])
    expect(project.subtitle.cues).toEqual([])
    expect(project.playhead).toBe(0)
    expect(path).toBeNull()
    const other = createBlankProject()
    project.tracks[0].muted = true
    expect(other.tracks[0].muted).toBe(false)
  })
  it('keeps project and path together and does not reopen a stale legacy save', () => {
    const local = storage({ 'videome-project': JSON.stringify(sampleProject) })
    const project = createBlankProject('真实工程', [{ id: 'v', path: '/media/source.mp4' }])
    writeProjectSession(local, project, '/work/真实工程.videome')
    expect(readProjectSession(local)).toEqual({ project, path: '/work/真实工程.videome' })
  })
  it('recovers the most recent legacy data when the new session is damaged', () => {
    const old = { ...createBlankProject('旧保存'), savedAt: '2026-11-04T00:00:00Z' }
    const latest = { ...createBlankProject('未保存修改'), autosavedAt: '2026-11-05T00:00:00Z' }
    const local = storage({ 'videome-session': '{broken', 'videome-project': JSON.stringify(old), 'videome-autosave': JSON.stringify(latest) })
    expect(readProjectSession(local)).toEqual({ project: latest, path: null })
  })
  it('preserves stored examples while distinguishing real timelines', () => {
    expect(isExampleProject(sampleProject)).toBe(true)
    expect(readProjectSession(storage({ 'videome-project': JSON.stringify(sampleProject) })).project.clips).toHaveLength(11)
    expect(isExampleProject({ clips: [...sampleProject.clips, { id: 'real-clip' }] })).toBe(false)
  })
})
