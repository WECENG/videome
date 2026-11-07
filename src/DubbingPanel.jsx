import React, { useEffect, useRef, useState } from 'react'
import { Download, LoaderCircle, Mic, Pause, Play, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import { resolveDubbingSources } from './dubbing-domain.js'
import './dubbing.css'

const active = new Set(['extracting', 'separating', 'recognizing', 'translating', 'generating'])
const gb = (bytes) => `${(Number(bytes || 0) / 1e9).toFixed(2)} GB`
const percent = (loaded, total) => total > 0 ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100))) : 0
const clock = (value) => `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}`
const voices = [{ id: 3, name: '中文女声 · zf_001' }, { id: 12, name: '中文女声 · zf_018' }, { id: 58, name: '中文男声 · zm_009' }, { id: 61, name: '中文男声 · zm_012' }]
const defaultNetwork = { mode: 'environment', url: '', username: '', password: '', keepPassword: false }
const emotions = [{ id: 'neutral', name: '中性' }, { id: 'warm', name: '温暖' }, { id: 'serious', name: '严肃' }, { id: 'excited', name: '兴奋' }, { id: 'sad', name: '低沉' }, { id: 'calm', name: '平静' }]
const preferenceKey = 'videome-dubbing-preferences'
const cloudPlannerPresets = ['gpt-6-luna', 'gpt-6.1-sol']
const cloudVoicePresets = [
  { id: 'alloy', name: '合金' },
  { id: 'ash', name: '灰烬' },
  { id: 'coral', name: '珊瑚' },
  { id: 'echo', name: '回声' },
  { id: 'fable', name: '寓言' },
  { id: 'nova', name: '新星' },
  { id: 'onyx', name: '缟玛瑙' },
  { id: 'sage', name: '鼠尾草' },
  { id: 'shimmer', name: '微光' },
]

