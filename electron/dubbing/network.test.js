import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
const require = createRequire(import.meta.url)
const { DubbingNetworkSettings, proxyEnvironment, normalizeProxyUrl, redactNetworkError } = require('./network.cjs')
const { download, DubbingModels } = require('./models.cjs')
const { run } = require('./process.cjs')

const folders = []
const servers = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })))
})
async function workspace() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-network-')); folders.push(root); return root }
function secureStorage() {
  const entries = new Map()
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => { const token = crypto.randomBytes(32); entries.set(token.toString('base64'), text); return token },
    decryptString: (token) => entries.get(token.toString('base64')),
  }
}

describe('dubbing installation proxy', () => {
  it('accepts local HTTP/HTTPS proxies and rejects credentials or paths in the address', () => {
    expect(normalizeProxyUrl(' http://127.0.0.1:7890/ ')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('https://[::1]:8080')).toBe('https://[::1]:8080')
    for (const value of ['127.0.0.1:7890', 'socks5://localhost:1080', 'http://user:secret@localhost:8080', 'http://localhost:8080/path']) {
      expect(() => normalizeProxyUrl(value)).toThrow()
    }
  })
  it('applies the same authenticated proxy to curl and pip and overrides inherited bypass rules', () => {
    const settings = { mode: 'manual', url: 'http://localhost:7890', username: 'user', password: 'p@ss:word' }
    const env = proxyEnvironment(settings, { PATH: '/bin', http_proxy: 'http://old:80', HTTPS_PROXY: 'http://old:81', NO_PROXY: '*', PIP_PROXY: 'http://old:82' })
    expect(env.http_proxy).toBe('http://user:p%40ss%3Aword@localhost:7890')
    expect(env.HTTPS_PROXY).toBe(env.http_proxy)
    expect(env.PIP_PROXY).toBe(env.http_proxy)
    expect(env.NO_PROXY).toBe('')
    expect(env.PATH).toBe('/bin')
    const direct = proxyEnvironment({ mode: 'direct' }, env)
    expect(direct.http_proxy).toBe('')
    expect(direct.PIP_PROXY).toBe('')
    expect(direct.NO_PROXY).toBe('*')
    expect(proxyEnvironment({ mode: 'environment' }, env)).toEqual(env)
  })
  it('persists encrypted credentials, hides saved passwords and does not reuse them for another proxy', async () => {
    const root = await workspace(); const vault = secureStorage()
    const store = new DubbingNetworkSettings(root, vault)
    const result = await store.save({ mode: 'manual', url: 'http://localhost:7890', username: 'proxy-user', password: 'private-password' })
    expect(result).toEqual({ mode: 'manual', url: 'http://localhost:7890', username: 'proxy-user', hasPassword: true })
    const raw = await fs.readFile(store.file, 'utf8')
    expect(raw).not.toContain('proxy-user')
    expect(raw).not.toContain('private-password')
    const reopened = new DubbingNetworkSettings(root, vault)
    expect((await reopened.read()).password).toBe('private-password')
    await reopened.save({ ...result, keepPassword: true })
    expect((await reopened.read()).password).toBe('private-password')
    await reopened.save({ ...result, url: 'http://localhost:7891', keepPassword: true })
    expect((await reopened.read()).password).toBe('')
    await reopened.save({ ...result, password: '', keepPassword: false })
    expect((await reopened.publicSettings()).hasPassword).toBe(false)
  })
  it('allows unauthenticated proxies without a vault and rejects plaintext credential storage', async () => {
    const store = new DubbingNetworkSettings(await workspace())
    await expect(store.save({ mode: 'manual', url: 'http://localhost:7890' })).resolves.toMatchObject({ hasPassword: false })
    await expect(store.save({ mode: 'manual', url: 'http://localhost:7890', username: 'user', password: 'secret' })).rejects.toThrow('安全存储')
  })
  it('removes credential values from diagnostic messages', () => {
    const settings = { username: 'example-user', password: 'p@ss:word' }
    const message = redactNetworkError(new Error('http://example-user:p%40ss%3Aword@localhost:7890 failed for example-user p@ss:word'), settings, {})
    expect(message).not.toContain('example-user')
    expect(message).not.toContain('p@ss:word')
    expect(message).not.toContain('p%40ss%3Aword')
  })
  it('actually downloads and verifies an asset through an authenticated local proxy', async () => {
    const body = Buffer.from('verified model bytes')
    const requests = []
    const proxy = http.createServer((request, response) => {
      requests.push({ url: request.url, auth: request.headers['proxy-authorization'] })
      response.writeHead(200, { 'Content-Length': body.length }); response.end(body)
    })
    servers.push(proxy); await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const target = path.join(await workspace(), 'model.bin')
    await download({ name: 'test', url: 'http://model.invalid/asset.bin', sha256: crypto.createHash('sha256').update(body).digest('hex') }, target,
      { network: { mode: 'manual', url: `http://127.0.0.1:${proxy.address().port}`, username: 'user', password: 'secret' } })
    expect(await fs.readFile(target)).toEqual(body)
    expect(requests).toEqual([{ url: 'http://model.invalid/asset.bin', auth: `Basic ${Buffer.from('user:secret').toString('base64')}` }])
  })
  it('never silently falls back to direct fetch after a configured proxy fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(download({ name: 'test', url: 'http://model.invalid/asset.bin', sha256: '0'.repeat(64) }, path.join(await workspace(), 'model.bin'),
      { network: { mode: 'manual', url: 'http://localhost:abc', username: '', password: '' } })).rejects.toThrow('代理配置')
    expect(fetchSpy).not.toHaveBeenCalled()
  }, 20000)
  it('does not merge excluded environment variables back into child processes', async () => {
    const env = proxyEnvironment({ mode: 'direct' })
    expect(await run(process.execPath, ['-e', 'process.stdout.write(process.env.PIP_PROXY + ":" + process.env.NO_PROXY)'], { env, inheritEnv: false })).toBe(':*')
  })
  it('rejects network changes while installation is active', async () => {
    const model = new DubbingModels({ root: await workspace(), resources: path.resolve('resources/dubbing') })
    model.installing = Promise.resolve()
    await expect(model.saveNetworkSettings({ mode: 'direct' })).rejects.toThrow('先取消安装')
  })
  it('blocks network setting changes during the independent Whisper install', async () => {
    const model = new DubbingModels({ root: await workspace(), resources: path.resolve('resources/dubbing') })
    model.whisperInstalling = true
    await expect(model.saveNetworkSettings({ mode: 'direct' })).rejects.toThrow('先取消安装')
  })
})
