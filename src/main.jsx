import React, { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/newsreader'
import '@fontsource/dm-mono'
import {
  Aperture,
  AudioLines,
  AudioWaveform,
  BadgeCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clapperboard,
  CloudOff,
  Copy,
  Disc3,
  Download,
  Expand,
  FileAudio2,
  FileImage,
  FileVideo2,
  Film,
  Flag,
  FolderOpen,
  Gauge,
  Grid3X3,
  Headphones,
  ImagePlus,
  Info,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  Mic,
  Minus,
  MoreHorizontal,
  Music2,
  Pause,
  PictureInPicture2,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  Search,
  Settings2,
  SkipBack,
  SkipForward,
  Sparkles,
  Subtitles,
  Sun,
  Trash2,
  Undo2,
  Unlink2,
  Volume2,
  VolumeX,
  WandSparkles,
  Waves,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  addTrack,
  assessExport,
  audioPreviewUrl,
  calculateWaveform,
  createMediaClips,
  createSrt,
  defaultProject,
  exportEstimate,
  fileUrl,
  findActiveVisualClip,
  isLegacySilentPreviewProxy,
  findStreamCopyIssue,
  formatCompactTime,
  formatFileSize,
  formatTime,
  generateSuggestions,
  makeMediaAsset,
  mergeAssetLibraries,
  mergeAssetsByPath,
  toggleOrderedSelection,
  parseSrt,
  parseSubtitleFile,
  removeAssetReferences,
  removeTrack,
  removeTrackClips,
  replaceAssetById,
  repairPlaceholderDurationClips,
  repairSplitAudioDuplicates,
  resolveMediaDurationSeconds,
  sampleProject,
  splitClips,
  thumbnailForTime,
  trackTypes,
  unlinkClipPair,
} from './domain.js'
import './styles.css'
import BatchMixPanel from './BatchMixPanel.jsx'
import DubbingPanel from './DubbingPanel.jsx'
import { applyDubbingResult, applyDubbingResults, repairDubbingPlaybackState } from './dubbing-domain.js'
import { moveTimelineClips, removeTimelineClips, selectTimelineClips, timelineMoveIds } from './timeline-selection.js'
import { DeleteTrackDialog, TimelineTrackMenu } from './TimelineTrackMenu.jsx'
import { createBlankProject, isExampleProject, projectFileName, readProjectSession, writeProjectSession } from './project-session.js'

const FALLBACK_TOOLS = [
  { name: 'ffmpeg', path: null, version: null },
  { name: 'ffprobe', path: null, version: null },
  { name: 'melt', path: null, version: null },
]

const FEATURE_TABS = [
  { id: 'edit', label: '剪辑', icon: Scissors },
  { id: 'subtitles', label: '字幕', icon: Subtitles },
  { id: 'music', label: '智能配乐', icon: WandSparkles },
  { id: 'settings', label: '画幅', icon: Aperture },
]

class AppErrorBoundary extends React.Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error(`[Videome] render failure: ${error.stack}\n${info?.componentStack || ''}`)
  }

  render() {
    if (this.state.error) {
      return <div style={{ padding: 32, color: '#26332b', fontFamily: 'sans-serif' }}><h2>Videome 加载失败</h2><p>{this.state.error.message}</p><button onClick={() => window.location.reload()}>重新加载</button></div>
    }
    return this.props.children
  }
}

