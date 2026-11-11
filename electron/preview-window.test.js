import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const { managePreviewWindow } = createRequire(import.meta.url)('./preview-window.cjs')
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

class TestWindow extends EventEmitter {
  constructor(fullscreen = false) {
    super()
    this.fullscreen = fullscreen
    this.destroyed = false
    this.webContents = new EventEmitter()
    this.webContents.executeJavaScript = vi.fn().mockResolvedValue(undefined)
    this.setFullScreen = vi.fn((value) => { this.fullscreen = value })
    this.focus = vi.fn()
    this.closeRequests = 0
  }
  isFullScreen() { return this.fullscreen }
  isDestroyed() { return this.destroyed }
  close() {
    this.closeRequests += 1
    const event = { prevented: false, preventDefault() { this.prevented = true } }
    this.emit('close', event)
    if (event.prevented) return
    this.destroyed = true
    this.emit('closed')
  }
}

describe('preview native fullscreen close lifecycle', () => {
  it('waits for macOS leave-full-screen before closing and preserves the fullscreen owner', async () => {
    const owner = new TestWindow(true)
    const preview = new TestWindow(true)
    managePreviewWindow(preview, { owner, platform: 'darwin' })
    preview.close()
    expect(preview.setFullScreen).toHaveBeenCalledWith(false)
    await nextTurn()
    expect(preview.isDestroyed()).toBe(false)
    expect(owner.focus).not.toHaveBeenCalled()
    preview.emit('leave-full-screen')
    expect(preview.isDestroyed()).toBe(false)
    await nextTurn()
    expect(preview.isDestroyed()).toBe(true)
    expect(owner.isFullScreen()).toBe(true)
    expect(owner.setFullScreen).not.toHaveBeenCalled()
    expect(owner.focus).toHaveBeenCalledOnce()
  })

  it('exits HTML fullscreen before exiting the native Space, including repeated close requests', async () => {
    const preview = new TestWindow(true)
    managePreviewWindow(preview, { platform: 'darwin' })
    preview.webContents.emit('enter-html-full-screen')
    preview.close()
    preview.close()
    expect(preview.webContents.executeJavaScript).toHaveBeenCalledOnce()
    expect(preview.setFullScreen).not.toHaveBeenCalled()
    await nextTurn()
    expect(preview.isDestroyed()).toBe(false)
    expect(preview.setFullScreen).toHaveBeenCalledOnce()
    preview.emit('leave-full-screen')
    await nextTurn()
    expect(preview.isDestroyed()).toBe(true)
  })

  it('still leaves the native Space when the fullscreen renderer has failed', async () => {
    const preview = new TestWindow(true)
    preview.webContents.executeJavaScript.mockRejectedValue(new Error('renderer gone'))
    managePreviewWindow(preview, { platform: 'darwin' })
    preview.webContents.emit('enter-html-full-screen')
    preview.close()
    await nextTurn()
    expect(preview.isDestroyed()).toBe(false)
    expect(preview.setFullScreen).toHaveBeenCalledWith(false)
    preview.emit('leave-full-screen')
    await nextTurn()
    expect(preview.isDestroyed()).toBe(true)
  })

  it('handles a close request during entry without destroying the fullscreen window', async () => {
    const preview = new TestWindow()
    managePreviewWindow(preview, { platform: 'darwin' })
    // isFullScreen changes before AppKit finishes the enter animation.
    preview.fullscreen = true
    preview.close()
    preview.emit('enter-full-screen')
    await nextTurn()
    expect(preview.isDestroyed()).toBe(false)
    preview.emit('leave-full-screen')
    await nextTurn()
    expect(preview.isDestroyed()).toBe(true)
  })

  it('lets Chromium exit HTML fullscreen on Escape without closing the preview', () => {
    const preview = new TestWindow(true)
    managePreviewWindow(preview, { platform: 'darwin' })
    preview.webContents.emit('enter-html-full-screen')
    const event = { preventDefault: vi.fn() }
    preview.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(preview.closeRequests).toBe(0)
  })

  it('closes a windowed preview immediately, including Escape and owner shutdown', () => {
    const owner = new TestWindow(true)
    const preview = new TestWindow()
    managePreviewWindow(preview, { owner, platform: 'darwin' })
    const event = { preventDefault: vi.fn() }
    preview.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' })
    expect(preview.isDestroyed()).toBe(true)
    expect(preview.setFullScreen).not.toHaveBeenCalled()
    expect(owner.listenerCount('closed')).toBe(0)
    const another = new TestWindow()
    managePreviewWindow(another, { owner, platform: 'darwin' })
    owner.close()
    expect(another.isDestroyed()).toBe(true)
  })

  it('keeps the ordinary Windows close behavior', () => {
    const preview = new TestWindow(true)
    managePreviewWindow(preview, { platform: 'win32' })
    preview.close()
    expect(preview.isDestroyed()).toBe(true)
    expect(preview.setFullScreen).not.toHaveBeenCalled()
  })
})
