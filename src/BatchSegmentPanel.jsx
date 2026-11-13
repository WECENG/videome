import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, LoaderCircle, Pause, Play, Scissors, X } from 'lucide-react'
import './batch-mix.css'

const statuses = { analyzing: '分析中', ready: '等待开始', queued: '排队中', running: '分段中', pausing: '正在暂停', paused: '已暂停', cancelling: '正在取消', cancelled: '已取消', interrupted: '可恢复', completed: '全部完成', partial_failed: '部分失败', analysis_failed: '分析失败' }
const itemStatuses = { queued: '等待', rendering: '编码', verifying: '校验', publishing: '发布', completed: '成功', failed: '失败' }
const basename = (value = '') => value.split(/[\\/]/).pop() || value
const formatTime = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(value / 60)
  return `${minutes}:${String(Math.floor(value - minutes * 60)).padStart(2, '0')}`
}

export default function BatchSegmentPanel({ assets = [], onClose }) {
  const api = window.videome
  const [form, setForm] = useState({ sourcePath: assets.find((asset) => asset.kind === 'video' && asset.path)?.path || '', outputDirectory: '', segmentSeconds: 20, concurrency: 1 })
  const [jobs, setJobs] = useState([])
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const job = jobs.find((entry) => entry.id === selected)
  const updateJob = (next) => setJobs((current) => [next, ...current.filter((entry) => entry.id !== next.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  const field = (name, value) => setForm((current) => ({ ...current, [name]: value }))
  const invoke = async (operation) => {
    setBusy(true); setError('')
    try { const result = await operation(); if (result?.ok === false) throw new Error(result.reason); if (result?.id) updateJob(result); return result }
    catch (failure) { setError(failure.message); return null }
    finally { if (mounted.current) setBusy(false) }
  }
  useEffect(() => {
    mounted.current = true
    if (!api?.listBatchSegmentJobs) return undefined
    api.listBatchSegmentJobs().then((result) => { if (!mounted.current) return; if (result?.ok === false) setError(result.reason); else { setJobs(result); setSelected((current) => current || result[0]?.id || null) } }).catch((failure) => setError(failure.message))
    const dispose = api.onBatchSegmentProgress(updateJob)
    const escape = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => { mounted.current = false; dispose?.(); window.removeEventListener('keydown', escape) }
  }, [])
  const pickSource = () => invoke(async () => { const paths = await api.pickMedia(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'mxf']); if (paths?.[0]) field('sourcePath', paths[0]); return null })
  const pickOutput = () => invoke(async () => { const result = await api.pickBatchSegmentOutputDirectory(); if (result?.path) field('outputDirectory', result.path); return null })
  const create = () => invoke(async () => { const result = await api.createBatchSegmentJob(form); if (result?.jobId) { setSelected(result.jobId); updateJob(await api.getBatchSegmentJob(result.jobId)) } return result })
  const start = () => invoke(() => api.startBatchSegmentJob(job.id))
  const pause = () => invoke(() => api.pauseBatchSegmentJob(job.id))
  const cancel = () => invoke(() => api.cancelBatchSegmentJob(job.id))
  const remove = () => invoke(async () => { const result = await api.removeBatchSegmentJob(job.id); if (result?.ok) { setJobs((current) => current.filter((entry) => entry.id !== job.id)); setSelected(null) } return result })
  const count = job?.items?.length || job?.segmentCount || 0
  const completed = job?.counts?.completed || 0
  const progress = count ? job.items.reduce((sum, item) => sum + (item.status === 'completed' ? 100 : item.percent || 0), 0) / count : 0
  const sourceAssets = useMemo(() => assets.filter((asset) => asset.kind === 'video' && asset.path), [assets])

  return <div className="dialog-scrim batch-scrim"><section className="batch-dialog batch-wizard" role="dialog" aria-modal="true" aria-labelledby="segment-title">
    <header className="batch-header"><div><span className="eyebrow">LOCAL SEGMENT STUDIO</span><h2 id="segment-title">批量分段</h2><p>按固定片段时长从头到尾顺序输出，不添加背景音乐。</p></div><button aria-label="关闭批量分段" onClick={onClose}><X size={20} /></button></header>
    {!api?.createBatchSegmentJob ? <p className="batch-error">批量分段需要使用 Videome 桌面版。</p> : <>
      <div className="batch-prep-grid"><div className="batch-config batch-panel"><div className="batch-panel-heading"><div><span className="batch-kicker">01 / SOURCE</span><h3>分段设置</h3></div><span className="batch-panel-note">自动计算分段数量</span></div><label>源视频<div className="batch-path"><input aria-label="分段源视频" value={form.sourcePath} onChange={(event) => field('sourcePath', event.target.value)} list="segment-sources" /><button type="button" onClick={pickSource} disabled={busy} aria-label="选择分段源视频"><FolderOpen size={16} /></button></div></label><datalist id="segment-sources">{sourceAssets.map((asset) => <option key={asset.id} value={asset.path}>{asset.name}</option>)}</datalist><label>输出目录<div className="batch-path"><input aria-label="分段输出目录" value={form.outputDirectory} onChange={(event) => field('outputDirectory', event.target.value)} /><button type="button" onClick={pickOutput} disabled={busy} aria-label="选择分段输出目录"><FolderOpen size={16} /></button></div></label><div className="batch-fields"><label>片段时长（秒）<input aria-label="分段片段时长" type="number" min="0.1" max="3600" step="0.1" value={form.segmentSeconds} onChange={(event) => field('segmentSeconds', event.target.value)} /></label><label>最大并发<select aria-label="分段最大并发" value={form.concurrency} onChange={(event) => field('concurrency', Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value} 路</option>)}</select></label></div><div className="batch-segment-note">最后不足一个片段时长的尾段会保留，源视频音轨按对应区间保留。并发越高，磁盘和 CPU 占用越高。</div><button type="button" className="batch-primary" disabled={busy || !form.sourcePath || !form.outputDirectory || !(Number(form.segmentSeconds) >= 0.1)} onClick={create}>{busy ? <LoaderCircle size={15} className="loading-spin" /> : <Scissors size={15} />}分析并创建分段任务</button></div><div className="batch-prep-side"><div className="batch-preview-card"><div className="batch-preview-label"><span>输出策略</span><b>MP4 · H.264</b></div><div className="batch-film-preview"><strong>{basename(form.sourcePath) || '尚未选择源视频'}</strong><span>顺序切片</span></div><div className="batch-preview-stats"><span>背景音乐 <b>不添加</b></span><span>原声 <b>按片段保留</b></span><span>尾段 <b>保留</b></span></div></div><div className="batch-preview-card"><div className="batch-preview-label"><span>历史任务</span><b>{jobs.length} 个</b></div><select aria-label="选择分段任务" value={selected || ''} onChange={(event) => setSelected(event.target.value)}><option value="">选择任务…</option>{jobs.map((entry) => <option key={entry.id} value={entry.id}>{new Date(entry.createdAt).toLocaleString()} · {statuses[entry.status]}</option>)}</select></div></div></div>
      {job && <div className="batch-segment-results"><div className="batch-summary"><div><strong>{statuses[job.status] || job.status}</strong><span>{job.source?.name || basename(job.sourcePath)}</span></div><b>{completed} / {count}</b></div><div className="batch-progress"><i style={{ width: `${progress}%` }} /></div><p className="batch-metrics">预计 {count} 段 · 输出目录 {basename(job.outputDirectory)}<br />{job.status === 'analyzing' ? '正在读取媒体信息…' : `成功 ${completed} · 失败 ${job.counts?.failed || 0} · 活动 ${job.counts?.active || 0} · 等待 ${job.counts?.queued || 0}`}</p>{job.error && <p className="batch-error">{job.error}</p>}<div className="batch-actions">{['ready', 'paused', 'interrupted'].includes(job.status) && <button type="button" className="batch-primary" disabled={busy} onClick={start}><Play size={14} />{job.status === 'ready' ? '开始分段' : '继续分段'}</button>}{['running', 'queued'].includes(job.status) && <button type="button" disabled={busy} onClick={pause}><Pause size={14} />暂停</button>}{['analyzing', 'ready', 'running', 'queued', 'paused', 'pausing'].includes(job.status) && <button type="button" disabled={busy} onClick={cancel}>取消</button>}{job && <button type="button" disabled={busy} onClick={() => invoke(() => api.openBatchSegmentDirectory(job.id))}>打开输出目录</button>}</div><div className="batch-table-wrap"><table><thead><tr><th>序号</th><th>源区间</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>{(job.items || []).map((item) => <tr key={item.index}><td>{String(item.index).padStart(4, '0')}</td><td>{formatTime(item.sourceStart)} → {formatTime(item.sourceEnd)}</td><td title={item.error || ''}>{itemStatuses[item.status]}{item.error && <small>{item.error.slice(-120)}</small>}</td><td>{Math.round(item.percent || 0)}%</td><td>{item.status === 'completed' && <><button type="button" onClick={() => invoke(() => api.openPreview({ path: item.outputPath, name: `分段 ${item.index}` }))}>预览</button><button type="button" onClick={() => invoke(() => navigator.clipboard.writeText(item.outputPath))}>路径</button></>}</td></tr>)}</tbody></table></div>{!['analyzing', 'running', 'queued', 'pausing', 'cancelling'].includes(job.status) && <button type="button" className="batch-remove" disabled={busy} onClick={remove}>清理任务记录（保留输出文件）</button>}</div>}
    </>}
    {error && <p className="batch-error" role="alert">{error}</p>}
  </section></div>
}
