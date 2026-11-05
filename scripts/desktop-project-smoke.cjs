const { _electron: electron } = require('playwright')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { exec } = require('./media-tools.cjs')
const { locateTool } = require('../electron/runtime.cjs')

async function main() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'videome-project-smoke-'))
  const screenshots = path.resolve('output/playwright')
  const packaged = Boolean(process.argv[2])
  const prefix = packaged ? 'installed-project' : 'project'
  const source = path.join(workspace, '真实素材.mp4')
  const firstPath = path.join(workspace, '我的工程.videome')
  const secondPath = path.join(workspace, '我的工程副本.videome')
  await exec(locateTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-c:v', 'libx264', '-threads', '2', source])
  await fs.mkdir(screenshots, { recursive: true })
  const app = await electron.launch({ executablePath: process.argv[2] || require('electron'), args: [...(packaged ? [] : [path.resolve(__dirname, '..')]), `--user-data-dir=${path.join(workspace, 'userData')}`], timeout: 60000 })
  const errors = []
  let activePage
  try {
    const page = await app.firstWindow()
    activePage = page
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: '项目菜单', exact: true }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: '项目名称', exact: true }).inputValue(), '未命名工程')
    assert.equal(await page.locator('.track-canvas .timeline-clip').count(), 0)
    assert.equal(await page.locator('.asset-filter-row b').first().innerText(), '0')
    assert.equal(await page.locator('.preview-gap-state').count(), 0)
    await page.getByRole('button', { name: '导入第一个素材', exact: true }).waitFor()
    await page.screenshot({ path: path.join(screenshots, `${prefix}-blank.png`) })

    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }) }, source)
    await page.getByRole('button', { name: '导入素材', exact: true }).click()
    await page.locator('.asset-card').first().waitFor()
    await page.locator('.asset-card').first().dblclick()
    await page.locator('.track-canvas .timeline-clip').first().waitFor()
    // The library must stay visible when the inspector is selected.
    assert.equal(await page.locator('.asset-card').count(), 1)
    await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('我的工程')
    await page.getByRole('textbox', { name: '项目名称', exact: true }).blur()
    await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }) }, firstPath)
    await page.getByRole('button', { name: '保存', exact: false }).filter({ hasText: '保存' }).first().click()
    await page.waitForFunction((target) => JSON.parse(localStorage.getItem('videome-session') || '{}').path === target, firstPath)
    const first = await fs.readFile(firstPath, 'utf8')
    assert.equal(JSON.parse(first).assets.length, 1)
    assert.ok(JSON.parse(first).clips.length > 0)

    await page.getByRole('button', { name: '工程位置', exact: true }).click()
    const location = page.getByRole('dialog', { name: '工程位置与本地文件', exact: true })
    await location.waitFor()
    assert.ok((await location.innerText()).includes(firstPath))
    await app.evaluate(({ shell }) => { global.__revealed = []; shell.showItemInFolder = (file) => global.__revealed.push(file) })
    await location.getByRole('button', { name: /在 .*显示/ }).click()
    assert.equal((await app.evaluate(() => global.__revealed))[0], await fs.realpath(firstPath))
    await page.screenshot({ path: path.join(screenshots, `${prefix}-location.png`) })
    await page.getByRole('button', { name: '关闭工程位置', exact: true }).click()

    const menu = async () => { await page.getByRole('button', { name: '项目菜单', exact: true }).click() }
    await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }) }, secondPath)
    await menu(); await page.getByRole('menuitem', { name: '另存为…', exact: true }).click()
    await page.waitForFunction((target) => JSON.parse(localStorage.getItem('videome-session') || '{}').path === target, secondPath)
    assert.equal(await fs.readFile(firstPath, 'utf8'), first)
    await page.reload()
    await page.getByRole('button', { name: '工程位置', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '工程位置', exact: true }).getAttribute('title'), secondPath)
    assert.equal(await page.locator('.asset-card').count(), 1)

    await menu(); await page.getByRole('menuitem', { name: /查看界面示例/ }).click()
    await page.locator('.example-badge').waitFor()
    assert.equal(await page.locator('.preview-gap-state').count(), 0)
    assert.equal(await page.locator('.asset-card').count(), 1)
    assert.ok((await page.locator('.illustration-title').innerText()).includes('未附带源文件'))
    await page.screenshot({ path: path.join(screenshots, `${prefix}-example.png`) })
    await menu(); await page.getByRole('menuitem', { name: '恢复切换前的工程', exact: true }).click()
    assert.equal(await page.getByRole('textbox', { name: '项目名称', exact: true }).inputValue(), '我的工程')
    assert.equal(await page.getByRole('button', { name: '工程位置', exact: true }).getAttribute('title'), secondPath)

    const originalCopy = await fs.readFile(secondPath, 'utf8')
    await menu(); await page.getByRole('menuitem', { name: '新建空白工程', exact: true }).click()
    assert.equal(await page.locator('.track-canvas .timeline-clip').count(), 0)
    assert.equal(await page.locator('.asset-card').count(), 1)
    assert.equal(await page.getByRole('button', { name: '工程位置', exact: true }).innerText(), '尚未保存')
    await page.waitForTimeout(6500)
    assert.equal(await fs.readFile(secondPath, 'utf8'), originalCopy)
    await menu(); await page.getByRole('menuitem', { name: '恢复切换前的工程', exact: true }).click()
    assert.ok(await page.locator('.track-canvas .timeline-clip').count() > 0)

    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, firstPath)
    await menu(); await page.getByRole('menuitem', { name: '打开工程…', exact: true }).click()
    await page.waitForFunction((target) => JSON.parse(localStorage.getItem('videome-session') || '{}').path === target, firstPath)
    for (const width of [1120, 1680]) {
      await page.setViewportSize({ width, height: 900 })
      assert.equal(await page.getByRole('button', { name: '项目菜单', exact: true }).isVisible(), true)
      assert.equal(await page.locator('.asset-panel').isVisible(), true)
      const outside = await page.locator('.batch-launch').evaluate((element) => element.getBoundingClientRect().right > window.innerWidth)
      assert.equal(outside, false)
    }
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ packaged, cleanStartup: true, library: true, save: true, saveAs: true, reveal: true, reload: true, newProjectPreservedOriginal: true, exampleAndRestore: true, open: true, widths: [1120,1680], errors }))
  } catch (error) {
    if (activePage) await activePage.screenshot({ path: path.join(screenshots, `${prefix}-failure.png`) }).catch(() => {})
    throw error
  } finally {
    await app.close()
    await fs.rm(workspace, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
