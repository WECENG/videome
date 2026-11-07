const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const DEFAULT_SETTINGS = { mode: 'environment', url: '', username: '', password: '' }
const proxyKeys = new Set(['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'pip_proxy'])

function normalizeProxyUrl(value) {
  const text = String(value || '').trim()
  let url
  try { url = new URL(text) } catch { throw new Error('请输入完整的 HTTP/HTTPS 代理地址，例如 http://127.0.0.1:7890。') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('代理地址仅支持 HTTP/HTTPS 的主机和端口；如需认证，请填写下方用户名和密码。')
  }
  return url.origin
}

function authenticatedProxy(settings) {
  const url = new URL(settings.url)
  if (settings.username) {
    url.username = settings.username
    url.password = settings.password
  }
  return url.href.replace(/\/$/, '')
}

function proxyEnvironment(settings, inherited = process.env) {
  if (settings.mode === 'environment') return { ...inherited }
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !proxyKeys.has(key.toLowerCase())))
  // PIP_PROXY overrides pip's configuration in manual mode. Direct mode also
  // passes --proxy '' because pip ignores empty environment option values.
  const proxy = settings.mode === 'manual' ? authenticatedProxy(settings) : ''
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'PIP_PROXY']) env[key] = proxy
  env.no_proxy = settings.mode === 'direct' ? '*' : ''
  env.NO_PROXY = env.no_proxy
  return env
}

function usesProxy(settings, env = process.env) {
  return settings.mode === 'manual' || (settings.mode === 'environment'
    && Object.entries(env).some(([key, value]) => ['http_proxy', 'https_proxy', 'all_proxy', 'pip_proxy'].includes(key.toLowerCase()) && value))
}

function redactNetworkError(error, settings = DEFAULT_SETTINGS, env = process.env) {
  let text = error?.message || String(error || '网络连接失败')
  const secrets = [settings.password, settings.username]
  for (const [key, value] of Object.entries(env)) {
    if (!proxyKeys.has(key.toLowerCase()) || !value) continue
    try { const url = new URL(value); secrets.push(decodeURIComponent(url.username), decodeURIComponent(url.password)) } catch {}
  }
  text = text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1***@')
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('***').split(encodeURIComponent(secret)).join('***')
  }
  return text
}

class DubbingNetworkSettings {
  constructor(root, secureStorage) {
    this.file = path.join(root, 'network-settings.json')
    this.secureStorage = secureStorage
    this.current = null
  }
  async read() {
    if (this.current) return { ...this.current }
    let stored
    try { stored = JSON.parse(await fs.readFile(this.file, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_SETTINGS }; throw new Error('无法读取安装网络设置，请重新保存代理配置。') }
    let auth = {}
    if (stored.encryptedAuth) {
      try { auth = JSON.parse(this.secureStorage.decryptString(Buffer.from(stored.encryptedAuth, 'base64'))) }
      catch { throw new Error('无法解密已保存的代理认证，请重新保存代理配置。') }
    }
    this.current = { ...DEFAULT_SETTINGS, ...stored, ...auth }
    delete this.current.encryptedAuth
    return { ...this.current }
  }
  async publicSettings() {
    const { mode, url, username, password } = await this.read()
    return { mode, url, username, hasPassword: Boolean(password) }
  }
  async save(input = {}) {
    if (!['environment', 'direct', 'manual'].includes(input.mode)) throw new Error('请选择有效的安装网络模式。')
    const previous = await this.read().catch(() => ({ ...DEFAULT_SETTINGS }))
    const url = input.url?.trim() ? normalizeProxyUrl(input.url) : ''
    if (input.mode === 'manual' && !url) throw new Error('请填写自定义代理地址。')
    const username = String(input.username || '').trim()
    let password = String(input.password || '')
    // Never silently carry stored credentials to a different proxy or user.
    if (!password && input.keepPassword && url === previous.url && username === previous.username) password = previous.password
    if (!username) password = ''
    if ([username, password].some((value) => /[\r\n\u0000]/.test(value) || value.length > 1024)) throw new Error('代理认证信息无效。')
    const settings = { mode: input.mode, url, username, password }
    const stored = { mode: settings.mode, url }
    if (username || password) {
      if (!this.secureStorage?.isEncryptionAvailable()
        || this.secureStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统安全存储不可用，无法保存代理认证。可使用无需认证的本地代理。')
      stored.encryptedAuth = this.secureStorage.encryptString(JSON.stringify({ username, password })).toString('base64')
    }
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.writeFile(temporary, JSON.stringify(stored, null, 2), { mode: 0o600 })
      await fs.rename(temporary, this.file)
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
    this.current = settings
    return this.publicSettings()
  }
}

module.exports = { DubbingNetworkSettings, DEFAULT_SETTINGS, proxyEnvironment, usesProxy, redactNetworkError, normalizeProxyUrl }
