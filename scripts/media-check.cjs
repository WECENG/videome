const path = require('node:path')
const { root, checkMedia, digest } = require('./media-tools.cjs')
const manifest = require('../resources/media-sources.json')
async function main() {
  await checkMedia(process.argv[2] || path.join(root, 'media-bin', `${process.platform}-${process.arch}`))
  if (await digest(path.join(root, 'resources/fonts/NotoSansCJKsc-Regular.otf')) !== manifest.font.sha256) throw new Error('字体摘要不匹配。')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
