import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { translationArguments, translationPrompt, parseTranslation } = require('./translation.cjs')
const { DubbingManager } = require('./manager.cjs')
const folders = []

afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true }))) })

describe('local Qwen translation', () => {
  it('keeps generated stdout enabled in the pinned llama.cpp runtime', () => {
    const args = translationArguments('/models', '/task/prompt.txt')
    expect(args).not.toContain('--log-disable')
    expect(args).toContain('--no-display-prompt')
    expect(args).toContain('-no-cnv')
  })
  it('keeps adjacent sentences as context and disables Qwen thinking', () => {
    const prompt = translationPrompt([{ text: 'Before.' }, { text: 'Now.' }, { text: 'After.' }], 1)
    expect(prompt).toContain('上下文：\nBefore.\nNow.\nAfter.')
    expect(prompt).toContain('当前句：Now.')
    expect(prompt).toContain('/no_think')
    expect(prompt).toMatch(/<think>\n\n<\/think>\n$/)
  })
  it('extracts only the Chinese answer and rejects empty, English-only or unfinished thinking output', () => {
    expect(parseTranslation('\n<think>推理内容</think>\n在马孔多，他睁着双眼。 [end of text]\n')).toBe('在马孔多，他睁着双眼。')
    for (const output of ['', '\n [end of text]\n', 'Only English.', '<think>尚未完成的推理']) {
      expect(() => parseTranslation(output)).toThrow('重试翻译')
    }
  })
  it.each([true, false])('retries only unfinished translations and preserves earlier edits (valid output: %s)', async (valid) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-translation-')); folders.push(root)
    const folder = path.join(root, 'job'); await fs.mkdir(folder)
    const source = path.join(root, 'source.wav'); await fs.writeFile(source, 'source')
    const stat = await fs.stat(source)
    const binary = process.execPath
    const script = path.join(root, 'llama-test.cjs')
    await fs.writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(root, 'arguments.json'))},JSON.stringify(process.argv.slice(2)));process.stderr.write('runtime diagnostics only');process.stdout.write(${JSON.stringify(valid ? '\n小时候，他总是仔细观察周围。 [end of text]\n' : '')});`, 'utf8')
    const manager = new DubbingManager({ root, models: { llama: binary, llamaArgs: [script], directory: root, status: async () => ({ ready: true }) } })
    await manager.initialized
    const job = { id: 'job', source: { path: source, duration: 20 }, fingerprint: { size: stat.size, mtimeMs: stat.mtimeMs }, backgroundPath: '/background.wav',
      status: 'review', error: '翻译未返回中文', cues: [
        { id: '0', text: 'Born in Macondo.', translation: '用户已校对的译文' },
        { id: '1', text: 'As a child, he watched everything closely.', translation: '' },
      ] }
    manager.jobs.set(job.id, job)
    manager.media = () => { throw new Error('翻译重试不应提取或分离音频。') }
    manager.worker = () => { throw new Error('翻译重试不应重新识别。') }
    manager.start('job', 'translate'); await manager.active.promise
    const restored = JSON.parse(await fs.readFile(path.join(folder, 'job.json'), 'utf8'))
    expect(restored.cues[0].translation).toBe('用户已校对的译文')
    expect(restored.status).toBe(valid ? 'review' : 'failed')
    expect(restored.cues[1].translation).toBe(valid ? '小时候，他总是仔细观察周围。' : '')
    if (valid) expect(restored.error).toBeNull()
    else expect(restored.error).toContain('重试翻译')
    expect(await fs.readFile(path.join(folder, 'translation-output.txt'), 'utf8')).not.toContain('runtime diagnostics')
  })
})
