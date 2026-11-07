import { defaultProject } from './domain.js'

export const isExampleProject = (project) => Boolean(project?.clips?.length) && project.clips.every((clip) => String(clip.id).startsWith('sample-'))

export function createBlankProject(name = defaultProject.name, assets = []) {
  return { ...structuredClone(defaultProject), projectId: globalThis.crypto.randomUUID(), name: String(name).trim() || defaultProject.name, assets: structuredClone(assets) }
}

export function readProjectSession(storage) {
  try {
    const session = JSON.parse(storage.getItem('videome-session'))
    if (session?.version === 1 && session.project && Array.isArray(session.project.clips)) return { project: session.project, path: session.path || null }
  } catch {}
  const candidates = []
  for (const key of ['videome-autosave', 'videome-project']) {
    try {
      const project = JSON.parse(storage.getItem(key))
      if (project && Array.isArray(project.clips)) candidates.push(project)
    } catch {}
  }
  candidates.sort((a, b) => (Date.parse(b.autosavedAt || b.savedAt) || 0) - (Date.parse(a.autosavedAt || a.savedAt) || 0))
  return { project: candidates[0] || createBlankProject(), path: null }
}

export function writeProjectSession(storage, project, path) {
  storage.setItem('videome-session', JSON.stringify({ version: 1, project, path: path || null }))
}

export function projectFileName(name) {
  let value = String(name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '')
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`
  return value || '未命名项目'
}
