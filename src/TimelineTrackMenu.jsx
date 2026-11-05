import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, X } from 'lucide-react'

export function TimelineTrackMenu({ anchor, title, items, onClose }) {
  const menuRef = useRef(null)
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.top })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const menu = menuRef.current
    const bounds = menu.getBoundingClientRect()
    const above = anchor.top - bounds.height - 6
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(above >= 8 ? above : anchor.bottom + 6, window.innerHeight - bounds.height - 8)),
    })
    const previousFocus = document.activeElement
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
    return () => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }) }
  }, [anchor])

  useEffect(() => {
    const dismiss = (event) => { if (!menuRef.current?.contains(event.target)) closeRef.current() }
    const close = () => closeRef.current()
    const scroll = (event) => { if (!menuRef.current?.contains(event.target)) close() }
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', scroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', scroll, true)
    }
  }, [])

  function handleKeyDown(event) {
    event.stopPropagation()
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      onClose()
      return
    }
    const buttons = [...menuRef.current.querySelectorAll('button:not(:disabled)')]
    const current = buttons.indexOf(document.activeElement)
    let next
    if (event.key === 'ArrowDown') next = (current + 1) % buttons.length
    if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = buttons.length - 1
    if (next !== undefined) {
      event.preventDefault()
      buttons[next]?.focus({ preventScroll: true })
    }
  }

  return createPortal(
    <div className="timeline-track-menu" ref={menuRef} role="menu" aria-label={title} style={position} onKeyDown={handleKeyDown}>
      <div className="timeline-track-menu-title">{title}</div>
      {items.map(({ id, icon: Icon, label, hint, disabled, danger, action }) => (
        <button key={id} role="menuitem" disabled={disabled} className={danger ? 'track-menu-danger' : ''} onClick={() => { onClose(); action() }}>
          {Icon && <Icon size={14} />}
          <span>{label}{hint && <small>{hint}</small>}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

export function DeleteTrackDialog({ track, clipCount, linkedCount, onCancel, onConfirm }) {
  const dialogRef = useRef(null)
  useEffect(() => { dialogRef.current.showModal() }, [])

  return createPortal(
    <dialog ref={dialogRef} className="delete-track-dialog" aria-labelledby="delete-track-title" aria-describedby="delete-track-description" onCancel={(event) => { event.preventDefault(); onCancel() }}>
      <div className="dialog-header"><div><span className="eyebrow">TIMELINE TRACK</span><h2 id="delete-track-title">删除「{track.label}」？</h2></div><button className="icon-button compact" aria-label="取消删除轨道" onClick={onCancel}><X size={16} /></button></div>
      <p id="delete-track-description">将删除这条轨道及其中的 <b>{clipCount}</b> 个片段{linkedCount > 0 && <>，同时移除其他轨道上的 <b>{linkedCount}</b> 个联动片段</>}。</p>
      <p className="delete-track-note">源素材仍保留在素材库中。删除后可通过“撤销”恢复轨道和片段。</p>
      <div className="dialog-actions"><button autoFocus className="dialog-cancel" onClick={onCancel}>取消</button><button className="dialog-export delete-track-confirm" onClick={onConfirm}><Trash2 size={13} />删除轨道</button></div>
    </dialog>,
    document.body,
  )
}
