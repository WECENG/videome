// AppKit fullscreen transitions are asynchronous. Destroying a fullscreen child
// window before it leaves its Space can leave the fullscreen owner behind a
// black native surface, even though the owner's renderer is still healthy.
function managePreviewWindow(window, { owner, platform = process.platform } = {}) {
  let closing = false
  let allowClose = false
  let htmlFullscreen = false
  let nativeFullscreen = window.isFullScreen()
  let exitingHtml = false
  let exitingNative = false
  let finishScheduled = false

  const finishClose = () => {
    if (finishScheduled || window.isDestroyed()) return
    finishScheduled = true
    // Finish outside the fullscreen event callback so AppKit can finish its
    // native transition before we destroy the NSWindow.
    setImmediate(() => {
      finishScheduled = false
      if (window.isDestroyed() || htmlFullscreen || nativeFullscreen || window.isFullScreen()) return
      allowClose = true
      window.close()
    })
  }

  const leaveFullscreen = () => {
    if (!closing || window.isDestroyed()) return
    if (htmlFullscreen) {
      if (exitingHtml) return
      exitingHtml = true
      window.webContents.executeJavaScript('document.fullscreenElement ? document.exitFullscreen() : undefined')
        .then(() => { htmlFullscreen = false; exitingHtml = false; leaveFullscreen() })
        .catch(() => {
          // A renderer can fail while fullscreen. Still let AppKit leave the
          // fullscreen Space through the BrowserWindow API before closing.
          htmlFullscreen = false
          exitingHtml = false
          leaveFullscreen()
        })
      return
    }
    if (nativeFullscreen || window.isFullScreen()) {
      if (!exitingNative) {
        exitingNative = true
        window.setFullScreen(false)
      }
      return
    }
    if (!exitingNative) finishClose()
  }

  const onClose = (event) => {
    if (allowClose || platform !== 'darwin') return
    if (!closing && !htmlFullscreen && !nativeFullscreen && !window.isFullScreen()) return
    event.preventDefault()
    closing = true
    leaveFullscreen()
  }
  const onEnterNative = () => {
    // A close request can arrive while the enter animation is still running.
    nativeFullscreen = true
    exitingNative = false
    leaveFullscreen()
  }
  const onLeaveNative = () => { nativeFullscreen = false; exitingNative = false; leaveFullscreen() }
  const onEnterHtml = () => { htmlFullscreen = true; leaveFullscreen() }
  const onLeaveHtml = () => { htmlFullscreen = false; leaveFullscreen() }
  const onInput = (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return
    // Chromium handles Escape from HTML video fullscreen. Other Escape
    // requests close the preview through the same native transition guard.
    if (!htmlFullscreen) { event.preventDefault(); window.close() }
  }
  const closeWithOwner = () => { if (!window.isDestroyed()) window.close() }

  window.on('close', onClose)
  window.on('enter-full-screen', onEnterNative)
  window.on('leave-full-screen', onLeaveNative)
  window.webContents.on('enter-html-full-screen', onEnterHtml)
  window.webContents.on('leave-html-full-screen', onLeaveHtml)
  window.webContents.on('before-input-event', onInput)
  owner?.once('closed', closeWithOwner)
  window.once('closed', () => {
    owner?.removeListener('closed', closeWithOwner)
    if (owner && !owner.isDestroyed()) owner.focus()
  })
}

module.exports = { managePreviewWindow }
