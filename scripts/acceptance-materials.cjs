const fs = require('node:fs/promises')
const path = require('node:path')
const { root } = require('./media-tools.cjs')
async function main() {
  const destination = path.join(root, 'release/manual-acceptance')
  await fs.mkdir(destination, { recursive: true })
  await fs.cp(path.join(root, 'output/manual-acceptance'), destination, { recursive: true })
  await fs.copyFile(path.join(root, 'docs/CROSS-PLATFORM-ACCEPTANCE.md'), path.join(destination, '验收步骤.md'))
  await fs.copyFile(path.join(root, 'scripts/installed-diagnostics.ps1'), path.join(destination, '收集Windows诊断.ps1'))
  await fs.writeFile(path.join(destination, 'result.json'), JSON.stringify({ appVersion: require('../package.json').version, platform: process.platform, architecture: process.arch, build: 'passed', automaticChecks: 'passed', manualAcceptance: 'pending', tester: '', osVersion: '', checks: [], notes: '' }, null, 2))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
