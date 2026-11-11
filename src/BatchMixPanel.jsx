import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FolderOpen, Headphones, LoaderCircle, Pause, Play, RefreshCw, Scissors, Upload, Volume2, X } from 'lucide-react'
import './batch-mix.css'

const statuses = { analyzing: '分析中', ready: '等待开始', queued: '排队中', running: '生成中', pausing: '正在暂停', paused: '已暂停', cancelling: '正在取消', cancelled: '已取消', interrupted: '可恢复', completed: '全部成功', partial_failed: '部分失败', analysis_failed: '分析失败', recovering: '校验恢复中' }
const phases = { fingerprint: '校验源视频与背景音乐', probe: '读取媒体信息', scenes: '识别镜头边界', planning: '生成唯一剪辑序列', ready: '分析完成' }
const itemStatuses = { queued: '等待', rendering: '编码', verifying: '校验', publishing: '发布', completed: '成功', failed: '失败' }
const sizeText = (bytes) => `${((bytes || 0) / 1024 ** 3).toFixed(2)} GB`
const basename = (value = '') => value.split(/[\\/]/).pop() || value
const audioExtensions = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'aiff', 'ogg']
const audioTime = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(value / 60)
  return `${minutes}:${(value - minutes * 60).toFixed(1).padStart(4, '0')}`
}