function App() {
  const [project, setProject] = useState(() => hydrateProject(mergeProjectAssetLibrary(loadProject(), loadAssets())))
  const [activeTab, setActiveTab] = useState('edit')
  const [activePanel, setActivePanel] = useState('素材库')
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)
  const [activeTrackId, setActiveTrackId] = useState('video-main')
  const [selectedId, setSelectedId] = useState(null)
  const [selectedClipIds, setSelectedClipIds] = useState([])
  const [selectedAssetIds, setSelectedAssetIds] = useState([])
  const [selectedCueId, setSelectedCueId] = useState('caption-1')
  const [assets, setAssets] = useState(() => mergeAssetLibraries(loadAssets(), loadProject().assets))
  const [tools, setTools] = useState(FALLBACK_TOOLS)
  const [zoom, setZoom] = useState(1.16)
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(1000)
  const [fitTimeline, setFitTimeline] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [guideMarkers, setGuideMarkers] = useState([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState('success')
  const [progress, setProgress] = useState(null)
  const [exportPreset, setExportPreset] = useState(() => project?.exportSettings?.preset || 'high')
  const [exportFormat, setExportFormat] = useState(() => project?.exportSettings?.format || 'mp4')
  const [search, setSearch] = useState('')
  const [assetMenuId, setAssetMenuId] = useState(null)
  const [timelineMenu, setTimelineMenu] = useState(null)
  const [deleteTrackId, setDeleteTrackId] = useState(null)
  const [trimDrafts, setTrimDrafts] = useState({ clipId: null, start: '', end: '' })
  const [mood, setMood] = useState('sunny')
  const [tempo, setTempo] = useState('mid')
  const [volumeTarget, setVolumeTarget] = useState(0.22)
  const transportAudio = useRef(null)
  const [saving, setSaving] = useState(false)
  const [projectPath, setProjectPath] = useState(() => readProjectSession(localStorage).path)
  const [showProjectMenu, setShowProjectMenu] = useState(false)
  const [showProjectLocation, setShowProjectLocation] = useState(false)
  const [storageLocations, setStorageLocations] = useState(null)
  const [previousProject, setPreviousProject] = useState(() => {
    try { return JSON.parse(localStorage.getItem('videome-previous-project')) } catch { return null }
  })
  const [editHistory, setEditHistory] = useState([])
  const [editFuture, setEditFuture] = useState([])
  const [subtitleGenerated, setSubtitleGenerated] = useState(false)
  const [relinkQueue, setRelinkQueue] = useState([])
  const [subtitleBusy, setSubtitleBusy] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showBatchMix, setShowBatchMix] = useState(false)
  const [showDubbing, setShowDubbing] = useState(false)
  const [musicFiles, setMusicFiles] = useState([])
  const [recordingMusic, setRecordingMusic] = useState(null)
  const [previewSeeking, setPreviewSeeking] = useState(false)
  const [previewErrorClipId, setPreviewErrorClipId] = useState(null)
  const [previewProxyClipId, setPreviewProxyClipId] = useState(null)
  const [previewErrorMessage, setPreviewErrorMessage] = useState('')
  const [previewFullscreen, setPreviewFullscreen] = useState(false)
  const [density, setDensity] = useState(false)
  const previewDurationRef = useRef(new Map())
  const fileInputRef = useRef(null)
  const audioRef = useRef(null)
  const timelineRef = useRef(null)
  const trackListRef = useRef(null)
  const objectUrlsRef = useRef(new Set())
  const playerRef = useRef(null)
  const projectNameInputRef = useRef(null)
  const timelineAudioPlayersRef = useRef(new Map())
  const playLoopRef = useRef(null)
  const audioFrameRef = useRef(0)
  const browserSessionRef = useRef(null)
  const previewAttemptRef = useRef(new Set())
  const previewReadyRef = useRef(new Map())
  const timelineMediaGrantRef = useRef(new Set())
  const durationProbeAttemptRef = useRef(new Set())
  const previewProxyAttemptRef = useRef(new Set())
  const previewSeekingTimerRef = useRef(null)
  const pendingVideoSeekRef = useRef(null)
  const liveTransportRef = useRef({ playing: false, position: project.playhead, lastClock: 0 })
  const activeTimelineAudioSignatureRef = useRef(null)
  const autosaveRef = useRef(null)
  const projectRef = useRef(project)
  const projectPathRef = useRef(projectPath)
  const projectEpochRef = useRef(0)
  const projectIdentityRef = useRef(0)
  const selectedClipIdsRef = useRef([])
  const timelineSelectionAnchorRef = useRef(null)
  const selectedAssetIdsRef = useRef([])
  const assetPointerSelectionRef = useRef(null)
  const toastTimerRef = useRef(null)
  const dragState = useRef(null)
  const suppressTimelineClickRef = useRef(null)
  const savePromiseRef = useRef(Promise.resolve())
  const manualSaveInProgressRef = useRef(false)
  const projectMenuRef = useRef(null)

  useEffect(() => {
    projectRef.current = project
    projectPathRef.current = projectPath
  }, [project, projectPath])

  useEffect(() => {
    const retained = selectedClipIdsRef.current.filter((id) => project.clips.some((clip) => clip.id === id))
    if (retained.length !== selectedClipIdsRef.current.length) updateSelectedClipIds(retained)
    if (!project.clips.some((clip) => clip.id === timelineSelectionAnchorRef.current)) timelineSelectionAnchorRef.current = null
  }, [project.clips])

  useEffect(() => {
    if (!window.videome?.onOpenProjectFile) return undefined
    return window.videome.onOpenProjectFile((opened) => {
      if (!opened?.data) return
      loadOpenedProject(opened.data, opened.path)
      setStatus(`已打开工程：${opened.path.split(/[\\/]/).pop()}`)
    })
  }, [])

  useEffect(() => {
    const viewport = timelineRef.current
    if (!viewport) return undefined
    const updateWidth = () => {
      setTimelineViewportWidth(viewport.clientWidth || 1000)
      trackListRef.current?.style.setProperty('--timeline-scrollbar-size', `${viewport.offsetHeight - viewport.clientHeight}px`)
    }
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!previewFullscreen) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setPreviewFullscreen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [previewFullscreen])

  const duration = Math.max(1, Number(project.duration) || 1)
  const safeExportSettings = project.exportSettings || defaultProject.exportSettings
  const safeSubtitle = project.subtitle || defaultProject.subtitle
  const timelineScaleBase = 12.4
  const minimumZoom = 0.15
  const timelineContentWidth = Math.max(1, duration * timelineScaleBase * zoom)
  const totalWidth = Math.max(timelineViewportWidth, timelineContentWidth)
  const selectedClip = useMemo(() => project.clips.find((clip) => clip.id === selectedId) || null, [project.clips, selectedId])
  const selectedAsset = useMemo(() => project.assets.find((asset) => asset.id === selectedClip?.assetId) || null, [project.assets, selectedClip])
  const activeTrack = useMemo(() => project.tracks.find((track) => track.id === activeTrackId) || project.tracks.find((track) => track.type === 'video') || project.tracks[0], [project.tracks, activeTrackId])
  const selectedSubtitle = useMemo(() => safeSubtitle.cues.find((cue) => project.playhead >= cue.start && project.playhead <= cue.end), [safeSubtitle.cues, project.playhead])
  const exampleMode = isExampleProject(project)
  const filteredAssets = assets.filter((asset) => `${asset.name} ${asset.kind} ${asset.codec || ''}`.toLowerCase().includes(search.toLowerCase()))
    const suggestions = generateSuggestions(musicFiles, { mood, tempo, duration })
  const exportSnapshot = useMemo(() => project, [project])
  const exportAssessment = useMemo(() => assessExport({ assets: project.assets, clips: project.clips, tracks: project.tracks, preset: exportPreset, format: exportFormat, frameSize: project.frameSize }), [project, exportPreset, exportFormat])
  const estimateBytes = exportEstimate({ duration, bitrateMbps: safeExportSettings.videoBitrateMbps, audioBitrateKbps: safeExportSettings.audioBitrateKbps, preset: exportPreset })
  const warning = selectedClip ? findStreamCopyIssue({ preset: exportPreset, format: exportFormat, clip: selectedClip, track: project.tracks.find((track) => track.id === selectedClip.trackId), subtitle: project.subtitle }) : null

  useEffect(() => {
    if (!selectedClip) {
      setTrimDrafts({ clipId: null, start: '', end: '' })
      return
    }
    setTrimDrafts({
      clipId: selectedClip.id,
      start: formatTime(Number(selectedClip.trimStart) || 0),
      end: formatTime((Number(selectedClip.trimEnd) || 0) || ((Number(selectedClip.trimStart) || 0) + (Number(selectedClip.duration) || 0))),
    })
  }, [selectedClip?.id, selectedClip?.trimStart, selectedClip?.trimEnd, selectedClip?.duration])

  useEffect(() => {
    let cancelled = false
    const unresolved = project.assets.filter((asset) => {
      const staleBrowserUrl = typeof asset.previewUrl === 'string' && asset.previewUrl.includes('/__videome/media?')
      const staleElectronUrl = typeof asset.previewUrl === 'string' && asset.previewUrl.startsWith('videome-media://')
      return asset.path && (!asset.previewUrl || staleBrowserUrl || staleElectronUrl) && !asset.missing && !previewAttemptRef.current.has(asset.id)
    })
    if (!unresolved.length) return undefined
    unresolved.forEach((asset) => previewAttemptRef.current.add(asset.id))

    Promise.all(unresolved.map((asset) => attachPreviewTransport(asset))).then((resolved) => {
      if (cancelled) return
      const byId = new Map(resolved.map((asset) => [asset.id, asset]))
      resolved.forEach((asset) => {
        if (asset.previewUrl || asset.proxyUrl) previewReadyRef.current.set(asset.id, asset.path || asset.id)
      })
      const changed = resolved.some((asset) => asset.previewUrl)
      if (!changed) return
      setProject((current) => ({ ...current, assets: current.assets.map((asset) => byId.get(asset.id) || asset) }))
      setAssets((current) => current.map((asset) => byId.get(asset.id) || asset))
    }).catch((error) => {
      if (!cancelled) setStatus(`本地预览连接失败：${error.message}`, 'info')
    })

    return () => { cancelled = true }
  }, [project.assets])

  useEffect(() => {
    if (!window.videome?.probeMedia) return undefined
    const candidates = project.assets.filter((asset) => asset.kind === 'video' && asset.path && !asset.missing && !durationProbeAttemptRef.current.has(asset.id))
    if (!candidates.length) return undefined
    candidates.forEach((asset) => durationProbeAttemptRef.current.add(asset.id))
    let cancelled = false

    window.videome.probeMedia(candidates.map((asset) => asset.path)).then((results) => {
      if (cancelled) return
      const durationByPath = new Map((results || []).filter((result) => result?.ok).map((result) => [result.path, resolveMediaDurationSeconds(result)]))
      if (!durationByPath.size) return

      setProject((current) => {
        let clips = current.clips
        const nextAssets = current.assets.map((asset) => {
          const probedDuration = durationByPath.get(asset.path)
          if (!(probedDuration > 0)) return asset
          previewDurationRef.current.set(asset.id, probedDuration)
          clips = repairPlaceholderDurationClips(clips, asset.id, probedDuration)
          return { ...asset, duration: probedDuration, sourceDuration: probedDuration }
        })
        const duration = Math.max(current.duration, ...clips.map((clip) => clip.start + clip.duration))
        return { ...current, assets: nextAssets, clips, duration }
      })
      setAssets((current) => current.map((asset) => {
        const probedDuration = durationByPath.get(asset.path)
        return probedDuration > 0 ? { ...asset, duration: probedDuration, sourceDuration: probedDuration } : asset
      }))
    }).catch((error) => {
      if (!cancelled) setStatus(`读取素材实际时长失败：${error.message}`, 'info')
    })

    return () => { cancelled = true }
  }, [project.assets])

  useEffect(() => {
    let mounted = true

    if (window.videome?.getMediaTools) {
      window.videome.getMediaTools()
        .then((result) => { if (mounted) setTools(result) })
        .catch(() => {})
    }

    window.videome?.getStorageLocations?.().then((locations) => { if (mounted) setStorageLocations(locations) }).catch(() => {})

    const dispose = window.videome?.onExportProgress
      ? window.videome.onExportProgress((nextProgress) => setProgress(nextProgress))
      : null
    let alive = true
    const reader = async () => {
      while (alive) {
        await new Promise((resolve) => window.setTimeout(resolve, 150))
        const next = window.__videomePendingProgress?.shift()
        if (next) setProgress(next)
      }
    }
    void reader()
    return () => {
      mounted = false
      alive = false
      dispose?.()
    }
  }, [])

  useEffect(() => {
    if (!showProjectMenu) return undefined
    const dismiss = (event) => { if (!projectMenuRef.current?.contains(event.target)) setShowProjectMenu(false) }
    const escape = (event) => { if (event.key === 'Escape') setShowProjectMenu(false) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [showProjectMenu])

  useEffect(() => {
    if (!showProjectLocation) return undefined
    const escape = (event) => { if (event.key === 'Escape') setShowProjectLocation(false) }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [showProjectLocation])

  useEffect(() => {
    const audioAssets = assets.filter((asset) => asset.kind === 'audio')
    setMusicFiles((current) => audioAssets.map((asset) => ({
      id: asset.id, name: asset.name, artist: '本地导入',
      mood: 'versatile', tempo: 'flexible', genre: '本地音乐', license: null, volume: 0.22,
      ...current.find((music) => music.id === asset.id),
      sourcePath: asset.path, previewUrl: asset.previewUrl, duration: asset.duration || 0,
    })))
  }, [assets])

  useEffect(() => {
    document.title = `${project.name || 'Videome'} — Videome Studio`
    return () => { document.title = 'Videome — Video Atelier' }
  }, [project.name])

  useEffect(() => {
    if (!message) return undefined
    toastTimerRef.current = window.setTimeout(() => setMessage(''), messageKind === 'error' ? 5600 : 3400)
    return () => window.clearTimeout(toastTimerRef.current)
  }, [message, messageKind])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (document.querySelector('[role="dialog"]') || event.target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], dialog')) return
      const key = event.key.toLowerCase()
      const mod = event.metaKey || event.ctrlKey

      if (mod && key === 's') {
        event.preventDefault()
        void saveProject({ saveAs: event.shiftKey })
      } else if (mod && key === 'n') {
        event.preventDefault()
        void createEmptyProject()
      } else if (mod && key === 'o') {
        event.preventDefault()
        void openProject()
      } else if (mod && key === 'z' && event.shiftKey) {
        event.preventDefault()
        handleRedo()
      } else if (mod && key === 'z') {
        event.preventDefault()
        handleUndo()
      } else if (mod && key === 'y') {
        event.preventDefault()
        handleRedo()
      } else if (key === 'escape') {
        clearTimelineSelection()
      } else if (event.code === 'Space') {
        event.preventDefault()
        togglePlayback()
      } else if (key === 'home' && !mod) {
        event.preventDefault()
        returnToStart()
      } else if (key === 'end' && !mod) {
        event.preventDefault()
        returnToEnd()
      } else if (key === 's' && !mod) {
        event.preventDefault()
        splitAtPlayhead()
      } else if (key === 'i' && !mod) {
        setActiveTab('subtitles')
      } else if (key === 'arrowright' && !mod) {
        setPlayhead(Math.min(duration, project.playhead + (event.shiftKey ? 1 : 1 / 30)))
      } else if (key === 'arrowleft' && !mod) {
        setPlayhead(Math.max(0, project.playhead - (event.shiftKey ? 1 : 1 / 30)))
      } else if ((key === 'delete' || key === 'backspace' || event.code === 'Delete') && event.shiftKey && !mod) {
        event.preventDefault()
        clearTrackContents()
      } else if (key === 'delete' || key === 'backspace' || event.code === 'Delete') {
        if (selectedId || selectedClipIdsRef.current.length) {
          event.preventDefault()
          removeSelected(false)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedId, project, duration, projectPath, activeTrackId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        writeProjectSession(localStorage, project, projectPath)
        localStorage.setItem('videome-assets', JSON.stringify(assets))
      } catch { setStatus('本地恢复缓存写入失败，请保存工程文件。', 'error') }
    }, 500)
    return () => window.clearTimeout(timer)
  }, [project, projectPath, assets])

  useEffect(() => {
    if (autosaveRef.current) window.clearInterval(autosaveRef.current)
    if (projectPath || project.assets.length || project.clips.some((clip) => !clip.id.startsWith('sample-'))) {
      autosaveRef.current = window.setInterval(() => {
        if (manualSaveInProgressRef.current) return
        const currentProject = projectRef.current
        const currentPath = projectPathRef.current
        const projectSnapshot = { ...currentProject, autosavedAt: new Date().toISOString() }
        const identity = projectIdentityRef.current
        try {
          savePromiseRef.current = savePromiseRef.current
            .catch(() => null)
            .then(async () => {
              if (projectIdentityRef.current !== identity || projectPathRef.current !== currentPath) return
              let recoveryCacheError = null
              try {
                localStorage.setItem('videome-autosave', JSON.stringify(projectSnapshot))
                localStorage.setItem('videome-assets', JSON.stringify(currentProject.assets))
                writeProjectSession(localStorage, projectSnapshot, currentPath)
              } catch (error) {
                recoveryCacheError = error
              }
              if (currentPath && !window.videome?.backupProject) {
                setStatus('当前应用尚未加载自动备份功能，请完全退出并重新打开桌面应用。', 'error')
                return
              }
              if (currentPath && window.videome?.backupProject) {
                const backupResult = await window.videome.backupProject({ project: projectSnapshot, path: currentPath })
                if (backupResult?.cleanupErrors?.length) {
                  setStatus(`自动备份已完成，但 ${backupResult.cleanupErrors.length} 个旧副本无法清理；请检查文件权限。`, 'info')
                }
              }
              if (recoveryCacheError) {
                setStatus(`本机恢复缓存写入失败，自动备份已完成：${recoveryCacheError.message || '存储空间不足'}`, 'info')
              }
            })
            .catch((error) => {
              const message = error?.message || '无法写入备份文件'
              const restartHint = /No handler registered|backup-project/i.test(message) ? '请完全退出并重新打开桌面应用。' : '请检查工程目录权限。'
              setStatus(`自动备份失败：${message}；${restartHint}`, 'error')
            })
        } catch {
          setStatus('本机恢复缓存空间不足；请尽快保存工程。', 'error')
        }
      }, 10000)
    }

    return () => {
      if (autosaveRef.current) window.clearInterval(autosaveRef.current)
    }
  }, [projectPath, project.assets.length])

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrlsRef.current.clear()
      if (playerRef.current) playerRef.current.pause()
      if (audioRef.current) audioRef.current.pause()
      if (playLoopRef.current) window.cancelAnimationFrame(playLoopRef.current)
      if (audioFrameRef.current) window.cancelAnimationFrame(audioFrameRef.current)
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    }
  }, [])

  function setStatus(text, kind = 'success') {
    setMessage(text)
    setMessageKind(kind)
  }

  function updateProject(patch, historyLabel = '', librarySnapshot = undefined) {
    setProject((current) => {
      projectEpochRef.current += 1
      if (historyLabel) {
        setEditHistory((previous) => [...previous.slice(-39), { label: historyLabel, project: current, ...(librarySnapshot !== undefined ? { assets: librarySnapshot } : {}) }])
        setEditFuture([])
      }
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch }
      projectRef.current = next
      return next
    })
  }

  function applyEdit(label, reducer, librarySnapshot = undefined) {
    updateProject(reducer, label, librarySnapshot)
  }

  function removeAsset(asset) {
    const current = projectRef.current
    const references = current.clips.filter((clip) => clip.assetId === asset.id)
    if (references.length && !window.confirm(`「${asset.name}」正在时间线上使用，将同时移除 ${references.length} 个片段。\n只从工程素材库移除，不会删除磁盘上的原始文件。继续？`)) return

    const nextProject = removeAssetReferences(current, asset.id)
    applyEdit('从素材库移除素材', (projectState) => removeAssetReferences(projectState, asset.id), assets)
    setAssets((existing) => existing.filter((item) => item.id !== asset.id))
    updateSelectedAssetIds(selectedAssetIdsRef.current.filter((id) => id !== asset.id))
    const removedClipIds = new Set(references.map((clip) => clip.id))
    updateSelectedClipIds(selectedClipIdsRef.current.filter((id) => !removedClipIds.has(id)))
    safeStorageWrite('videome-assets', nextProject.assets)
    if (selectedId && !nextProject.clips.some((clip) => clip.id === selectedId)) setSelectedId(null)
    setStatus(references.length ? `已移除素材及其 ${references.length} 个时间线片段；原文件未删除。` : `已从素材库移除「${asset.name}」；原文件未删除。`)
  }

  function clearMediaLibrary() {
    const current = projectRef.current
    const libraryAssets = [...new Map([...assets, ...(current.assets || [])].map((asset) => [asset.id, asset])).values()]
    if (!libraryAssets.length) return
    const assetIds = new Set(libraryAssets.map((asset) => asset.id))
    const nextProject = [...assetIds].reduce((next, assetId) => removeAssetReferences(next, assetId), current)
    const removedClipCount = current.clips.length - nextProject.clips.length
    if (!window.confirm(`确定清空素材库中的 ${libraryAssets.length} 个素材吗？${removedClipCount ? `同时移除时间线上的 ${removedClipCount} 个片段。` : ''}\n只移除本机库和工程引用，不会删除磁盘上的原始文件。此操作可撤销。`)) return

    applyEdit('清空素材库', () => nextProject, assets)
    setAssets([])
    updateSelectedAssetIds([])
    updateSelectedClipIds(selectedClipIdsRef.current.filter((id) => nextProject.clips.some((clip) => clip.id === id)))
    setAssetMenuId(null)
    safeStorageWrite('videome-assets', nextProject.assets)
    if (selectedId && !nextProject.clips.some((clip) => clip.id === selectedId)) setSelectedId(null)
    setStatus(`已清空 ${libraryAssets.length} 个素材${removedClipCount ? `及 ${removedClipCount} 个时间线片段` : ''}；原文件未删除。`)
  }

  async function copyAssetPath(asset) {
    if (!asset.path) {
      setStatus('该素材没有可用的本地文件路径。', 'info')
      return
    }
    try {
      await navigator.clipboard.writeText(asset.path)
      setStatus('素材路径已复制到剪贴板。')
    } catch {
      setStatus(`${asset.name}\n${asset.path}`, 'info')
    }
    setAssetMenuId(null)
  }

  function loadClip(clips, id = selectedId) {
    return clips.find((clip) => clip.id === id) || null
  }

  function updateSelectedClipIds(ids) {
    selectedClipIdsRef.current = ids
    setSelectedClipIds(ids)
  }

  function clearTimelineSelection() {
    updateSelectedClipIds([])
    timelineSelectionAnchorRef.current = null
    setSelectedId(null)
    setActivePanel('素材库')
  }

  function updateSelectedAssetIds(ids) {
    selectedAssetIdsRef.current = ids
    setSelectedAssetIds(ids)
  }

  function selectLibraryAsset(asset, event) {
    setAssetMenuId(null)
    updateSelectedClipIds([])
    timelineSelectionAnchorRef.current = null
    const current = selectedAssetIdsRef.current
    if (event.metaKey || event.ctrlKey) {
      updateSelectedAssetIds(toggleOrderedSelection(current, asset.id))
    } else if (event.shiftKey && current.length) {
      const visibleIds = filteredAssets.map((item) => item.id)
      const anchorIndex = visibleIds.indexOf(current.at(-1))
      const targetIndex = visibleIds.indexOf(asset.id)
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = [anchorIndex, targetIndex].sort((first, second) => first - second)
        const rangeIds = visibleIds.slice(start, end + 1)
        updateSelectedAssetIds([...current.filter((id) => !rangeIds.includes(id)), ...rangeIds])
      } else {
        updateSelectedAssetIds([asset.id])
      }
    } else {
      updateSelectedAssetIds([asset.id])
    }

    const assetClip = project.clips.find((clip) => clip.assetId === asset.id)
    setSelectedId(assetClip?.id || null)
    if (assetClip) setPlayhead(assetClip.start)
  }

  function handleLibraryAssetPointerDown(asset, event) {
    // Native dragging in Electron can swallow the later click event. Select on
    // the primary pointer press so a card remains selectable before a drag.
    if (event.button !== 0 || event.target.closest('button, [role="menu"]')) return
    assetPointerSelectionRef.current = asset.id
    selectLibraryAsset(asset, event)
  }

  function handleLibraryAssetClick(asset, event) {
    // A normal pointer press already selected this card. Ignore its follow-up
    // click so Ctrl/Cmd multi-selection is not toggled twice. Keep click as a
    // fallback for keyboard/assistive activation that has no pointer event.
    if (assetPointerSelectionRef.current === asset.id) {
      assetPointerSelectionRef.current = null
      return
    }
    selectLibraryAsset(asset, event)
  }

  function setPlayhead(value, selectedClipId = undefined) {
    const next = Math.max(0, Math.min(duration, value))
    liveTransportRef.current.position = next
    liveTransportRef.current.lastClock = 0
    if (liveTransportRef.current.playing) {
      const nextProject = { ...projectRef.current, playhead: next }
      const activeClip = findActiveVisualClip(nextProject, next)
      const video = playerRef.current
      if (activeClip?.kind === 'video' && video?.dataset.clipId === activeClip.id && video.readyState >= 1) {
        const sourceTime = Math.max(0, (Number(activeClip.trimStart) || 0) + next - activeClip.start)
        const target = Math.min(Number.isFinite(video.duration) ? video.duration : sourceTime, sourceTime)
        const frameTolerance = 1 / Number(nextProject.frameRate.numerator || 30)
        if (Math.abs(video.currentTime - target) > frameTolerance) {
          pendingVideoSeekRef.current = { clipId: activeClip.id, target }
          video.currentTime = target
        } else {
          pendingVideoSeekRef.current = null
        }
      } else {
        pendingVideoSeekRef.current = null
      }
      syncTimelineAudio(next, true, nextProject, true)
    }
    projectRef.current = { ...projectRef.current, playhead: next }
    setProject((current) => ({ ...current, playhead: next }))
    setSelectedId((previous) => {
      if (selectedClipId !== undefined) return selectedClipId
      const selection = selectedClipIdsRef.current
      if (selection.length) return selection.includes(previous) ? previous : selection.at(-1)
      const clip = project.clips.find((item) => next >= item.start && next < item.start + item.duration)
      return clip?.id || previous
    })
  }

  function returnToStart() {
    const currentProject = projectRef.current
    liveTransportRef.current.playing = false
    liveTransportRef.current.position = 0
    liveTransportRef.current.lastClock = 0
    if (playerRef.current && !playerRef.current.paused) playerRef.current.pause()
    syncTimelineAudio(0, false, currentProject)
    setPlaying(false)
    setPlayhead(0)
  }

  function returnToEnd() {
    const currentProject = projectRef.current
    liveTransportRef.current.playing = false
    liveTransportRef.current.position = duration
    liveTransportRef.current.lastClock = 0
    if (playerRef.current && !playerRef.current.paused) playerRef.current.pause()
    syncTimelineAudio(duration, false, currentProject)
    setPlaying(false)
    setPlayhead(duration)
  }

  function syncPreviewToPlayhead(event, clipId) {
    const video = event.currentTarget
    const currentProject = projectRef.current
    const activeClip = findActiveVisualClip(currentProject, currentProject.playhead)
    if (!activeClip || activeClip.id !== clipId) return
    const sourceTime = Math.max(0, (activeClip.trimStart || 0) + currentProject.playhead - activeClip.start)
    video.currentTime = Math.min(Number.isFinite(video.duration) ? video.duration : sourceTime, sourceTime)
    if (liveTransportRef.current.playing) {
      const resume = () => {
        const latestProject = projectRef.current
        const latestClip = findActiveVisualClip(latestProject, latestProject.playhead)
        if (latestClip?.id !== clipId || !liveTransportRef.current.playing) return
        const target = Math.max(0, (latestClip.trimStart || 0) + latestProject.playhead - latestClip.start)
        if (Math.abs(video.currentTime - target) > 1 / Number(latestProject.frameRate.numerator || 30)) video.currentTime = target
        video.play().catch(() => {})
      }
      if (video.readyState >= 2) resume()
      else video.addEventListener('loadeddata', resume, { once: true })
    }
  }

  function syncPreviewMetadata(event, clipId) {
    const video = event.currentTarget
    const currentProject = projectRef.current
    const activeClip = currentProject.clips.find((item) => item.id === clipId)
    const asset = currentProject.assets.find((item) => item.id === activeClip?.assetId)
    if (!activeClip || !asset) return syncPreviewToPlayhead(event, clipId)

    const duration = Math.max(Number(previewDurationRef.current.get(asset.id)) || 0, Number(asset.duration) || 0, Number(asset.sourceDuration) || 0)
    if (duration > Number(activeClip.sourceDuration || activeClip.duration) + 0.5) {
      const repaired = repairPlaceholderDurationClips(currentProject.clips, asset.id, duration)
      if (repaired !== currentProject.clips) {
        const end = Math.max(currentProject.duration, ...repaired.map((clip) => clip.start + clip.duration))
        setProject((current) => ({ ...current, clips: repaired, duration: end }))
        setStatus(`「${asset.name}」片段时长已从旧的 10 秒占位值修正为 ${formatCompactTime(duration)}。`)
      }
    }
    syncPreviewToPlayhead(event, clipId)
  }

  async function handlePreviewDecodeError(asset, clipId, event) {
    const mediaError = event?.currentTarget?.error
    const mediaErrorText = mediaError ? `媒体错误 ${mediaError.code}${mediaError.message ? `：${mediaError.message}` : ''}` : ''
    if (!asset?.path || !window.videome?.createPreviewProxy || asset.proxyUrl) {
      setPreviewErrorMessage(asset?.proxyUrl
        ? `兼容预览文件也无法读取。${mediaErrorText}`
        : `原素材无法读取，且本机未连接预览转换服务。${mediaErrorText}`)
      setPreviewErrorClipId(clipId)
      return
    }

    await requestPreviewProxy(asset, clipId)
  }

  async function requestPreviewProxy(asset, clipId) {
    if (!asset?.path || !window.videome?.createPreviewProxy || asset.proxyUrl || previewProxyAttemptRef.current.has(asset.id)) return
    previewProxyAttemptRef.current.add(asset.id)
    setPreviewProxyClipId(clipId)
    setPreviewErrorClipId(null)
    setPreviewErrorMessage('')
    const result = await window.videome.createPreviewProxy(asset.path).catch((error) => ({ ok: false, reason: error.message }))
    if (result?.ok && result.url) {
      setProject((current) => ({ ...current, assets: current.assets.map((item) => item.id === asset.id ? { ...item, proxyUrl: result.url } : item) }))
      setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, proxyUrl: result.url } : item))
    } else {
      setPreviewErrorClipId(clipId)
      const reason = result?.reason || 'FFmpeg 未返回失败原因。'
      setPreviewErrorMessage(reason)
      setStatus(`「${asset.name}」预览代理生成失败：${reason}`, 'error')
    }
    setPreviewProxyClipId(null)
  }

  function handleVideoSeeking() {
    if (liveTransportRef.current.playing) return
    if (previewSeekingTimerRef.current) window.clearTimeout(previewSeekingTimerRef.current)
    setPreviewSeeking(true)
    previewSeekingTimerRef.current = window.setTimeout(() => setPreviewSeeking(false), 1500)
  }

  function handleVideoSeeked() {
    if (previewSeekingTimerRef.current) window.clearTimeout(previewSeekingTimerRef.current)
    previewSeekingTimerRef.current = null
    setPreviewSeeking(false)
    if (pendingVideoSeekRef.current?.clipId === playerRef.current?.dataset.clipId
      && Math.abs((playerRef.current?.currentTime || 0) - pendingVideoSeekRef.current.target) <= 1 / Number(projectRef.current.frameRate.numerator || 30)) {
      pendingVideoSeekRef.current = null
    }
  }

  function handleUndo() {
    if (!editHistory.length) {
      setStatus('当前没有可撤销的编辑操作。', 'info')
      return
    }
    const previous = editHistory.at(-1)
    setEditFuture((future) => [...future, { label: previous.label, project, ...(previous.assets !== undefined ? { assets } : {}) }])
    setEditHistory((history) => history.slice(0, -1))
    projectEpochRef.current += 1
    projectRef.current = previous.project
    setProject(previous.project)
    if (previous.assets !== undefined) {
      setAssets(previous.assets)
      safeStorageWrite('videome-assets', previous.assets)
    }
    setStatus(`已撤销「${previous.label}」。`)
  }

  function handleRedo() {
    if (!editFuture.length) return
    const next = editFuture.at(-1)
    setEditHistory((history) => [...history, { label: next.label, project, ...(next.assets !== undefined ? { assets } : {}) }])
    setEditFuture((future) => future.slice(0, -1))
    projectEpochRef.current += 1
    projectRef.current = next.project
    setProject(next.project)
    if (next.assets !== undefined) {
      setAssets(next.assets)
      safeStorageWrite('videome-assets', next.assets)
    }
    setStatus('已重做一项编辑。')
  }

  function selectClip(clip, track, event) {
    const nextSelection = selectTimelineClips(project.clips, selectedClipIdsRef.current, clip.id, {
      toggle: event.metaKey || event.ctrlKey,
      range: event.shiftKey,
      anchorId: timelineSelectionAnchorRef.current,
    })
    if (!event.shiftKey || !project.clips.some((item) => item.id === timelineSelectionAnchorRef.current && item.trackId === clip.trackId)) timelineSelectionAnchorRef.current = clip.id
    const activeClipId = nextSelection.includes(clip.id) ? clip.id : nextSelection.at(-1) || null
    const activeClip = project.clips.find((item) => item.id === activeClipId)
    updateSelectedClipIds(nextSelection)
    setSelectedId(activeClipId)
    setActiveTrackId(activeClip?.trackId || track.id)
    setActivePanel(activeClip ? '属性检查器' : '素材库')
    if (activeClip && activeClip.start >= 0) setPlayhead(activeClip.start, activeClip.id)

    setActiveTab('edit')
  }

  function addSubtitleClip(cue) {
    const subtitleTrack = (activeTrack?.type === 'subtitle' && !activeTrack.locked ? activeTrack : null)
      || project.tracks.find((track) => track.type === 'subtitle' && !track.locked)
      || project.tracks.find((track) => track.type === 'graphics' && !track.locked)
    const targetTrack = subtitleTrack || { id: 'subtitles', type: 'subtitle', label: '字幕', accent: 'violet', locked: false, muted: false }
    if (!subtitleTrack) {
      setProject((current) => ({ ...current, tracks: [...current.tracks, targetTrack] }))
    }
    return {
      id: `caption-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
      assetId: cue.id,
      trackId: targetTrack.id,
      name: cue.text,
      start: cue.start,
      duration: cue.end - cue.start,
      color: 'violet',
      kind: 'subtitle',
      sourceCueId: cue.id,
      sourceStart: cue.start,
      missing: false,
    }
  }

  async function importPaths(paths, { files = [], addToTimeline = false, preferredKind = null } = {}) {
    if (!paths?.length) return []
    setLoading(true)

    try {
      const metadata = window.videome?.probeMedia
        ? await window.videome.probeMedia(paths)
        : await previewProbeMedia(paths, files)
      if (!window.videome?.getMediaTools) {
        const toolsResponse = await fetch('/__videome/api/tools').catch(() => null)
        if (toolsResponse?.ok) setTools(await toolsResponse.json())
      }
      const fileByPath = new Map(files.map((file) => [file.path || file.name, file]))
      const browserDurationByName = new Map()
      const durationForFile = async (file) => {
        if (!file) return 0
        const key = file.path || file.name
        if (browserDurationByName.has(key)) return browserDurationByName.get(key)
        const duration = await probeBrowserFileDuration(file)
        browserDurationByName.set(key, duration)
        return duration
      }
      const additions = []

      for (const item of metadata) {
        if (!item.ok) {
          const file = fileByPath.get(item.path) || files.find((candidate) => candidate.name === item.name)
          if (file) {
            const localUrl = URL.createObjectURL(file)
            objectUrlsRef.current.add(localUrl)
            const browserDuration = await durationForFile(file)
            const asset = makeMediaAsset(file.path || item.path, {
              name: file.name,
              size: file.size,
              duration: Number(file.duration) || browserDuration || resolveMediaDurationSeconds(item) || 0,
              kind: preferredKind || (file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : 'video'),
              previewUrl: localUrl,
              path: file.path || null,
            })
            asset.previewUrl = localUrl
            additions.push(asset)
          } else {
            setStatus(`${item.name}: ${item.reason}`, 'error')
          }
          continue
        }

        const file = fileByPath.get(item.path) || files.find((candidate) => candidate.name === item.name)
        const browserDuration = file ? await durationForFile(file) : 0
        const detectedDuration = resolveMediaDurationSeconds(item) || Number(item.duration) || browserDuration || 0
        const storedAsset = projectRef.current.assets.find((asset) => asset.path === item.path)
        const source = makeMediaAsset(item.path, {
          ...storedAsset,
          ...item,
          duration: Math.max(detectedDuration, Number(storedAsset?.duration) || 0),
          sourceDuration: Math.max(detectedDuration, Number(storedAsset?.sourceDuration) || 0),
        })
        const asset = preferredKind ? { ...source, kind: preferredKind } : source
        additions.push(asset)
      }

      if (!additions.length) return []

      const resolvedAssets = await Promise.all(additions.map((asset) => attachPreviewTransport(asset)))
      resolvedAssets.forEach((asset) => {
        if (asset.previewUrl || asset.proxyUrl) previewReadyRef.current.set(asset.id, asset.path || asset.id)
      })
      const currentLibrary = mergeAssetLibraries(projectRef.current.assets, assets, loadAssets())
      const mergedLibrary = mergeAssetLibraries(currentLibrary, resolvedAssets)
      const libraryAsset = (asset) => mergedLibrary.find((item) => item.id === asset.id || (asset.path && item.path === asset.path)) || asset
      const timelineAssets = resolvedAssets.map(libraryAsset)

      if (addToTimeline) {
        const withMissing = resolveMissingClips(projectRef.current.clips, timelineAssets)
        const result = createMediaClips({
          assets: timelineAssets,
          track: projectRef.current.tracks.find((track) => track.id === activeTrackId) || projectRef.current.tracks.find((track) => track.type === 'video') || projectRef.current.tracks[0],
          clips: withMissing,
          playhead: projectRef.current.playhead,
          duration: projectRef.current.duration,
          tracks: projectRef.current.tracks,
        })

        updateProject((current) => ({
          ...current,
          clips: result.clips,
          tracks: result.tracks,
          assets: mergeAssetLibraries(current.assets, currentLibrary, timelineAssets),
          duration: Math.max(current.duration, result.duration),
          exportSettings: { ...current.exportSettings, preset: result.inserted.some((clip) => clip.kind === 'video') ? 'high' : current.exportSettings.preset },
        }), '导入素材')

        if (result.inserted.length) {
          updateSelectedClipIds([])
          const focused = result.inserted[0]
          setSelectedId(focused.id)
          setActiveTrackId(focused.trackId)
          setPlayhead(focused.start, focused.id)
          setActivePanel('属性检查器')
          setStatus(`已添加 ${result.inserted.length} 个片段到「${focused.kind === 'audio' ? '音频轨' : focused.kind === 'image' ? '图文轨' : '视频轨'}」。`)
        }
      } else if (isExampleProject(project)) {
        setProject((current) => ({ ...current, clips: current.clips.filter((clip) => !clip.id.startsWith('sample-')) }))
        setStatus('真实素材已导入。示例时间轴仅用于预览，按住素材后拖入时间轴开始制作。', 'info')
      } else {
        setStatus(`已导入 ${additions.length} 个${preferredKind === 'audio' ? '音乐文件' : '媒体素材'}。拖入时间轴开始剪辑。`)
      }

      setProject((current) => ({ ...current, assets: mergeAssetLibraries(current.assets, currentLibrary, timelineAssets) }))
      setAssets((current) => mergeAssetLibraries(current, currentLibrary, timelineAssets))
      safeStorageWrite('videome-assets', mergedLibrary)
      return timelineAssets
    } catch (error) {
      setStatus(`导入失败：${error.message}`, 'error')
      return []
    } finally {
      setLoading(false)
    }
  }

  function resolveMissingClips(clips, additions) {
    const replacementByName = new Map(additions.map((asset) => [asset.name.toLowerCase(), asset]))
    return clips.map((clip) => {
      if (!clip.missing) return clip
      const match = replacementByName.get(String(clip.name || '').toLowerCase()) || additions[0]
      return match ? { ...clip, assetId: match.id, path: match.path, missing: false } : clip
    })
  }

  async function openPicker({ preferredKind = null, addToTimeline = false } = {}) {
    try {
      if (window.videome?.pickMedia) {
        const paths = await window.videome.pickMedia()
        if (paths.length) await importPaths(paths, { preferredKind, addToTimeline })
        return
      }
      fileInputRef.current?.setAttribute('data-preferred-kind', preferredKind || '')
      fileInputRef.current?.setAttribute('data-add-to-timeline', String(addToTimeline))
      fileInputRef.current?.click()
    } catch (error) {
      setStatus(`无法打开文件选择器：${error.message}`, 'error')
    }
  }

  async function handleBrowserFiles(event) {
    const files = [...(event.target.files || [])]
    const kind = event.target.dataset.preferredKind || null
    const addToTimeline = event.target.dataset.addToTimeline === 'true'
    if (!files.length) return

    if (window.videome?.probeMedia) {
      await importPaths(files.map((file) => file.path || file.name), { files, preferredKind: kind, addToTimeline })
    } else {
      const additions = await Promise.all(files.map(async (file, index) => {
        const url = URL.createObjectURL(file)
        objectUrlsRef.current.add(url)
        const measuredDuration = await probeBrowserFileDuration(file)
        const asset = makeMediaAsset(file.name, {
          id: `browser-${Date.now()}-${index}`,
          name: file.name,
          size: file.size,
          duration: resolveMediaDurationSeconds({ duration: file.duration }) || measuredDuration || 0,
          kind: kind || (file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : 'video'),
          previewUrl: url,
        })
        asset.previewUrl = url
        return asset
      }))
      const currentLibrary = mergeAssetLibraries(projectRef.current.assets, assets, loadAssets())
      const mergedAssets = mergeAssetLibraries(currentLibrary, additions)
      setAssets((existing) => mergeAssetLibraries(existing, currentLibrary, additions))
      setProject((current) => ({ ...current, assets: mergeAssetLibraries(current.assets, currentLibrary, additions) }))
      safeStorageWrite('videome-assets', mergedAssets)
      if (addToTimeline) {
        const firstVideo = project.tracks.find((track) => track.type === 'video') || project.tracks[0]
        const result = createMediaClips({ assets: additions, track: firstVideo, clips: project.clips.filter((clip) => !clip.id.startsWith('sample-')), playhead: project.playhead, duration: project.duration, tracks: project.tracks })
        applyEdit('添加素材', (current) => ({ ...current, clips: result.clips, tracks: result.tracks, assets: mergeAssetsByPath(current.assets, additions), duration: Math.max(current.duration, result.duration) }))
      }
      setStatus(`已添加 ${additions.length} 个文件到素材库。`)
    }
    event.target.value = ''
  }

  async function saveProject({ saveAs = false } = {}) {
    if (saving) return savePromiseRef.current
    manualSaveInProgressRef.current = true
    await savePromiseRef.current.catch(() => null)
    const nameInEditor = projectNameInputRef.current?.value
    const name = typeof nameInEditor === 'string' ? normalizeProjectName(nameInEditor) : normalizeProjectName(projectRef.current.name)
    if (projectRef.current.name !== name) {
      projectRef.current = { ...projectRef.current, name }
      setProject((current) => current.name === name ? current : { ...current, name })
    }
    const checkpoint = normalizeProjectForPersistence({ ...projectRef.current })
    checkpoint.savedAt = new Date().toISOString()
    try {
      localStorage.setItem('videome-autosave', JSON.stringify(checkpoint))
      localStorage.setItem('videome-assets', JSON.stringify(checkpoint.assets))
    } catch {
      setStatus('无法写入本地恢复缓存；工程文件保存仍会继续。', 'info')
    }
    const saveEpoch = projectEpochRef.current
    const saveIdentity = projectIdentityRef.current
    const checkpointSignature = JSON.stringify(checkpoint)

    if (!window.videome?.saveProject && !window.videome?.saveProjectFile) {
      try {
        localStorage.setItem('videome-project', JSON.stringify(checkpoint))
        localStorage.setItem('videome-assets', JSON.stringify(checkpoint.assets))
        updateProject({ savedAt: checkpoint.savedAt })
        setStatus('已保存到此设备的本地浏览器存储。', 'info')
      } catch {
        setStatus('本地存储空间不足；可在桌面应用中保存为 .videome 工程。', 'error')
      } finally {
        manualSaveInProgressRef.current = false
      }
      return null
    }

    setSaving(true)
    try {
      const writablePath = !saveAs && projectPath && projectPathMatchesName(projectPath, checkpoint.name) ? projectPath : null
      const write = () => writablePath && window.videome?.saveProjectFile
        ? window.videome.saveProjectFile({ project: checkpoint, path: writablePath })
        : window.videome.saveProject({ project: checkpoint, defaultDirectory: projectPath ? pathDirname(projectPath) : null })
      savePromiseRef.current = savePromiseRef.current.catch(() => null).then(write)
      const result = await savePromiseRef.current
      if (!result?.path) return
      if (projectIdentityRef.current !== saveIdentity) return result
      projectPathRef.current = result.path
      setProjectPath(result.path)
      writeProjectSession(localStorage, projectRef.current, result.path)
      if (projectEpochRef.current === saveEpoch && JSON.stringify(normalizeProjectForPersistence(projectRef.current)) === checkpointSignature) {
        projectRef.current = { ...projectRef.current, savedAt: checkpoint.savedAt }
        setProject((current) => ({ ...current, savedAt: checkpoint.savedAt }))
      }
      setStatus(`工程已保存：${result.path}`)
      return result
    } catch (error) {
      setStatus(`工程保存失败：${error.message}`, 'error')
    } finally {
      setSaving(false)
      manualSaveInProgressRef.current = false
    }
  }

  async function openProject() {
    setShowProjectMenu(false)
    if (!window.videome?.openProject) {
      setStatus('打开 .videome 文件请使用桌面版；当前修改会保存在此浏览器的恢复缓存中。', 'info')
      return
    }

    try {
      const result = await window.videome.openProject()
      if (!result) return
      const openedData = hydrateProject(result.data)
      if (!loadOpenedProject(openedData, result.path)) return
      setStatus('工程已打开；正在检查源素材路径。')
      const missing = openedData.assets.filter((asset) => asset.path && !asset.previewUrl)
      if (missing.length) {
        const identity = projectIdentityRef.current
        const diagnostics = await window.videome.probeMedia(missing.map((asset) => asset.path))
        if (projectIdentityRef.current !== identity) return
        const byPath = new Map(diagnostics.map((entry) => [entry.path, entry]))
        const recovered = openedData.assets.map((asset) => {
          const item = byPath.get(asset.path)
          return item?.ok ? { ...asset, ...item, codec: item.videoCodec || item.audioCodec || asset.codec, missing: false } : { ...asset, missing: true, missingReason: item?.reason || '素材文件不可访问' }
        })
        setProject((current) => ({ ...current, assets: recovered, clips: current.clips.map((clip) => ({ ...clip, missing: Boolean(recovered.find((asset) => asset.id === clip.assetId)?.missing) })) }))
        setAssets((current) => mergeAssetLibraries(current, loadAssets(), recovered))
        if (recovered.some((asset) => asset.missing)) {
          setRelinkQueue(recovered.filter((asset) => asset.missing))
          setStatus(`有 ${recovered.filter((asset) => asset.missing).length} 个素材找不到原文件，请重新定位。`, 'error')
        }
      }
    } catch (error) {
      setStatus(`打开工程失败：${error.message}`, 'error')
    }
  }

  function loadOpenedProject(data, path) {
    if (!preserveCurrentProject()) return false
    const migrated = hydrateProject(data)
    const fileName = pathBasename(path).replace(/\.videome$/i, '')
    const storedName = typeof data?.name === 'string' ? data.name.trim() : ''
    if ((!storedName || storedName === '未命名项目') && fileName) migrated.name = fileName
    const libraryAssets = mergeAssetLibraries(loadAssets(), assets, migrated.assets)
    const openedProject = { ...migrated, assets: migrated.assets }
    try { writeProjectSession(localStorage, openedProject, path) }
    catch { setStatus('无法保存工程切换状态，请先释放本机存储空间。', 'error'); return false }
    projectEpochRef.current += 1
    projectIdentityRef.current += 1
    projectRef.current = openedProject
    projectPathRef.current = path
    setProject(openedProject)
    setAssets(libraryAssets)
    setProjectPath(path)
    updateSelectedAssetIds([])
    updateSelectedClipIds([])
    setPlaying(false)
    setShowProjectMenu(false)
    setShowProjectLocation(false)
    setTimelineMenu(null)
    setDeleteTrackId(null)
    setEditHistory([])
    setEditFuture([])
    setSelectedId(migrated.clips[0]?.id || null)
    return true
  }

  function createEmptyProject() {
    const libraryAssets = mergeAssetLibraries(projectRef.current.assets, assets, loadAssets())
    if (!loadOpenedProject(createBlankProject(defaultProject.name, libraryAssets), null)) return
    setActivePanel('素材库')
    setActiveTab('edit')
    setSearch('')
    setStatus('已新建空白工程，素材库已保留。可在项目菜单恢复切换前的工程。')
  }

  function preserveCurrentProject() {
    const snapshot = { project: normalizeProjectForPersistence(projectRef.current), path: projectPathRef.current, capturedAt: new Date().toISOString() }
    if (!safeStorageWrite('videome-previous-project', snapshot)) {
      setStatus('无法保存切换前的工程，请先手动保存。', 'error')
      return false
    }
    setPreviousProject(snapshot)
    return true
  }

  async function revealProject() {
    if (!projectPath || !window.videome?.showProjectInFolder) return
    const result = await window.videome.showProjectInFolder(projectPath)
    if (!result?.ok) setStatus(result?.reason || '无法定位工程文件。', 'error')
  }

  function restorePreviousProject() {
    if (!previousProject?.project) return
    if (!loadOpenedProject(previousProject.project, previousProject.path)) return
    setStatus('已恢复切换前的工程。')
  }

  function setExportValue(key, value) {
    setProject((current) => ({ ...current, exportSettings: { ...current.exportSettings, [key]: value } }))
  }

  async function startExport() {
    if (!exportAssessment.ready) {
      setStatus(exportAssessment.issues.find((issue) => issue.severity === 'error')?.detail || '请先修复导出设置。', 'error')
      setShowExport(true)
      return
    }
    const settings = {
      project,
      preset: exportPreset,
      format: exportFormat,
      videoCodec: project.exportSettings.videoCodec || 'h264',
      videoBitrateMbps: Number(project.exportSettings.videoBitrateMbps) || 12,
      audioBitrateKbps: Number(project.exportSettings.audioBitrateKbps) || 256,
      fileName: `${project.name || 'Videome'}-export`,
      expectedSizeBytes: estimateBytes,
    }

    setProgress({ percent: 0, indeterminate: true })
    setShowExport(false)
    setStatus('正在分析时间轴并安全导出。', 'info')
    try {
      const result = window.videome?.exportMedia
        ? await window.videome.exportMedia({ settings, project })
        : await exportThroughLocalPreview(settings, project, (nextProgress) => setProgress(nextProgress))
      if (!result) {
        setProgress(null)
        return
      }
      if (!result.ok) {
        setProgress(null)
        setStatus(`导出失败：${result.reason}`, 'error')
        return
      }
      setProgress(null)
      setStatus(`导出完成，文件已验证：${result.path.split(/[\\/]/).pop()}`)
    } catch (error) {
      setProgress(null)
      setStatus(`导出失败：${error.message}`, 'error')
    }
  }

  async function cancelExport() {
    const canceled = window.videome?.cancelExport
      ? await window.videome.cancelExport()
      : await cancelLocalPreviewExport()
    if (canceled) setStatus('已停止导出，未完成的临时文件将自动清理。', 'info')
    setProgress(null)
  }

  function splitAtPlayhead() {
    const activeState = projectRef.current
    const editableTrackIds = activeState.tracks.filter((track) => ['video', 'audio', 'graphics', 'subtitle'].includes(track.type) && !track.locked).map((track) => track.id)
    const splitResult = splitClips(activeState.clips, activeState.playhead, editableTrackIds)
    const sourceIds = new Set(activeState.clips.map((clip) => clip.id))
    const splitCount = splitResult.filter((clip) => !sourceIds.has(clip.id)).length
    if (!splitCount) {
      const crossingClips = activeState.clips.filter((clip) => activeState.playhead > clip.start + 1 / 240 && activeState.playhead < clip.start + clip.duration - 1 / 240)
      setStatus(crossingClips.length && crossingClips.every((clip) => !editableTrackIds.includes(clip.trackId))
        ? '播放指针处的轨道已锁定，请先解锁后再分割。'
        : '播放指针未穿过任何片段，请将红色播放头移动到片段内部。', 'info')
      return
    }

    applyEdit('分割片段', (current) => ({ ...current, clips: splitResult }))
    setStatus(`已在 ${formatTime(activeState.playhead)} 分割 ${splitCount} 个片段。`)
  }

  function removeSelected(ripple) {
    const current = projectRef.current
    const selectedIds = selectedClipIdsRef.current.filter((id) => current.clips.some((clip) => clip.id === id))
    if (!selectedIds.length && current.clips.some((clip) => clip.id === selectedId)) selectedIds.push(selectedId)
    if (!selectedIds.length) {
      setStatus('先选择需要删除的片段。', 'info')
      return
    }
    const lockedTracks = new Set(current.tracks.filter((track) => track.locked).map((track) => track.id))
    if (current.clips.some((clip) => selectedIds.includes(clip.id) && lockedTracks.has(clip.trackId))) {
      setStatus('所选片段中有锁定轨道的内容；请先解锁或取消选择后再删除。', 'info')
      return
    }
    const nextClips = removeTimelineClips(current.clips, selectedIds, ripple, current.tracks)
    if (current.clips.length === nextClips.length) {
      setStatus('所选片段没有被删除，请重新选择后重试。', 'info')
      return
    }
    applyEdit(ripple ? '波纹删除片段' : '删除片段', (projectState) => {
      const previousDuration = Math.max(1, ...projectState.clips.map((clip) => clip.start + clip.duration))
      const nextDuration = Math.max(1, ...nextClips.map((clip) => clip.start + clip.duration))
      const retainedIds = new Set(nextClips.map((clip) => clip.id))
      const removed = projectState.clips.filter((clip) => !retainedIds.has(clip.id))
      const retainedCueIds = new Set(nextClips.filter((clip) => clip.kind === 'subtitle').map((clip) => clip.sourceCueId || clip.assetId))
      const removedCueIds = new Set(removed.filter((clip) => clip.kind === 'subtitle').map((clip) => clip.sourceCueId || clip.assetId))
      const delta = previousDuration - nextDuration
      return {
        ...projectState,
        clips: nextClips,
        duration: ripple && delta > 0 && removed.some((clip) => clip.start + clip.duration >= previousDuration - .15) ? nextDuration : projectState.duration,
        subtitle: removedCueIds.size ? { ...projectState.subtitle, cues: projectState.subtitle.cues.filter((cue) => !removedCueIds.has(cue.id) || retainedCueIds.has(cue.id)) } : projectState.subtitle,
      }
    })
    clearTimelineSelection()
    setStatus(`已删除 ${current.clips.length - nextClips.length} 个片段${ripple ? '，后续片段向前闭合' : ''}。`)
  }

  function clearTrackContents(trackId = activeTrackId) {
    const current = projectRef.current
    const track = current.tracks.find((item) => item.id === trackId)
    if (!track) {
      setStatus('没有可清空的活动轨道。', 'info')
      return
    }
    if (track.locked) {
      setStatus(`「${track.label}」已锁定；请先解锁再清空轨道。`, 'info')
      return
    }
    const directClips = current.clips.filter((clip) => clip.trackId === track.id)
    if (!directClips.length) {
      setStatus(`「${track.label}」已经是空的。`, 'info')
      return
    }
    const nextClips = removeTrackClips(current.clips, track.id)
    const removedIds = new Set(current.clips.filter((clip) => !nextClips.some((candidate) => candidate.id === clip.id)).map((clip) => clip.id))
    const removedCueIds = new Set(current.clips.filter((clip) => removedIds.has(clip.id) && clip.kind === 'subtitle' && clip.sourceCueId).map((clip) => clip.sourceCueId))
    const linkedCount = Math.max(0, removedIds.size - directClips.length)

    applyEdit('清空轨道内容', (projectState) => ({
      ...projectState,
      clips: removeTrackClips(projectState.clips, track.id),
      subtitle: removedCueIds.size
        ? { ...projectState.subtitle, cues: projectState.subtitle.cues.filter((cue) => !removedCueIds.has(cue.id)) }
        : projectState.subtitle,
    }))
    if (selectedId && removedIds.has(selectedId)) setSelectedId(null)
    if (removedIds.size) updateSelectedClipIds(selectedClipIdsRef.current.filter((id) => !removedIds.has(id)))
    setStatus(`已清空「${track.label}」中的 ${directClips.length} 个片段${linkedCount ? `，并移除 ${linkedCount} 个关联片段` : ''}。`)
  }

  function requestTrackDeletion(trackId) {
    const current = projectRef.current
    const track = current.tracks.find((item) => item.id === trackId)
    if (!track) return
    const next = removeTrack(current, trackId)
    if (next === current) {
      setStatus(track.locked ? `「${track.label}」已锁定；请先解锁再删除轨道。` : '联动片段所在轨道已锁定；请先解锁再删除轨道。', 'info')
      return
    }
    if (next.clips.length < current.clips.length) {
      setDeleteTrackId(trackId)
      return
    }
    deleteTrackCommand(trackId)
  }

  function deleteTrackCommand(trackId) {
    const current = projectRef.current
    const track = current.tracks.find((item) => item.id === trackId)
    const next = removeTrack(current, trackId)
    setDeleteTrackId(null)
    if (!track || next === current) {
      if (track) setStatus('轨道或其联动片段已锁定，请先解锁。', 'info')
      return
    }
    const retainedIds = new Set(next.clips.map((clip) => clip.id))
    applyEdit('删除轨道', (projectState) => removeTrack(projectState, trackId))
    if (selectedId && !retainedIds.has(selectedId)) setSelectedId(null)
    updateSelectedClipIds(selectedClipIdsRef.current.filter((id) => retainedIds.has(id)))
    if (activeTrack?.id === trackId) {
      const index = current.tracks.findIndex((item) => item.id === trackId)
      setActiveTrackId(next.tracks[Math.min(index, next.tracks.length - 1)]?.id || null)
    }
    const removedCount = current.clips.length - next.clips.length
    setStatus(`已删除「${track.label}」${removedCount ? `及 ${removedCount} 个片段` : ''}，可撤销恢复。`)
  }

  function setClipVolume(clipId, volume) {
    applyEdit('调整片段音量', (current) => {
      const target = current.clips.find((clip) => clip.id === clipId)
      const linkedVideoId = target?.kind === 'video' ? target.id : target?.linkedClipId
      return {
        ...current,
        clips: current.clips.map((clip) => clip.id === clipId
          || (linkedVideoId && (clip.id === linkedVideoId || clip.linkedClipId === linkedVideoId))
          ? { ...clip, volume }
          : clip),
      }
    })
  }

  function toggleClipLink() {
    if (!selectedClip) return
    if (selectedClip.linkedClipId || selectedClip.audioLinked) {
      applyEdit('解除音画联动', (current) => ({ ...current, clips: unlinkClipPair(current.clips, selectedClip.id) }))
      setStatus('音画已解除联动，可分别移动和编辑。')
      return
    }
    if (selectedClip.kind !== 'video' || !selectedAsset?.audioCodec) {
      setStatus('请选择带原声的视频片段。', 'info')
      return
    }
    const audioTrack = project.tracks.find((track) => track.type === 'audio' && /原声|配音/i.test(track.label)) || project.tracks.find((track) => track.type === 'audio')
    if (!audioTrack) {
      setStatus('请先添加一条音频轨，再链接视频原声。', 'info')
      return
    }
    const linked = {
      id: `${selectedClip.id}-source-audio`, linkedClipId: selectedClip.id, assetId: selectedClip.assetId,
      path: selectedAsset.path, trackId: audioTrack.id, name: `${selectedClip.name} · 原声`,
      start: selectedClip.start, duration: selectedClip.duration, trimStart: selectedClip.trimStart || 0,
      trimEnd: selectedClip.trimEnd || selectedClip.duration, sourceDuration: selectedClip.sourceDuration,
      color: audioTrack.accent, kind: 'audio', volume: selectedClip.volume ?? 0.82, isMusic: false,
    }
    applyEdit('链接音画', (current) => ({
      ...current,
      clips: [...current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, audioLinked: true } : clip), linked],
    }))
    setStatus('视频原声已添加到音频轨并与画面联动。')
  }

  function addMusicToTimeline(music) {
    const source = music.sourcePath ? project.assets.find((asset) => asset.path === music.sourcePath) : null
    if (!source && window.videome?.pickAudio) {
      void (async () => {
        const paths = await window.videome.pickAudio()
        if (!paths.length) return
        const added = await importPaths(paths, { preferredKind: 'audio' })
        const chosen = added[0]
        if (chosen) appendMusicClip(chosen, music)
      })()
      return
    }
    if (!source) {
      setStatus('为保护版权与离线使用，曲目库仅分析你导入的音乐。请选择一首已获授权的本地音频。', 'info')
      openPicker({ preferredKind: 'audio', addToTimeline: true })
      return
    }
    appendMusicClip(source, music)
  }

  function appendMusicClip(asset, music) {
    if (!asset.path) {
      setStatus('当前曲目只能预览，尚无可导出的本地源文件。', 'info')
      return
    }

    let track = project.tracks.find((item) => item.id === 'audio-music' || (item.type === 'audio' && /背景|music/i.test(item.label)))
    if (!track) track = { id: 'audio-music', type: 'audio', label: '背景音乐', accent: 'blue', order: project.tracks.filter((item) => item.type === 'audio').length, locked: false, muted: false }
    const audioClip = {
      id: `clip-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
      assetId: asset.id,
      path: asset.path,
      trackId: track.id,
      name: `${music.name} · 自动音乐`,
      start: 0,
      duration,
      trimStart: 0,
      trimEnd: duration,
      sourceDuration: asset.duration || duration,
      kind: 'audio',
      color: track.accent,
      volume: Number(music.volume ?? 0.22),
      isMusic: true,
      fadeIn: 1.2,
      fadeOut: 4.5,
      tempo: music.tempo,
      autoDuck: true,
      repeat: asset.duration > 0 && duration > asset.duration,
    }
    const nextClips = [...project.clips.filter((clip) => !clip.isMusic), audioClip]
    const nextTracks = project.tracks.some((item) => item.id === track.id) ? project.tracks : [...project.tracks, track]
    applyEdit('添加智能配乐', (current) => ({ ...current, tracks: nextTracks, clips: nextClips, assets: current.assets.some((item) => item.id === asset.id) ? current.assets : [...current.assets, asset], duration: Math.max(current.duration, audioClip.duration) }))
    setVolumeTarget(audioClip.volume)
    setActiveTab('edit')
    setActiveTrackId(track.id)
    updateSelectedClipIds([audioClip.id])
    timelineSelectionAnchorRef.current = audioClip.id
    setSelectedId(audioClip.id)
    setStatus(`已添加「${music.name}」，自动混音、循环铺设并为人声预留空间。`)
  }

  async function addMusicFiles() {
    const imported = await importPathsFromAudioPicker()
    if (imported?.length) {
      setActivePanel('音乐库')
    }
  }

  function saveMusicLicense(music) {
    if (!music) return
    setMusicFiles((current) => current.map((item) => item.id === music.id ? { ...item, license: item.license ? null : '用户已确认使用许可' } : item))
  }

  async function importPathsFromAudioPicker() {
    if (window.videome?.pickAudio) {
      const paths = await window.videome.pickAudio()
      if (!paths.length) return []
      return importPaths(paths, { preferredKind: 'audio' })
    }
    return openPicker({ preferredKind: 'audio' }).then(() => [])
  }

  function toggleMusicPreview(music) {
    if (recordingMusic === music.id) {
      stopMusicPreview()
      return
    }
    if (recordingMusic) stopMusicPreview()

    if (!music.previewUrl) {
      if (music.sourcePath && typeof Audio !== 'undefined') {
        const audio = new Audio(fileUrl(music.sourcePath))
        audioRef.current = audio
        audio.play().catch(() => setStatus('无法读取这首本地音乐，请重新定位源文件。', 'error'))
        setRecordingMusic(music.id)
        transportAudio.current = audio
        audio.addEventListener('ended', () => setRecordingMusic(null), { once: true })
        return
      }
      setStatus('添加音乐后可在时间轴预览。', 'info')
      return
    }

    const audio = new Audio(music.previewUrl)
    audio.volume = 0.45
    audioRef.current = audio
    transportAudio.current = null
    audio.addEventListener('error', () => {
      setRecordingMusic(null)
      setStatus('网络试听失败；你仍可导入本地曲库并继续制作。', 'info')
    }, { once: true })
    audio.addEventListener('ended', () => setRecordingMusic(null), { once: true })
    audio.play().then(() => setRecordingMusic(music.id)).catch(() => setStatus('系统未授权播放此试听，请在系统设置中检查音频权限。', 'info'))
  }

  function stopMusicPreview() {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    audioRef.current = null
    transportAudio.current = null
    setRecordingMusic(null)
  }

  function addTrackCommand(type) {
    const nextTracks = addTrack(projectRef.current.tracks, type)
    const track = nextTracks.at(-1)
    applyEdit('新增轨道', (current) => ({ ...current, tracks: nextTracks }))
    setActiveTrackId(track.id)
    setStatus(`已添加「${track.label}」。`)
    window.requestAnimationFrame(() => {
      const row = trackListRef.current?.lastElementChild
      if (row) trackListRef.current.scrollTop = row.offsetTop
    })
  }

  function openTimelineMenu(event, kind, trackId = null) {
    event.preventDefault()
    event.stopPropagation()
    const bounds = event.currentTarget.getBoundingClientRect()
    const context = event.type === 'contextmenu'
    setTimelineMenu({
      kind,
      trackId,
      anchor: context
        ? { left: event.clientX, top: event.clientY, bottom: event.clientY }
        : { left: bounds.left, top: bounds.top, bottom: bounds.bottom },
    })
  }

  function renderAddTrackButton() {
    return <button className="add-track-trigger" aria-haspopup="menu" aria-expanded={timelineMenu?.kind === 'add'} onClick={(event) => openTimelineMenu(event, 'add')}><Plus size={12} />添加轨道 <ChevronDown size={10} /></button>
  }

  function renderTimelineMenu() {
    if (!timelineMenu) return null
    const icons = { video: FileVideo2, audio: AudioLines, graphics: ImagePlus, subtitle: Subtitles }
    const track = project.tracks.find((item) => item.id === timelineMenu.trackId)
    if (timelineMenu.kind === 'track' && !track) return null
    const items = timelineMenu.kind === 'add'
      ? trackTypes.map((item) => ({ id: item.type, icon: icons[item.type], label: item.label, action: () => addTrackCommand(item.type) }))
      : [
          { id: 'mute', icon: track.muted ? Volume2 : VolumeX, label: track.muted ? '取消静音' : '静音轨道', action: () => toggleTrackFor(track.id, 'muted') },
          { id: 'lock', icon: LockKeyhole, label: track.locked ? '解锁轨道' : '锁定轨道', action: () => toggleTrackFor(track.id, 'locked') },
          { id: 'clear', icon: RotateCcw, label: '清空轨道内容', hint: '保留轨道 · Shift+Delete', disabled: track.locked, action: () => clearTrackContents(track.id) },
          { id: 'delete', icon: Trash2, label: '删除轨道', disabled: track.locked, danger: true, action: () => requestTrackDeletion(track.id) },
        ]
    return <TimelineTrackMenu key={`${timelineMenu.kind}-${timelineMenu.trackId || ''}`} anchor={timelineMenu.anchor} title={timelineMenu.kind === 'add' ? '选择轨道类型' : track.label} items={items} onClose={() => setTimelineMenu(null)} />
  }

  function renderDeleteTrackDialog() {
    if (!deleteTrackId) return null
    const track = project.tracks.find((item) => item.id === deleteTrackId)
    if (!track) return null
    const clipCount = project.clips.filter((clip) => clip.trackId === track.id).length
    const linkedCount = project.clips.length - removeTrackClips(project.clips, track.id).length - clipCount
    return <DeleteTrackDialog track={track} clipCount={clipCount} linkedCount={linkedCount} onCancel={() => setDeleteTrackId(null)} onConfirm={() => deleteTrackCommand(track.id)} />
  }

  function syncTrackScroll(event, target) {
    if (target && Math.abs(target.scrollTop - event.currentTarget.scrollTop) > 0.5) target.scrollTop = event.currentTarget.scrollTop
  }

  function toggleTrack(key) {
    if (!activeTrack) return
    applyEdit(key === 'locked' ? '切换轨道锁定' : '切换轨道静音', (current) => ({
      ...current,
      tracks: current.tracks.map((track) => track.id === activeTrack.id ? { ...track, [key]: !track[key] } : track),
    }))
  }

  function addMarkerAtPlayhead() {
    const marker = { id: `marker-${Date.now()}`, start: project.playhead, name: `标记 · ${formatCompactTime(project.playhead)}` }
    setGuideMarkers((current) => [...current, marker].sort((first, second) => first.start - second.start))
    setStatus(`已在 ${formatTime(marker.start)} 标记当前位置。`)
  }

  function setSubtitleCue(cueId, patch) {
    applyEdit('修改字幕', (current) => ({
      ...current,
      subtitle: {
        ...current.subtitle,
        cues: current.subtitle.cues.map((cue) => cue.id === cueId ? { ...cue, ...patch, edited: true } : cue),
      },
    }))
  }

  function handleSubtitleCueSelection(cue) {
    setSelectedCueId(cue.id)
    setProject((current) => ({ ...current, playhead: cue.start }))
    const matchingClip = project.clips.find((clip) => clip.kind === 'subtitle' && clip.sourceCueId === cue.id)
    if (matchingClip) {
      updateSelectedClipIds([matchingClip.id])
      timelineSelectionAnchorRef.current = matchingClip.id
      setSelectedId(matchingClip.id)
    }
  }

  function loadSubtitlesToTimeline(cues, replace = false) {
    const add = cues.map((cue) => addSubtitleClip(cue))
    setProject((current) => ({
      ...current,
      clips: [...(replace ? current.clips.filter((clip) => clip.kind !== 'subtitle') : current.clips), ...add],
      subtitle: { ...current.subtitle, enabled: true, cues: [...(replace ? [] : current.subtitle.cues), ...cues] },
    }))
  }

  async function importSubtitleFile() {
    if (!window.videome?.pickSubtitles) {
      setStatus('字幕文件导入需要桌面版，请使用下方手工字幕编辑器。', 'info')
      return
    }
    const selected = await window.videome.pickSubtitles()
    if (!selected) return
    const cues = parseSrt(selected.content)
    if (!cues.length) {
      setStatus('没有找到可读取的字幕行；请使用有效的 SRT 文件。', 'error')
      return
    }
    const hasEdits = project.subtitle.cues.some((cue) => cue.edited)
    if (hasEdits && !window.confirm(`字幕文件包含 ${cues.length} 条对白。是否保留原字幕并合并？\n选择“取消”会将字幕文件仅作为字幕草稿另行预览。`)) {
      setProject((current) => ({ ...current, subtitleDraft: cues }))
      setStatus('已导入字幕草稿；原有字幕与时间轴片段未覆盖。', 'info')
      return
    }
    loadSubtitlesToTimeline(cues, true)
    setSelectedCueId(cues[0].id)
    setStatus(`已导入 ${cues.length} 行 SRT 字幕并同步到时间轴。`)
  }

  async function exportSrt() {
    const content = createSrt(project.subtitle.cues)
    if (!content) {
      setStatus('当前没有字幕可导出。', 'info')
      return
    }
    if (window.videome?.saveText) {
      const result = await window.videome.saveText({ content, defaultFileName: `${project.name || 'videome'}-subtitles.srt`, type: 'srt' })
      if (result) setStatus(`SRT 已导出：${result.path.split(/[\\/]/).pop()}`)
      return
    }
    downloadText(content, 'captions.srt', 'application/x-subrip')
    setStatus('SRT 字幕已下载。')
  }

  function downloadText(text, name, type) {
    const url = URL.createObjectURL(new Blob([text], { type }))
    objectUrlsRef.current.add(url)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    window.setTimeout(() => {
      URL.revokeObjectURL(url)
      objectUrlsRef.current.delete(url)
    }, 500)
  }

  async function recognizeSpeech() {
    if (project.subtitle.cues.some((cue) => cue.edited)) {
      const accepted = window.confirm('已有字幕包含手动修改。新识别结果将单独保存为草稿，不会覆盖现有内容。继续识别？')
      if (!accepted) return
    }
    if (!selectedAsset?.path && !project.assets.length) {
      setStatus('请先导入一段包含人声的视频，再开始语音识别。', 'info')
      await openPicker({ addToTimeline: true })
      return
    }
    if (!window.videome?.probeMedia) {
      setStatus('本地语音识别需要桌面版与 whisper.cpp 模型；当前尚未安装识别服务。', 'info')
      return
    }

    const candidate = selectedAsset?.kind === 'video' && selectedAsset.audioCodec ? selectedAsset : project.assets.find((asset) => asset.kind === 'video' && asset.audioCodec)
    if (!candidate) {
      setStatus('所选项目中没有可读取的音轨。', 'error')
      return
    }
    setSubtitleBusy(true)
    setStatus('正在检查本机是否已配置 Whisper 本地模型。', 'info')
    window.setTimeout(() => {
      setSubtitleBusy(false)
      setStatus('媒体与音轨已确认。本机尚未安装 whisper.cpp 或语音模型，因此未伪造识别字幕；现有字幕和工程未改动。', 'info')
    }, 700)
  }

  async function markGoodOutPoint() {
    if (!selectedAsset?.path || !window.videome?.exportFrame) {
      setStatus('抽帧封面需要已导入的真实视频，并请先选中这个视频片段。', 'info')
      return
    }
    const result = await window.videome.exportFrame({ asset: selectedAsset, time: Math.max(0, project.playhead - selectedClip.start + selectedClip.trimStart), width: project.frameSize.width, height: project.frameSize.height, subtitle: selectedSubtitle ? { ...project.subtitle, text: selectedSubtitle.text } : project.subtitle })
    if (!result) return
    if (!result.ok) {
      setStatus(`封面导出失败：${result.reason}`, 'error')
      return
    }
    setStatus(`已保存视频封面：${result.path.split(/[\\/]/).pop()}`)
  }

  function handleWheel(event) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      setManualTimelineZoom((current) => Math.max(minimumZoom, Math.min(2.4, current * (event.deltaY < 0 ? 1.09 : 0.91))), event.clientX)
      return
    }
    // Scrolling the timeline is a viewport operation. It must not scrub the
    // transport, especially while playback is running; only an explicit
    // click on the ruler or a clip should move the playhead.
    if (event.shiftKey) {
      event.preventDefault()
      timelineRef.current?.scrollBy({ left: event.deltaY || event.deltaX, behavior: 'instant' })
    }
  }

  function changeTimelineZoom(nextValue, anchorX = null) {
    const viewport = timelineRef.current
    if (!viewport) {
      setZoom((current) => typeof nextValue === 'function' ? nextValue(current) : nextValue)
      return
    }
    const width = viewport.clientWidth
    const bounds = viewport.getBoundingClientRect()
    const pointerRatio = typeof anchorX === 'number'
      ? Math.max(0, Math.min(1, (anchorX - bounds.left) / width))
      : 0.5
    const anchorTime = Math.max(0, Math.min(duration, (viewport.scrollLeft + pointerRatio * width) / Math.max(1, timelineContentWidth) * duration))
    const currentZoom = fitTimeline ? 1 : zoom
    const next = typeof nextValue === 'function' ? nextValue(currentZoom) : nextValue
    const nextContentWidth = duration * timelineScaleBase * next
    const nextViewportWidth = Math.max(timelineViewportWidth, nextContentWidth)
    setZoom(next)
    requestAnimationFrame(() => {
      viewport.scrollLeft = Math.min(Math.max(0, nextViewportWidth - width), Math.max(0, anchorTime / duration * nextContentWidth - pointerRatio * width))
    })
  }

  function fitTimelineToViewport() {
    setFitTimeline(true)
    setZoom(Math.max(minimumZoom, Math.min(2.4, timelineViewportWidth / Math.max(1, duration * timelineScaleBase))))
    requestAnimationFrame(() => {
      if (timelineRef.current) timelineRef.current.scrollLeft = 0
    })
  }

  function setManualTimelineZoom(nextValue, anchorX = null) {
    setFitTimeline(false)
    changeTimelineZoom(nextValue, anchorX)
  }

  function timelineTimeFromClientX(clientX) {
    const viewport = timelineRef.current
    if (!viewport) return 0
    const bounds = viewport.getBoundingClientRect()
    const contentX = clientX - bounds.left + viewport.scrollLeft
    return Math.max(0, Math.min(duration, (contentX / Math.max(1, timelineContentWidth)) * duration))
  }

  function handleTimelinePointerDown(event, trackId, clip, track) {
    if (event.button !== 0 || !clip || event.target.closest('.clip-action, .clip-volume, .clip-resize')) return
    if (event.metaKey || event.ctrlKey || event.shiftKey) return
    const current = projectRef.current
    const selectedIds = selectedClipIdsRef.current.includes(clip.id)
      ? selectedClipIdsRef.current.filter((id) => current.clips.some((item) => item.id === id)) : [clip.id]
    const movingIds = timelineMoveIds(current.clips, selectedIds)
    const lockedTracks = new Set(current.tracks.filter((item) => item.locked).map((item) => item.id))
    const blocked = current.clips.some((item) => movingIds.includes(item.id) && lockedTracks.has(item.trackId))
    event.currentTarget.setPointerCapture(event.pointerId)
    const pixelsPerSecond = timelineContentWidth / duration
    const fps = Number(current.frameRate.numerator) / Number(current.frameRate.denominator) || 30
    dragState.current = { clipId: clip.id, trackId, selectedIds, movingIds, blocked, initialStart: clip.start, clipDuration: clip.duration, initialClips: current.clips, initialProject: current, pixelsPerSecond, fps, originX: event.clientX, moved: false, delta: 0 }
  }

  function handleTimelinePointerMove(event) {
    const state = dragState.current
    if (!state) return
    const dx = event.clientX - state.originX
    if (Math.abs(dx) > 4 && !state.moved) {
      state.moved = true
      if (state.blocked) {
        setStatus('所选片段或联动片段所在轨道已锁定；请先解锁或取消选择后再移动。', 'info')
      } else {
        updateSelectedClipIds(state.selectedIds)
        setSelectedId(state.clipId)
        setActiveTrackId(state.trackId)
        setActivePanel('属性检查器')
        timelineSelectionAnchorRef.current = state.clipId
      }
    }
    if (!state.moved) return
    if (state.blocked) return

    const snappedSeconds = Math.round((state.initialStart + dx / state.pixelsPerSecond) * state.fps) / state.fps
    const stationary = state.initialClips.filter((clip) => !state.movingIds.includes(clip.id))
    const target = stationary.find((clip) => Math.abs(clip.start - snappedSeconds) <= 5 / state.fps)
    const endTarget = stationary.find((clip) => Math.abs(clip.start + clip.duration - (snappedSeconds + state.clipDuration)) <= 5 / state.fps)
    const nextStart = target ? target.start : endTarget ? endTarget.start + endTarget.duration - state.clipDuration : snappedSeconds
    const nextClips = moveTimelineClips(state.initialClips, state.selectedIds, nextStart - state.initialStart, state.initialProject.tracks)
    state.delta = (nextClips.find((clip) => clip.id === state.clipId)?.start ?? state.initialStart) - state.initialStart
    const nextProject = { ...projectRef.current, clips: nextClips, duration: Math.max(state.initialProject.duration, ...nextClips.map((clip) => clip.start + clip.duration)) }
    projectRef.current = nextProject
    setProject(nextProject)
  }

  function handleTimelinePointerUp() {
    const state = dragState.current
    if (!state) return
    dragState.current = null
    if (state.moved) {
      suppressTimelineClickRef.current = state.clipId
      window.setTimeout(() => {
        if (suppressTimelineClickRef.current === state.clipId) suppressTimelineClickRef.current = null
      }, 0)
      if (state.blocked || !state.delta) return
      projectEpochRef.current += 1
      updateSelectedClipIds(state.selectedIds)
      setSelectedId(state.clipId)
      setActiveTrackId(state.trackId)
      setEditHistory((history) => [...history.slice(-39), { label: '移动片段', project: { ...state.initialProject, clips: state.initialClips } }])
      setEditFuture([])
      setStatus(state.selectedIds.length > 1 ? `已整体移动 ${state.selectedIds.length} 个片段，保留相对间距。` : '片段已逐帧吸附移动。')
    }
  }

  function handleTimelinePointerCancel() {
    const state = dragState.current
    if (!state) return
    dragState.current = null
    if (state.moved && !state.blocked) {
      projectRef.current = state.initialProject
      setProject(state.initialProject)
    }
  }

  function updateGraphicText(clip, text) {
    applyEdit('修改图文', (current) => ({
      ...current,
      clips: current.clips.map((item) => item.id === clip.id ? { ...item, name: text } : item),
    }))
  }

  function addGraphicClip() {
    const existing = (activeTrack?.type === 'graphics' && !activeTrack.locked ? activeTrack : null) || project.tracks.find((track) => track.type === 'graphics' && !track.locked)
    const track = existing || { id: `graphics-${Date.now()}`, type: 'graphics', label: '图文标题', accent: 'amber', order: 3, locked: false, muted: false }
    const clip = {
      id: `graphics-${Date.now()}`,
      assetId: `text-${Date.now()}`,
      trackId: track.id,
      kind: 'graphics',
      name: '新标题 · 双击修改',
      start: project.playhead,
      duration: 4.5,
      color: 'amber',
      text: '新标题 · 双击修改',
      fontSize: 52,
    }
    applyEdit('添加标题图文', (current) => ({ ...current, tracks: existing ? current.tracks : [...current.tracks, track], clips: [...current.clips, clip], duration: Math.max(current.duration, clip.start + clip.duration) }))
    updateSelectedClipIds([clip.id])
    timelineSelectionAnchorRef.current = clip.id
    setSelectedId(clip.id)
    setActiveTrackId(track.id)
    setStatus('已添加标题图文；可在右侧属性面板修改文字和显示时长。')
  }

  function removeSubtitleCue(cue) {
    applyEdit('删除字幕', (current) => ({
      ...current,
      subtitle: { ...current.subtitle, cues: current.subtitle.cues.filter((item) => item.id !== cue.id) },
      clips: current.clips.filter((clip) => clip.sourceCueId !== cue.id),
    }))
    setStatus('已删除字幕行。')
  }

  function cueToEnd(cue) {
    return (cue.end - cue.start).toFixed(1)
  }

  function toggleFullscreen() {
    setPreviewFullscreen((current) => !current)
  }

  async function openStandalonePreview(asset) {
    if (!asset?.path) {
      setStatus('请先把本地视频或图片素材放到时间轴，再打开独立预览。', 'info')
      return
    }
    if (!window.videome?.openPreview) {
      setStatus('独立预览窗口仅在 Videome 桌面版中可用。', 'info')
      return
    }
    try {
      const result = await window.videome.openPreview(asset)
      if (!result?.ok) throw new Error(result?.reason || '桌面端没有成功打开预览窗口。')
      setStatus(`已打开「${asset.name}」的独立预览窗口。`, 'info')
    } catch (error) {
      setStatus(`独立预览打开失败：${error.message}`, 'error')
    }
  }

  function adjustTrim(clip, edge, delta) {
    const next = { ...clip }
    if (edge === 'start') {
      const change = Math.max(-clip.trimStart, Math.min(clip.duration - 0.5, delta))
      next.start += change
      next.trimStart += change
      next.duration -= change
    } else {
      const change = Math.max(0.5 - clip.duration, Math.min((clip.sourceDuration || clip.duration) - clip.trimEnd + clip.duration, delta))
      next.duration += change
      next.trimEnd += change
    }
    applyEdit(edge === 'start' ? '调整片段入点' : '调整片段出点', (current) => ({ ...current, clips: current.clips.map((item) => item.id === clip.id ? next : item), duration: Math.max(current.duration, next.start + next.duration) }))
  }

  function updateProjectName(value) {
    updateProject({ name: value.trim() || '未命名项目' }, '修改工程名称')
  }

  function togglePlayback() {
    const video = playerRef.current
    const stateProject = projectRef.current
    const currentClip = findActiveVisualClip(stateProject, stateProject.playhead)
    const currentAsset = stateProject.assets.find((asset) => asset.id === currentClip?.assetId)
    if (playing) {
      if (video && !video.paused) video.pause()
      syncTimelineAudio(stateProject.playhead, false, stateProject)
      setPlaying(false)
      return
    }

    syncTimelineAudio(stateProject.playhead, true, stateProject)
    setPlaying(true)
    if (video && currentAsset?.path && !currentAsset.missing && currentAsset.kind === 'video') {
      const frameRate = Number(stateProject.frameRate.numerator || 30)
      const target = currentClip ? (currentClip.trimStart || 0) + stateProject.playhead - currentClip.start : stateProject.playhead
      const seek = () => {
        if (Math.abs(video.currentTime - target) > 1 / frameRate) video.currentTime = Math.max(0, target)
        video.play().catch(() => setStatus('系统暂时不能解码此原片，播放指针仍可按工程时间播放。', 'info'))
      }
      if (video.readyState < 2) video.addEventListener('loadeddata', seek, { once: true })
      else seek()
    }
  }

  async function applyDubbingJob(job, options = {}) {
    try {
      const currentProject = projectRef.current
      const next = Array.isArray(job) ? applyDubbingResults(currentProject, job, options) : applyDubbingResult(currentProject, job, options)
      // Dubbing outputs live under the app data directory. Resolve their
      // desktop media grants before committing the edit so pressing Play
      // immediately after insertion never creates an unusable 4179 fallback
      // URL for the first playback tick.
      const currentAssetIds = new Set(currentProject.assets.map((asset) => asset.id))
      const generatedAssets = next.assets.filter((asset) => !currentAssetIds.has(asset.id) && asset.path)
      const resolvedAssets = await Promise.all(generatedAssets.map((asset) => attachPreviewTransport(asset)))
      resolvedAssets.forEach((asset) => {
        if (asset.previewUrl || asset.proxyUrl) previewReadyRef.current.set(asset.id, asset.path || asset.id)
      })
      const resolvedById = new Map(resolvedAssets.map((asset) => [asset.id, asset]))
      const withTransport = {
        ...next,
        assets: next.assets.map((asset) => resolvedById.get(asset.id) || asset),
      }
      const addedSubtitleCount = (next.subtitle?.cues.length || 0) - (currentProject.subtitle?.cues.length || 0)
      applyEdit(addedSubtitleCount ? '中文配音与字幕入轨' : '中文配音入轨', () => withTransport, assets)
      setAssets((current) => mergeAssetLibraries(current, withTransport.assets))
      setStatus(`中文配音与保留背景已入轨${addedSubtitleCount ? `，同步添加 ${addedSubtitleCount} 条中文字幕` : ''}，来源范围已静音；可一次撤销。`)
    } catch (error) {
      setStatus(`中文配音入轨失败：${error.message || '无法读取生成的音频文件。'}`, 'error')
    }
  }

  useEffect(() => {
    liveTransportRef.current.playing = playing
    if (!playing) {
      if (playLoopRef.current) window.cancelAnimationFrame(playLoopRef.current)
      const currentVideo = playerRef.current
      if (currentVideo && !currentVideo.paused) currentVideo.pause()
      syncTimelineAudio(projectRef.current.playhead, false, projectRef.current)
      return undefined
    }

    const tick = (time) => {
      const state = liveTransportRef.current
      if (!state.playing) return
      const elapsed = state.lastClock ? Math.max(0, Math.min((time - state.lastClock) / 1000, 0.12)) : 0
      state.lastClock = time
      const currentProject = projectRef.current
      const playheadClip = findActiveVisualClip(currentProject, state.position)
      const currentVideo = playerRef.current
      const videoIsTimelineClock = playheadClip?.kind === 'video'
        && currentVideo?.dataset.clipId === playheadClip.id
        && !currentVideo.paused
        && !currentVideo.seeking
        && pendingVideoSeekRef.current?.clipId !== playheadClip.id
        && Number.isFinite(currentVideo.currentTime)
      if (videoIsTimelineClock) {
        state.position = Math.min(duration, playheadClip.start + Math.max(0, currentVideo.currentTime - (playheadClip.trimStart || 0)))
      } else {
        state.position = Math.min(duration, state.position + elapsed)
      }
      const frameRate = Number(projectRef.current.frameRate.numerator || 30) / Number(projectRef.current.frameRate.denominator || 1)
      const video = playerRef.current
      const activeClip = findActiveVisualClip(projectRef.current, state.position)
      const activeAsset = projectRef.current.assets.find((asset) => asset.id === activeClip?.assetId)
      syncTimelineAudio(state.position, true, projectRef.current)

      if (video && video.dataset.clipId !== activeClip?.id) {
        video.pause()
      }

      if (time - Number(state.lastRender || 0) > 50 || state.position >= duration) {
        state.lastRender = time
        projectRef.current = { ...projectRef.current, playhead: state.position }
        setProject((current) => ({ ...current, playhead: state.position }))
      }

      if (state.position >= duration) {
        state.playing = false
        state.lastClock = 0
        if (video && !video.paused) video.pause()
        syncTimelineAudio(state.position, false, projectRef.current)
        setPlaying(false)
        return
      }
      playLoopRef.current = window.requestAnimationFrame(tick)
    }
    liveTransportRef.current.lastClock = 0
    liveTransportRef.current.lastRender = 0
    playLoopRef.current = window.requestAnimationFrame(tick)
    return () => {
      liveTransportRef.current.playing = false
      liveTransportRef.current.lastClock = 0
      syncTimelineAudio(projectRef.current.playhead, false, projectRef.current)
      if (playLoopRef.current) window.cancelAnimationFrame(playLoopRef.current)
    }
  }, [playing, duration, selectedClip?.id])

  function syncTimelineAudio(position, shouldPlay, currentProject, forceSeek = false) {
    // Linked source audio is decoded by the paired video element to keep it
    // sample-synchronous; this scheduler handles independent audio clips only.
    const clips = currentProject.clips.filter((clip) => clip.kind === 'audio' && !clip.linkedClipId)
    const timelineAudioSource = (asset, clip) => {
      const previewUrl = typeof asset?.previewUrl === 'string' ? asset.previewUrl : ''
      const stalePreview = previewUrl.includes('/__videome/media?') || previewUrl.startsWith('videome-media://')
      // Electron must use an authorized videome-media URL. A persisted 4179
      // browser URL (or a URL while the grant is still being requested) cannot
      // be decoded by the desktop renderer and would make the clip silent.
      if (window.videome?.requestMedia && asset?.path && !asset?.proxyUrl) {
        if (!previewUrl) return null
        if (stalePreview && previewReadyRef.current.get(asset.id) !== asset.path) return null
      }
      return audioPreviewUrl(asset, clip)
    }
    const requestTimelineMedia = (asset) => {
      if (!window.videome?.requestMedia || !asset?.id || !asset.path || timelineMediaGrantRef.current.has(asset.id)) return
      timelineMediaGrantRef.current.add(asset.id)
      void window.videome.requestMedia([asset.path]).then((grant) => {
        const source = grant?.ok ? grant.files.find((file) => file.path === asset.path)?.url : null
        if (!source) {
          timelineMediaGrantRef.current.delete(asset.id)
          return
        }
        previewReadyRef.current.set(asset.id, asset.path)
        setProject((current) => ({ ...current, assets: current.assets.map((item) => item.id === asset.id ? { ...item, previewUrl: source, missing: false } : item) }))
        setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, previewUrl: source, missing: false } : item))
        activeTimelineAudioSignatureRef.current = null
      }).catch(() => timelineMediaGrantRef.current.delete(asset.id))
    }
    const activeIds = new Set()
    const effectiveVolume = (clip) => clip.dubbingSource && Number(clip.volume) <= 0 ? 0.82 : Number(clip.volume ?? 0.82)
    const activeClips = clips.filter((clip) => {
      const track = currentProject.tracks.find((item) => item.id === clip.trackId)
      return position >= clip.start && position < clip.start + clip.duration
        && !clip.muted && !track?.muted && effectiveVolume(clip) > 0
    })
    const audioSignature = JSON.stringify(activeClips.map((clip) => {
      // A generated dubbing asset receives its playable videome-media URL
      // asynchronously after it is added to the project. Include that URL in
      // the signature so a failed first attempt using the fallback browser URL
      // is replaced as soon as the authorized local URL is available.
      const asset = currentProject.assets.find((item) => item.id === clip.assetId)
      return [clip.id, clip.start, clip.trimStart || 0, effectiveVolume(clip), timelineAudioSource(asset, clip)]
    }))
    if (!forceSeek && shouldPlay && activeTimelineAudioSignatureRef.current === audioSignature) {
      const allActivePlayersRunning = activeClips.every((clip) => {
        const asset = currentProject.assets.find((item) => item.id === clip.assetId)
        const source = timelineAudioSource(asset, clip)
        const entry = timelineAudioPlayersRef.current.get(clip.id)
        return Boolean(source && entry && entry.source === source && !entry.player.paused)
      })
      if (allActivePlayersRunning) return
    }
    activeTimelineAudioSignatureRef.current = shouldPlay ? audioSignature : null
    for (const clip of clips) {
      const track = currentProject.tracks.find((item) => item.id === clip.trackId)
      const active = position >= clip.start && position < clip.start + clip.duration
        && !clip.muted && !track?.muted && effectiveVolume(clip) > 0
      const asset = currentProject.assets.find((item) => item.id === clip.assetId)
      const source = timelineAudioSource(asset, clip)
      if (!source) requestTimelineMedia(asset)
      if (!active || !source) continue

      activeIds.add(clip.id)
      let entry = timelineAudioPlayersRef.current.get(clip.id)
      if (!entry || entry.source !== source) {
        if (entry) entry.wantToPlay = false
        entry?.player.pause()
        const player = new Audio(source)
        player.preload = 'auto'
        entry = { player, source, playErrorReported: false, wantToPlay: false, playPending: false, lastPlayAttempt: 0 }
        player.addEventListener('canplay', () => {
          if (!entry.wantToPlay || !player.paused || entry.playPending) return
          const now = Date.now()
          if (now - entry.lastPlayAttempt < 200) return
          entry.lastPlayAttempt = now
          entry.playPending = true
          player.play().catch((error) => {
            entry.playPending = false
            if (entry.playErrorReported) return
            entry.playErrorReported = true
            setStatus(`音频「${clip.name}」播放失败：${error.message || '浏览器拒绝了音频播放。'}`, 'error')
          })
        })
        player.addEventListener('playing', () => { entry.playPending = false })
        player.addEventListener('error', () => {
          if (entry.playErrorReported) return
          entry.playErrorReported = true
          const code = player.error?.code ? `（媒体错误 ${player.error.code}）` : ''
          setStatus(`音频「${clip.name}」无法解码${code}，检查本地兼容预览和素材路径。`, 'error')
        })
        timelineAudioPlayersRef.current.set(clip.id, entry)
      }

      const player = entry.player
      const offset = Math.max(0, (clip.trimStart || 0) + position - clip.start)
      const sourceDuration = Number(clip.sourceDuration || asset?.duration || player.duration || 0)
      const sourceTime = clip.repeat && sourceDuration > 0 ? offset % sourceDuration : Math.min(offset, Math.max(0, (player.duration || sourceDuration || offset) - 0.04))
      if (Number.isFinite(sourceTime) && (forceSeek || Math.abs(player.currentTime - sourceTime) > (shouldPlay ? 0.35 : 0.04))) player.currentTime = sourceTime
      player.volume = Math.max(0, Math.min(1, effectiveVolume(clip)))
      player.muted = false
      entry.wantToPlay = shouldPlay

      if (shouldPlay && player.paused) {
        const now = Date.now()
        if (now - entry.lastPlayAttempt < 200 || entry.playPending) continue
        entry.lastPlayAttempt = now
        entry.playPending = true
        player.play().catch((error) => {
          entry.playPending = false
          if (entry.playErrorReported) return
          entry.playErrorReported = true
          setStatus(`音频「${clip.name}」播放失败：${error.message || '无法读取音频源。'}`, 'error')
        })
      } else if (!shouldPlay && !player.paused) {
        player.pause()
      }
    }

    for (const [clipId, entry] of timelineAudioPlayersRef.current) {
      if (activeIds.has(clipId)) continue
      entry.wantToPlay = false
      if (!entry.player.paused) entry.player.pause()
    }
  }

  useEffect(() => {
    const video = playerRef.current
    const playheadClip = findActiveVisualClip(project, project.playhead)
    const playheadAsset = project.assets.find((item) => item.id === playheadClip?.assetId)
    if (!video || !playheadClip || playheadAsset?.kind !== 'video' || !playheadAsset.path || video.readyState < 1) return
    const target = (playheadClip.trimStart || 0) + Math.max(0, project.playhead - playheadClip.start)
    const sourceTime = Math.max(0, Math.min(Number(playheadAsset.duration || target), target))
    if (!playing && Number.isFinite(sourceTime) && Math.abs(video.currentTime - sourceTime) > 1 / (project.frameRate.numerator || 30)) video.currentTime = sourceTime
  }, [project.playhead, project.frameRate.numerator, selectedClip?.id, project.assets, project.clips, playing])

  useEffect(() => {
    setPreviewSeeking(false)
    setPreviewErrorClipId(null)
  }, [findActiveVisualClip(project, project.playhead)?.id])

  // When the playhead crosses a clip boundary React replaces the preview source.
  // A newly mounted video element starts paused, so explicitly seek and resume it.
  useEffect(() => {
    if (!playing) return undefined
    const clip = findActiveVisualClip(project, project.playhead)
    const asset = project.assets.find((item) => item.id === clip?.assetId)
    const video = playerRef.current
    if (!clip || asset?.kind !== 'video' || !video || !asset.path) {
      if (video && !video.paused) video.pause()
      return undefined
    }
    const resume = () => {
      const currentProject = projectRef.current
      const currentClip = currentProject.clips.find((item) => item.id === clip.id)
      if (!currentClip) return
      const sourceTime = Math.max(0, (currentClip.trimStart || 0) + currentProject.playhead - currentClip.start)
      if (Math.abs(video.currentTime - sourceTime) > 1 / Number(project.frameRate.numerator || 30)) video.currentTime = sourceTime
      video.play().catch(() => {})
    }
    if (video.readyState >= 2) resume()
    else video.addEventListener('loadeddata', resume, { once: true })
    return () => {
      video.removeEventListener('loadeddata', resume)
      if (!video.paused) video.pause()
    }
  }, [playing, findActiveVisualClip(project, project.playhead)?.id, project.assets, project.frameRate.numerator])

  useEffect(() => {
    const audio = transportAudio.current
    if (!audio || !playing) return undefined
    if (audioFrameRef.current) window.cancelAnimationFrame(audioFrameRef.current)
    let last = performance.now()
    const update = (time) => {
      const delta = Math.max(0, Math.min((time - last) / 1000, 0.1))
      last = time
      if (!audio.paused && audio.duration) {
        try {
          const next = audio.currentTime + delta
          if (Number.isFinite(next)) audio.currentTime = next % audio.duration
        } catch {
          // Preview playback is optional; keep the editing cursor responsive if browsers reject seeks.
        }
      }
      audioFrameRef.current = window.requestAnimationFrame(update)
    }
    audioFrameRef.current = window.requestAnimationFrame(update)
    return () => {
      if (audioFrameRef.current) window.cancelAnimationFrame(audioFrameRef.current)
    }
  }, [playing])

  function renderTimelineClip(clip, track, trackIndex, clipIndex) {
    const left = (clip.start / duration) * timelineContentWidth
    const width = Math.max(28, (clip.duration / duration) * timelineContentWidth)
    const selected = selectedClipIds.length ? selectedClipIds.includes(clip.id) : clip.id === selectedId
    const sequenceOrder = selectedClipIds.indexOf(clip.id) + 1
    const isImageClip = clip.kind === 'image' || clip.previewColor === 'green'
    const asset = project.assets.find((item) => item.id === clip.assetId)
    const isMusic = clip.kind === 'audio' && (clip.isMusic || /music|背景音乐/i.test(track.label))
    const waveform = calculateWaveform(clip.id, Math.max(12, Math.round(width / (isMusic ? 8 : 6))))
    const posters = clip.kind === 'video' && asset?.poster
      ? Array.from({ length: Math.max(2, Math.min(16, Math.floor(width / 34))) }, (_, index) => {
        const sourceOffset = (clip.trimStart || 0) + clip.duration * index / Math.max(2, Math.floor(width / 34))
        return thumbnailForTime(asset, sourceOffset)
      })
      : []

    return (
      <div
        key={clip.id}
        className={`timeline-clip clip-${clip.color || track.accent} ${selected ? 'is-selected' : ''} ${clip.missing ? 'is-missing' : ''} ${clip.kind === 'subtitle' ? 'subtitle-clip' : ''} ${isMusic ? 'music-clip' : ''} ${clip.kind === 'graphics' ? 'graphics-clip' : ''}`}
        data-clip-id={clip.id}
        style={{ left: `${left}px`, width: `${width}px`, '--clip-index': clipIndex, '--clip-width': `${width}px`, ...(isImageClip ? { background: previewBackground(clip.previewColor) } : {}) }}
        onPointerDown={(event) => handleTimelinePointerDown(event, track.id, clip, track)}
        onPointerMove={handleTimelinePointerMove}
        onPointerUp={handleTimelinePointerUp}
        onPointerCancel={handleTimelinePointerCancel}
        onClick={(event) => {
          if (event.target.closest('.clip-action, .clip-volume, .clip-resize')) return
          if (suppressTimelineClickRef.current === clip.id) {
            suppressTimelineClickRef.current = null
            return
          }
          selectClip(clip, track, event)
        }}
        onDoubleClick={() => {
          if (clip.kind === 'graphics') {
            const text = window.prompt('修改图文标题', clip.text || clip.name)
            if (text !== null) updateGraphicText(clip, text)
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          if (!selectedClipIdsRef.current.includes(clip.id)) updateSelectedClipIds([clip.id])
          timelineSelectionAnchorRef.current = clip.id
          setSelectedId(clip.id)
          setActiveTrackId(track.id)
          setStatus(`${clip.name} · ${formatTime(clip.start)} · ${formatTime(clip.duration)}`, 'info')
        }}
        title={`${clip.name} · ${formatTime(clip.start)} → ${formatTime(clip.start + clip.duration)}${clip.missing ? ' · 找不到原素材' : ''}`}
        role="button"
        aria-label={`片段 ${clip.name}`}
        aria-pressed={selected}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget && event.key === 'Enter') {
            event.preventDefault()
            selectClip(clip, track, event)
          }
        }}
        tabIndex={0}
      >
        <span className="clip-resize clip-resize-start" onPointerDown={(event) => { event.stopPropagation(); const direction = event.clientX < event.currentTarget.getBoundingClientRect().left + 12 ? -1 : 1; adjustTrim(clip, 'start', direction / 30) }} aria-hidden="true" />
        {clip.kind === 'subtitle' ? <Subtitles size={12} /> : clip.kind === 'graphics' ? <ImagePlus size={12} /> : null}
        {posters.length ? <div className="clip-thumbnail-strip" aria-hidden="true">{posters.map((poster, index) => <img key={`${clip.id}-${index}`} src={poster} alt="" />)}</div> : null}
        {clip.kind === 'audio' ? <div className="waveform" aria-hidden="true">{waveform.map((bar, index) => <i key={`${clip.id}-${index}`} style={{ height: `${bar}%`, opacity: isMusic ? 0.6 : 0.78 }} />)}</div> : null}
        {clip.kind === 'video' && <div className="clip-frames" aria-hidden="true">{Array.from({ length: Math.max(2, Math.min(10, Math.floor(width / 48))) }, (_, index) => <i key={index} style={{ '--frame-index': index, background: previewBackground(clip.previewColor) }} />)}</div>}
        {clip.kind === 'graphics' && <div className="graphics-waveform" aria-hidden="true"><span /> <span /></div>}
        {clip.kind === 'subtitle' && <span className="subtitle-label" aria-hidden="true">{clip.name}</span>}
        {sequenceOrder > 0 ? <span className="clip-sequence-order" aria-label={`片段序号 ${sequenceOrder}`}>{sequenceOrder}</span> : null}
        <span className="clip-label"><span>{clip.name}</span>{!isImageClip && !posters.length && clip.kind !== 'subtitle' && clip.kind !== 'graphics' ? <small>{formatCompactTime(clip.duration)}</small> : null}</span>
        {clip.missing && <span className="missing-clip-badge">原素材丢失</span>}
        {clip.kind === 'audio' && selected && selectedClipIds.length <= 1 && !isMusic && <input aria-label="片段音量" className="clip-volume" type="range" min="0" max="1.2" step="0.01" value={clip.volume ?? 0.82} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => setClipVolume(clip.id, Number(event.target.value))} />}
        {clip.kind !== 'audio' && width > 90 && <span className="clip-duration-inline" aria-hidden="true">{formatCompactTime(clip.duration)}</span>}
        {selected && <span className="clip-corner-mark" aria-hidden="true" />}
        <span className="clip-resize clip-resize-end" aria-hidden="true" />
      </div>
    )
  }

  function renderTrack(track, trackIndex) {
    const clips = project.clips.filter((clip) => clip.trackId === track.id).sort((first, second) => first.start - second.start)
    const isSelected = activeTrack?.id === track.id
    const visibleClip = clips.find((clip) => clip.id === selectedId)

    return (
      <div className={`track-row ${isSelected ? 'track-is-active' : ''} track-type-${track.type} ${track.locked ? 'track-is-locked' : ''} ${track.muted ? 'track-is-muted' : ''}`} key={track.id}>
        <div className="track-info" onContextMenu={(event) => openTimelineMenu(event, 'track', track.id)} onClick={() => { setActiveTrackId(track.id); setSelectedId(visibleClip?.id || null) }}>
          <button className={`track-icon track-color-${track.accent}`} aria-label={`${track.label}轨道操作`} title="轨道操作：清空内容、删除轨道" aria-haspopup="menu" aria-expanded={timelineMenu?.trackId === track.id} onClick={(event) => openTimelineMenu(event, 'track', track.id)}><TrackIcon type={track.type} /></button>
          <div className="track-name-wrap"><span className="track-index">T{String(trackIndex + 1).padStart(2, '0')}</span><span className="track-title" title={track.label}>{track.label}</span></div>
          <div className="track-controls">
            <button className="track-control" aria-label={track.muted ? '取消静音' : '静音轨道'} title={track.muted ? '取消静音' : '静音轨道'} onClick={(event) => { event.stopPropagation(); toggleTrackFor(track.id, 'muted') }}>{track.muted ? <VolumeX size={11} className="toggle-on" /> : <Volume2 size={11} />}</button>
            <button className="track-control track-delete-control" aria-label={`删除${track.label}轨道`} title={track.locked ? '轨道已锁定，请先解锁' : `删除「${track.label}」轨道`} disabled={track.locked} onClick={(event) => { event.stopPropagation(); requestTrackDeletion(track.id) }}><Trash2 size={11} /></button><button className="track-control" aria-label={track.locked ? '解锁轨道' : '锁定轨道'} title={track.locked ? '解锁轨道' : '锁定轨道'} onClick={(event) => { event.stopPropagation(); toggleTrackFor(track.id, 'locked') }}>{track.locked ? <LockKeyhole size={11} className="toggle-on" /> : <Circle size={11} />}</button>
          </div>
        </div>
        <div className={`track-clip-lane ${track.type === 'subtitle' ? 'subtitle-lane' : ''} ${track.type === 'audio' ? 'audio-lane' : ''}`} style={{ width: `${totalWidth}px` }} onPointerDown={(event) => {
          if (event.target.closest('.timeline-clip')) return
          const position = timelineTimeFromClientX(event.clientX)
          clearTimelineSelection()
          setPlayhead(position, null)
          setActiveTrackId(track.id)
        }}>
          {track.type === 'audio' && <div className="audio-lane-center" aria-hidden="true" />}
          {track.id === 'video-main' && <div className="empty-track-hint" aria-hidden="true"><span className="empty-add-dot">+</span><span>拖入视频开始剪辑</span></div>}
          {clips.map((clip, index) => renderTimelineClip(clip, track, trackIndex, index))}
          {guideMarkers.filter((marker) => marker.start <= duration).map((marker) => <button key={marker.id} className="timeline-marker" style={{ left: `${marker.start / duration * timelineContentWidth}px` }} title={marker.name} onClick={(event) => { event.stopPropagation(); setPlayhead(marker.start); setStatus(marker.name, 'info') }}><span /></button>)}
        </div>
      </div>
    )
  }

  function toggleTrackFor(trackId, key) {
    applyEdit(key === 'locked' ? '切换轨道锁定' : '切换轨道静音', (current) => ({ ...current, tracks: current.tracks.map((track) => track.id === trackId ? { ...track, [key]: !track[key] } : track) }))
  }

  function handleOutPointStyle(cue) {
    return { color: cue.edited ? '#ed755b' : 'inherit' }
  }

  function handleDragStart(event, asset) {
    const ids = selectedAssetIdsRef.current.includes(asset.id) ? selectedAssetIdsRef.current : [asset.id]
    if (!selectedAssetIdsRef.current.includes(asset.id)) updateSelectedAssetIds(ids)
    event.dataTransfer.setData('application/x-videome-asset', JSON.stringify({ ids, id: asset.id, path: asset.path }))
    event.dataTransfer.effectAllowed = 'copyMove'
  }

  async function refreshTimelineAssetDuration(asset) {
    const cachedDuration = Number(previewDurationRef.current.get(asset.id)) || 0
    if (cachedDuration > 0) return { ...asset, duration: cachedDuration, sourceDuration: Math.max(Number(asset.sourceDuration) || 0, cachedDuration) }
    const assetDuration = Number(asset.duration) || 0
    const sourceDuration = Number(asset.sourceDuration) || 0
    const hasUsableStoredDuration = assetDuration > 0 && (asset.kind !== 'video' || assetDuration > 10.5 || sourceDuration > 10.5)
    if (!asset.path || !window.videome?.probeMedia || hasUsableStoredDuration) return asset
    const [probe] = await window.videome.probeMedia([asset.path]).catch(() => [])
    if (!probe?.ok) return asset
    const probedDuration = resolveMediaDurationSeconds(probe)
    const duration = probedDuration || Number(asset.duration) || Number(asset.sourceDuration) || 0
    if (!(duration > 0)) return asset
    previewDurationRef.current.set(asset.id, duration)

    const refreshed = {
      ...asset,
      ...probe,
      id: asset.id,
      duration,
      sourceDuration: duration,
      previewUrl: asset.previewUrl || null,
      proxyUrl: asset.proxyUrl || null,
      missing: false,
    }
    const sourceAsset = projectRef.current.assets.find((item) => item.id === asset.id || (asset.path && item.path === asset.path))
    const targetAssetId = sourceAsset?.id || asset.id
    setProject((current) => ({
      ...current,
      assets: current.assets.map((item) => item.id === targetAssetId || (asset.path && item.path === asset.path) ? { ...item, ...refreshed, id: item.id } : item),
      clips: repairPlaceholderDurationClips(current.clips, targetAssetId, duration),
    }))
    setAssets((current) => current.map((item) => item.id === targetAssetId || (asset.path && item.path === asset.path) ? { ...item, ...refreshed, id: item.id } : item))
    const projectClipAsset = projectRef.current.assets.find((item) => item.id === targetAssetId)
    return { ...projectClipAsset, ...refreshed, id: targetAssetId }
  }

  async function handleDrop(event, track) {
    event.preventDefault()
    const encoded = event.dataTransfer.getData('application/x-videome-asset')
    const insertion = timelineTimeFromClientX(event.clientX)

    if (encoded) {
      const data = JSON.parse(encoded)
      const ids = Array.isArray(data.ids) && data.ids.length ? data.ids : [data.id]
      const library = mergeAssetLibraries(projectRef.current.assets, assets)
      const selectedAssets = ids.map((id) => library.find((item) => item.id === id)).filter(Boolean)
      if (selectedAssets.length) {
        const timelineAssets = []
        for (const [index, asset] of selectedAssets.entries()) {
          const refreshed = await refreshTimelineAssetDuration(asset)
          timelineAssets.push(refreshed)
        }
        const currentProject = projectRef.current
        const result = createMediaClips({ assets: timelineAssets, track, clips: [], playhead: insertion, duration: currentProject.duration, tracks: currentProject.tracks })
        applyEdit('拖入素材', (current) => {
          const repairedClips = timelineAssets.reduce((clips, asset) => repairPlaceholderDurationClips(clips, asset.id, asset.duration), current.clips)
          return { ...current, clips: [...repairedClips, ...result.clips], tracks: result.tracks, assets: mergeAssetLibraries(current.assets, timelineAssets), duration: Math.max(current.duration, ...repairedClips.map((clip) => clip.start + clip.duration), result.duration) }
        })
        const inserted = result.inserted[0]
        if (inserted) {
          updateSelectedClipIds([])
          setSelectedId(result.inserted.at(-1).id)
          setActiveTrackId(result.inserted.at(-1).trackId)
          setPlayhead(result.inserted.at(-1).start, result.inserted.at(-1).id)
          setStatus(selectedAssets.length > 1 ? `已按选中顺序插入 ${selectedAssets.length} 个片段。` : `已将「${selectedAssets[0].name}」插入时间轴，片段时长 ${formatCompactTime(inserted.duration)}。`)
        }
      }
      return
    }

    const movedId = event.dataTransfer.getData('application/x-videome-clip')
    const clip = project.clips.find((item) => item.id === movedId)
    if (clip && !track.locked && !clip.muted) {
      const delta = insertion - clip.start
      applyEdit('移动片段', (current) => ({ ...current, clips: current.clips.map((item) => item.id === clip.id || item.linkedClipId === clip.id ? { ...item, start: Math.max(0, item.start + delta), ...(item.id === clip.id ? { trackId: track.id } : {}) } : item), duration: Math.max(current.duration, insertion + clip.duration) }))
      setSelectedId(clip.id)
      setStatus('片段已移动到目标轨道。')
    }
  }

  function miniClipRange(clip) {
    return {
      left: `${(clip.start / duration) * 100}%`,
      width: `${Math.max(0.7, (clip.duration / duration) * 100)}%`,
    }
  }

  const previewRatio = project.frameSize.width / project.frameSize.height
  const historyNote = projectPath ? '工程手动保存 · 每 10 秒自动备份' : '本机恢复缓存 · 尚未保存工程文件'

  function renderHeader() {
    return (
      <header className="topbar">
        <div className="topbar-brand"><div className="brand-mark"><Clapperboard size={16} strokeWidth={2.1} /><i /></div><span>videome<span className="brand-atelier"> atelier</span></span></div>
        <div className="breadcrumb"><div className="project-menu-anchor" ref={projectMenuRef}><button className="crumb-root" aria-label="项目菜单" aria-expanded={showProjectMenu} aria-haspopup="menu" onClick={() => setShowProjectMenu((current) => !current)}><FolderOpen size={13} />项目<ChevronDown size={11} /></button>{renderNewProjectMenu()}</div><label className="project-title-input"><input ref={projectNameInputRef} value={project.name} aria-label="项目名称" onChange={(event) => { const name = event.target.value; projectRef.current = { ...projectRef.current, name }; updateProject({ name }) }} onBlur={(event) => updateProjectName(event.target.value)} /></label><button className="project-location-trigger" aria-label="工程位置" title={projectPath || '尚未保存为工程文件，点击选择保存位置'} onClick={() => setShowProjectLocation(true)}><span className={projectPath ? 'location-dot saved' : 'location-dot'} />{saving ? '保存中…' : projectPath ? '工程位置' : '尚未保存'}</button>{exampleMode && <span className="example-badge">界面示例 · 无源文件</span>}</div>
        <div className="topbar-actions"><button className="icon-button undo-button" aria-label="撤销" title="撤销 · ⌘Z" disabled={!editHistory.length} onClick={handleUndo}><Undo2 size={16} /></button><button className="icon-button undo-button" aria-label="重做" title="重做 · ⌘⇧Z" disabled={!editFuture.length} onClick={handleRedo}><Redo2 size={16} /></button><span className="topbar-divider" /><button className="topbar-save" onClick={() => void saveProject()}><span>保存</span><kbd>⌘ S</kbd></button><button className="export-button" onClick={() => setShowExport(true)}><Download size={14} /><span>导出成片</span><ChevronDown size={13} /></button></div>
        <button className="batch-launch" onClick={() => setShowBatchMix(true)}><Scissors size={14} />批量混剪</button>
      </header>
    )
  }

  function renderLeftRail() {
    return (
      <aside className="left-rail" aria-label="项目面板">
        <div className="rail-top"><button className="rail-user" aria-label="工程位置与本地文件" title="工程位置与本地文件" onClick={() => setShowProjectLocation(true)}><FolderOpen size={16} /></button></div>
        <div className="rail-section"><span className="rail-label">制作</span><button className={`rail-icon ${activePanel === '素材库' ? 'rail-active' : ''}`} title="素材库" aria-label="素材库" onClick={() => { setActivePanel('素材库'); setActiveTab('edit') }}><Grid3X3 size={18} /></button><button className={`rail-icon ${activePanel === '音乐库' ? 'rail-active' : ''}`} title="音乐库" aria-label="音乐库" onClick={() => { setActivePanel('音乐库'); setActiveTab('music') }}><Music2 size={18} /></button><button className={`rail-icon ${activePanel === '属性检查器' ? 'rail-active' : ''}`} title="属性" aria-label="属性" onClick={() => { setActivePanel('属性检查器'); setActiveTab('edit') }}><Settings2 size={18} /></button></div>
        <div className="rail-bottom"><span className="rail-cpu"><i />OFFLINE</span><button className="rail-icon" title="首选项" aria-label="首选项" onClick={() => { setActiveTab('settings'); setActivePanel('属性检查器') }}><Settings2 size={16} /></button><span className="rail-version">v0.1 preview</span></div>
      </aside>
    )
  }

  function renderMediaLibrary() {
    return (
      <section className="asset-panel" aria-label="素材库">
        <div className="panel-header"><div><span className="eyebrow">ASSET LIBRARY</span><h2>素材库</h2></div><button className="icon-button compact" aria-label="导入素材" title="导入素材" onClick={() => openPicker()}><Plus size={16} /></button></div>
        <div className="library-tabs"><button className={activePanel !== '音乐库' ? 'library-tab active' : 'library-tab'} onClick={() => setActivePanel('素材库')}>全部素材<span>{assets.length}</span></button><button className={activePanel === '音乐库' ? 'library-tab active' : 'library-tab'} onClick={() => setActivePanel('音乐库')}>我的曲库<span>{musicFiles.length}</span></button></div>
        {activePanel !== '音乐库' ? (
          <>
            <div className="library-search"><Search size={14} /><input placeholder="搜索素材名称..." value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索素材" /><kbd>⌘ K</kbd></div>
            <button className="import-dropzone" onClick={() => openPicker()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const paths = [...(event.dataTransfer.files || [])]; if (paths.length) handleBrowserFiles({ target: { files: paths, dataset: {}, value: '' } }) }}><span className="drop-icon"><Plus size={16} /></span><span>拖入文件或 <b>选择素材</b></span><small>视频 · 音频 · 图片</small></button>
            <div className="asset-filter-row"><span>素材 <b>{filteredAssets.length}</b></span><button className="asset-batch-add" type="button" disabled={!selectedAssetIds.length} aria-label="按选中顺序入轨" title={selectedAssetIds.length ? `按选中顺序入轨 ${selectedAssetIds.length} 个片段` : '先选择素材'} onClick={() => { setAssetMenuId(null); void addSelectedAssetsToTimeline() }}><Plus size={12} />入轨{selectedAssetIds.length ? <b>{selectedAssetIds.length}</b> : null}</button><button className="asset-clear-button" type="button" disabled={!assets.length && !project.assets.length} title="清空全部素材（不会删除原文件）" onClick={clearMediaLibrary}><Trash2 size={11} />清空</button><button className="asset-sort-button" onClick={() => setStatus(`${assets.length} 个本地素材；源文件仅在你主动使用时读取。`, 'info')}>最近添加 <ChevronDown size={11} /></button></div>
            <div className="asset-list">{filteredAssets.map((asset, index) => renderMediaAsset(asset, index))}{!filteredAssets.length ? <div className="empty-library">{assets.length ? '没有找到匹配的素材。' : exampleMode ? '示例只有时间线布局，未附带视频或音乐文件。' : '尚未导入素材。导入后可双击或拖入时间线。'}</div> : null}</div>
            <div className="storage-card"><div className="storage-icon"><HardDiskIcon /></div><div className="storage-copy"><span>本地空间</span><small>素材不会上传至服务器</small></div><span className="storage-tag">LOCAL</span></div>
          </>
        ) : renderMusicLibrary()}
      </section>
    )
  }

  function renderMediaAsset(asset, index) {
    const assetClips = project.clips.filter((clip) => clip.assetId === asset.id)
    const selected = selectedAssetIds.includes(asset.id)
    const selectionOrder = selectedAssetIds.indexOf(asset.id) + 1
    return (
      <div className={`asset-card ${selected ? 'asset-selected' : ''} ${asset.missing ? 'asset-missing' : ''}`} key={asset.id} draggable role="button" aria-pressed={selected} tabIndex={0} onPointerDown={(event) => handleLibraryAssetPointerDown(asset, event)} onClick={(event) => handleLibraryAssetClick(asset, event)} onDragStart={(event) => handleDragStart(event, asset)} onDoubleClick={() => addAssetToTimeline(asset)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); updateSelectedAssetIds([asset.id]); const clip = assetClips[0]; setSelectedId(clip?.id || null); if (clip) setPlayhead(clip.start) } }}>
        <div className={`asset-thumb thumb-${asset.previewColor || thumbAccent(asset.id, index)} ${asset.kind === 'audio' ? 'audio-thumb' : ''} ${asset.kind === 'image' ? 'image-thumb' : ''}`} style={asset.thumbnail ? { backgroundImage: `linear-gradient(180deg,rgba(6,14,18,.04),rgba(9,18,20,.12)),url("${asset.thumbnail}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>{asset.kind === 'audio' ? <AudioWaveform size={29} /> : asset.thumbnail ? <span className="real-media-thumb-play"><Play size={12} fill="currentColor" /></span> : <span className="thumb-runner">{String(index + 1).padStart(2, '0')}</span>}{selectionOrder > 0 ? <span className="asset-selection-order" aria-label={`素材选择顺序 ${selectionOrder}`}>{selectionOrder}</span> : null}<span className="asset-type-tag">{asset.kind === 'video' ? 'MOV' : asset.kind === 'audio' ? 'WAV' : 'IMG'}</span><span className="asset-thumb-duration">{formatCompactTime(asset.duration)}</span>{asset.missing ? <span className="asset-missing-tag">原素材丢失</span> : null}</div>
        <span className="asset-details"><span className="asset-name">{asset.name}</span><span className="asset-meta">{asset.kind === 'video' && asset.width ? `${asset.width}×${asset.height} · ` : ''}{asset.codec?.toUpperCase() || kindLabel(asset.kind)} · {formatFileSize(asset.size)}</span></span>
        <span className="asset-actions"><button type="button" className={`asset-info ${assetMenuId === asset.id ? 'menu-open' : ''}`} aria-label={`素材操作：${asset.name}`} aria-haspopup="menu" aria-expanded={assetMenuId === asset.id} title="打开素材操作" onClick={(event) => { event.stopPropagation(); setAssetMenuId((current) => current === asset.id ? null : asset.id) }}><MoreHorizontal size={15} /></button><button type="button" className="asset-delete" aria-label={`从素材库移除 ${asset.name}`} title="从素材库移除（不会删除原文件）" onClick={(event) => { event.stopPropagation(); setAssetMenuId(null); removeAsset(asset) }}><Trash2 size={14} /></button></span>
        {assetMenuId === asset.id ? <div className="asset-menu" role="menu" onClick={(event) => event.stopPropagation()}><span className="asset-menu-title">素材操作</span><span className="asset-menu-path" title={asset.path || '路径不可用'}>{asset.path || '路径不可用'}</span><button role="menuitem" onClick={() => copyAssetPath(asset)}><Copy size={12} />复制文件路径</button><button role="menuitem" className="asset-menu-remove" onClick={() => { setAssetMenuId(null); removeAsset(asset) }}><Trash2 size={12} />从素材库移除</button></div> : null}
      </div>
    )
  }

  function renderMusicLibrary() {
    return <div className="music-library-panel"><div className="music-library-intro"><div className="music-mini-icon"><Music2 size={18} /></div><p>只匹配你自己的授权音乐。曲库分析和推荐完全在本机进行。</p><span><CloudOff size={12} /> 未上传素材</span></div><label className="music-search"><Search size={14} /><input placeholder="搜索曲目 · 风格 · BPM" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索曲库" /></label>{musicFiles.filter((music) => `${music.name} ${music.artist} ${music.genre}`.toLowerCase().includes(search.toLowerCase())).map((music, index) => <div className="music-library-card" key={music.id}><button className="library-play" aria-label={`${recordingMusic === music.id ? '停止' : '试听'} ${music.name}`} onClick={() => toggleMusicPreview(music)}>{recordingMusic === music.id ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}</button><div className="music-library-card-copy"><b>{music.name}</b><span>{music.genre} · {music.bpm ? `${music.bpm} BPM` : '节奏待分析'}</span></div><div className="license-mark" title={music.license || '尚未确认使用许可'} style={{ color: music.license ? '#72ad81' : '#cf9367' }}>{music.license ? <BadgeCheck size={15} /> : <Info size={14} />}</div><button className="mini-add" aria-label={`使用 ${music.name}`} onClick={() => addMusicToTimeline(music)}><Plus size={14} /></button></div>)}{!musicFiles.length && <div className="empty-library">曲库为空，导入自己的音频文件后即可试听和配乐。</div>}<button className="library-add-music" onClick={addMusicFiles}><Plus size={14} />导入已授权的音乐文件</button></div>
  }

  function renderEditorToolbar() {
    return <div className="editor-toolbar"><div className="mode-rail">{FEATURE_TABS.map(({ id, label, icon: Icon }) => <button key={id} className={`mode-button ${activeTab === id ? 'mode-active' : ''}`} onClick={() => { setActiveTab(id); setActivePanel(id === 'music' ? '音乐库' : '属性检查器') }}><Icon size={14} />{label}</button>)}</div><div className="toolbar-divider" /><button className="toolbar-tool" onClick={() => { setInspectorCollapsed(false); setShowDubbing(true) }}><Mic size={13} /><span>智能配音</span></button><button className="toolbar-tool" onClick={splitAtPlayhead}><Scissors size={13} /><span>分割</span><kbd>S</kbd></button><button className="toolbar-tool" onClick={() => removeSelected(false)}><Trash2 size={13} /><span>删除</span><kbd>⌫</kbd></button><button className="toolbar-tool" onClick={() => removeSelected(true)}><Unlink2 size={13} /><span>波纹</span></button><button className="toolbar-tool" onClick={toggleClipLink} disabled={!selectedClip || (selectedClip.kind !== 'video' && !selectedClip.linkedClipId && !selectedClip.audioLinked)}><Unlink2 size={13} /><span>{selectedClip?.linkedClipId || selectedClip?.audioLinked ? '解除联动' : '链接音画'}</span></button><span className="toolbar-spacer" /><button className="toolbar-tool" onClick={() => addMarkerAtPlayhead()}><Flag size={13} /><span>标记</span></button><button className="toolbar-tool" onClick={addGraphicClip}><ImagePlus size={13} /><span>添加图文</span></button><button className="toolbar-tool" onClick={() => openPicker({ preferredKind: 'audio', addToTimeline: true })}><Music2 size={13} /><span>添加音乐</span></button></div>
  }

  function renderVideoPanel() {
    const timestamp = formatTime(project.playhead)
    const dominantClip = findActiveVisualClip(project, project.playhead)
    const clipAsset = dominantClip ? project.assets.find((asset) => asset.id === dominantClip.assetId) : null
    const finalPreviewAsset = dominantClip ? clipAsset : null
    const finalUrl = finalPreviewAsset?.proxyUrl || finalPreviewAsset?.previewUrl || (finalPreviewAsset?.path ? fileUrl(finalPreviewAsset.path) : null)
    const finalLive = Boolean(dominantClip && finalUrl && !finalPreviewAsset?.missing)
    const visualMediaStyle = dominantClip ? {
      objectFit: dominantClip.fill === 'cover' ? 'cover' : 'contain',
      transform: `translate(${Number(dominantClip.x || 0) * 100}%, ${Number(dominantClip.y || 0) * 100}%) scale(${Number(dominantClip.scale) || 1}) rotate(${Number(dominantClip.rotation) || 0}deg)`,
      transformOrigin: 'center center',
    } : undefined
    const linkedSourceAudio = dominantClip && project.clips.find((clip) => {
      const track = project.tracks.find((item) => item.id === clip.trackId)
      return clip.kind === 'audio' && clip.linkedClipId === dominantClip.id
        && project.playhead >= clip.start && project.playhead < clip.start + clip.duration
    })
    const linkedAudioTrack = linkedSourceAudio && project.tracks.find((track) => track.id === linkedSourceAudio.trackId)
    const videoAudioMuted = Boolean((dominantClip?.suppressEmbeddedAudio && !linkedSourceAudio) || linkedSourceAudio && (linkedSourceAudio.muted || linkedAudioTrack?.muted || Number(linkedSourceAudio.volume ?? 0.82) <= 0))
    const hasSeparateSameSourceAudio = false
    const currentCaption = selectedSubtitle?.text || null

    return (
        <div
          className={`preview-workspace ${previewFullscreen ? 'preview-fullscreen' : ''} aspect-${project.frameSize.width === project.frameSize.height ? 'square' : project.frameSize.width < project.frameSize.height ? 'vertical' : 'wide'}`}
          onDragOver={(event) => {
            const asset = project.assets.find((item) => item.id === dominantClip?.assetId)
            if (!playing && asset?.path && !asset.proxyUrl && !previewProxyAttemptRef.current.has(asset.id)) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }
          }}
          onDrop={(event) => {
            const asset = project.assets.find((item) => item.id === dominantClip?.assetId)
            if (!playing && asset?.path && !asset.proxyUrl && !previewProxyAttemptRef.current.has(asset.id)) {
              event.preventDefault()
              void requestPreviewProxy(asset, dominantClip.id)
            }
          }}
        >
        <div className="preview-topbar"><div className="scene-label"><span className="record-dot" /><span>{finalPreviewAsset?.name || (project.clips.length ? project.name : '预览画面')}</span><span className="scene-divider">/</span><span>时间线 · 当前片段</span></div><div className="preview-top-actions"><span className="proxy-pill"><span className="proxy-spark">✳</span>本地素材</span><button className="icon-button preview-settings-button" onClick={() => setActiveTab('settings')} title="画幅设置" aria-label="画幅设置"><Settings2 size={13} /></button><button className="icon-button preview-expand" onClick={toggleFullscreen} title={previewFullscreen ? '退出预览区全屏' : '预览区全屏'} aria-label={previewFullscreen ? '退出预览区全屏' : '预览区全屏'}><Expand size={14} /></button><button className="icon-button preview-expand" onClick={() => void openStandalonePreview(finalPreviewAsset)} title="在独立窗口中预览当前片段" aria-label="在独立窗口中预览当前片段"><PictureInPicture2 size={14} /></button></div></div>
        <div className="preview-stage"><div className="preview-edge-stamp">FRAME {String(Math.round(project.playhead * 30)).padStart(6, '0')} <span>/</span> {Number(project.frameRate.numerator || 30)}FPS</div><div className="preview-edge-time">COLOR · SDR <span>◉</span></div>
          <div className={`preview-video ${finalLive ? 'has-live-frame' : ''}`} style={{ aspectRatio: `${project.frameSize.width} / ${project.frameSize.height}`, '--preview-ratio': project.frameSize.width / project.frameSize.height, ...(finalPreviewAsset?.previewColor ? { background: previewBackground(finalPreviewAsset.previewColor) } : finalLive ? {} : { background: previewBackground(dominantClip?.previewColor || 'ocean') }) }}>
            {finalLive && finalPreviewAsset?.kind === 'video' ? <video ref={playerRef} data-clip-id={dominantClip.id} key={`${dominantClip.id}:${finalUrl}`} src={finalUrl} poster={finalPreviewAsset.poster || finalPreviewAsset.thumbnail} muted={videoAudioMuted || hasSeparateSameSourceAudio || (!linkedSourceAudio && Number(dominantClip.volume ?? 0.82) <= 0)} volume={Math.max(0, Math.min(1, Number(linkedSourceAudio?.volume ?? dominantClip.volume ?? 0.82)))} style={visualMediaStyle} playsInline preload="metadata" onSeeking={handleVideoSeeking} onSeeked={handleVideoSeeked} onLoadedMetadata={(event) => syncPreviewMetadata(event, dominantClip.id)} onError={(event) => handlePreviewDecodeError(finalPreviewAsset, dominantClip.id, event)} /> : finalLive && finalPreviewAsset?.kind === 'image' ? <img className="preview-image" src={finalUrl} style={visualMediaStyle} alt="当前预览素材" /> : null}
            <div className={`frame-cinema-overlay ${finalLive && previewErrorClipId !== dominantClip?.id ? 'muted-overlay' : ''}`} aria-hidden="true"><span /><span /><span /><i /><b /></div>
            {finalLive && finalPreviewAsset?.kind === 'video' && previewErrorClipId !== dominantClip?.id ? <div className="preview-frame-guide" aria-hidden="true"><i /><i /><i /><i /><span className="guide-crosshair crosshair-x" /><span className="guide-crosshair crosshair-y" /></div> : null}
            {finalLive && finalPreviewAsset?.kind === 'video' && <span className="preview-live-badge"><span />本地原片 · 即时预览</span>}
            {project.clips.length > 0 && (!dominantClip || !finalLive) && !exampleMode && <div className="preview-gap-state"><span>{dominantClip ? '无法显示此片段' : '无画面片段'}</span><small>{dominantClip ? '源素材缺失或无法读取' : playing ? '播放指针位于片段空隙' : '此处没有可显示的视频或图片'}</small></div>}
            {previewSeeking && finalLive && !playing ? <span className="preview-seeking">正在定位画面…</span> : null}
            {!finalLive && !project.clips.length && <div className="preview-placeholder"><div className="preview-placeholder-orbit orbit-one" /><div className="preview-placeholder-orbit orbit-two" /><div className="preview-placeholder-center"><span>PLAYGROUND <i>01</i></span><Aperture size={46} strokeWidth={0.75} /><b>创作，由此开始</b><small>导入素材，搭建你的第一条时间线</small><button onClick={() => openPicker({ addToTimeline: true })}><Plus size={14} />导入第一个素材</button></div></div>}
            {!finalLive && exampleMode && <div className="illustration-title"><span className="project-overline">界面示例 · 未附带源文件</span><span className="title-rule" /><span className="display-title">coastline<br /><i>stories</i></span><span className="display-caption">这些片段仅展示时间线布局，无法播放或导出</span><button className="example-start-button" onClick={createEmptyProject}><Plus size={13} />新建空白工程</button><span className="project-edition">NO. 07 &nbsp; / &nbsp; EASTERN COAST</span></div>}
            {currentCaption && <div className="preview-subtitle">{currentCaption}</div>}
            {previewProxyClipId === dominantClip?.id ? <div className="preview-unavailable"><LoaderCircle size={14} className="loading-spin" />正在创建本地兼容预览…</div> : previewErrorClipId === dominantClip?.id ? <div className="preview-unavailable"><Info size={14} />{previewErrorMessage || '预览失败，但未能获取具体错误信息。'}</div> : null}
            <div className="preview-safe-margin" aria-hidden="true" />
          </div>
        </div>
        <div className="transport-row"><button className="transport-side" title="回到开头" aria-label="回到开头" onClick={returnToStart}><SkipBack size={13} /></button><button className="transport-side" title="上一剪辑点" onClick={() => { const previous = [...project.clips].filter((clip) => clip.start < project.playhead).sort((a, b) => b.start - a.start)[0]; setPlayhead(previous?.start || 0) }}><ChevronLeft size={14} /></button><button className="transport-step" aria-label="前一帧" onClick={() => setPlayhead(Math.max(0, project.playhead - 1 / 30))}><ChevronLeft size={13} /></button><button className="play-button" onClick={togglePlayback} aria-label={playing ? '暂停' : '播放'}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button><button className="transport-step next" aria-label="后一帧" onClick={() => setPlayhead(Math.min(duration, project.playhead + 1 / 30))}><ChevronRight size={13} /></button><button className="transport-side" title="下一剪辑点" onClick={() => { const next = [...project.clips].filter((clip) => clip.start > project.playhead).sort((a, b) => a.start - b.start)[0]; setPlayhead(next?.start || duration) }}><ChevronRight size={14} /></button><button className="transport-side" title="到末尾" aria-label="到末尾" onClick={returnToEnd}><SkipForward size={13} /></button><div className="timecode">{timestamp}<span className="timecode-separator">:</span><span className="frame-code">{String(Math.round((project.playhead % 1) * 30).toString().padStart(2, '0'))}</span></div><span className="transport-ratio">01.00 ×</span><button className="icon-button" title="原画预览" onClick={() => setStatus('播放性能：代理模式已就绪，代理将在后续阶段生成。', 'info')}><Gauge size={13} /></button></div>
        <div className="preview-footer"><span><span className="footer-rec" /><b>PREVIEW</b><i>·</i>{finalLive && finalPreviewAsset?.width ? `${finalPreviewAsset.width} × ${finalPreviewAsset.height}` : project.profile}</span><span><span className="preview-fps">30</span> FPS <i>·</i>{finalLive ? '时间线预览' : exampleMode ? '界面示例 · 无源文件' : project.clips.length ? '无可用画面' : '等待导入素材'}<i>·</i>SDR</span></div>
      </div>
    )
  }

  function renderTracks() {
    return <div className={`timeline-editor-panel ${density ? 'density-compact' : ''}`}><div className="timeline-heading"><div className="timeline-title"><div><span className="eyebrow">MULTITRACK TIMELINE</span><h2>时间线</h2></div><span className="timeline-version">TCS <i>·</i> 30FPS</span></div><div className="timeline-controls"><div className="duration-chip"><Disc3 size={12} /><span>{formatCompactTime(duration)}</span></div><button className={`timeline-icon ${density ? 'is-toggled' : ''}`} title="缩紧时间线轨道" aria-label="缩紧时间线轨道" onClick={() => setDensity((value) => !value)}><Layers3 size={13} /></button><button className="timeline-icon" title="适配整个工程" aria-label="适配整个工程" onClick={fitTimelineToViewport}><Maximize2 size={13} /></button></div></div>
      {renderTimelineControls()}
      <div className="timeline-grid" onWheel={handleWheel}><div className="timeline-sidebar"><div className="track-label-row ruler-label">TIMECODE<span>00:00:00:00</span></div><div className="tracks-list" ref={trackListRef} onScroll={(event) => syncTrackScroll(event, timelineRef.current)}>{project.tracks.map((track, index) => renderTrack(track, index))}</div><div className="track-sidebar-footer">{renderAddTrackButton()}</div></div>
      <div className="timeline-viewport" ref={timelineRef} onScroll={(event) => syncTrackScroll(event, trackListRef.current)}><div className="timeline-canvas" style={{ width: `${totalWidth}px` }}><div className="timeline-ruler" onClick={(event) => setPlayhead(timelineTimeFromClientX(event.clientX))}><div className="ruler-tick-row">{createTicks(duration, timelineContentWidth).map((tick) => <span className="ruler-tick" key={tick.position} style={{ left: `${tick.position}px` }}><i />{formatCompactTime(tick.seconds)}</span>)}</div>{guideMarkers.map((marker) => <span className="ruler-marker-label" key={marker.id} style={{ left: `${marker.start / duration * timelineContentWidth}px` }}><i />{formatCompactTime(marker.start)}</span>)}</div><div className="track-canvas">{project.tracks.map((track, index) => {
        const clips = project.clips.filter((clip) => clip.trackId === track.id).sort((a, b) => a.start - b.start)
        return <div className={`track-row ${activeTrack?.id === track.id ? 'track-is-active' : ''} track-type-${track.type} ${track.locked ? 'track-is-locked' : ''} ${track.muted ? 'track-is-muted' : ''}`} key={track.id}>
          <div className="track-info timeline-track-header" onClick={() => { setActiveTrackId(track.id); setSelectedId(clips.find((clip) => clip.id === selectedId)?.id || null) }}><span className={`track-icon track-color-${track.accent}`}><TrackIcon type={track.type} /></span><div className="track-name-wrap"><span className="track-index">T{String(index + 1).padStart(2, '0')}</span><span className="track-title" title={track.label}>{track.label}</span></div><div className="track-controls"><button className="track-control" aria-label={track.muted ? '取消静音' : '静音轨道'} title={track.muted ? '取消静音' : '静音轨道'} onClick={() => toggleTrackFor(track.id, 'muted')}>{track.muted ? <VolumeX size={11} className="toggle-on" /> : <Volume2 size={11} />}</button><button className="track-control" aria-label={track.locked ? '解锁轨道' : '锁定轨道'} title={track.locked ? '解锁轨道' : '锁定轨道'} onClick={() => toggleTrackFor(track.id, 'locked')}>{track.locked ? <LockKeyhole size={11} className="toggle-on" /> : <Circle size={11} />}</button></div></div>
          <div className={`track-clip-lane ${track.type === 'subtitle' ? 'subtitle-lane' : ''} ${track.type === 'audio' ? 'audio-lane' : ''}`} style={{ width: `${totalWidth}px` }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={(event) => handleDrop(event, track)} onPointerDown={(event) => {
            if (event.target.closest('.timeline-clip')) return
            clearTimelineSelection()
            setPlayhead(timelineTimeFromClientX(event.clientX), null)
            setActiveTrackId(track.id)
          }}>
            {track.type === 'audio' && <div className="audio-lane-center" aria-hidden="true" />}
            {track.id === 'video-main' && !clips.length && <div className="empty-track-hint"><span className="empty-add-dot">+</span><span>拖入视频开始剪辑</span></div>}
            {clips.map((clip, clipIndex) => renderTimelineClip(clip, track, index, clipIndex))}
            {guideMarkers.map((marker) => <button key={marker.id} className="timeline-marker" style={{ left: `${marker.start / duration * timelineContentWidth}px` }} title={marker.name} onClick={(event) => { event.stopPropagation(); setPlayhead(marker.start); setStatus(marker.name, 'info') }}><span /></button>)}
          </div>
        </div>
      })}
        <div className="track-add-row">{renderAddTrackButton()}<span>拖入素材 · 双击图文修改 · S 分割</span></div>
      </div><div className="timeline-playhead" style={{ left: `${project.playhead / duration * timelineContentWidth}px` }}><div className="playhead-handle"><i /></div><div className="playhead-line" /></div></div></div></div>
      <div className="timeline-statusbar"><div className="selection-status"><span className="selection-dot" /><span>{selectedClipIds.length > 1 ? `已选 ${selectedClipIds.length} 个片段` : selectedClip ? selectedClip.name : `${project.tracks.length} 条轨道 · ${project.clips.length} 个片段`}</span><i>·</i><span>{selectedClipIds.length > 1 ? '拖动整体移动 · Delete 批量删除' : selectedClip ? `${formatTime(selectedClip.start)} → ${formatTime(selectedClip.start + selectedClip.duration)}` : '⌘/Ctrl 点击多选 · Shift 点击范围选择'}</span></div><div className="zoom-controls"><button aria-label="缩小时间轴" title="缩小时间轴" onClick={() => setManualTimelineZoom((value) => Math.max(minimumZoom, value * 0.86))}><ZoomOut size={13} /></button><input type="range" min={minimumZoom} max="2.4" step="0.01" value={zoom} onChange={(event) => setManualTimelineZoom(Number(event.target.value), event.clientX)} aria-label="时间轴缩放" title="拖动以缩放时间轴" /><button aria-label="放大时间轴" title="放大时间轴" onClick={() => setManualTimelineZoom((value) => Math.min(2.4, value * 1.16))}><ZoomIn size={13} /></button><span>{fitTimeline ? '适配' : `${Math.round(zoom * 100)}%`}</span><span className="zoom-divider" /><button className="timeline-shortcut" title="⌘/Ctrl 点击多选 · Shift 点击同轨范围 · Esc 取消选择 · ⌘/Ctrl 滚轮缩放 · Shift 滚轮横向移动 · Shift+Delete 清空当前轨道" aria-label="时间轴快捷键说明"><Info size={12} /></button></div></div>
    </div>
  }

  function renderTimelineControls() {
    return <div className="timeline-transport"><div className="transport-clock">{formatTime(project.playhead)}<span>:<i>{String(Math.floor(project.playhead * 30) % 30).padStart(2, '0')}</i></span></div><button className="timeline-transport-step" aria-label="回到开头" title="回到开头 · Home" onClick={returnToStart}><SkipBack size={13} /></button><button className="timeline-transport-step" aria-label="前一帧" onClick={() => setPlayhead(Math.max(0, project.playhead - 1 / 30))}><ChevronLeft size={14} /></button><button className="timeline-transport-play" aria-label={playing ? '暂停' : '播放'} onClick={togglePlayback}>{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</button><button className="timeline-transport-step" aria-label="后一帧" onClick={() => setPlayhead(Math.min(duration, project.playhead + 1 / 30))}><ChevronRight size={14} /></button><button className="timeline-transport-step" aria-label="到末尾" title="到末尾 · End" onClick={returnToEnd}><SkipForward size={13} /></button><span className="transport-vertical-rule" /><button className="timeline-transport-step" title="跳转标记" onClick={() => { const next = guideMarkers.find((marker) => marker.start > project.playhead); if (next) setPlayhead(next.start) }}><Flag size={13} /></button><span className="timeline-transport-label">{activeTrack?.label || '未选择轨道'}</span><span className="timeline-transport-hint">AUDIO SCRUB <i>·</i> 30 fps</span></div>
  }

  function renderRightInspector() {
    return <aside className={`inspector-panel ${inspectorCollapsed ? 'inspector-panel-collapsed' : ''}`}><div className="inspector-heading"><div><span className="eyebrow">INSPECTOR</span><h2>{activeTab === 'subtitles' ? '字幕编辑' : activeTab === 'music' ? '配乐编排' : activeTab === 'settings' ? '画幅与声音' : '属性检查器'}</h2></div><button className="icon-button compact inspector-toggle" onClick={() => setInspectorCollapsed((collapsed) => !collapsed)} aria-label={inspectorCollapsed ? '展开检查器' : '收起检查器'} title={inspectorCollapsed ? '展开检查器' : '收起检查器'}>{inspectorCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}</button></div>{activeTab === 'subtitles' ? renderSubtitleInspector() : activeTab === 'music' ? renderMusicInspector() : activeTab === 'settings' ? renderProjectSettings() : renderClipInspector()}</aside>
  }

  function renderSubtitleInspector() {
    return <div className="inspector-scroll"><div className="inspector-section subtitle-status-card"><div className="section-kicker"><span>01 / TRANSCRIBE</span><span className={`local-model-pill ${tools.find((item) => item.name === 'melt')?.version ? 'connected' : ''}`}><span />{subtitleBusy ? 'CHECKING MODEL' : 'OFFLINE'}</span></div><div className="asr-title"><div className="asr-orbit"><Mic size={17} /><span>AI</span></div><div><h3>对白变字幕</h3><small>{subtitleGenerated ? '当前显示字幕草稿' : 'Whisper · 本地模型尚未安装'}</small></div></div><button className="generate-subtitles" disabled={subtitleBusy || !window.videome?.probeMedia} title={!window.videome?.probeMedia ? '桌面版将连接本地媒体处理服务' : ''} onClick={recognizeSpeech}><Sparkles size={14} />{subtitleBusy ? '正在检查本地语音模型…' : '检查本地语音识别'}</button><div className="subtitles-note"><LockKeyhole size={11} /><span>离线处理 · 原始音频不会上传</span><button title="本地 Whisper 组件尚未安装；自动识别不可用，但你可以手工编辑或导入字幕。" onClick={() => setStatus('Whisper 组件尚未安装，界面不会生成虚构的转写字幕。', 'info')}><Info size={11} /></button></div></div><div className="inspector-section cues-section"><div className="section-heading-row"><div><span className="section-kicker">02 / CAPTIONS</span><span className="subsection-title">字幕行</span></div><span className="cue-count">{project.subtitle.cues.length} 行</span></div><div className="subtitle-list">{project.subtitle.cues.map((cue, index) => <div className={`subtitle-row ${selectedCueId === cue.id ? 'cue-selected' : ''}`} key={cue.id} onClick={() => handleSubtitleCueSelection(cue)}><span className="cue-number">{String(index + 1).padStart(2, '0')}</span><div className="cue-fields"><div className="cue-time-fields"><input className="cue-time" value={formatCompactTime(cue.start)} aria-label="字幕起始时间" onChange={(event) => { const time = parseClock(event.target.value, cue.start); setSubtitleCue(cue.id, { start: time, end: Math.max(time + 0.2, cue.end) }) }} onClick={(event) => event.stopPropagation()} /><span>→</span><input className="cue-time" value={formatCompactTime(cue.end)} aria-label="字幕结束时间" onChange={(event) => { const time = parseClock(event.target.value, cue.end); setSubtitleCue(cue.id, { end: Math.max(cue.start + 0.2, time) }) }} onClick={(event) => event.stopPropagation()} /><button aria-label="删除字幕行" title="删除字幕行" onClick={(event) => { event.stopPropagation(); removeSubtitleCue(cue) }}><X size={11} /></button></div><textarea value={cue.text} rows={1} aria-label="字幕内容" onClick={(event) => event.stopPropagation()} onChange={(event) => { setSubtitleCue(cue.id, { text: event.target.value }); event.target.style.height = 'auto'; event.target.style.height = `${event.target.scrollHeight}px` }} /></div><span className="cue-duration">{cueToEnd(cue)}s</span></div>)}</div><button className="add-caption" onClick={() => { const cue = { id: `caption-${Date.now()}`, start: Math.min(duration - 0.5, project.playhead), end: Math.min(duration, project.playhead + 3), text: '新增字幕', edited: true }; applyEdit('添加字幕', (current) => ({ ...current, subtitle: { ...current.subtitle, enabled: true, cues: [...current.subtitle.cues, cue] }, clips: [...current.clips, addSubtitleClip(cue)] })); setSelectedCueId(cue.id); setStatus('已添加字幕行；导出前可校准起止时间。') }}><Plus size={12} />添加字幕行</button><div className="subtitle-bulk-actions"><button onClick={importSubtitleFile}><FolderOpen size={12} />导入 SRT</button><button onClick={exportSrt}><Download size={12} />导出 SRT</button></div></div><div className="inspector-section style-section"><div className="section-kicker">03 / STYLE</div><div className="mini-field-row"><span>字幕样式</span><div className="setting-readonly">经典 · 白字描边 <ChevronDown size={11} /></div></div><div className="mini-field-row"><span>字幕字号</span><div className="setting-stepper"><button aria-label="减小字号" onClick={() => updateProject((current) => ({ ...current, subtitle: { ...current.subtitle, fontSize: Math.max(20, current.subtitle.fontSize - 2) } }), '调整字幕字号')}><Minus size={10} /></button><span>{project.subtitle.fontSize} <i>px</i></span><button aria-label="增大字号" onClick={() => updateProject((current) => ({ ...current, subtitle: { ...current.subtitle, fontSize: Math.min(100, current.subtitle.fontSize + 2) } }), '调整字幕字号')}><Plus size={10} /></button></div></div><div className="mini-field-row"><span>描边底色</span><button className={`switch ${project.subtitle.background ? 'switch-on' : ''}`} role="switch" aria-checked={project.subtitle.background} aria-label="字幕背景" onClick={() => applyEdit('切换字幕背景', (current) => ({ ...current, subtitle: { ...current.subtitle, background: !current.subtitle.background } }))}><i /></button></div></div></div>
  }

  function renderMusicInspector() {
    return <div className="inspector-scroll music-inspector-scroll"><div className="music-match-card"><div className="match-card-ribbon"><Sparkles size={13} />LOCAL SOUND MATCHER</div><h3>给故事找到<br /><i>合适的声音。</i></h3><p>曲库筛选、情绪标签与匹配分数均在本机计算。未连接在线服务，不上传视频或素材。</p><div className="match-local-mark"><LockKeyhole size={12} />PRIVATE BY DEFAULT <span>·</span> AUDIO RIGHTS MATTER</div></div><div className="inspector-section music-preferences"><div className="section-heading-row"><div><span className="section-kicker">01 / STORY FEEL</span><span className="subsection-title">项目氛围</span></div><span className="offline-badge"><span />本地</span></div><span className="mood-choice-label">节奏与情绪</span><div className="mood-chips">{[['sunny', '晴朗', '☼'], ['calm', '舒缓', '↗'], ['dreamy', '朦胧', '◌'], ['energetic', '轻快', '↗']].map(([id, label, icon]) => <button className={mood === id ? 'mood-chip mood-selected' : 'mood-chip'} key={id} onClick={() => setMood(id)}><i>{icon}</i>{label}</button>)}</div><div className="mini-field-row"><span>剪辑节奏</span><select className="inline-select" value={tempo} onChange={(event) => setTempo(event.target.value)}><option value="slow">慢 · 余韵镜头</option><option value="mid">中 · 自然节奏</option><option value="fast">快 · 密集转场</option></select></div><div className="mini-field-row"><span>音乐响度</span><div className="mix-volume"><input aria-label="背景音乐响度" type="range" min="0.05" max="0.6" step="0.01" value={volumeTarget} onChange={(event) => { const next = Number(event.target.value); setVolumeTarget(next); if (selectedClip?.isMusic) setClipVolume(selectedClip.id, next) }} /><span>{Math.round(volumeTarget * 100)}%</span></div></div><div className="ducking-summary"><Headphones size={13} /><span>人声出现时自动压低音乐</span><span className="check-tick"><Check size={11} /></span></div></div><div className="inspector-section matches-section"><div className="section-heading-row"><div><span className="section-kicker">02 / MATCHES</span><span className="subsection-title">为这支影片推荐</span></div><button className="rerun-button" onClick={() => setStatus('推荐已按影片氛围、本机曲库和时长重新排序。', 'info')}><RotateCw size={12} />重新分析</button></div>{!musicFiles.length && <div className="rights-warning"><Info size={12} /><span>尚未导入本地音乐。导入后可试听并加入时间线。</span></div>}{suggestions.map((music, index) => <div className={`recommended-track ${index === 0 ? 'recommended-primary' : ''}`} key={music.id}><div className="track-artwork" style={{ '--music-hue': [46, 186, 276][index] }}>{index === 0 ? <Waves size={17} /> : index === 1 ? <Sun size={16} /> : <AudioLines size={16} />}<span>{String(index + 1).padStart(2, '0')}</span></div><div className="recommended-copy"><div className="recommended-title-row"><strong>{music.name}</strong><span className="match-score">{music.score}<i>%</i></span></div><span>{music.artist} <i>·</i> {formatCompactTime(music.duration)}</span><div className="recommend-tags"><span>{moodLabel(music.mood)}</span><span>{music.tempo === 'mid' ? '中节奏' : music.tempo === 'slow' ? '慢节奏' : '节奏灵活'}</span></div><small>{music.license ? music.reason : '请确认许可后再用于成片'}</small></div><button className={`track-play ${recordingMusic === music.id ? 'is-playing' : ''}`} aria-label={`${recordingMusic === music.id ? '暂停' : '试听'} ${music.name}`} onClick={() => toggleMusicPreview(music)}>{recordingMusic === music.id ? <Pause size={13} /> : <Play size={13} fill="currentColor" />}</button><button className="track-use" aria-label={`添加 ${music.name}`} title="添加到时间轴" onClick={() => addMusicToTimeline(music)}><Plus size={14} /></button></div>)}<div className="licence-checkbox" role="button" aria-disabled={!suggestions.length} tabIndex={suggestions.length ? 0 : -1} onClick={() => { const topTrack = suggestions[0]; saveMusicLicense(topTrack) }} onKeyDown={(event) => event.key === 'Enter' && saveMusicLicense(suggestions[0])}><span className={suggestions[0]?.license ? 'license-checkbox checked' : 'license-checkbox'}>{suggestions[0]?.license && <Check size={9} />}</span><span>我确认所选音乐具有用于个人作品的许可</span><button title="记录你的许可状态，不会验证实际授权内容。" onClick={(event) => { event.stopPropagation(); setStatus('Videome 不自动授予音乐版权；仅记录你自行确认的授权声明。', 'info') }}><Info size={11} /></button></div><button className="add-library-music" onClick={addMusicFiles}><Plus size={13} />添加一首授权的本地音乐</button></div><div className="music-ethics-note"><LockKeyhole size={11} /><span>推荐基于你导入的音乐元数据。本地模型分析不代替人工确认授权或配乐质量。</span></div></div>
  }

  function renderProjectSettings() {
    return <div className="inspector-scroll"><div className="inspector-section"><div className="section-kicker">01 / FRAME</div><h3 className="setting-title">画幅 · 输出规格</h3><div className="aspect-selector">{[
      { id: 'wide', label: '16:9', icon: '□', width: 1920, height: 1080 }, { id: 'portrait', label: '9:16', icon: '▯', width: 1080, height: 1920 }, { id: 'square', label: '1:1', icon: '▣', width: 1080, height: 1080 }, { id: 'source', label: '素材原始', icon: '◇', width: 1920, height: 1080 },
    ].map((option) => <button key={option.id} className={project.frameSize.width === option.width && project.frameSize.height === option.height ? 'aspect-option selected' : 'aspect-option'} onClick={() => { applyEdit('更改项目画幅', (current) => ({ ...current, frameSize: { width: option.width, height: option.height }, profile: `${option.width}×${option.height} · ${current.frameRate.numerator} fps` })); setStatus(`项目画幅已更改为 ${option.width}×${option.height}。`) }}><span>{option.icon}</span><small>{option.label}</small></button>)}</div><div className="mini-field-row"><span>宽度 · 高度</span><div className="setting-dimensions"><input aria-label="画布宽度" type="number" step="2" min="320" max="7680" value={project.frameSize.width} onChange={(event) => updateProject((current) => ({ ...current, frameSize: { ...current.frameSize, width: Number(event.target.value) || 1920 } }), '修改画幅')} /><X size={10} /><input aria-label="画布高度" type="number" step="2" min="320" max="7680" value={project.frameSize.height} onChange={(event) => updateProject((current) => ({ ...current, frameSize: { ...current.frameSize, height: Number(event.target.value) || 1080 } }), '修改画幅')} /></div></div><div className="mini-field-row"><span>适配方式</span><select className="inline-select" value={selectedClip?.fill || 'contain'} onChange={(event) => selectedClip && applyEdit('更改画面适配', (current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, fill: event.target.value } : clip) }))}><option value="contain">留黑边 · 适合全部画面</option><option value="cover">裁剪填满 · 可能裁掉边缘</option></select></div></div><div className="inspector-section"><div className="section-kicker">02 / PLAYBACK</div><h3 className="setting-title">编辑偏好</h3><div className="mini-field-row"><span>工程帧率</span><select className="inline-select" value={project.frameRate.numerator} onChange={(event) => applyEdit('更改工程帧率', (current) => { const rate = Number(event.target.value); return { ...current, frameRate: { numerator: rate, denominator: 1 }, profile: `${current.frameSize.width}×${current.frameSize.height} · ${rate} fps` } })}><option value="24">24 fps · 电影</option><option value="25">25 fps · PAL</option><option value="30">30 fps · 通用</option><option value="50">50 fps · 流畅</option><option value="60">60 fps · 高帧率</option></select></div><div className="mini-field-row"><span>代理预览</span><button className="read-only-tag" onClick={() => setStatus('预览代理队列已启用；本机目前不下载任何云端模型。', 'info')}><span className="proxy-dot-small" />HD · 本地</button></div></div><div className="preview-warning-card"><Info size={14} /><div><strong>不支持 HDR / 10-bit 合成</strong><span>SDR 素材可正常混剪。HDR 素材请保留原片或等待完整色彩管理支持。</span></div></div><div className="inspector-section"><div className="section-kicker">03 / ABOUT PROJECT</div><div className="property-row"><span>工程格式</span><b>.videome · v1</b></div><div className="property-row"><span>媒体引擎</span><b>FFmpeg {tools.find((item) => item.name === 'ffmpeg')?.version?.match(/version\s+([^ ]+)/)?.[1] || '未安装'}</b></div><div className="property-row"><span>轨道数量</span><b>{project.tracks.length} 条</b></div><div className="property-row"><span>缓存恢复</span><b>{historyNote}</b></div></div></div>
  }

  function renderClipInspector() {
    if (selectedClip?.kind === 'graphics') return renderGraphicsInspector()
    if (selectedClip?.kind === 'subtitle') return renderCaptionInspector()
    if (selectedClip?.kind === 'audio') return renderAudioInspector()
    if (!selectedClip) return renderDefaultInspector()

    const sourceDuration = selectedClip.sourceDuration || selectedClip.duration
    const inPoint = selectedClip.trimStart || 0
    const outPoint = selectedClip.trimEnd || inPoint + selectedClip.duration

    return <div className="inspector-scroll"><div className="selected-clip-card"><div className={`inspector-preview-art thumb-${selectedClip.previewColor || 'ocean'}`} style={{ backgroundImage: selectedAsset?.thumbnail ? `url("${selectedAsset.thumbnail}")` : undefined }}><Film size={18} /><span className="inspector-card-tag">{selectedClip.kind === 'video' ? 'VIDEO' : 'IMAGE'}</span><span className="inspector-timecode-over">{formatTime(project.playhead)}</span></div><div className="selected-clip-copy"><b>{selectedClip.name}</b><span>{selectedAsset?.width ? `${selectedAsset.width}×${selectedAsset.height} · ` : ''}{selectedAsset?.codec?.toUpperCase() || (selectedClip.kind === 'image' ? '静态图像' : '视频片段')}</span><span>{selectedAsset?.path || (exampleMode ? '界面占位 · 未附带源文件' : '未关联源素材')}</span></div></div><div className="inspector-section"><div className="section-heading-row"><div><span className="section-kicker">01 / SOURCE</span><span className="subsection-title">片段区间</span></div><button className="ghost-mini-button" onClick={() => setStatus('播放指针将显示绝对时间码；拖动红色播放头逐帧定位。', 'info')}>30fps <ChevronDown size={10} /></button></div><div className="trim-visual"><span className="trim-rail" /><span className="trim-window" style={{ left: `${sourceDuration ? inPoint / sourceDuration * 100 : 0}%`, width: `${Math.min(100, selectedClip.duration / Math.max(sourceDuration, selectedClip.duration) * 100)}%` }} /><span className="trim-handle start" /><span className="trim-handle end" /></div><div className="trim-fields"><label><span>入点</span><input aria-label="片段入点" value={trimDrafts.clipId === selectedClip.id ? trimDrafts.start : formatTime(inPoint)} onChange={(event) => setTrimDrafts((current) => ({ ...current, clipId: selectedClip.id, start: event.target.value }))} onBlur={(event) => commitTrimDraft(selectedClip, 'trimStart', event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label><span className="trim-separator">—</span><label><span>出点</span><input aria-label="片段出点" value={trimDrafts.clipId === selectedClip.id ? trimDrafts.end : formatTime(outPoint)} onChange={(event) => setTrimDrafts((current) => ({ ...current, clipId: selectedClip.id, end: event.target.value }))} onBlur={(event) => commitTrimDraft(selectedClip, 'trimEnd', event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label><span className="duration-value">{formatCompactTime(selectedClip.duration)}</span></div></div><div className="inspector-section audio-properties"><div className="section-kicker">02 / COMPOSITION</div><div className="mini-field-row"><span>画面填充</span><select className="inline-select" value={selectedClip.fill || 'contain'} onChange={(event) => editClip({ fill: event.target.value }, '设置画面适配')}><option value="contain">适应画布</option><option value="cover">裁剪铺满</option></select></div><div className="mini-field-row"><span>缩放比例</span><div className="mix-volume"><input aria-label="片段缩放" type="range" min="0.25" max="2" step="0.01" value={selectedClip.scale ?? 1} onChange={(event) => editClip({ scale: Number(event.target.value) }, '调整片段缩放')} /><span>{Math.round((selectedClip.scale || 1) * 100)}%</span></div></div><div className="mini-field-row"><span>水平偏移</span><div className="mix-volume"><input aria-label="画面水平位置" type="range" min="-0.6" max="0.6" step="0.01" value={selectedClip.x || 0} onChange={(event) => editClip({ x: Number(event.target.value) }, '调整画面位置')} /><span>{Math.round((selectedClip.x || 0) * 100)}%</span></div></div><div className="mini-field-row"><span>旋转画面</span><button className="rotate-clip" onClick={() => editClip({ rotation: ((Number(selectedClip.rotation) || 0) + 90) % 360 }, '旋转画面')}><RotateCw size={13} />{selectedClip.rotation || 0}° · 旋转 90°</button></div></div><div className="inspector-section inspector-audio"><div className="section-heading-row"><div><span className="section-kicker">03 / ORIGINAL SOUND</span><span className="subsection-title">原始收音</span></div><span className="volume-value">{Math.round((selectedClip.volume ?? 0.82) * 100)}%</span></div><div className="mix-volume big-volume"><Volume2 size={14} /><input type="range" min="0" max="1.5" step="0.01" value={selectedClip.volume ?? 0.82} onChange={(event) => setClipVolume(selectedClip.id, Number(event.target.value))} /><button aria-label="设为静音" onClick={() => setClipVolume(selectedClip.id, 0)}><VolumeX size={13} /></button></div><div className="inspector-note"><Info size={12} /><span>该操作修改工程音量，不触碰原视频文件。声音处理时会重新编码音频。</span></div></div>{warning && <div className="stream-warning"><Info size={13} /><span>{warning}</span></div>}<button className="section-reset-button" onClick={() => { setSelectedId(null); setActivePanel('素材库') }}>完成检查 <Check size={12} /></button></div>
  }

  function editClip(patch, label) {
    if (!selectedClip?.id) return
    applyEdit(label, (current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, ...patch } : clip) }))
  }

  function commitTrimDraft(clip, field, draft) {
    const currentValue = field === 'trimStart'
      ? Number(clip.trimStart) || 0
      : Number(clip.trimEnd) || ((Number(clip.trimStart) || 0) + (Number(clip.duration) || 0))
    const parsed = parseClock(draft, currentValue)
    setTrimDrafts((current) => ({ ...current, [field === 'trimStart' ? 'start' : 'end']: formatTime(parsed) }))
    adjustClipTime(clip, field, parsed)
  }

  function adjustClipTime(clip, field, value) {
    const next = Math.max(0, Number(value) || 0)
    const currentClip = projectRef.current.clips.find((item) => item.id === clip.id) || clip
    const trimStart = Number(currentClip.trimStart) || 0
    const trimEnd = Number(currentClip.trimEnd) || (trimStart + Number(currentClip.duration || 0))
    let patch

    if (field === 'trimStart') {
      const delta = Math.max(-trimStart, Math.min(currentClip.duration - 0.2, next - trimStart))
      patch = {
        trimStart: trimStart + delta,
        duration: Math.max(0.2, currentClip.duration - delta),
        start: Math.max(0, currentClip.start + delta),
      }
    } else {
      const nextEnd = Math.min(currentClip.sourceDuration || currentClip.duration, Math.max(trimStart + 0.2, next))
      patch = { trimEnd: nextEnd, duration: Math.max(0.2, nextEnd - trimStart) }
    }

    applyEdit(field === 'trimStart' ? '调整片段入点' : '调整片段出点', (current) => {
      const nextClip = { ...currentClip, ...patch }
      const clips = current.clips.map((item) => item.id === currentClip.id
        ? nextClip
        : item.linkedClipId === currentClip.id
          ? { ...item, start: nextClip.start, duration: nextClip.duration, trimStart: nextClip.trimStart, trimEnd: nextClip.trimEnd, sourceDuration: nextClip.sourceDuration }
          : item)
      return { ...current, clips, duration: Math.max(current.duration, nextClip.start + nextClip.duration) }
    })
  }

  function renderGraphicsInspector() {
    return <div className="inspector-scroll"><div className="inspector-section"><div className="section-kicker">01 / TYPE</div><h3 className="setting-title">标题与图文</h3><label className="graphic-text-field"><span>显示文字</span><textarea rows={3} value={selectedClip.text || selectedClip.name} onChange={(event) => updateGraphicText(selectedClip, event.target.value)} /></label><div className="mini-field-row"><span>显示时长</span><div className="mix-volume"><input aria-label="图文显示时长" type="range" min="1" max="12" step="0.25" value={selectedClip.duration} onChange={(event) => editClip({ duration: Number(event.target.value) }, '调整图文时长')} /><span>{selectedClip.duration.toFixed(1)}s</span></div></div><div className="mini-field-row"><span>垂直位置</span><select className="inline-select" value={selectedClip.titlePosition || 'bottom'} onChange={(event) => editClip({ titlePosition: event.target.value }, '调整标题位置')}><option value="top">画面上方</option><option value="center">画面中央</option><option value="bottom">字幕上方</option></select></div></div><div className="stream-warning"><Info size={13} /><span>图文导出必须重新编码视频，预览字体与最终成品可能因系统字体而略有差异。</span></div><button className="section-reset-button" onClick={() => removeSelected(false)}>移除图文 <Trash2 size={12} /></button></div>
  }

  function renderCaptionInspector() {
    const cue = project.subtitle.cues.find((item) => item.id === selectedClip.sourceCueId)
    return <div className="inspector-scroll"><div className="inspector-section"><div className="section-kicker">01 / CAPTION</div><h3 className="setting-title">字幕时间线片段</h3>{cue ? <div className="graphic-text-field"><span>字幕内容</span><textarea rows={3} value={cue.text} onChange={(event) => setSubtitleCue(cue.id, { text: event.target.value })} /></div> : <p className="empty-caption-state">此字幕片段来自导入的图文；可直接在时间轴中移动或裁切。</p>}<div className="mini-field-row"><span>时长</span><div className="setting-readonly">{selectedClip.duration.toFixed(2)} 秒 <Info size={11} /></div></div><label className="toggle-row"><span>全局字幕可见</span><button className={`switch ${project.subtitle.enabled ? 'switch-on' : ''}`} role="switch" aria-checked={project.subtitle.enabled} aria-label="显示字幕" onClick={() => updateProject((current) => ({ ...current, subtitle: { ...current.subtitle, enabled: !current.subtitle.enabled } }), '切换字幕显示')}><i /></button></label></div><div className="inspector-note"><Info size={12} /><span>渲染前可在检查器修改字幕，字幕导出与时间线位置保持一致。</span></div></div>
  }

  function renderAudioInspector() {
    const isMusic = selectedClip.isMusic || /music|背景/i.test(activeTrack?.label || '')
    return <div className="inspector-scroll"><div className="selected-audio-card"><div className="audio-note-icon"><AudioLines size={21} /></div><div><b>{selectedClip.name}</b><span>{selectedAsset?.codec?.toUpperCase() || selectedClip.codec?.toUpperCase() || 'AUDIO'} · {formatCompactTime(selectedClip.duration)}</span></div></div><div className="inspector-section"><div className="section-kicker">01 / GAIN</div><div className="section-heading-row"><div><span className="subsection-title">音量与混音</span></div><span className="volume-value">{Math.round((selectedClip.volume ?? 0.82) * 100)}%</span></div><div className="mix-volume big-volume"><Volume2 size={14} /><input aria-label="音频片段音量" type="range" min="0" max="1.5" step="0.01" value={selectedClip.volume ?? 0.82} onChange={(event) => setClipVolume(selectedClip.id, Number(event.target.value))} /><button aria-label="静音音轨" onClick={() => setClipVolume(selectedClip.id, 0)}><VolumeX size={13} /></button></div><div className="mini-field-row"><span>音乐自动避让人声</span><button className={`switch ${selectedClip.isMusic !== false ? 'switch-on' : ''}`} role="switch" aria-checked={selectedClip.isMusic !== false} aria-label="背景音乐人声避让" onClick={() => editClip({ autoDuck: selectedClip.autoDuck === false }, '切换背景音乐避让')}><i /></button></div><div className="mini-field-row"><span>结尾淡出</span><div className="mix-volume"><input aria-label="音乐淡出" type="range" min="0" max="10" step="0.25" value={selectedClip.fadeOut || 0} onChange={(event) => editClip({ fadeOut: Number(event.target.value) }, '调整音乐淡出')} /><span>{Number(selectedClip.fadeOut || 0).toFixed(1)}s</span></div></div><div className="mini-field-row"><span>处理策略</span><span className="read-only-tag"><CheckCircle2 size={12} /> {isMusic ? '人声智能避让' : '视频原声'}</span></div><div className="inspector-note"><Info size={12} /><span>混音时对音轨重新编码；原素材不会被覆盖。</span></div></div></div>
  }

  function renderDefaultInspector() {
    return <div className="inspector-scroll"><div className="inspector-empty-card"><span className="inspector-empty-orbit" /><div className="empty-icon"><Layers3 size={20} /></div><h3>挑一个片段<br /><i>开始调整。</i></h3><p>画面、声音与字幕的所有参数，都会在这里展开。</p><button onClick={() => setActivePanel('素材库')}>选取主视频 <ChevronRight size={13} /></button></div><div className="inspector-section shortcuts-section"><div className="section-kicker">QUICK ACCESS</div><button className="quick-action-button" onClick={() => openPicker({ addToTimeline: true })}><Plus size={13} />添加视频到时间线<kbd>⌘ I</kbd></button><button className="quick-action-button" onClick={addGraphicClip}><ImagePlus size={13} />添加标题图文<kbd>⌘ T</kbd></button><button className="quick-action-button" onClick={() => setActiveTab('subtitles')}><Subtitles size={13} />编辑字幕<kbd>I</kbd></button><button className="quick-action-button" onClick={() => void saveProject()}><Download size={13} />安全保存工程<kbd>⌘ S</kbd></button></div><div className="project-health-card"><div className="health-heading"><span><span className="health-dot" />工程健康</span><b>{project.assets.some((asset) => asset.missing) ? '有待修复' : '正常'}</b></div><div className="health-meter"><i style={{ width: `${project.assets.length ? Math.max(24, 100 - project.assets.filter((asset) => asset.missing).length * 17) : 24}%` }} /></div><div className="health-micro-copy"><span>{project.assets.length} 个已登记素材</span><span>{project.clips.length} 个时间线元素</span></div></div></div>
  }

  function renderFooter() {
    return <footer className="bottom-statusbar"><div className="status-left"><span><i />{historyNote}</span><span><LockKeyhole size={11} />本地保存 · 不上传</span><span><span className="foot-triangle">△</span>SDR</span></div><div className="status-center">{loading ? <><LoaderCircle size={12} className="loading-spin" />正在检查素材元数据…</> : <><span className="success-check"><Check size={10} /></span>工程已就绪 <span>·</span> {formatCompactTime(project.playhead)} / {formatCompactTime(duration)}</>}</div><div className="status-right"><span>原片不受影响</span><span className="system-signature">MADE LOCALLY <i>✳</i></span></div></footer>
  }

  function renderExportDialog() {
    if (!showExport) return null
    return <div className="dialog-scrim" onMouseDown={(event) => event.target === event.currentTarget && setShowExport(false)}><div className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="dialog-header"><div><span className="eyebrow">FINAL DELIVERY · DEVICE ONLY</span><h2 id="export-title">导出成片</h2></div><button className="icon-button compact" aria-label="关闭" onClick={() => setShowExport(false)}><X size={16} /></button></div><p className="dialog-intro">选择成片的画面质量、文件格式与字幕处理方式。每次重新编码都会提前说明，不会静默损失原片。</p><div className="export-profile-options">{[
      { id: 'stream-copy', icon: <FileVideo2 size={17} />, title: '原码流保留', description: '不重编码 · 条件限制较多', hint: '只适合兼容的单视频流拼接与切割' },
      { id: 'high', icon: <Clapperboard size={17} />, title: '日常高质量', description: 'H.264 · 推荐', hint: '字幕/叠加将重编码视频，音频混合会重编码音频' },
      { id: 'lossless', icon: <Disc3 size={17} />, title: '无损中间文件', description: 'FFV1 · 文件较大', hint: '无损保存合成结果，不保留原始压缩码流' },
    ].map((item) => <button key={item.id} className={exportPreset === item.id ? 'export-profile selected' : 'export-profile'} onClick={() => { setExportPreset(item.id); setExportValue('preset', item.id) }}><span className="export-choice-icon">{item.icon}</span><span className="export-choice-text"><strong>{item.title}</strong><small>{item.description}</small></span><span className="export-choice-radio">{exportPreset === item.id && <i />}</span><span className="export-choice-hint">{item.hint}</span></button>)}</div><div className="export-options-grid"><label><span>视频编码</span><select value={project.exportSettings.videoCodec || 'h264'} onChange={(event) => setExportValue('videoCodec', event.target.value)} disabled={exportPreset !== 'high'}><option value="h264">H.264 · 通用兼容</option><option value="hevc">HEVC · 文件更小</option></select></label><label><span>文件容器</span><select value={exportFormat} onChange={(event) => { setExportFormat(event.target.value); setExportValue('format', event.target.value) }}><option value="mp4">MP4 · 通用推荐</option><option value="mov">MOV · 后期中间</option><option value="mkv">MKV · 开放封装</option><option value="webm">WebM · 网络发布</option></select></label><label><span>目标画幅</span><select value={`${project.frameSize.width}x${project.frameSize.height}`} onChange={(event) => { const [width, height] = event.target.value.split('x').map(Number); applyEdit('设置导出画幅', (current) => ({ ...current, frameSize: { width, height }, profile: `${width}×${height} · ${current.frameRate.numerator} fps` })) }}><option value="1920x1080">1920 × 1080 · FHD</option><option value="3840x2160">3840 × 2160 · 4K</option><option value="1080x1920">1080 × 1920 · 竖屏</option><option value="1080x1080">1080 × 1080 · 方形</option></select></label><label><span>比特率</span><select value={project.exportSettings.videoBitrateMbps || 12} onChange={(event) => setExportValue('videoBitrateMbps', Number(event.target.value))} disabled={exportPreset !== 'high'}><option value="6">6 Mbps · 小文件</option><option value="12">12 Mbps · 平衡</option><option value="20">20 Mbps · 高质量</option><option value="35">35 Mbps · 4K 推荐</option></select></label></div>{warning && <div className="export-warning"><Info size={13} />{warning}</div>}{exportAssessment.issues.map((issue, index) => <div key={index} className={`export-assessment-note note-${issue.severity}`}><span>{issue.severity === 'error' ? <Info size={13} /> : issue.severity === 'warning' ? <Info size={13} /> : <CheckCircle2 size={13} />}</span><div><b>{issue.title}</b><small>{issue.detail}</small></div></div>)}<div className="export-space-check"><div className="space-check-mark"><Check size={12} /></div><div><b>{estimateBytes ? `预计文件约 ${formatFileSize(estimateBytes)}` : `原码流 · ${formatCompactTime(duration)}`}</b><span>{tools.find((tool) => tool.name === 'ffmpeg')?.path ? '检测到系统 FFmpeg · 输出前执行文件校验' : '桌面版导出需安装 FFmpeg · 恢复缓存已开启'}</span></div><span className="local-export-tag"><CloudOff size={11} /> LOCAL</span></div><div className="export-privacy"><LockKeyhole size={12} /><span>项目、视频与字幕全程在你的设备上处理。无云上传。</span></div><div className="dialog-actions"><button className="dialog-cancel" onClick={() => setShowExport(false)}>取消</button><button className="dialog-export" disabled={!exportAssessment.ready || Boolean(progress) || !tools.find((tool) => tool.name === 'ffmpeg')?.path} onClick={startExport}>{progress ? <LoaderCircle size={14} className="loading-spin" /> : <Download size={14} />}{!tools.find((tool) => tool.name === 'ffmpeg')?.path ? '请先安装 FFmpeg' : exportAssessment.ready ? '开始导出' : '修复导出问题'}<ChevronRight size={13} /></button></div></div></div>
  }

  function renderProgress() {
    if (!progress) return null
    const percent = Number(progress.percent) || 0
    return <div className="export-progress-card"><div className="progress-card-header"><div><LoaderCircle size={15} className="loading-spin" /><span>正在渲染 · 安全写入</span></div><span>{percent.toFixed(0)}%</span></div><div className="progress-bar"><i style={{ width: `${Math.max(4, percent)}%` }} /></div><div className="progress-card-footer"><span>{progress.size ? `正在写入 ${formatFileSize(progress.size)}` : progress.indeterminate ? '正在准备视频编码与混合音轨…' : '预览与成片使用同一时间线。'}</span><button onClick={cancelExport}>取消任务</button></div></div>
  }

  function renderRelinkDialog() {
    if (!relinkQueue.length) return null
    const asset = relinkQueue[0]
    return <div className="dialog-scrim"><div className="relink-dialog" role="dialog" aria-modal="true"><div className="dialog-header"><div><span className="eyebrow">SOURCE OFFLINE</span><h2>重新定位素材</h2></div><button className="icon-button compact" onClick={() => setRelinkQueue([])} aria-label="关闭"><X size={16} /></button></div><div className="relink-warning"><Info size={17} /><div><b>找不到「{asset.name}」</b><span>恢复此素材只会关联原文件，不会修改其内容。</span></div></div><div className="dialog-actions"><button className="dialog-cancel" onClick={() => setRelinkQueue([])}>暂时跳过</button><button className="dialog-export" onClick={() => void relinkAsset(asset)}>选择原始视频<FolderOpen size={13} /></button></div></div></div>
  }

  async function relinkAsset(asset) {
    if (!window.videome?.pickMedia) {
      setStatus('重新定位素材需要桌面应用文件选择器。', 'info')
      setRelinkQueue([])
      return
    }
    const paths = await window.videome.pickMedia()
    if (!paths.length) return
    const match = paths.find((candidate) => candidate.split(/[\\/]/).pop().toLowerCase() === asset.name.toLowerCase()) || paths[0]
    const resolved = await importPaths([match])
    if (resolved[0]) {
      const replacement = resolved[0]
      const currentProject = projectRef.current
      const mergedAssets = mergeAssetLibraries(currentProject.assets, assets, loadAssets())
      const nextProject = {
        ...currentProject,
        assets: replaceAssetById(mergedAssets, asset.id, { ...replacement, id: asset.id }),
        clips: currentProject.clips.map((clip) => clip.assetId === asset.id ? { ...clip, missing: false } : clip),
      }
      setProject(nextProject)
      setAssets(nextProject.assets)
      safeStorageWrite('videome-assets', nextProject.assets)
      setRelinkQueue((current) => current.slice(1))
      setStatus(`已将「${asset.name}」重新关联到本地文件。`)
    }
  }

  function renderSubtitleBusy() {
    if (!subtitleBusy) return null
    return <div className="overlay-busy"><div className="busy-orbit"><Waves size={19} /></div><div><b>检查本机语音模型</b><span>素材没有上传 · 未生成虚构转写</span></div></div>
  }

  const timelineShell = (
    <div className="editor-shell">
      {renderHeader()}
      {renderLeftRail()}
      {renderMediaLibrary()}
      <main className="editor-main">
        {renderEditorToolbar()}
        <div className={`workspace-grid ${inspectorCollapsed ? 'workspace-inspector-collapsed' : ''}`}>
          {renderVideoPanel()}
          {renderRightInspector()}
        </div>
        <div className="timeline-dock">
          {renderTracks()}
        </div>
      </main>
      {renderFooter()}
      {message && <div className={`toast toast-${messageKind}`} role="status"><span className="toast-mark">{messageKind === 'error' ? <Info size={14} /> : messageKind === 'info' ? <Sparkles size={14} /> : <CheckCircle2 size={14} />}</span><span>{message}</span><button aria-label="关闭通知" onClick={() => setMessage('')}><X size={14} /></button></div>}
      {renderExportDialog()}
      {renderProjectLocation()}
      {renderTimelineMenu()}
      {renderDeleteTrackDialog()}
      {showBatchMix && <BatchMixPanel assets={assets} frameSize={project.frameSize} currentProject={() => normalizeProjectForPersistence(projectRef.current)} onOpenProject={loadOpenedProject} onClose={() => setShowBatchMix(false)} />}
      {showDubbing && <DubbingPanel currentProject={() => projectRef.current} selectedClipId={selectedId} selectedClipIds={selectedClipIds} onApply={(job, options) => { void applyDubbingJob(job, options) }} onClose={() => setShowDubbing(false)} />}
      {renderRelinkDialog()}
      {renderProgress()}
      {renderSubtitleBusy()}
      <input ref={fileInputRef} className="hidden-file-input" type="file" accept="video/*,audio/*,image/*" multiple onChange={handleBrowserFiles} aria-label="选择媒体文件" />
    </div>
  )

  function toggleTrackForPlaceholder(trackId, key) {
    const track = project.tracks.find((item) => item.id === trackId)
    if (!track) return
    applyEdit('切换轨道状态', (current) => ({ ...current, tracks: current.tracks.map((item) => item.id === trackId ? { ...item, [key]: !item[key] } : item) }))
  }

  function addAssetToTimeline(asset) {
    const track = asset.kind === 'audio' ? project.tracks.find((item) => item.type === 'audio') || project.tracks[0] : project.tracks.find((item) => item.type === 'video') || project.tracks[0]
    const projectAsset = project.assets.find((item) => item.id === asset.id || (item.path && item.path === asset.path))
    const timelineAsset = projectAsset && (Number(projectAsset.duration) > Number(asset.duration) || Number(projectAsset.sourceDuration) > Number(asset.duration))
      ? { ...asset, ...projectAsset, duration: Math.max(Number(asset.duration) || 0, Number(projectAsset.duration) || 0, Number(projectAsset.sourceDuration) || 0) }
      : asset
    void (async () => {
      const refreshedAsset = await refreshTimelineAssetDuration(timelineAsset)
      const currentProject = projectRef.current
      const result = createMediaClips({ assets: [refreshedAsset], track, clips: [], playhead: currentProject.playhead, duration: currentProject.duration, tracks: currentProject.tracks })
      applyEdit('从素材库添加片段', (current) => {
        const repairedClips = repairPlaceholderDurationClips(current.clips, refreshedAsset.id, refreshedAsset.duration)
        return { ...current, clips: [...repairedClips, ...result.clips], tracks: result.tracks, assets: current.assets.some((item) => item.id === refreshedAsset.id) ? current.assets.map((item) => item.id === refreshedAsset.id ? refreshedAsset : item) : [...current.assets, refreshedAsset], duration: Math.max(current.duration, ...repairedClips.map((clip) => clip.start + clip.duration), result.duration) }
      })
      if (result.inserted[0]) {
        updateSelectedClipIds([])
        setSelectedId(result.inserted[0].id)
        setPlayhead(result.inserted[0].start, result.inserted[0].id)
      }
      setStatus(`已将「${asset.name}」添加到时间轴，片段时长 ${formatCompactTime(result.inserted[0]?.duration || 0)}。`)
    })()
  }

  async function addSelectedAssetsToTimeline() {
    const selectedAssets = selectedAssetIdsRef.current
      .map((id) => assets.find((item) => item.id === id) || projectRef.current.assets.find((item) => item.id === id))
      .filter(Boolean)
    if (!selectedAssets.length) {
      setStatus('请先选择要入轨的素材。', 'info')
      return
    }

    const currentProject = projectRef.current
    const track = selectedAssets[0].kind === 'audio'
      ? currentProject.tracks.find((item) => item.type === 'audio') || currentProject.tracks[0]
      : currentProject.tracks.find((item) => item.type === 'video') || currentProject.tracks[0]
    const timelineAssets = await refreshSelectedAssetDurations(selectedAssets)
    const repairedClips = timelineAssets.reduce(
      (clips, asset) => repairPlaceholderDurationClips(clips, asset.id, asset.duration),
      currentProject.clips,
    )
    const result = createMediaClips({
      assets: timelineAssets,
      track,
      clips: repairedClips,
      playhead: currentProject.playhead,
      duration: currentProject.duration,
      tracks: currentProject.tracks,
    })
    applyEdit('按选中顺序入轨', (current) => ({
      ...current,
      clips: result.clips,
      tracks: result.tracks,
      assets: mergeAssetLibraries(current.assets, timelineAssets),
      duration: Math.max(current.duration, result.duration),
    }))
    setAssets((current) => mergeAssetLibraries(current, timelineAssets))
    const firstInserted = result.inserted[0]
    const lastInserted = result.inserted.at(-1)
    if (firstInserted) {
      updateSelectedClipIds([])
      setSelectedId(lastInserted.id)
      setActiveTrackId(lastInserted.trackId)
      setPlayhead(lastInserted.start, lastInserted.id)
      setActivePanel('属性检查器')
      setStatus(`已按选中顺序从左到右加入 ${result.inserted.length} 个片段。`)
    }
  }

  async function refreshSelectedAssetDurations(selectedAssets) {
    const cachedAssets = selectedAssets.map((asset) => {
      const cachedDuration = Number(previewDurationRef.current.get(asset.id)) || 0
      return cachedDuration > 0
        ? { ...asset, duration: cachedDuration, sourceDuration: Math.max(Number(asset.sourceDuration) || 0, cachedDuration) }
        : asset
    })
    const candidates = cachedAssets.filter((asset) => {
      const duration = Number(asset.duration) || 0
      const sourceDuration = Number(asset.sourceDuration) || 0
      return asset.path
        && (asset.kind === 'video' || asset.kind === 'audio')
        && (!duration || (asset.kind === 'video' && duration <= 10.5 && sourceDuration <= 10.5))
    })
    if (!candidates.length || !window.videome?.probeMedia) return cachedAssets

    const results = await window.videome.probeMedia(candidates.map((asset) => asset.path), { metadataOnly: true }).catch(() => [])
    const byPath = new Map((results || []).filter((result) => result?.ok).map((result) => [result.path, result]))
    return cachedAssets.map((asset) => {
      const probe = byPath.get(asset.path)
      if (!probe) return asset
      const duration = resolveMediaDurationSeconds(probe) || Number(asset.duration) || Number(asset.sourceDuration) || 0
      if (!(duration > 0)) return asset
      previewDurationRef.current.set(asset.id, duration)
      return {
        ...asset,
        ...probe,
        id: asset.id,
        duration,
        sourceDuration: Math.max(duration, Number(asset.sourceDuration) || 0),
        previewUrl: asset.previewUrl || null,
        proxyUrl: asset.proxyUrl || null,
        thumbnail: asset.thumbnail || probe.thumbnail || null,
        poster: asset.poster || probe.poster || null,
        missing: false,
      }
    })
  }

  function snapshotClip(clip) {
    return { ...clip }
  }

  function updateAudioMute(clip) {
    setClipVolume(clip.id, (clip.volume || 0.82) > 0 ? 0 : 0.82)
  }

  function renderAlbumInfo(music) {
    return `${music.artist} · ${formatCompactTime(music.duration)} · ${music.bpm ? `${music.bpm} BPM` : '本地曲库'}`
  }

  function catchPreviewError() {
    if (playerRef.current?.error) setStatus('浏览器无法播放此编码；原始素材仍安全，可以继续导出。', 'info')
  }

  function adjustPreviewTime(timestamp) {
    const clip = project.clips.find((item) => item.id === selectedId)
    if (!clip) return timestamp
    return Math.max(0, timestamp - clip.start + (clip.trimStart || 0))
  }

  function trackOrder(track) {
    return `${track.type === 'audio' ? 'A' : track.type === 'subtitle' ? 'S' : 'V'}${String(track.order ?? 0).padStart(2, '0')}`
  }

  function updateCaptionPreview() {
    if (!playerRef.current || !selectedAsset) return
    setStatus('预览已按当前播放指针定位。', 'info')
  }

  function muteSourceTrack(track) {
    toggleTrackForPlaceholder(track.id, 'muted')
  }

  function checkMusicLicense(music) {
    return music.license ? 'AUTHORIZATION RECORDED' : 'LICENSE NOT CONFIRMED'
  }


  function renderNewProjectMenu() {
    if (!showProjectMenu) return null
    const action = (operation) => () => { setShowProjectMenu(false); void operation() }
    return <div className="new-project-menu" role="menu" aria-label="工程操作">
      <button role="menuitem" onClick={action(createEmptyProject)}><Plus size={14} />新建空白工程</button>
      <button role="menuitem" onClick={action(openProject)}><FolderOpen size={14} />打开工程…</button>
      <button role="menuitem" onClick={action(() => saveProject({ saveAs: true }))}><Copy size={14} />另存为…</button>
      <button role="menuitem" onClick={action(() => setShowProjectLocation(true))}><FolderOpen size={14} />工程位置…</button>
      {previousProject?.project && <button role="menuitem" onClick={action(restorePreviousProject)}><RotateCcw size={14} />恢复切换前的工程</button>}
      <div className="project-menu-divider" />
      <button role="menuitem" onClick={action(resetStory)}><Layers3 size={14} /><span>查看界面示例<small>不包含视频或音乐文件</small></span></button>
    </div>
  }

  function renderProjectLocation() {
    if (!showProjectLocation) return null
    const folderLabel = storageLocations?.platform === 'darwin' ? '在 Finder 中显示' : '在文件夹中显示'
    return <div className="dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowProjectLocation(false) }}><section className="project-location-dialog" role="dialog" aria-modal="true" aria-labelledby="project-location-title">
      <div className="dialog-header"><div><span className="eyebrow">PROJECT FILES</span><h2 id="project-location-title">工程位置与本地文件</h2></div><button autoFocus className="icon-button compact" aria-label="关闭工程位置" onClick={() => setShowProjectLocation(false)}><X size={16} /></button></div>
      <div className="project-file-section"><span className="section-kicker">当前工程</span><strong>{project.name}</strong><p className="project-file-path">{projectPath || '尚未保存为 .videome 工程文件'}</p>{projectPath ? <div className="project-file-actions"><button onClick={() => void revealProject()}><FolderOpen size={14} />{folderLabel}</button><button onClick={() => void navigator.clipboard.writeText(projectPath).then(() => setStatus('已复制工程路径。')).catch(() => setStatus('复制失败，请手动选择路径。', 'error'))}><Copy size={14} />复制路径</button><button onClick={() => void saveProject({ saveAs: true })}>另存为…</button></div> : <><p>当前修改保存在本机恢复缓存。保存工程后可自行管理和重新打开。</p><button className="project-primary-action" onClick={() => void saveProject()}><Download size={14} />选择位置并保存</button></>}</div>
      {projectPath && <div className="project-file-section"><span className="section-kicker">自动备份</span><p className="project-file-path">同目录 / {pathBasename(projectPath).replace(/\.autosave(?:-\d{8}-\d{6})?\.videome$/i, '').replace(/\.videome$/i, '')}.autosave-时间戳.videome</p><p>每 10 秒生成带时间戳的最新备份，并清理同工程旧备份；不修改原工程。可通过“项目 → 打开工程”打开备份。</p></div>}
      <div className="project-file-section"><span className="section-kicker">源素材</span><p>{project.assets.length} 个已登记素材。原文件保留在导入位置，工程保存剪辑信息与文件路径。</p><button className="project-text-action" onClick={() => { setShowProjectLocation(false); setActivePanel('素材库'); setActiveTab('edit') }}>查看素材库 <ChevronRight size={13} /></button></div>
      <div className="project-file-section"><span className="section-kicker">本机恢复缓存</span><p className="project-file-path">{storageLocations?.dataDirectory || '当前浏览器的本地存储'}</p><p>用于恢复编辑状态和批次记录，成片保存在生成时选择的输出目录。</p></div>
    </section></div>
  }

  function seekToClip(clip) {
    setPlayhead(clip.start)
    updateSelectedClipIds([clip.id])
    setSelectedId(clip.id)
  }

  function resetStory() {
    if (!loadOpenedProject(structuredClone(sampleProject), null)) return
    setStatus('已打开界面示例，不包含视频或音乐文件。可在项目菜单恢复切换前的工程。', 'info')
  }

  function showAbout() {
    setStatus(`Videome Preview · FFmpeg ${tools.find((tool) => tool.name === 'ffmpeg')?.version?.split(' ').slice(1, 2)[0] || 'not detected'} · ${tools.find((tool) => tool.name === 'melt')?.version || 'MLT not configured'} · local-first`, 'info')
  }

  const editingState = { project, selectedClip, selectedId, activeTrack, activeTab, editHistory, editFuture, projectPath }
  void editingState
  void addTrack
  void recordingMusic
  void loadClip
  void updateProjectName
  void stopMusicPreview
  void markGoodOutPoint
  void thumbnailForTime
  void handleOutPointStyle
  void trackOrder
  void renderAlbumInfo
  void catchPreviewError
  void adjustPreviewTime
  void updateCaptionPreview
  void muteSourceTrack
  void checkMusicLicense
  void renderNewProjectMenu
  void seekToClip
  void resetStory
  void showAbout
  void renderSubtitleBusy
  void renderTrack
  void renderTracks
  void renderTimelineControls
  void addAssetToTimeline
  void updateAudioMute
  void snapshotClip

  return <>{timelineShell}</>
}

function TrackIcon({ type }) {
  if (type === 'audio') return <AudioLines size={14} />
  if (type === 'subtitle') return <Subtitles size={13} />
  if (type === 'graphics') return <ImagePlus size={13} />
  if (type === 'video') return <FileVideo2 size={14} />
  return <Film size={14} />
}

function HardDiskIcon() {
  return <span className="hard-disk-icon"><span /><i /></span>
}

function createTicks(duration, width) {
  const interval = duration > 360 ? 60 : duration > 150 ? 30 : duration > 60 ? 10 : 5
  const ticks = []
  for (let seconds = 0; seconds <= duration; seconds += interval) ticks.push({ seconds, position: seconds / duration * width })
  return ticks
}

async function attachPreviewTransport(asset) {
  const staleBrowserUrl = typeof asset.previewUrl === 'string' && asset.previewUrl.includes('/__videome/media?')
  const staleElectronUrl = typeof asset.previewUrl === 'string' && asset.previewUrl.startsWith('videome-media://')
  if ((!staleBrowserUrl && !staleElectronUrl && (asset.previewUrl || asset.proxyUrl)) || !asset.path) return asset
  if (window.videome?.requestMedia) {
    const grant = await window.videome.requestMedia([asset.path]).catch(() => null)
    const source = grant?.ok ? grant.files.find((file) => file.path === asset.path)?.url : null
    return source ? { ...asset, previewUrl: source } : { ...asset, previewUrl: null }
  }

  if (!window.__videomeSession) {
    const response = await fetch('/__videome/api/health')
    if (!response.ok) throw new Error('本地媒体服务不可用。')
    const session = await response.json()
    window.__videomeSession = session.token
  }
  const response = await fetch('/__videome/api/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-videome-session': window.__videomeSession },
    body: JSON.stringify({ paths: [asset.path] }),
  })
  if (!response.ok) throw new Error((await response.json()).error || '本地素材访问失败。')
  const rows = await response.json()
  return { ...asset, previewUrl: rows.find((row) => row.path === asset.path)?.url || null }
}

/**
 * Reads duration from a browser File when ffprobe is unavailable. Browser File
 * objects do not expose a duration property; creating a short-lived media
 * element avoids falling back to the old ten-second placeholder.
 */
async function probeBrowserFileDuration(file) {
  if (!file || typeof URL === 'undefined' || typeof document === 'undefined') return 0
  const fileType = String(file.type || '')
  const extension = String(file.name || '').split('.').pop().toLowerCase()
  const isAudio = fileType.startsWith('audio/') || /^(mp3|wav|m4a|aac|flac|aiff|ogg)$/.test(extension)
  const isVideo = fileType.startsWith('video/') || /^(mp4|mov|m4v|mkv|webm|avi|mts|mxf)$/.test(extension)
  if (!isVideo && !isAudio) return 0
  const url = URL.createObjectURL(file)
  const element = document.createElement(isAudio ? 'audio' : 'video')
  element.preload = 'metadata'
  try {
    const duration = await new Promise((resolve) => {
      const timer = window.setTimeout(() => finish(0), 15000)
      const finish = (value) => {
        window.clearTimeout(timer)
        resolve(Number.isFinite(value) && value > 0 ? value : 0)
      }
      element.addEventListener('loadedmetadata', () => finish(element.duration), { once: true })
      element.addEventListener('error', () => finish(0), { once: true })
      element.src = url
    })
    return duration
  } finally {
    element.removeAttribute('src')
    element.load()
    URL.revokeObjectURL(url)
  }
}

async function previewProbeMedia(paths, files = []) {
  const byPath = new Map(files.map((file) => [file.path || file.name, file]))
  const health = await fetch('/__videome/api/health')
  if (!health.ok) return paths.map((filePath) => ({ path: filePath, ok: false, name: pathBasename(filePath), reason: '浏览器预览服务不可用。' }))
  const { token } = await health.json()
  window.__videomeSession = token
  const rows = await Promise.all(paths.map(async (filePath) => {
    try {
      const response = await fetch('/__videome/api/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-videome-session': token },
        body: JSON.stringify({ path: filePath }),
      })
      if (!response.ok) throw new Error((await response.json()).error || '素材探测失败。')
      return (await response.json())[0]
    } catch (error) {
      const file = byPath.get(filePath)
      if (file && file.type.startsWith('image/')) return { path: filePath, ok: true, name: file.name, size: file.size, duration: 0, kind: 'image' }
      return { path: filePath, ok: false, name: file?.name || pathBasename(filePath), reason: error.message }
    }
  }))
  return rows
}

async function exportThroughLocalPreview(settings, project, onProgress) {
  if (!window.__videomeSession) {
    const health = await fetch('/__videome/api/health')
    if (!health.ok) throw new Error('本地导出服务不可用。')
    window.__videomeSession = (await health.json()).token
  }
  const headers = { 'Content-Type': 'application/json', 'x-videome-session': window.__videomeSession }
  const started = await fetch('/__videome/api/export', { method: 'POST', headers, body: JSON.stringify({ settings, project }) })
  const payload = await started.json()
  if (!started.ok) return { ok: false, reason: payload.error || '导出任务启动失败。' }

  const { id } = payload.job
  window.__videomeActiveJob = id
  let state = null
  while (!state || state.state === 'running') {
    await new Promise((resolve) => window.setTimeout(resolve, 350))
    const response = await fetch(`/__videome/api/jobs/${id}`, { headers: { 'x-videome-session': window.__videomeSession } })
    state = await response.json()
    if (!response.ok) throw new Error(state.error || '无法读取导出任务。')
    onProgress({ percent: state.progress || 0, indeterminate: !state.progress, size: state.size || 0 })
  }
  window.__videomeActiveJob = null
  if (state.state !== 'complete') return { ok: false, reason: state.error || '导出任务未完成。' }

  const response = await fetch(`/__videome/api/jobs/${id}/download`, { headers: { 'x-videome-session': window.__videomeSession } })
  if (!response.ok) throw new Error((await response.json()).error || '导出文件下载失败。')
  const blob = await response.blob()
  const anchor = document.createElement('a')
  const url = URL.createObjectURL(blob)
  anchor.href = url
  anchor.download = state.fileName || `videome.${settings.format}`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 3000)
  return { ok: true, path: anchor.download }
}

async function cancelLocalPreviewExport() {
  const id = window.__videomeActiveJob
  if (!id || !window.__videomeSession) return false
  const response = await fetch(`/__videome/api/jobs/${id}/cancel`, { headers: { 'x-videome-session': window.__videomeSession } })
  window.__videomeActiveJob = null
  return response.ok
}

function pathBasename(value) {
  return String(value || '').split(/[\\/]/).pop() || '本地素材'
}

function pathDirname(value) {
  const normalized = String(value || '').replace(/\\/g, '/')
  const separator = normalized.lastIndexOf('/')
  return separator > 0 ? normalized.slice(0, separator) : null
}

function normalizeProjectName(value) {
  const name = String(value ?? '').trim()
  return name || '未命名项目'
}

function projectPathMatchesName(value, name) {
  const fileName = pathBasename(value).replace(/\.videome$/i, '')
  const expectedFileName = projectFileName(normalizeProjectName(name))
  return Boolean(fileName) && fileName.normalize('NFC') === expectedFileName.normalize('NFC')
}

function resolveMediaUrl(asset) {
  return asset.previewUrl || fileUrl(asset.path)
}

function previewBackground(kind) {
  const backgrounds = {
    ocean: 'linear-gradient(180deg,#94bbc3 0%,#d2d1c5 23%,#5b8191 50%,#c6c4b3 51%,#467889 100%)',
    palms: 'linear-gradient(90deg,#455747 0%,#85917a 23%,#dad3bc 26%,#b1a48c 78%,#334c46 80%,#637d6b 100%)',
    shore: 'linear-gradient(180deg,#a8cad1 0%,#a8cad1 46%,#e4dac4 47%,#b19b78 63%,#4f8090 65%,#406b78 100%)',
    sunset: 'linear-gradient(180deg,#ecc6a5 0%,#e0a88b 35%,#9d8290 55%,#375560 57%,#223d46 100%)',
    boardwalk: 'linear-gradient(135deg,#b8c8be 0%,#74887a 34%,#d9d4c1 35%,#cbbd9e 55%,#455956 56%,#899b91 100%)',
    seafoam: 'linear-gradient(180deg,#b8c3be 0%,#ece4d6 29%,#e2bc8e 30%,#f0d9ad 50%,#8db3b1 51%,#446a70 100%)',
    orange: 'linear-gradient(115deg,#d4bda2,#647c73 45%,#b8b09b)',
    green: 'linear-gradient(135deg,#d3c2a0,#6a816f 54%,#bcc6b3)',
  }
  return backgrounds[kind] || backgrounds.ocean
}

function thumbAccent(seed, index = 0) {
  const options = ['ocean', 'palms', 'shore', 'sunset']
  return options[(Math.abs(String(seed).length + index * 3) + 1) % options.length]
}

function kindLabel(kind) {
  return kind === 'audio' ? '音频' : kind === 'image' ? '图像' : '视频'
}

function moodLabel(mood) {
  return ({ sunny: '晴朗 · 明亮', calm: '舒缓 · 留白', dreamy: '朦胧 · 电影感', energetic: '活力 · 轻快', versatile: '通用 · 待标注' })[mood] || '通用'
}

function parseClock(value, fallback) {
  const pieces = String(value).split(':').map(Number)
  if (pieces.some((part) => !Number.isFinite(part))) return fallback
  if (pieces.length === 2) return Math.max(0, pieces[0] * 60 + pieces[1])
  if (pieces.length === 3) return Math.max(0, pieces[0] * 3600 + pieces[1] * 60 + pieces[2])
  const num = Number(value)
  return Number.isFinite(num) ? Math.max(0, num) : fallback
}

function loadProject() {
  return hydrateProject(readProjectSession(localStorage).project)
}

function loadAssets() {
  try {
    const saved = localStorage.getItem('videome-assets')
    return saved ? hydrateProject({ assets: JSON.parse(saved) }).assets : []
  } catch {
    return []
  }
}

function safeStorageWrite(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function hydrateProject(project) {
  const source = project && typeof project === 'object' ? project : {}
  const assets = Array.isArray(source.assets) ? source.assets.map((asset) => {
    if (!isLegacySilentPreviewProxy(asset.previewUrl) && !isLegacySilentPreviewProxy(asset.proxyUrl)) return asset
    return { ...asset, previewUrl: null, proxyUrl: null }
  }) : []
  const hydrated = {
    ...defaultProject,
    ...source,
    schemaVersion: 1,
    projectId: source.projectId || globalThis.crypto.randomUUID(),
    frameSize: source.frameSize || defaultProject.frameSize,
    frameRate: source.frameRate || defaultProject.frameRate,
    exportSettings: { ...defaultProject.exportSettings, ...(source.exportSettings || {}) },
    subtitle: { ...defaultProject.subtitle, ...(source.subtitle || {}), cues: Array.isArray(source.subtitle?.cues) ? source.subtitle.cues : defaultProject.subtitle.cues },
    tracks: Array.isArray(source.tracks) ? source.tracks : defaultProject.tracks.map((track) => ({ ...track })),
    clips: repairSplitAudioDuplicates(Array.isArray(source.clips) ? source.clips : []),
    assets,
  }
  return repairDubbingPlaybackState(hydrated)
}

function normalizeProjectForPersistence(project) {
  const hydrated = hydrateProject(project)
  return {
    ...hydrated,
    name: normalizeProjectName(hydrated.name),
    assets: (hydrated.assets || []).filter(Boolean).map((asset, index) => ({
      ...asset,
      id: asset.id || `asset-${index}`,
      name: asset.name || `未命名素材 ${index + 1}`,
    })),
    tracks: (hydrated.tracks || []).filter(Boolean).map((track, index) => ({
      ...track,
      id: track.id || `track-${index}`,
      label: track.label || `轨道 ${index + 1}`,
    })),
    clips: (hydrated.clips || []).filter(Boolean).map((clip, index) => ({
      ...clip,
      id: clip.id || `clip-${index}`,
      name: clip.name || `片段 ${index + 1}`,
      start: Number(clip.start) || 0,
      duration: Math.max(0, Number(clip.duration) || 0),
    })),
  }
}

function mergeProjectAssetLibrary(project, persistedAssets = []) {
  const source = hydrateProject(project)
  return { ...source, assets: mergeAssetLibraries(source.assets, persistedAssets) }
}

function timeAgo(value) {
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (elapsed < 3) return '刚刚'
  if (elapsed < 60) return `${elapsed} 秒前`
  const minutes = Math.floor(elapsed / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  return formatCompactTime(elapsed)
}


createRoot(document.getElementById('root')).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>)
