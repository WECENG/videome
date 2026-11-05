const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

async function syncDirectory(directory, platform = process.platform) {
  // Windows does not expose POSIX directory fsync through Node. File data is still flushed.
  if (platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function replaceFile(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rename(source, target); return } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

async function publishExclusive(partial, target) {
  const handle = await fs.open(partial, 'r+')
  try { await handle.sync() } finally { await handle.close() }
  await fs.link(partial, target)
  await syncDirectory(path.dirname(target))
  await fs.rm(partial)
}

async function checkOutputDirectory(directory) {
  const token = `.videome-check-${crypto.randomUUID()}`
  const source = path.join(directory, token)
  const linked = `${source}.link`
  try {
    const handle = await fs.open(source, 'wx')
    try { await handle.writeFile('Videome'); await handle.sync() } finally { await handle.close() }
    await fs.link(source, linked)
    await fs.statfs(directory)
    await syncDirectory(directory)
  } catch (error) {
    if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV'].includes(error.code)) {
      throw Object.assign(new Error('输出目录不支持所需的独占发布或写入操作。请使用可写的本地 APFS / NTFS 目录。'), { code: error.code })
    }
    throw error
  } finally {
    await Promise.all([source, linked].map((file) => fs.rm(file, { force: true }).catch(() => {})))
  }
}

module.exports = { syncDirectory, replaceFile, publishExclusive, checkOutputDirectory }
