const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const FONT_FAMILY = 'Noto Sans CJK SC'

function toolCandidates(name, { platform = process.platform, arch = process.arch, env = process.env, packaged = false, resourcesPath = process.resourcesPath } = {}) {
  const executable = platform === 'win32' ? `${name}.exe` : name
  if (packaged) return [path.join(resourcesPath, 'media-bin', executable)]
  const candidates = [env[`VIDEOME_${name.toUpperCase()}`], path.join(root, 'media-bin', `${platform}-${arch}`, executable), path.join(root, 'media-bin', executable)]
  for (const directory of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) candidates.push(path.join(directory.replace(/^"|"$/g, ''), executable))
  if (platform === 'darwin') candidates.push(...['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map((directory) => path.join(directory, executable)))
  return [...new Set(candidates.filter(Boolean))]
}

function locateTool(name, options) {
  return toolCandidates(name, options).find((candidate) => {
    try { return fs.statSync(candidate).isFile() } catch { return false }
  }) || null
}

function fontResources({ packaged = false, resourcesPath = process.resourcesPath } = {}) {
  const directory = packaged ? path.join(resourcesPath, 'fonts') : path.join(root, 'resources', 'fonts')
  return { fontFile: path.join(directory, 'NotoSansCJKsc-Regular.otf'), fontsDirectory: directory, fontFamily: FONT_FAMILY }
}

function encoderFor(codec = 'h264', platform = process.platform, software = false) {
  if (platform === 'darwin' && !software) return codec === 'hevc' ? 'hevc_videotoolbox' : 'h264_videotoolbox'
  return codec === 'hevc' ? 'libx265' : 'libx264'
}

function hardwareFailure(error) {
  return /videotoolbox|encoder.*(?:open|initial)|cannot create.*compression|hardware.*(?:fail|unavailable)/i.test(error.message)
}

function filterPath(value) {
  // Escape both the filtergraph parser and the filter option parser; callers do not add quotes.
  const option = String(value).replace(/\\/g, '/').replace(/[\\':]/g, (character) => `\\${character}`)
  return option.replace(/[\\'\[\],; ]/g, (character) => `\\${character}`)
}

function safeFileName(value) {
  let name = String(value ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '')
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`
  return name || '未命名项目'
}

function nativePath(value, platform = process.platform) {
  const text = String(value || '')
  return platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(text) ? text.slice(1) : text
}

module.exports = { toolCandidates, locateTool, fontResources, encoderFor, hardwareFailure, filterPath, safeFileName, nativePath, FONT_FAMILY }
