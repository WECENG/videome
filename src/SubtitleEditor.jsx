import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, Expand, FolderOpen, Minimize2, Pause, Play, Plus, Settings2, Trash2, Undo2 } from 'lucide-react'
import { formatSubtitleTime, parseSubtitleTime, subtitleOverlapIds, subtitleTimingError } from './subtitle-domain.js'
import './subtitle-editor.css'

function SubtitleRow({ cue, index, selected, overlap, playing, onSelect, onChange, onDelete, onPlay, onEditing }) {
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState('')
  const textareaRef = useRef(null)
  const textEditedRef = useRef(false)
  const draftRef = useRef(null)
  const cancelledRef = useRef(false)
  const times = draft || { start: formatSubtitleTime(cue.start), end: formatSubtitleTime(cue.end) }

  useLayoutEffect(() => {
    const field = textareaRef.current
    const fit = () => {
      field.style.height = '0px'
      field.style.height = `${Math.max(selected ? 88 : 52, field.scrollHeight + 2)}px`
    }
    fit()
    // Width changes must reflow even before the user types anything.
    let lastWidth = field.clientWidth
    const observer = new ResizeObserver(() => {
      if (field.clientWidth !== lastWidth) { lastWidth = field.clientWidth; fit() }
    })
    observer.observe(field)
    return () => observer.disconnect()
  }, [cue.text, selected])

  function commitTime() {
    if (cancelledRef.current) { cancelledRef.current = false; return }
    const value = draftRef.current
    if (!value) return
    const start = parseSubtitleTime(value.start), end = parseSubtitleTime(value.end)
    const reason = subtitleTimingError(start, end)
    setError(reason)
    if (reason) return
    if (start !== cue.start || end !== cue.end) onChange(cue.id, { start, end })
    draftRef.current = null
    setDraft(null)
  }

  function nudge(edge, delta) {
    const start = edge === 'start' ? Math.max(0, Math.round((cue.start + delta) * 1000) / 1000) : cue.start
    const end = edge === 'end' ? Math.round((cue.end + delta) * 1000) / 1000 : cue.end
    const reason = subtitleTimingError(start, end)
    setError(reason)
    if (!reason) {
      draftRef.current = null
      setDraft(null)
      onChange(cue.id, { start, end })
    }
  }

  return <div className={`subtitle-editor-row ${selected ? 'is-selected' : ''}`} data-cue-id={cue.id}
    onFocusCapture={(event) => { if (event.target.matches('input, textarea')) { onEditing(true); onSelect(cue, false) } }}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onEditing(false) }}>
    <button className="subtitle-editor-number" aria-label={`定位第 ${index + 1} 句`} aria-pressed={selected} onClick={() => onSelect(cue, true)}>{String(index + 1).padStart(2, '0')}</button>
    <div className="subtitle-editor-fields">
      <div className="subtitle-editor-times">
        {['start', 'end'].map((edge) => <React.Fragment key={edge}>
          {edge === 'end' && <span aria-hidden="true">→</span>}
          <input aria-label={`第 ${index + 1} 句${edge === 'start' ? '起始' : '结束'}时间`} aria-invalid={Boolean(error)}
            aria-describedby={error ? `cue-error-${cue.id}` : undefined} value={times[edge]} spellCheck={false}
            onChange={(event) => { const next = { ...times, [edge]: event.target.value }; draftRef.current = next; setDraft(next); setError('') }}
            onBlur={commitTime}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
              if (event.key === 'Escape') { event.stopPropagation(); cancelledRef.current = true; draftRef.current = null; setDraft(null); setError(''); event.currentTarget.blur() }
            }} />
        </React.Fragment>)}
        <span className="subtitle-editor-duration">{(cue.end - cue.start).toFixed(1)} 秒</span>
        <button className="subtitle-editor-delete" aria-label={`删除第 ${index + 1} 句`} onClick={() => onDelete(cue)}><Trash2 size={14} /></button>
      </div>
      <textarea ref={textareaRef} aria-label={`第 ${index + 1} 句字幕内容`} rows={2} value={cue.text}
        onChange={(event) => { onChange(cue.id, { text: event.target.value }, !textEditedRef.current); textEditedRef.current = true }}
        onBlur={() => { textEditedRef.current = false }} />
      {error && <p className="subtitle-editor-error" id={`cue-error-${cue.id}`} role="alert">{error}</p>}
      {!error && overlap && <p className="subtitle-editor-overlap">与其他字幕时间重叠</p>}
      {selected && <div className="subtitle-editor-row-actions">
        <button className="subtitle-editor-play" onClick={() => onPlay(cue)}>{playing ? <Pause size={13} /> : <Play size={13} />} {playing ? '暂停' : '播放此句'}</button>
        {['start', 'end'].map((edge) => <div className="subtitle-editor-nudge" key={edge}>
          <span>{edge === 'start' ? '起点' : '终点'}</span>
          <button aria-label={`${edge === 'start' ? '起点' : '终点'}提前 0.1 秒`} onClick={() => nudge(edge, -0.1)}>−0.1</button>
          <button aria-label={`${edge === 'start' ? '起点' : '终点'}延后 0.1 秒`} onClick={() => nudge(edge, 0.1)}>+0.1</button>
        </div>)}
      </div>}
    </div>
  </div>
}