export default function DubbingPanel({ currentProject, selectedClipId, selectedClipIds = [], onApply, onClose }) {
  const api = window.videome
  const [models, setModels] = useState(null)
  const [jobs, setJobs] = useState([])
  const [selected, setSelected] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [cueProsody, setCueProsody] = useState({})
  const [generatingCueId, setGeneratingCueId] = useState(null)
  const [voice, setVoice] = useState(3)
  const [backend, setBackend] = useState('local-expressive')
  const [emotion, setEmotion] = useState('neutral')
  const [ratePreset, setRatePreset] = useState('natural')
  const [pause, setPause] = useState('normal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [network, setNetwork] = useState(defaultNetwork)
  const [networkLoaded, setNetworkLoaded] = useState(false)
  const [networkDirty, setNetworkDirty] = useState(false)
  const [networkNotice, setNetworkNotice] = useState('')
  const [networkResults, setNetworkResults] = useState([])
  const [ttsSettings, setTtsSettings] = useState({ baseUrl: '', transcriptionModel: '', plannerModel: 'gpt-6-luna', ttsModel: '', model: '', voice: '', apiKey: '', keepApiKey: false })
  const [ttsSettingsLoaded, setTtsSettingsLoaded] = useState(false)
  const [ttsSettingsState, setTtsSettingsState] = useState('idle')
  const [ttsTestState, setTtsTestState] = useState('idle')
  const [ttsTestMessage, setTtsTestMessage] = useState('')
  const [batchIds, setBatchIds] = useState([])
  const [autoBatch, setAutoBatch] = useState(false)
  const [appliedJobIds, setAppliedJobIds] = useState([])
  const [step, setStep] = useState('prepare')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const mounted = useRef(true)
  const audioRef = useRef(null)
  const removedJobIds = useRef(new Set())
  const generatingCueRef = useRef(null)
  const generationStartedRef = useRef(false)
  const projectId = currentProject().projectId
  const job = jobs.find((item) => item.id === selected)
  const running = active.has(job?.status)
  const hasRunningJobs = jobs.some((item) => active.has(item.status) || item.status === 'created')
  const cloudReady = ttsSettingsLoaded && Boolean(ttsSettings.baseUrl && ttsSettings.transcriptionModel && (ttsSettings.ttsModel || ttsSettings.model) && ttsSettings.plannerModel && ttsSettings.voice && ttsSettings.keepApiKey)
  const backendReady = backend === 'openai-cloud' ? cloudReady : Boolean(models?.ready)
  const selectionIds = selectedClipIds.length ? selectedClipIds : (selectedClipId ? [selectedClipId] : [])
  const resolved = resolveDubbingSources(currentProject(), selectionIds)
  const source = resolved.sources[0] || null
  const sourceError = resolved.issues[0]?.reason || ''
  const batchJobs = batchIds.map((id) => jobs.find((item) => item.id === id)).filter(Boolean)
  const readyBatchJobs = batchJobs.filter((item) => item.status === 'ready')
  const batchReady = !batchJobs.length || batchJobs.every((item) => item.status === 'ready')

  const updateJob = (value) => {
    if (removedJobIds.current.has(value.id)) return
    if (generatingCueRef.current?.jobId === value.id) {
      if (active.has(value.status)) generationStartedRef.current = true
      else if (generationStartedRef.current) {
        generatingCueRef.current = null
        generationStartedRef.current = false
        setGeneratingCueId(null)
      }
    }
    setJobs((current) => [value, ...current.filter((item) => item.id !== value.id)])
  }
  const removeJobsFromList = (ids) => {
    ids.forEach((id) => removedJobIds.current.add(id))
    setJobs((current) => current.filter((item) => !removedJobIds.current.has(item.id)))
  }
  const invoke = async (operation) => {
    setBusy(true); setError('')
    try {
      const result = await operation()
      if (!result?.ok) throw new Error(result?.reason || '本地配音服务不可用。')
      return result.value
    } catch (failure) { if (mounted.current) setError(failure.message); return null }
    finally { if (mounted.current) setBusy(false) }
  }
  useEffect(() => {
    mounted.current = true
    if (!api?.dubbingModels) return undefined
    void invoke(() => api.dubbingModels()).then((value) => value && mounted.current && setModels(value))
    if (api.dubbingNetworkSettings) void api.dubbingNetworkSettings().then((result) => {
      if (!mounted.current) return
      if (!result.ok) { setError(result.reason); setNetworkLoaded(true); return }
      setNetwork({ ...defaultNetwork, ...result.value, keepPassword: result.value.hasPassword })
      setNetworkLoaded(true)
    }).catch((failure) => { if (mounted.current) setError(failure.message) })
    if (api.dubbingTtsSettings) void api.dubbingTtsSettings().then((result) => {
      if (!mounted.current) return
      if (result.ok) { setTtsSettings((current) => ({ ...current, ...result.value, keepApiKey: result.value.hasApiKey })); setTtsSettingsLoaded(true) }
    }).catch(() => {})
    void api.listDubbingJobs(projectId).then((result) => {
      if (!mounted.current || !result.ok) return
      const restored = result.value.filter((item) => !removedJobIds.current.has(item.id))
      setJobs(restored)
      const selectedSet = new Set(selectionIds)
      const restoredBatch = restored.filter((item) => selectedSet.has(item.source?.selectedClipId)).map((item) => item.id)
      setBatchIds(restoredBatch)
      setSelected(restoredBatch[0] || restored[0]?.id || null)
    })
    const dispose = api.onDubbingProgress((payload) => {
      if (payload.models) setModels((current) => ({ ...current, ...payload.models }))
      if (payload.job?.projectId === projectId) updateJob(payload.job)
      if (payload.removed?.projectId === projectId) removeJobsFromList(payload.removed.ids)
    })
    return () => { mounted.current = false; dispose(); audioRef.current?.pause(); setPreviewPlaying(false) }
  }, [projectId])
  useEffect(() => {
    if (selected && !jobs.some((item) => item.id === selected)) setSelected(jobs[0]?.id || null)
  }, [jobs, selected])
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) || 'null')
      if (saved && !job) { setVoice(saved.voice ?? 3); setBackend(saved.backend || 'local-expressive'); setEmotion(saved.emotion || 'neutral'); setRatePreset(saved.ratePreset || 'natural'); setPause(saved.pause || 'normal') }
    } catch {}
  }, [projectId])
  useEffect(() => {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ voice, backend, emotion, ratePreset, pause })) } catch {}
  }, [voice, backend, emotion, ratePreset, pause])
  useEffect(() => {
    audioRef.current?.pause(); setPreview(null); setPreviewPlaying(false)
    setDrafts({}); setCueProsody({}); setGeneratingCueId(null); generatingCueRef.current = null; generationStartedRef.current = false; setVoice(job?.voice || 3); setBackend(job?.backend || 'local-expressive'); setEmotion(job?.style?.emotion || 'neutral'); setRatePreset(job?.style?.rate >= 1.06 ? 'fast' : job?.style?.rate <= 0.94 ? 'slow' : 'natural'); setPause(job?.style?.pause || 'normal')
  }, [selected])
  useEffect(() => {
    const escape = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])

  useEffect(() => {
    if (!autoBatch || !batchJobs.length) return
    if (batchJobs.some((item) => ['failed', 'cancelled', 'interrupted'].includes(item.status))) {
      setAutoBatch(false)
      setError('一键配音未完成，请检查失败的配音草稿后重试。')
      setStep('result')
      return
    }
    if (!batchReady || readyBatchJobs.length !== batchJobs.length) return
    try {
      onApply(batchJobs.length > 1 ? batchJobs : batchJobs[0])
      setAppliedJobIds(batchJobs.map((item) => item.id))
      setAutoBatch(false)
      setStep('result')
    } catch (failure) { setAutoBatch(false); setError(failure.message) }
  }, [autoBatch, batchJobs, batchReady, readyBatchJobs.length, onApply, onClose])

  const create = (action = 'analyze') => invoke(async () => {
    if (!resolved.sources.length) return { ok: false, reason: sourceError || '请选择可处理的音频片段。' }
    const created = []
    for (const item of resolved.sources) {
      const result = await api.createDubbingJob({ source: item, projectId, voice, backend, action, style: { emotion, ratePreset, pause } })
      if (!result.ok) return result
      created.push(result.value); updateJob(result.value)
    }
    setBatchIds(created.map((item) => item.id)); setSelected(created[0]?.id || null); setAutoBatch(action === 'auto'); setStep('batch')
    if (resolved.issues.length) setError(`已创建 ${created.length} 段；${resolved.issues.length} 段无法处理：${resolved.issues.map((item) => item.name).join('、')}`)
    return { ok: true, value: created.at(-1) }
  })
  const saveDraft = async () => {
    const result = await api.updateDubbingJob({ id: job.id, voice, backend, style: { emotion, ratePreset, pause }, cues: job.cues.map((cue) => ({ id: cue.id, translation: drafts[cue.id] ?? cue.translation, ...(cueProsody[cue.id] ? { prosody: { ...(cue.prosody || {}), ...cueProsody[cue.id] } } : {}) })) })
    if (result.ok) { updateJob(result.value); setDrafts({}); setCueProsody({}) }
    return result
  }
  const generate = (cueId) => {
    setGeneratingCueId(cueId)
    generatingCueRef.current = { jobId: job.id, cueId }
    generationStartedRef.current = false
    void invoke(async () => {
      const saved = await saveDraft()
      if (!saved.ok) { generatingCueRef.current = null; setGeneratingCueId(null); return saved }
      const result = await api.startDubbingJob({ id: job.id, action: 'generate', cueId })
      if (!result?.ok) { generatingCueRef.current = null; setGeneratingCueId(null) }
      return result
    })
  }
  const generateAll = () => {
    if (!job || !job.cues?.length || generatingCueId || busy || running) return
    setGeneratingCueId('__all__')
    generatingCueRef.current = { jobId: job.id, cueId: null }
    generationStartedRef.current = false
    void invoke(async () => {
      const saved = await saveDraft()
      if (!saved.ok) { generatingCueRef.current = null; setGeneratingCueId(null); return saved }
      const result = await api.startDubbingJob({ id: job.id, action: 'generate' })
      if (!result?.ok) { generatingCueRef.current = null; setGeneratingCueId(null) }
      return result
    })
  }
  const listen = (file, title) => {
    if (preview?.file === file && audioRef.current) {
      if (audioRef.current.paused) {
        void audioRef.current.play().then(() => setPreviewPlaying(true)).catch(() => setError('音频播放失败，请重试。'))
      } else {
        audioRef.current.pause(); setPreviewPlaying(false)
      }
      return
    }
    void invoke(async () => {
      const result = await api.requestMedia([file])
      if (!result.ok) return result
      setPreview({ file, title, url: result.files[0].url }); setPreviewPlaying(true)
      return { ok: true, value: true }
    })
  }
  const previewButtonLabel = (file, label) => preview?.file === file && previewPlaying ? `暂停${label}` : label
  const previewButtonIcon = (file) => preview?.file === file && previewPlaying ? <Pause size={13} /> : <Play size={13} />
  const dirty = Object.keys(drafts).length > 0 || (job && (voice !== job.voice || backend !== (job.backend || 'local-expressive') || emotion !== (job.style?.emotion || 'neutral') || ratePreset !== (job.style?.rate >= 1.06 ? 'fast' : job.style?.rate <= 0.94 ? 'slow' : 'natural') || pause !== (job.style?.pause || 'normal')))
  const disabled = busy || running
  const needsTranslation = job?.cues?.some((cue) => !(drafts[cue.id] ?? cue.translation)?.trim())
  const retryTranslation = () => invoke(async () => {
    const saved = await saveDraft(); if (!saved.ok) return saved
    return api.startDubbingJob({ id: job.id, action: 'translate' })
  })
  const networkField = (name, value) => {
    setNetwork((current) => ({ ...current, [name]: value }))
    setNetworkDirty(true); setNetworkNotice(''); setNetworkResults([])
  }
  const saveNetwork = async () => {
    const result = await api.saveDubbingNetworkSettings(network)
    if (result.ok) {
      setNetwork({ ...defaultNetwork, ...result.value, keepPassword: result.value.hasPassword })
      setNetworkDirty(false); setNetworkNotice('已保存，本次安装将使用此配置。')
    }
    return result
  }
  const updateTtsSettings = (patch) => {
    setTtsSettings((current) => ({ ...current, ...patch }))
    setTtsSettingsState('dirty')
  }
  const saveTtsSettings = async () => {
    if (!api.saveDubbingTtsSettings) { setTtsSettingsState('error'); setError('当前桌面版本不支持云端配音配置，请重启应用。'); return null }
    setTtsSettingsState('saving'); setError('')
    const result = await api.saveDubbingTtsSettings(ttsSettings)
    if (result?.ok) { setTtsSettings((current) => ({ ...current, ...result.value, apiKey: '', keepApiKey: result.value.hasApiKey })); setTtsSettingsState('saved') }
    else { setTtsSettingsState('error'); setError(result?.reason || '云端配音设置保存失败。') }
    return result
  }
  const testTtsSettings = async () => {
    if (!api.testDubbingTtsSettings) { setTtsTestState('error'); setTtsTestMessage('当前桌面版本不支持接口测试，请重启应用。'); return null }
    setTtsTestState('testing'); setTtsTestMessage('')
    const result = await api.testDubbingTtsSettings(ttsSettings)
    if (result?.ok) { setTtsTestState('success'); setTtsTestMessage(`连接正常 · ${(result.value.latencyMs / 1000).toFixed(1)} 秒 · ${(result.value.bytes / 1024).toFixed(0)} KB`) }
    else { setTtsTestState('error'); setTtsTestMessage(result?.reason || '接口测试失败。') }
    return result
  }
  const installModels = () => invoke(async () => {
    if (networkDirty) { const result = await saveNetwork(); if (!result.ok) return result }
    const result = await api.installDubbingModels()
    if (result.ok) setModels(result.value)
    return result
  })
  const testNetwork = () => invoke(async () => {
    setNetworkResults([])
    if (networkDirty) { const saved = await saveNetwork(); if (!saved.ok) return saved }
    const result = await api.testDubbingNetwork()
    if (result.ok) setNetworkResults(result.value)
    return result
  })
  const deleteDrafts = (item = null) => {
    const text = item ? `确定删除配音草稿「${item.source.name}」吗？` : `确定清空当前工程的 ${jobs.length} 条配音草稿吗？`
    if (!window.confirm(`${text}\n草稿校对记录将被删除；已生成音频仍保留，已入轨的片段不受影响。`)) return
    void invoke(async () => {
      const result = item ? await api.removeDubbingJob({ id: item.id, projectId }) : await api.clearDubbingJobs(projectId)
      if (result.ok) {
        removeJobsFromList(result.value.ids)
        if (result.value.failures.length) setError(`${result.value.failures.length} 条草稿未能删除，请重试。`)
      }
      return result
    })
  }

  const statusText = (item) => ({ created: '待处理', extracting: '提取中', separating: '分离中', recognizing: '识别中', translating: '翻译中', generating: '生成中', review: '待校对', ready: '已完成', 'too-long': '超出时长', failed: '失败', cancelled: '已取消', interrupted: '已中断' }[item?.status] || item?.stage || '待处理')
  const failedJobs = batchJobs.filter((item) => ['failed', 'cancelled', 'interrupted'].includes(item.status))
  const appliedCount = batchJobs.filter((item) => appliedJobIds.includes(item.id) || item.clipsApplied || item.status === 'applied').length
  const pendingReadyJobs = readyBatchJobs.filter((item) => !appliedJobIds.includes(item.id) && item.status !== 'applied')
  const retryFailed = () => {
    failedJobs.forEach((item) => void invoke(() => api.startDubbingJob({ id: item.id, action: item.cues?.length && item.cues.every((cue) => cue.translation) ? 'generate' : 'analyze' })))
    setStep('batch')
  }
  const applyReady = (items = readyBatchJobs) => {
    if (!items.length) return
    try { onApply(items.length > 1 ? items : items[0]); setAppliedJobIds((current) => [...new Set([...current, ...items.map((item) => item.id)])]); setStep('result') } catch (failure) { setError(failure.message) }
  }
  const renderSettings = () => <div className="dubbing-settings-drawer" role="dialog" aria-label="智能配音设置">
    <div className="dubbing-settings-head"><b>配音设置</b><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭配音设置"><X size={16} /></button></div>
    <div className="dubbing-settings-body">
      <section><h3>本地识别与翻译模型</h3><div className="dubbing-models"><div className="dubbing-model-copy"><b>{models?.ready ? '本地模型已就绪' : models?.installing ? models.stage : '首次使用需安装模型'}</b><small>{models?.installing ? `${gb(models.downloadedBytes)} / ${gb(models.totalBytes)} · ${models.indeterminate ? '正在处理' : `${percent(models.currentAssetLoaded, models.currentAssetTotal)}%`}` : '用于音频分离、英文识别和中文翻译；云端后端只替换中文语音生成。'}</small>{models?.installing && <div className={`dubbing-progress ${models.indeterminate ? 'is-indeterminate' : ''}`}><i style={{ width: `${models.indeterminate ? 100 : percent(models.downloadedBytes, models.totalBytes)}%` }} /></div>}</div>{models?.installing ? <button disabled={busy} onClick={() => void invoke(() => api.cancelDubbingInstall())}>取消</button> : <button disabled={busy || models?.supported === false || !networkLoaded} onClick={installModels}><Download size={13} />{models?.error ? '重试安装' : '安装模型'}</button>}</div></section>
      <section><h3>安装网络与代理</h3>{!api.dubbingNetworkSettings ? <p>请重启桌面应用以加载代理配置。</p> : <><fieldset disabled={busy || models?.installing || !networkLoaded}><label>连接方式<select aria-label="安装连接方式" value={network.mode} onChange={(event) => networkField('mode', event.target.value)}><option value="environment">沿用环境代理</option><option value="direct">直接连接</option><option value="manual">自定义 HTTP/HTTPS 代理</option></select></label>{network.mode === 'manual' && <div className="dubbing-proxy-fields"><label>代理地址<input aria-label="安装代理地址" value={network.url} onChange={(event) => networkField('url', event.target.value)} placeholder="http://127.0.0.1:7890" /></label><label>用户名<input aria-label="代理用户名" value={network.username} onChange={(event) => networkField('username', event.target.value)} /></label><label>密码<input aria-label="代理密码" type="password" value={network.password} onChange={(event) => networkField('password', event.target.value)} /></label></div>}<div className="dubbing-network-actions"><button disabled={!networkDirty} onClick={() => void invoke(saveNetwork)}>保存设置</button><button onClick={testNetwork}>测试连接</button></div></fieldset>{!!networkResults.length && <ul className="dubbing-network-results dubbing-settings-network-results">{networkResults.map((result) => <li key={result.name} className={result.ok ? 'connected' : 'failed'}><b>{result.name}：{result.ok ? '正常' : '失败'}</b>{!result.ok && <span>{result.reason}</span>}</li>)}</ul>}</>}</section>
      <section><h3>OpenAI 兼容云端</h3><div className="dubbing-cloud-settings"><label>接口地址<input aria-label="云端配音接口地址" value={ttsSettings.baseUrl} onChange={(event) => updateTtsSettings({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label><label>规划模型（Sol/Luna）<input list="cloud-planner-presets" aria-label="云端规划模型" value={ttsSettings.plannerModel} onChange={(event) => updateTtsSettings({ plannerModel: event.target.value })} placeholder="gpt-6-luna" /><datalist id="cloud-planner-presets">{cloudPlannerPresets.map((item) => <option key={item} value={item} />)}</datalist></label><label>TTS 模型<input aria-label="云端 TTS 模型" value={ttsSettings.ttsModel || ttsSettings.model} onChange={(event) => updateTtsSettings({ ttsModel: event.target.value, model: event.target.value })} placeholder="网关提供的语音模型" /></label><label>转写模型<input aria-label="云端转写模型" value={ttsSettings.transcriptionModel} onChange={(event) => updateTtsSettings({ transcriptionModel: event.target.value })} placeholder="audio/transcriptions 模型" /></label><label>云端音色<select aria-label="云端配音音色" value={cloudVoicePresets.some((item) => item.id === ttsSettings.voice) ? ttsSettings.voice : '__custom__'} onChange={(event) => updateTtsSettings({ voice: event.target.value === '__custom__' ? '' : event.target.value })}><option value="__custom__">自定义音色 ID</option>{cloudVoicePresets.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}</select>{!cloudVoicePresets.some((item) => item.id === ttsSettings.voice) && <input aria-label="自定义云端配音音色" value={ttsSettings.voice} onChange={(event) => updateTtsSettings({ voice: event.target.value })} placeholder="输入自定义音色 ID" />}</label><label>API Key<input aria-label="云端配音 API Key" type="password" value={ttsSettings.apiKey} placeholder={ttsSettings.keepApiKey ? '已保存，留空保持原 Key' : '粘贴 API Key'} onChange={(event) => updateTtsSettings({ apiKey: event.target.value })} /></label><button className={`dubbing-save-button dubbing-save-${ttsSettingsState}`} disabled={!ttsSettingsLoaded || busy || ttsSettingsState === 'saving'} onClick={() => void saveTtsSettings()}>{ttsSettingsState === 'saving' ? '保存中…' : ttsSettingsState === 'saved' ? '已保存' : ttsSettingsState === 'error' ? '重试保存' : '保存云端设置'}</button><button className={`dubbing-test-button dubbing-test-${ttsTestState}`} disabled={!ttsSettingsLoaded || busy || ttsTestState === 'testing'} onClick={() => void testTtsSettings()}>{ttsTestState === 'testing' ? '测试中…' : ttsTestState === 'success' ? '测试成功' : ttsTestState === 'error' ? '重试测试' : '测试接口'}</button></div>{ttsTestMessage && <p className={`dubbing-tts-test-message dubbing-tts-test-${ttsTestState}`}>{ttsTestMessage}</p>}<small className="dubbing-cloud-hint">Sol/Luna 负责规划，TTS 模型负责发声；没有真实 TTS 模型时不能生成 WAV。</small></section>
    </div>
  </div>
  const renderPrepare = () => <div className="dubbing-step"><div className="dubbing-selection-card"><span className="section-kicker">当前选择 · {selectionIds.length} 段</span><h3>{source ? (resolved.sources.length > 1 ? `${resolved.sources.length} 段音频片段` : source.name) : '未选择可处理片段'}</h3><p>{source ? `${resolved.sources.map((item) => item.name).join('、')} · 总时长 ${resolved.sources.reduce((sum, item) => sum + item.duration, 0).toFixed(2)} 秒` : sourceError}</p>{resolved.issues.length > 0 && <div className="dubbing-warning">无法处理：{resolved.issues.map((item) => item.name).join('、')}</div>}</div><div className="dubbing-prepare-controls"><div className="dubbing-basic-settings"><label>语音生成后端<select aria-label="一键配音语音生成后端" value={backend} onChange={(event) => setBackend(event.target.value)}><option value="local-expressive">本地韵律增强</option><option value="kokoro-fast">本地快速模式</option><option value="openai-cloud">云端全流程（Sol/Luna + TTS）</option><option value="openai-compatible">仅云端 TTS</option></select></label>{backend !== 'openai-compatible' && backend !== 'openai-cloud' && <label>本地音色<select aria-label="一键配音本地音色" value={voice} onChange={(event) => setVoice(Number(event.target.value))}>{voices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}</div>{backend !== 'openai-compatible' && backend !== 'openai-cloud' && <details className="dubbing-advanced"><summary>表现设置 · {emotions.find((item) => item.id === emotion)?.name} · {ratePreset === 'slow' ? '慢速' : ratePreset === 'fast' ? '快速' : '自然'} · {pause === 'strong' ? '明显停顿' : pause === 'light' ? '弱停顿' : '标准停顿'}</summary><div className="dubbing-basic-settings"><label>情绪<select aria-label="一键配音情绪" value={emotion} onChange={(event) => setEmotion(event.target.value)}>{emotions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>语速<select aria-label="一键配音语速" value={ratePreset} onChange={(event) => setRatePreset(event.target.value)}><option value="slow">慢</option><option value="natural">自然</option><option value="fast">快</option></select></label><label>停顿<select aria-label="一键配音停顿" value={pause} onChange={(event) => setPause(event.target.value)}><option value="light">弱</option><option value="normal">标准</option><option value="strong">明显</option></select></label></div></details>}</div><div className="dubbing-step-actions"><button className="dubbing-primary-action" disabled={!resolved.sources.length || !backendReady || busy || hasRunningJobs} onClick={() => create('auto')}><Sparkles size={15} />{backend === 'openai-cloud' ? '云端一键识别并入轨' : '一键识别并入轨'}</button><button disabled={!resolved.sources.length || !backendReady || busy || hasRunningJobs} onClick={() => create('analyze')}><Mic size={14} />识别并翻译，进入校对</button><button className="dubbing-secondary-action" onClick={() => setSettingsOpen(true)}>模型、代理与云端设置</button></div></div>
  const renderBatch = () => <div className="dubbing-step"><div className="dubbing-batch-summary"><b>批次处理中</b><span>{batchJobs.filter((item) => item.status === 'ready').length}/{batchJobs.length} 已完成 · {batchJobs.filter((item) => active.has(item.status)).length} 处理中 · {failedJobs.length} 失败</span></div><div className="dubbing-batch-layout"><nav className="dubbing-batch-list" aria-label="配音批次">{batchJobs.map((item) => <button key={item.id} className={selected === item.id ? 'selected' : ''} onClick={() => { setSelected(item.id); setStep(item.status === 'review' || item.status === 'ready' ? 'review' : 'batch') }}><strong>{item.source.name}</strong><small>{statusText(item)}</small></button>)}</nav><div className="dubbing-batch-detail">{job ? <><div className="dubbing-job-heading"><div><b>{job.source.name}</b><small>{running && <LoaderCircle size={12} className="loading-spin" />}{job.stage}</small></div>{running && <button disabled={busy} onClick={() => void invoke(() => api.cancelDubbingJob(job.id)).then((value) => value && updateJob(value))}>取消当前任务</button>}</div>{job.error && <p className="dubbing-error">{job.error}</p>}<div className="dubbing-progress-copy">{statusText(job)} · {job.percent ? `${Math.round(job.percent)}%` : ''}</div></> : <p>批次任务尚未开始。</p>}</div></div><div className="dubbing-step-actions"><button onClick={() => setStep('result')}>查看结果</button>{failedJobs.length > 0 && <button onClick={retryFailed}>重试失败项</button>}</div></div>
  const renderReview = () => <div className="dubbing-step"><div className="dubbing-batch-layout"><nav className="dubbing-batch-list">{batchJobs.map((item) => <button key={item.id} className={selected === item.id ? 'selected' : ''} onClick={() => setSelected(item.id)}><strong>{item.source.name}</strong><small>{statusText(item)}</small></button>)}</nav><div className="dubbing-editor">{job ? <><div className="dubbing-job-heading"><div><b>{job.source.name}</b><small>{statusText(job)}</small></div></div><div className="dubbing-options"><button disabled={!job.backgroundPath || busy} onClick={() => listen(job.backgroundPath, '保留背景试听')}>{previewButtonIcon(job.backgroundPath)}{previewButtonLabel(job.backgroundPath, '试听背景')}</button><button disabled={!job.mixPath || dirty || busy} onClick={() => listen(job.mixPath, '整段中文配音试听')}>{previewButtonIcon(job.mixPath)}{previewButtonLabel(job.mixPath, '整段试听')}</button><button disabled={busy || running || generatingCueId === '__all__' || !job.cues?.some((cue) => cue.status !== 'ready')} onClick={generateAll}><LoaderCircle size={13} className={generatingCueId === '__all__' ? 'loading-spin' : undefined} />{generatingCueId === '__all__' ? '整段生成中…' : '整段生成'}</button></div><div className="dubbing-cues">{job.cues.map((cue, index) => <article className="dubbing-cue" key={cue.id}><div className="dubbing-cue-time"><b>{String(index + 1).padStart(2, '0')}</b><span>{clock(cue.start)} → {clock(cue.end)}</span><small>{statusText(cue)}</small></div><p lang="en">{cue.text}</p><textarea aria-label={`第 ${index + 1} 句中文译文`} value={drafts[cue.id] ?? cue.translation} onChange={(event) => setDrafts((current) => ({ ...current, [cue.id]: event.target.value }))} rows={2} /><div className="dubbing-cue-tweaks"><label>情绪<select aria-label={`第 ${index + 1} 句情绪`} value={cueProsody[cue.id]?.emotion || cue.prosody?.emotion || emotion} onChange={(event) => setCueProsody((current) => ({ ...current, [cue.id]: { ...(current[cue.id] || {}), emotion: event.target.value } }))}>{emotions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>语速<select aria-label={`第 ${index + 1} 句语速`} value={cueProsody[cue.id]?.ratePreset || (cue.prosody?.rate >= 1.06 ? 'fast' : cue.prosody?.rate <= 0.94 ? 'slow' : 'natural')} onChange={(event) => setCueProsody((current) => ({ ...current, [cue.id]: { ...(current[cue.id] || {}), ratePreset: event.target.value, rate: event.target.value === 'slow' ? 0.9 : event.target.value === 'fast' ? 1.1 : 1 } }))}><option value="slow">慢</option><option value="natural">自然</option><option value="fast">快</option></select></label><label>停顿<select aria-label={`第 ${index + 1} 句停顿`} value={cueProsody[cue.id]?.pause || cue.prosody?.pause || pause} onChange={(event) => setCueProsody((current) => ({ ...current, [cue.id]: { ...(current[cue.id] || {}), pause: event.target.value } }))}><option value="light">弱</option><option value="normal">标准</option><option value="strong">明显</option></select></label></div><div className="dubbing-cue-actions"><button disabled={busy || Boolean(generatingCueId)} onClick={() => generate(cue.id)}><RefreshCw size={12} className={generatingCueId === cue.id ? 'loading-spin' : undefined} />{generatingCueId === cue.id ? '生成中…' : '重新生成此句'}</button>{cue.audioPath && <button onClick={() => listen(cue.audioPath, `第 ${index + 1} 句试听`)}>{previewButtonIcon(cue.audioPath)}试听</button>}</div></article>)}</div>{preview && <div className="dubbing-player"><b>{preview.title}</b><audio key={preview.url} ref={audioRef} controls autoPlay src={preview.url} onPlay={() => setPreviewPlaying(true)} onPause={() => setPreviewPlaying(false)} onEnded={() => setPreviewPlaying(false)} /></div>}<div className="dubbing-step-actions"><button onClick={() => void invoke(saveDraft)}>保存校对</button>{job.status === 'ready' && <button className="dubbing-primary-action" disabled={dirty} onClick={() => applyReady([job])}>入轨当前片段</button>}</div></> : <p>请选择一个草稿。</p>}</div></div></div>
  const renderResult = () => <div className="dubbing-step"><div className="dubbing-result-card"><Sparkles size={22} /><h3>批次处理完成</h3><p>{readyBatchJobs.length} 段成功 · {failedJobs.length} 段失败 · {appliedCount} 段已入轨</p>{failedJobs.length > 0 && <div className="dubbing-error">失败片段：{failedJobs.map((item) => `${item.source.name}（${item.error || item.stage}）`).join('；')}</div>}</div><div className="dubbing-step-actions">{failedJobs.length > 0 && <button onClick={retryFailed}>重试失败项</button>}{pendingReadyJobs.length > 0 && <button className="dubbing-primary-action" onClick={() => applyReady(pendingReadyJobs)}>全部入轨</button>}<button onClick={onClose}>关闭</button></div></div>
  return <div className="dialog-scrim dubbing-scrim"><section className="dubbing-panel dubbing-wizard" role="dialog" aria-modal="true" aria-labelledby="dubbing-title">
    <header className="dialog-header"><div><span className="eyebrow">LOCAL · ENGLISH → 中文</span><h2 id="dubbing-title">智能配音</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭智能配音"><X size={18} /></button></header>
    <div className="dubbing-stepper" aria-label="配音流程"><button className={step === 'prepare' ? 'active' : ''} onClick={() => setStep('prepare')}>1 准备</button><button className={step === 'batch' ? 'active' : ''} onClick={() => batchJobs.length && setStep('batch')}>2 批次</button><button className={step === 'review' ? 'active' : ''} onClick={() => job && setStep('review')}>3 校对试听</button><button className={step === 'result' ? 'active' : ''} onClick={() => setStep('result')}>4 结果</button></div>
    {!api?.dubbingModels ? <p className="dubbing-error">请使用桌面版。本地智能配音首版支持 Apple Silicon Mac。</p> : <>{step === 'prepare' && renderPrepare()}{step === 'batch' && renderBatch()}{step === 'review' && renderReview()}{step === 'result' && renderResult()}{settingsOpen && renderSettings()}{error && <p className="dubbing-error" role="alert">{error}</p>}</>}
  </section></div>
}