export default function BatchMixPanel({ assets = [], frameSize, currentProject, onOpenProject, onClose }) {
  const api = window.videome
  const audioAssets = useMemo(() => assets.filter((asset) => asset.kind === 'audio' && asset.path), [assets])
  const [form, setForm] = useState(() => ({ sourcePath: assets.find((asset) => asset.kind === 'video' && asset.path)?.path || '', outputDirectory: '', segmentSeconds: 3, targetSeconds: 30, count: '', seed: crypto.randomUUID().slice(0, 8), fps: 30, concurrency: 'auto', alignScenes: true, threshold: 0.35, backgroundAudio: null }))
  const [jobs, setJobs] = useState([])
  const [selected, setSelected] = useState(null)
  const [step, setStep] = useState('prepare')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [resultPage, setResultPage] = useState(0)
  const [audioPreview, setAudioPreview] = useState(false)
  const [resultFilter, setResultFilter] = useState('all')
  const mounted = useRef(true)
  const audioRef = useRef(null)
  const job = jobs.find((entry) => entry.id === selected)

  const updateJob = (next) => setJobs((current) => {
    if (!next?.id || current.some((entry) => entry.id === next.id && entry.revision > next.revision)) return current
    return [next, ...current.filter((entry) => entry.id !== next.id)].sort((first, second) => second.createdAt.localeCompare(first.createdAt))
  })

  useEffect(() => {
    mounted.current = true
    if (!api?.listBatchMixJobs) return undefined
    api.listBatchMixJobs().then((result) => {
      if (!mounted.current) return
      if (result?.ok === false) setError(result.reason)
      else { setJobs(result); setSelected((current) => current || result[0]?.id || null) }
    }).catch((failure) => setError(failure.message))
    const dispose = api.onBatchMixProgress(updateJob)
    const escape = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => { mounted.current = false; dispose?.(); window.removeEventListener('keydown', escape) }
  }, [])

  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null }, [])

  useEffect(() => {
    if (!job) return
    if (['running', 'queued', 'paused', 'pausing', 'cancelling', 'recovering'].includes(job.status)) setStep('render')
    else if (['completed', 'partial_failed'].includes(job.status)) setStep('results')
    else if (['analyzing', 'ready', 'analysis_failed'].includes(job.status)) setStep('analysis')
  }, [job?.status])

  const invoke = async (operation) => {
    setBusy(true); setError('')
    try {
      const result = await operation()
      if (result?.ok === false) throw new Error(result.reason)
      if (result?.id) updateJob(result)
      return result
    } catch (failure) { setError(failure.message); return null }
    finally { if (mounted.current) setBusy(false) }
  }
  const field = (name, value) => setForm((current) => ({ ...current, [name]: value }))
  const restoreJobForm = (entry = job) => {
    if (!entry?.options) return
    const options = entry.options
    const generatedDirectory = entry.outputDirectory || ''
    const outputDirectory = generatedDirectory.replace(/[\\/][^\\/]*$/, '') || generatedDirectory
    setForm((current) => ({
      ...current,
      sourcePath: entry.sourcePath || entry.source?.path || current.sourcePath,
      outputDirectory: outputDirectory || current.outputDirectory,
      segmentSeconds: options.segmentSeconds ?? current.segmentSeconds,
      targetSeconds: options.targetSeconds ?? current.targetSeconds,
      count: options.count ?? current.count,
      seed: options.seed ?? current.seed,
      fps: options.fps ?? current.fps,
      concurrency: options.concurrency ?? current.concurrency,
      alignScenes: options.alignScenes !== false,
      threshold: options.threshold ?? current.threshold,
      backgroundAudio: options.backgroundAudio ? { ...options.backgroundAudio } : null,
    }))
  }
  const enterStep = (nextStep) => {
    if (nextStep === 'prepare') restoreJobForm()
    setStep(nextStep)
  }
  const pickSource = () => invoke(async () => { const paths = await api.pickMedia(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'mxf']); if (paths?.length) field('sourcePath', paths[0]); return null })
  const pickAudioFile = () => invoke(async () => {
    const paths = await api.pickMedia(audioExtensions)
    if (!paths?.[0]) return null
    return chooseAudio({ path: paths[0], name: basename(paths[0]) })
  })
  const chooseAudio = async (audio) => {
    if (!audio?.path) return null
    let details = audio
    const asset = audioAssets.find((entry) => entry.path === audio.path)
    if (asset) details = { ...asset, ...audio, name: audio.name || asset.name, duration: audio.duration || asset.duration }
    if (api?.probeBatchAudio) {
      const probed = await api.probeBatchAudio(audio.path)
      if (probed?.ok !== false) details = { ...details, ...probed }
    }
    field('backgroundAudio', { path: details.path, name: details.name || basename(details.path), duration: Number(details.duration) || 0, volume: form.backgroundAudio?.volume ?? 0.22, mixMode: form.backgroundAudio?.mixMode || 'mix', start: Math.min(Number(form.backgroundAudio?.start) || 0, Math.max(0, (Number(details.duration) || 0) - 0.1)), lengthMode: 'loop', fadeOut: form.backgroundAudio?.fadeOut ?? 1.5, ducking: 'auto' })
    setAudioPreview(false)
    return null
  }
  const chooseAsset = (event) => { const path = event.target.value; const asset = audioAssets.find((entry) => entry.path === path); if (asset) void invoke(() => chooseAudio(asset)) }
  const removeAudio = () => field('backgroundAudio', null)
  const setMixMode = (mixMode) => field('backgroundAudio', form.backgroundAudio ? { ...form.backgroundAudio, mixMode } : form.backgroundAudio)
  const updateBackgroundAudio = (patch) => field('backgroundAudio', form.backgroundAudio ? { ...form.backgroundAudio, ...patch } : form.backgroundAudio)
  const toggleAudioPreview = async () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
      setAudioPreview(false)
      return
    }
    const sourcePath = form.backgroundAudio?.path
    if (!sourcePath) return
    try {
      const result = await api.requestMedia?.([sourcePath])
      const url = result?.files?.[0]?.url || `file://${sourcePath.replace(/\\/g, '/')}`
      const audio = new Audio(url)
      audio.addEventListener('ended', () => { audioRef.current = null; setAudioPreview(false) }, { once: true })
      await audio.play()
      audioRef.current = audio
      setAudioPreview(true)
    } catch (failure) { setError(`试听失败：${failure.message}`) }
  }
  const analyze = () => invoke(async () => {
    const result = await api.createBatchMixAnalysis({ ...form, width: frameSize.width, height: frameSize.height })
    if (result?.jobId) { setSelected(result.jobId); updateJob(await api.getBatchMixJob(result.jobId)); setResultPage(0); setStep('analysis') }
    return result
  })
  const start = () => invoke(async () => { const result = await api.startBatchMix(job.id); setStep('render'); return result })
  const openRepresentative = (item) => invoke(async () => { const result = await api.createBatchMixProject({ jobId: job.id, index: item.index, currentProject: currentProject() }); if (result?.ok) { onOpenProject(result.data, result.path); onClose() } return result })
  const relocate = () => invoke(async () => {
    const sourcePaths = await api.pickMedia(['mp4', 'mov', 'mkv', 'webm', 'm4v'])
    if (!sourcePaths?.[0]) return null
    return api.resumeBatchMix({ jobId: job.id, sourcePath: sourcePaths[0] })
  })
  const relocateBackground = () => invoke(async () => {
    const audioPaths = await api.pickMedia(audioExtensions)
    if (!audioPaths?.[0]) return null
    return api.resumeBatchMix({ jobId: job.id, backgroundAudioPath: audioPaths[0] })
  })
  const retryFailed = () => invoke(() => api.retryBatchMix(job.id))
  const removeJob = () => invoke(async () => {
    const result = await api.removeBatchMix(job.id)
    if (result?.ok) { setJobs((current) => current.filter((entry) => entry.id !== job.id)); setSelected(null); setStep('prepare') }
    return result
  })

  const completed = job?.counts?.completed || 0
  const progress = job?.items?.length ? job.items.reduce((sum, item) => sum + (item.status === 'completed' ? 100 : item.percent || 0), 0) / job.items.length : 0
  const firstSuccess = job?.items?.find((item) => item.status === 'completed')
  const visibleItems = job?.items?.slice(resultPage * 25, resultPage * 25 + 25) || []
  const requestedCount = Number(form.count)
  const validCount = Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 1000
  const hasBackground = Boolean(form.backgroundAudio?.path)
  const filteredItems = visibleItems.filter((item) => resultFilter === 'all' || (resultFilter === 'success' ? item.status === 'completed' : item.status === 'failed'))

  const renderAudioCard = () => <div className="batch-audio-card">
    <div className="batch-audio-heading"><div><span className="batch-kicker">BACKGROUND AUDIO</span><h3>统一背景音乐</h3></div><span className="batch-audio-badge"><Headphones size={12} />每条成片复用</span></div>
    <div className="batch-audio-source"><select aria-label="从素材库选择背景音乐" value={form.backgroundAudio?.path || ''} onChange={chooseAsset}><option value="">从素材库选择…</option>{audioAssets.map((asset) => <option key={asset.id} value={asset.path}>{asset.name || basename(asset.path)}</option>)}</select><button type="button" onClick={pickAudioFile} disabled={busy}><Upload size={14} />导入音频</button></div>
    {form.backgroundAudio ? <div className="batch-audio-selected"><div className="batch-audio-icon"><Volume2 size={17} /></div><div className="batch-audio-copy"><strong>{form.backgroundAudio.name}</strong><span>{form.backgroundAudio.duration ? `${form.backgroundAudio.duration.toFixed(1)} 秒` : '时长待探测'} · 每条从 0:00 开始</span></div><button type="button" className="batch-icon-button" onClick={toggleAudioPreview} aria-label={audioPreview ? '暂停试听' : '试听'}>{audioPreview ? <Pause size={14} /> : <Play size={14} />}</button><button type="button" className="batch-icon-button" onClick={() => { audioRef.current?.pause(); audioRef.current = null; setAudioPreview(false); removeAudio() }} aria-label="移除背景音乐"><X size={14} /></button></div> : <div className="batch-audio-empty">背景音乐可选。选择项目素材库音频或导入本地音乐；添加后会循环铺满，末尾 1.5 秒淡出。</div>}
    {hasBackground && <><div className="batch-segmented" role="group" aria-label="背景音乐策略"><button type="button" className={form.backgroundAudio.mixMode === 'mix' ? 'active' : ''} onClick={() => setMixMode('mix')}>混合 · 保留原声</button><button type="button" className={form.backgroundAudio.mixMode === 'replace' ? 'active' : ''} onClick={() => setMixMode('replace')}>替换 · 仅背景音乐</button></div><div className="batch-audio-controls"><label className="batch-audio-volume"><span>音乐音量 <b>{Math.round((form.backgroundAudio.volume ?? 0.22) * 100)}%</b></span><input aria-label="背景音乐音量" type="range" min="0" max="1" step="0.01" value={form.backgroundAudio.volume ?? 0.22} onChange={(event) => updateBackgroundAudio({ volume: Number(event.target.value) })} /></label><label className="batch-audio-start-control"><span>起点 <b>{audioTime(form.backgroundAudio.start)}</b></span><input aria-label="背景音乐起点" type="range" min="0" max={Math.max(0, (Number(form.backgroundAudio.duration) || 0) - 0.1)} step="0.1" value={Math.min(Number(form.backgroundAudio.start) || 0, Math.max(0, (Number(form.backgroundAudio.duration) || 0) - 0.1))} onChange={(event) => updateBackgroundAudio({ start: Number(event.target.value) })} /></label><label className="batch-audio-fade"><span>末尾淡出</span><select aria-label="背景音乐淡出时长" value={String(form.backgroundAudio.fadeOut ?? 1.5)} onChange={(event) => updateBackgroundAudio({ fadeOut: Number(event.target.value) })}>{[0, 0.5, 1.5, 3, 5].filter((value) => value <= Math.max(0, Number(form.targetSeconds) || 30)).map((value) => <option key={value} value={value}>{value === 0 ? '关闭' : `${value} 秒`}</option>)}</select></label></div></>}
  </div>

  return <div className="dialog-scrim batch-scrim"><section className="batch-dialog batch-wizard" role="dialog" aria-modal="true" aria-labelledby="batch-title">
    <header className="batch-header"><div><span className="eyebrow">LOCAL BATCH STUDIO</span><h2 id="batch-title">批量混剪</h2><p>先配置一次，再让每条成片保持一致的声音策略。</p></div><button aria-label="关闭批量混剪" onClick={onClose}><X size={20} /></button></header>
    {!api?.createBatchMixAnalysis ? <p className="batch-error">批量混剪需要使用 Videome 桌面版。</p> : <>
      <nav className="batch-steps" aria-label="批量混剪步骤">{[['prepare', '准备'], ['analysis', '分析'], ['render', '批次'], ['results', '结果']].map(([id, label], index) => <button type="button" key={id} className={step === id ? 'active' : ''} aria-current={step === id ? 'step' : undefined} onClick={() => (id === 'prepare' || job ? enterStep(id) : null)}>{index + 1} {label}</button>)}</nav>
      {step === 'prepare' && <div className="batch-step-view"><div className="batch-prep-grid"><div className="batch-config batch-panel"><div className="batch-panel-heading"><div><span className="batch-kicker">01 / SOURCE</span><h3>素材与输出</h3></div><span className="batch-panel-note">一次配置，批量复用</span></div><label>源视频<div className="batch-path"><input aria-label="混剪源视频" value={form.sourcePath} onChange={(event) => field('sourcePath', event.target.value)} list="batch-sources" /><button type="button" onClick={pickSource} disabled={busy} aria-label="选择混剪源视频"><FolderOpen size={16} /></button></div></label><datalist id="batch-sources">{assets.filter((asset) => asset.kind === 'video' && asset.path).map((asset) => <option key={asset.id} value={asset.path}>{asset.name}</option>)}</datalist><label>输出目录<div className="batch-path"><input aria-label="混剪输出目录" value={form.outputDirectory} onChange={(event) => field('outputDirectory', event.target.value)} /><button type="button" aria-label="选择混剪输出目录" disabled={busy} onClick={() => invoke(async () => { const result = await api.pickBatchOutputDirectory(); if (result) field('outputDirectory', result.path); return null })}><FolderOpen size={16} /></button></div></label><div className="batch-fields">{[['segmentSeconds', '片段时长（秒）', 0.1, 3600, 0.1], ['targetSeconds', '成片时长（秒）', 0.1, 3600, 0.1], ['count', '生成数量（条）', 1, 1000, 1]].map(([name, label, min, max, stepValue]) => <label key={name}>{label}<input aria-label={label} type="number" min={min} max={max} step={stepValue} required={name === 'count'} placeholder={name === 'count' ? '请输入 1–1000' : undefined} value={form[name]} onChange={(event) => field(name, event.target.value)} /></label>)}</div><details><summary>高级设置</summary><div className="batch-fields"><label>输出帧率<select aria-label="混剪输出帧率" value={form.fps} onChange={(event) => field('fps', Number(event.target.value))}>{[24, 25, 30, 50, 60].map((value) => <option key={value} value={value}>{value} fps</option>)}</select></label><label>最大并发<select aria-label="混剪最大并发" value={form.concurrency} onChange={(event) => field('concurrency', event.target.value)}><option value="auto">自动 · 1–2 路</option>{[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value} 路</option>)}</select></label><label>随机种子<input aria-label="随机种子" value={form.seed} onChange={(event) => field('seed', event.target.value)} /></label><label>镜头检测阈值<input aria-label="镜头检测阈值" type="number" min="0.01" max="0.99" step="0.01" value={form.threshold} onChange={(event) => field('threshold', event.target.value)} /></label></div><label className="batch-check"><input type="checkbox" checked={form.alignScenes} onChange={(event) => field('alignScenes', event.target.checked)} />优先对齐附近镜头边界</label></details></div><div className="batch-prep-side">{renderAudioCard()}<div className="batch-preview-card"><div className="batch-preview-label"><span>音频预览</span><b>每条成片统一</b></div><div className="batch-film-preview"><strong>{basename(form.sourcePath) || '尚未选择源视频'}</strong><span>{form.targetSeconds || 30}s</span></div><div className="batch-wave" aria-label="背景音乐波形">{Array.from({ length: 36 }, (_, index) => <i key={index} style={{ height: `${8 + ((index * 17) % 34)}px` }} />)}</div><div className="batch-preview-stats"><span>背景音乐 <b>{hasBackground ? `${Math.round((form.backgroundAudio.volume ?? 0.22) * 100)}%` : '未选择'}</b></span><span>原声 <b>{hasBackground && form.backgroundAudio.mixMode === 'replace' ? '替换' : '保留'}</b></span><span>长度 <b>{hasBackground ? '循环 + 淡出' : '不添加'}</b></span></div></div></div></div><div className="batch-step-footer"><span>分析会识别镜头边界并生成不重复的剪辑序列；背景音乐为可选项。</span><button className="batch-primary" type="button" disabled={busy || !form.sourcePath || !form.outputDirectory || !validCount} onClick={analyze}>{busy ? <LoaderCircle size={15} className="loading-spin" /> : <Scissors size={15} />}分析并生成方案</button></div></div>}
      {step === 'analysis' && <div className="batch-step-view"><div className="batch-analysis-summary"><div><span>源视频</span><b>{basename(form.sourcePath || job?.source?.name) || '待分析'}</b></div><div><span>背景音乐</span><b>{job?.options?.backgroundAudio?.name || form.backgroundAudio?.name || '未选择'}</b></div><div><span>生成数量</span><b>{job?.options?.count || form.count || '—'} 条</b></div></div>{job ? <><div className="batch-analysis-panel"><h3>分析过程</h3>{Object.entries(phases).filter(([key]) => key !== 'ready').map(([key, label]) => <div className="batch-analysis-row" key={key}><span>{label}</span><em className={job.status === 'ready' || (job.phase && Object.keys(phases).indexOf(key) < Object.keys(phases).indexOf(job.phase)) ? 'done' : ''}>{job.status === 'analyzing' && job.phase === key ? '进行中' : (job.status === 'ready' || (job.phase && Object.keys(phases).indexOf(key) < Object.keys(phases).indexOf(job.phase)) ? '已完成' : '等待')}</em></div>)}<div className="batch-analysis-row"><span>规划结果</span><em>{job.uniqueCount ? `${job.uniqueCount} 条可用` : '等待'}</em></div></div><div className="batch-step-footer"><span>{job.error || (job.status === 'analyzing' ? phases[job.phase] || '正在分析…' : '分析完成后即可开始批量生成。')}</span><div className="batch-actions"><button type="button" onClick={() => enterStep('prepare')}>返回修改</button>{job.status === 'ready' && <button type="button" className="batch-primary" disabled={busy} onClick={start}><Play size={14} />开始批量生成</button>}</div></div></> : <div className="batch-empty">提交准备信息后，这里会显示镜头分析和序列规划进度。</div>}</div>}
      {(step === 'render' || step === 'results') && <div className="batch-step-view"><div className="batch-job-toolbar"><label>批次<select aria-label="选择混剪批次" value={selected || ''} onChange={(event) => { setSelected(event.target.value); setResultPage(0) }}><option value="" disabled>尚无批次</option>{jobs.map((entry) => <option key={entry.id} value={entry.id}>{new Date(entry.createdAt).toLocaleString()} · {statuses[entry.status]} · {entry.options.count} 条</option>)}</select></label><div className="batch-actions">{job?.status === 'ready' && <button type="button" className="batch-primary" disabled={busy} onClick={start}><Play size={14} />开始生成</button>}{['running', 'queued'].includes(job?.status) && <button type="button" disabled={busy} onClick={() => invoke(() => api.pauseBatchMix(job.id))}><Pause size={14} />暂停</button>}{['paused', 'interrupted', 'cancelled', 'partial_failed'].includes(job?.status) && <button type="button" disabled={busy} onClick={() => invoke(() => api.resumeBatchMix({ jobId: job.id }))}><RefreshCw size={14} />校验并继续</button>}{job && ['paused', 'interrupted', 'cancelled', 'partial_failed'].includes(job.status) && <><button type="button" disabled={busy} onClick={relocate}>重新定位源视频</button>{job.options?.backgroundAudio && <button type="button" disabled={busy} onClick={relocateBackground}>重新定位背景音乐</button>}</>}{job?.counts?.failed > 0 && ['partial_failed', 'paused'].includes(job.status) && <button type="button" disabled={busy} onClick={retryFailed}>重试失败项</button>}{job && ['analyzing', 'ready', 'running', 'queued', 'paused', 'pausing', 'recovering'].includes(job.status) && <button type="button" disabled={busy} onClick={() => invoke(() => api.cancelBatchMix(job.id))}>取消</button>}{job && <button type="button" disabled={busy} onClick={() => invoke(() => api.openBatchDirectory(job.id))}>输出目录</button>}{firstSuccess && <button type="button" disabled={busy} onClick={() => openRepresentative(firstSuccess)}>编辑代表时间线</button>}</div></div>{job ? <><div className="batch-summary"><div><strong>{statuses[job.status] || job.status}</strong><span>{job.source?.name || basename(job.sourcePath)}</span></div><b>{completed} / {job.options.count}</b></div><div className="batch-progress"><i style={{ width: `${progress}%` }} /></div><p className="batch-metrics">切片 {job.segmentCount || '待分析'} · 唯一序列 {job.uniqueCount || '待分析'} · {job.options?.backgroundAudio ? `背景音乐：${job.options.backgroundAudio.name} · 每条从 0:00 开始` : '未使用背景音乐'}<br />请求 {job.options.targetSeconds} 秒 → {Number(job.options.actualSeconds || job.options.targetSeconds).toFixed(4)} 秒 / {job.options.targetFrames} 帧 · 预计 {sizeText(job.estimatedBytes)}<br />{job.status === 'analyzing' ? phases[job.phase] : `成功 ${completed} · 失败 ${job.counts.failed} · 活动 ${job.counts.active} · 等待 ${job.counts.queued}`}{job.averageItemMs ? ` · 平均 ${(job.averageItemMs / 1000).toFixed(1)} 秒/条` : ''}</p>{step === 'results' && <div className="batch-result-filters"><button type="button" className={resultFilter === 'all' ? 'active' : ''} onClick={() => setResultFilter('all')}>全部</button><button type="button" className={resultFilter === 'success' ? 'active' : ''} onClick={() => setResultFilter('success')}>成功</button><button type="button" className={resultFilter === 'failed' ? 'active' : ''} onClick={() => setResultFilter('failed')}>失败</button></div>}{job.error && <p className="batch-error">{job.error}</p>}{job.warnings?.map((warning, index) => <p className="batch-warning" key={index}>{warning}</p>)}<div className="batch-table-wrap"><table><thead><tr><th>序号</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>{filteredItems.map((item) => <tr key={item.index}><td>{String(item.index).padStart(4, '0')}</td><td title={item.error || ''}>{itemStatuses[item.status]}{item.error && <small>{item.error.slice(-140)}</small>}</td><td>{Math.round(item.percent || 0)}%</td><td>{item.status === 'completed' && <><button type="button" disabled={busy} onClick={() => invoke(() => api.openPreview({ path: item.outputPath, name: `混剪 ${item.index}` }))}>预览</button><button type="button" disabled={busy} onClick={() => openRepresentative(item)}>编辑</button><button type="button" onClick={() => invoke(() => navigator.clipboard.writeText(item.outputPath))}>路径</button></>}</td></tr>)}</tbody></table></div>{job.items.length > 25 && <div className="batch-pages"><button type="button" disabled={resultPage === 0} onClick={() => setResultPage((value) => value - 1)}>上一页</button><span>{resultPage + 1} / {Math.ceil(job.items.length / 25)}</span><button type="button" disabled={(resultPage + 1) * 25 >= job.items.length} onClick={() => setResultPage((value) => value + 1)}>下一页</button></div>}<div className="batch-result-note"><Check size={14} />本批次成片已统一应用同一首背景音乐。打开代表时间线可继续试听和调整。</div>{!['analyzing', 'running', 'queued', 'pausing', 'cancelling', 'recovering'].includes(job.status) && <button type="button" className="batch-remove" disabled={busy} onClick={removeJob}>清理任务记录（保留输出文件）</button>}</> : <div className="batch-empty">先选择视频并分析，或选择已有批次继续。</div>}</div>}
    </>}
    {error && <p className="batch-error" role="alert">{error}</p>}
  </section></div>
}