export default function SubtitleEditor({ cues, selectedCueId, activeCueId, playing, auditionCueId, workbench, onWorkbench, onCollapse, onSelect, onChange, onDelete, onPlay, onAdd, onImport, onExport, onUndo, canUndo, modelControls, styleControls, recognitionNotice }) {
  const listRef = useRef(null)
  const editingRef = useRef(false)
  const lastFollowedRef = useRef(null)
  const [follow, setFollow] = useState(true)
  const [followPaused, setFollowPaused] = useState(false)
  const [showStyle, setShowStyle] = useState(false)
  const overlaps = useMemo(() => subtitleOverlapIds(cues), [cues])
  const ordered = useMemo(() => [...cues].sort((a, b) => a.start - b.start || a.end - b.end), [cues])
  const selectedIndex = ordered.findIndex((cue) => cue.id === selectedCueId)
  const playingCueId = activeCueId

  function reveal(id) {
    const list = listRef.current
    const row = [...list.children].find((element) => element.dataset.cueId === id)
    if (!row) return
    const container = list.getBoundingClientRect(), bounds = row.getBoundingClientRect()
    if (bounds.top < container.top || bounds.bottom > container.bottom) list.scrollTop += bounds.top - container.top - 12
  }

  useEffect(() => {
    if (!playing || !follow || followPaused || editingRef.current || !playingCueId || lastFollowedRef.current === playingCueId) return
    lastFollowedRef.current = playingCueId
    const cue = cues.find((item) => item.id === playingCueId)
    onSelect(cue, false)
    reveal(playingCueId)
  }, [playing, follow, followPaused, playingCueId, onSelect, cues])

  useEffect(() => {
    if (editingRef.current || !selectedCueId) return undefined
    // Selection expands the row. Wait until all child layout effects and
    // any pending font/layout changes have settled before scrolling it.
    const frame = requestAnimationFrame(() => reveal(selectedCueId))
    return () => cancelAnimationFrame(frame)
  }, [selectedCueId, workbench])

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (!editingRef.current && !followPaused && selectedCueId) reveal(selectedCueId)
    })
    observer.observe(listRef.current)
    return () => observer.disconnect()
  }, [selectedCueId, followPaused])

  function select(cue, seek) { if (seek) lastFollowedRef.current = null; onSelect(cue, seek) }
  function adjacent(delta) {
    const index = selectedIndex < 0 ? 0 : selectedIndex + delta
    const cue = ordered[Math.max(0, Math.min(ordered.length - 1, index))]
    if (cue) { select(cue, true); reveal(cue.id) }
  }

  return <div className="subtitle-editor">
    {modelControls}
    {recognitionNotice && <div className="subtitle-editor-notice"><span>{recognitionNotice}</span><button onClick={() => onWorkbench(true)}>打开工作台 <Expand size={13} /></button></div>}
    <div className="subtitle-editor-toolbar">
      <div className="subtitle-editor-title"><h3>{workbench ? '字幕工作台' : '字幕行'}</h3><span>{cues.length} 行</span></div>
      <button className="subtitle-editor-expand" onClick={() => onWorkbench(!workbench)}>{workbench ? <Minimize2 size={14} /> : <Expand size={14} />}{workbench ? '收起工作台' : '展开工作台'}</button>
      {!workbench && <button className="subtitle-editor-collapse" aria-label="收起字幕侧栏" onClick={onCollapse}><ChevronRight size={14} /></button>}
      <div className="subtitle-editor-tools">
        <button onClick={onAdd}><Plus size={14} />添加</button>
        <button onClick={onImport}><FolderOpen size={14} />导入</button>
        <button onClick={onExport} disabled={!cues.length}><Download size={14} />导出 SRT</button>
        <button onClick={onUndo} disabled={!canUndo} aria-label="撤销字幕编辑"><Undo2 size={14} /></button>
        <button aria-expanded={showStyle} aria-label="字幕样式" onClick={() => setShowStyle(!showStyle)}><Settings2 size={14} /></button>
      </div>
    </div>
    {showStyle && <div className="subtitle-editor-style">{styleControls}</div>}
    <div className="subtitle-editor-list" ref={listRef} aria-label="字幕列表"
      onWheel={() => { if (playing && follow) setFollowPaused(true) }}
      onTouchMove={() => { if (playing && follow) setFollowPaused(true) }}
      onPointerDown={(event) => { if (playing && follow && event.target === event.currentTarget) setFollowPaused(true) }}>
      {ordered.map((cue, index) => <SubtitleRow key={cue.id} cue={cue} index={index} selected={selectedCueId === cue.id}
        overlap={overlaps.has(cue.id)} playing={playing && auditionCueId === cue.id}
        onSelect={select} onChange={onChange} onDelete={onDelete} onPlay={onPlay}
        onEditing={(value) => { editingRef.current = value; if (value && playing && follow) setFollowPaused(true) }} />)}
      {!cues.length && <div className="subtitle-editor-empty"><h3>开始校对你的字幕</h3><p>识别音视频片段、导入 SRT，或添加字幕行。</p><button onClick={onAdd}><Plus size={15} />添加第一句字幕</button></div>}
    </div>
    <div className="subtitle-editor-footer">
      <span>{selectedIndex >= 0 ? `第 ${selectedIndex + 1} / ${cues.length} 句` : '原语字幕'}<small>更改同步至时间线 · 可撤销</small></span>
      {Boolean(cues.length) && <div className="subtitle-editor-follow">
        <label><input type="checkbox" checked={follow} onChange={(event) => { setFollow(event.target.checked); setFollowPaused(false); lastFollowedRef.current = null }} />跟随播放</label>
        {follow && followPaused && <button onClick={() => { editingRef.current = false; setFollowPaused(false); lastFollowedRef.current = null }}>恢复跟随</button>}
      </div>}
      <div><button aria-label="上一句字幕" disabled={selectedIndex <= 0} onClick={() => adjacent(-1)}><ChevronLeft size={16} /></button><button aria-label="下一句字幕" disabled={!cues.length || selectedIndex === ordered.length - 1} onClick={() => adjacent(1)}><ChevronRight size={16} /></button></div>
    </div>
  </div>
}
