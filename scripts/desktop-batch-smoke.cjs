const { _electron: electron } = require('playwright')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { locateTool } = require('../electron/runtime.cjs')
const { exec } = require('./media-tools.cjs')

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-desktop-smoke-'))
  const executablePath = process.argv[2] || require('electron')
  const packaged = Boolean(process.argv[2])
  const fixture = path.join(userData, '素材 空格.mp4')
  await exec(locateTool('ffmpeg'), ['-v','error','-f','lavfi','-i','testsrc2=s=640x360:r=30:d=12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=12','-c:v','libx264','-threads','2','-c:a','aac',fixture])
  const application = await electron.launch({ executablePath, args: [...(packaged ? [] : [path.resolve(__dirname, '..')]), `--user-data-dir=${userData}`], env: { ...process.env, VIDEOME_FFMPEG: '', VIDEOME_FFPROBE: '' }, timeout: 60000 })
  let jobId
  try {
    const page = await application.firstWindow()
    await page.waitForSelector('button.batch-launch', { timeout: 60000 })
    await page.getByRole('button', { name: '批量混剪', exact: true }).click()
    await page.getByRole('dialog', { name: '批量混剪', exact: true }).waitFor()
    const quantity = page.getByRole('spinbutton', { name: '生成数量（条）', exact: true })
    assert.equal(await quantity.inputValue(), '')
    await fs.mkdir(path.resolve(__dirname, '../output/playwright'), { recursive: true })
    await page.screenshot({ path: path.resolve(__dirname, `../output/playwright/${packaged ? 'packaged' : 'desktop'}-batch-panel.png`) })
    const snapshot = await page.locator('body').ariaSnapshot()
    console.log(snapshot.slice(snapshot.indexOf('dialog "批量混剪"'), snapshot.indexOf('dialog "批量混剪"') + 5500))
    await page.getByRole('combobox', { name: '混剪源视频', exact: true }).fill(fixture)
    await page.getByRole('textbox', { name: '混剪输出目录', exact: true }).fill(userData)
    assert.equal(await page.getByRole('button', { name: '分析并生成方案', exact: true }).isDisabled(), true)
    await quantity.fill('3')
    assert.equal(await quantity.inputValue(), '3')
    await page.getByRole('spinbutton', { name: '成片时长（秒）', exact: true }).fill('6')
    await page.getByRole('button', { name: '分析并生成方案', exact: true }).click()
    await page.getByRole('button', { name: '开始生成', exact: true }).waitFor({ timeout: 60000 })
    await page.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.locator('.batch-summary strong').filter({ hasText: '全部成功' }).waitFor({ timeout: 120000 })
    const result = await page.evaluate(async () => (await window.videome.listBatchMixJobs())[0])
    jobId = result.id
    assert.equal(result.options.count, 3)
    assert.equal(result.items.length, 3)
    assert.equal(result.counts.completed, 3)
    console.log(JSON.stringify({ packaged, visible: await page.isVisible('.batch-dialog'), jobId, counts: result.counts, frames: result.items.map((item) => item.verification.frames) }))
    await page.getByRole('button', { name: '编辑代表时间线 #1', exact: true }).click()
    await page.getByRole('dialog', { name: '批量混剪', exact: true }).waitFor({ state: 'hidden', timeout: 30000 })
    const title = await page.title()
    console.log(JSON.stringify({ representativeTitle: title, errors: await page.locator('.toast-error').count() }))
    await page.waitForFunction(() => { const video = document.querySelector('video'); return video && video.readyState >= 2 && !video.seeking }, { timeout: 30000 })
    await page.screenshot({ path: path.resolve(__dirname, `../output/playwright/${packaged ? 'packaged' : 'desktop'}-representative.png`) })
    const ordinaryOutput = path.join(userData, '普通导出 字幕.mp4')
    await application.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }) }, ordinaryOutput)
    const project = {
      name: '字幕 smoke', duration: 2, frameSize: { width: 320, height: 180 }, frameRate: { numerator: 30, denominator: 1 },
      assets: [{ id: 'v', kind: 'video', path: fixture, audioCodec: 'aac' }],
      tracks: [{ id: 'v', type: 'video' }, { id: 'title', type: 'graphics', order: 1 }],
      clips: [{ id: 'v', kind: 'video', assetId: 'v', trackId: 'v', start: 0, duration: 2 }, { id: 't', kind: 'graphics', trackId: 'title', start: 0, duration: 2, text: '中文标题' }],
      subtitle: { enabled: true, cues: [{ start: 0, end: 2, text: '你好 Videome' }] },
    }
    const ordinary = await page.evaluate((project) => window.videome.exportMedia({ project, settings: { preset: 'high', format: 'mp4', videoCodec: 'h264', expectedSizeBytes: 4000000 } }), project)
    assert.equal(ordinary.ok, true, ordinary.reason)
    console.log(JSON.stringify({ ordinaryExport: ordinary }))
  } finally {
    await application.close()
    await fs.rm(userData, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
