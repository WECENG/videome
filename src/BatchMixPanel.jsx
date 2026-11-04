import React, { useEffect, useRef, useState } from 'react'
import { FolderOpen, LoaderCircle, Play, RefreshCw, Scissors, X } from 'lucide-react'
import './batch-mix.css'

const statuses = { analyzing: '分析中', ready: '等待开始', queued: '排队中', running: '生成中', pausing: '正在暂停', paused: '已暂停',
  cancelling: '正在取消', cancelled: '已取消', interrupted: '可恢复', completed: '全部成功', partial_failed: '部分失败', analysis_failed: '分析失败', recovering: '校验恢复中' }
const phases = { fingerprint: '校验源视频', scenes: '识别镜头边界', planning: '生成唯一剪辑序列', ready: '分析完成' }
const itemStatuses = { queued: '等待', rendering: '编码', verifying: '校验', publishing: '发布', completed: '成功', failed: '失败' }
const sizeText = (bytes) => `${((bytes || 0) / 1024 ** 3).toFixed(2)} GB`

export default function BatchMixPanel({ assets, frameSize, currentProject, onOpenProject, onClose }) {
  const api = window.videome
  const [form, setForm] = useState(() => ({ sourcePath: assets.find((asset) => asset.kind === 'video' && asset.path)?.path || '', outputDirectory: '',
    segmentSeconds: 3, targetSeconds: 30, count: '', seed: crypto.randomUUID().slice(0, 8), fps: 30, concurrency: 'auto', alignScenes: true, threshold: 0.35 }))
  const [jobs, setJobs] = useState([])
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [resultPage, setResultPage] = useState(0)
  const mounted = useRef(true)
  const job = jobs.find((entry) => entry.id === selected)
  const updateJob = (next) => setJobs((current) => {
    if (current.some((entry) => entry.id === next.id && entry.revision > next.revision)) return current
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
    return () => { mounted.current = false; dispose(); window.removeEventListener('keydown', escape) }
  }, [])

  const invoke = async (operation) => {
    setBusy(true)
    setError('')
    try {
      const result = await operation()
      if (result?.ok === false) throw new Error(result.reason)
      if (result?.id) updateJob(result)
      return result
    } catch (failure) { setError(failure.message); return null }
    finally { if (mounted.current) setBusy(false) }
  }
  const field = (name, value) => setForm((current) => ({ ...current, [name]: value }))
  const pickSource = () => invoke(async () => {
    const paths = await api.pickMedia(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'mxf'])
    if (paths?.length) field('sourcePath', paths[0])
  })
  const analyze = () => invoke(async () => {
    const result = await api.createBatchMixAnalysis({ ...form, width: frameSize.width, height: frameSize.height })
    if (result?.jobId) { setSelected(result.jobId); updateJob(await api.getBatchMixJob(result.jobId)); setResultPage(0) }
    return result
  })
  const openRepresentative = (item) => invoke(async () => {
    const result = await api.createBatchMixProject({ jobId: job.id, index: item.index, currentProject: currentProject() })
    if (result?.ok) { onOpenProject(result.data, result.path); onClose() }
    return result
  })
  const completed = job?.counts?.completed || 0
  const progress = job?.items?.length ? job.items.reduce((sum, item) => sum + (item.status === 'completed' ? 100 : item.percent || 0), 0) / job.items.length : 0
  const firstSuccess = job?.items?.find((item) => item.status === 'completed')
  const visibleItems = job?.items?.slice(resultPage * 25, resultPage * 25 + 25) || []
  const requestedCount = Number(form.count)
  const validCount = Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 1000

  return <div className="dialog-scrim batch-scrim"><section className="batch-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-title">
    <header className="batch-header"><div><span className="eyebrow">LOCAL BATCH STUDIO</span><h2 id="batch-title">批量混剪</h2><p>一段长视频，自动拆片与随机重组。每条保留原声，序列去重。</p></div><button aria-label="关闭批量混剪" onClick={onClose}><X size={20} /></button></header>
    {!api?.createBatchMixAnalysis ? <p className="batch-error">批量混剪需要使用 Videome 桌面版。</p> : <div className="batch-columns">
      <div className="batch-config"><h3>创建新批次</h3>
        <label>源视频<div className="batch-path"><input aria-label="混剪源视频" value={form.sourcePath} onChange={(event) => field('sourcePath', event.target.value)} list="batch-sources" /><button onClick={pickSource} disabled={busy} aria-label="选择混剪源视频"><FolderOpen size={16} /></button></div></label>
        <datalist id="batch-sources">{assets.filter((asset) => asset.kind === 'video' && asset.path).map((asset) => <option key={asset.id} value={asset.path}>{asset.name}</option>)}</datalist>
        <label>输出目录<div className="batch-path"><input aria-label="混剪输出目录" value={form.outputDirectory} onChange={(event) => field('outputDirectory', event.target.value)} /><button aria-label="选择混剪输出目录" disabled={busy} onClick={() => invoke(async () => { const result = await api.pickBatchOutputDirectory(); if (result) field('outputDirectory', result.path) })}><FolderOpen size={16} /></button></div></label>
        <div className="batch-fields">{[['segmentSeconds', '片段时长（秒）', 0.1, 3600, 0.1], ['targetSeconds', '成片时长（秒）', 0.1, 3600, 0.1], ['count', '生成数量（条）', 1, 1000, 1]].map(([name, label, min, max, step]) => <label key={name}>{label}<input aria-label={label} type="number" min={min} max={max} step={step} required={name === 'count'} placeholder={name === 'count' ? '请输入 1–1000' : undefined} value={form[name]} onChange={(event) => field(name, event.target.value)} /></label>)}
          <label>输出帧率<select aria-label="混剪输出帧率" value={form.fps} onChange={(event) => field('fps', Number(event.target.value))}>{[24, 25, 30, 50, 60].map((value) => <option key={value} value={value}>{value} fps</option>)}</select></label>
          <label>最大并发<select aria-label="混剪最大并发" value={form.concurrency} onChange={(event) => field('concurrency', event.target.value)}><option value="auto">自动 · 1–2 路</option>{[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value} 路</option>)}</select></label>
          <label>随机种子<input aria-label="随机种子" value={form.seed} onChange={(event) => field('seed', event.target.value)} /></label>
        </div>
        <label className="batch-check"><input type="checkbox" checked={form.alignScenes} onChange={(event) => field('alignScenes', event.target.checked)} />优先对齐附近镜头边界</label>
        <details><summary>高级设置</summary><label>镜头检测阈值<input aria-label="镜头检测阈值" type="number" min="0.01" max="0.99" step="0.01" value={form.threshold} onChange={(event) => field('threshold', event.target.value)} /></label></details>
        <button disabled={busy} onClick={() => invoke(() => api.clearBatchMixCache())}>清理镜头分析缓存</button>
        <button className="batch-primary" disabled={busy || !form.sourcePath || !form.outputDirectory || !validCount} onClick={analyze}>{busy ? <LoaderCircle size={15} className="loading-spin" /> : <Scissors size={15} />}分析并生成方案</button>
      </div>
      <div className="batch-results"><label className="batch-job-picker">批次历史<select aria-label="选择混剪批次" value={selected || ''} onChange={(event) => { setSelected(event.target.value); setResultPage(0) }}><option value="" disabled>尚无批次</option>{jobs.map((entry) => <option key={entry.id} value={entry.id}>{new Date(entry.createdAt).toLocaleString()} · {statuses[entry.status]} · {entry.options.count} 条</option>)}</select></label>
        {job ? <><div className="batch-summary"><div><strong>{statuses[job.status] || job.status}</strong><span>{job.source?.name || job.sourcePath?.split('/').pop()}</span></div><b>{completed} / {job.options.count}</b></div>
          <div className="batch-progress"><i style={{ width: `${progress}%` }} /></div>
          <p className="batch-metrics">切片 {job.segmentCount || '待分析'} · 唯一序列 {job.uniqueCount} · 并发上限 {job.concurrency || '待分析'}<br />请求 {job.options.targetSeconds} 秒 → {job.options.actualSeconds.toFixed(4)} 秒 / {job.options.targetFrames} 帧 · 预计 {sizeText(job.estimatedBytes)}<br />{job.status === 'analyzing' ? phases[job.phase] : `成功 ${completed} · 失败 ${job.counts.failed} · 活动 ${job.counts.active} · 等待 ${job.counts.queued}`}{job.averageItemMs ? ` · 平均 ${(job.averageItemMs / 1000).toFixed(1)} 秒/条` : ''}</p>
          <div className="batch-actions">
            {job.status === 'ready' && <button className="batch-primary" disabled={busy} onClick={() => invoke(() => api.startBatchMix(job.id))}><Play size={14} />开始生成</button>}
            {['running', 'queued'].includes(job.status) && <button disabled={busy} onClick={() => invoke(() => api.pauseBatchMix(job.id))}>暂停</button>}
            {['paused', 'interrupted', 'cancelled', 'partial_failed'].includes(job.status) && <button disabled={busy} onClick={() => invoke(() => api.resumeBatchMix({ jobId: job.id }))}><RefreshCw size={14} />校验并继续</button>}
            {['paused', 'interrupted', 'cancelled', 'partial_failed'].includes(job.status) && <button disabled={busy} onClick={() => invoke(async () => {
              const paths = await api.pickMedia(['mp4', 'mov', 'mkv', 'webm', 'm4v'])
              if (paths?.[0]) return api.resumeBatchMix({ jobId: job.id, sourcePath: paths[0] })
              return null
            })}>重新定位源视频</button>}
            {job.counts.failed > 0 && ['partial_failed', 'paused'].includes(job.status) && <button disabled={busy} onClick={() => invoke(() => api.retryBatchMix(job.id))}>重试失败项</button>}
            {['analyzing', 'ready', 'running', 'queued', 'paused', 'pausing', 'recovering'].includes(job.status) && <button disabled={busy && job.status !== 'recovering'} onClick={() => invoke(() => api.cancelBatchMix(job.id))}>取消批次</button>}
            <button disabled={busy} onClick={() => invoke(() => api.openBatchDirectory(job.id))}>输出目录</button>
            {firstSuccess && <button disabled={busy} onClick={() => openRepresentative(firstSuccess)}>编辑代表时间线 #{firstSuccess.index}</button>}
          </div>
          {job.error && <p className="batch-error">{job.error}</p>}{job.warnings.map((warning, index) => <p className="batch-warning" key={index}>{warning}</p>)}
          <div className="batch-table-wrap"><table><thead><tr><th>序号</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>{visibleItems.map((item) => <tr key={item.index}><td>{String(item.index).padStart(4, '0')}</td><td title={item.error || ''}>{itemStatuses[item.status]}{item.error && <small>{item.error.slice(-140)}</small>}</td><td>{Math.round(item.percent || 0)}%</td><td>{item.status === 'completed' && <><button disabled={busy} onClick={() => invoke(() => api.openPreview({ path: item.outputPath, name: `混剪 ${item.index}` }))}>预览</button><button disabled={busy} onClick={() => openRepresentative(item)}>编辑</button><button onClick={() => invoke(() => navigator.clipboard.writeText(item.outputPath))}>路径</button></>}</td></tr>)}</tbody></table></div>
          {job.items.length > 25 && <div className="batch-pages"><button disabled={resultPage === 0} onClick={() => setResultPage((value) => value - 1)}>上一页</button><span>{resultPage + 1} / {Math.ceil(job.items.length / 25)}</span><button disabled={(resultPage + 1) * 25 >= job.items.length} onClick={() => setResultPage((value) => value + 1)}>下一页</button></div>}
          {!['analyzing', 'running', 'queued', 'pausing', 'cancelling', 'recovering'].includes(job.status) && <button className="batch-remove" disabled={busy} onClick={() => invoke(async () => { const result = await api.removeBatchMix(job.id); if (result.ok) { setJobs((current) => current.filter((entry) => entry.id !== job.id)); setSelected(null) } return result })}>清理任务记录（保留输出文件）</button>}
        </> : <div className="batch-empty">先选择视频并分析，或选择已有批次继续。</div>}
      </div>
    </div>}
    {error && <p className="batch-error" role="alert">{error}</p>}
  </section></div>
}
