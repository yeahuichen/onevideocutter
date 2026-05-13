import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Banana, FolderOpen, Scissors, Play, Pause,
  SkipBack, SkipForward, Volume2, VolumeX,
  Download, Trash2, Plus, Music, X
} from 'lucide-react'

/* ── Static Wails imports (safe — Wails stubs these in browser) ── */
import * as GoApp from '../wailsjs/go/main/App'
import { EventsOn } from '../wailsjs/runtime/runtime'

/* ── Detect Wails environment ────────────────────────────── */
// window.go is injected by Wails; window.__wails is set later.
// We check at call-time to be safe.
const isWails = () => typeof window !== 'undefined' && !!window.go

/* ── Mocks for plain browser dev ─────────────────────────── */
const MOCKS = {
  OpenVideoFile:  () => Promise.resolve(''),
  OpenAudioFile:  () => Promise.resolve(''),
  SaveVideoFile:  () => Promise.resolve(''),
  GetVideoInfo:   () => Promise.resolve({ duration: 120, width: 1920, height: 1080, fps: '29.97', bitrate: 5000000, vcodec: 'h264', acodec: 'aac', hasAudio: true, size: 52428800 }),
  CheckFFmpeg:    () => Promise.resolve(true),
  ProcessVideo:   () => Promise.resolve(null),
}

async function goCall(name, ...args) {
  try {
    if (!isWails()) return MOCKS[name]?.(...args) ?? null
    return await GoApp[name](...args)
  } catch (e) {
    console.error(`[goCall] ${name} failed:`, e)
    // Fall back to mock so UI doesn't crash
    return MOCKS[name]?.(...args) ?? null
  }
}

function onEvent(event, cb) {
  try {
    if (!isWails()) return () => {}
    return EventsOn(event, cb)
  } catch {
    return () => {}
  }
}

/* ── Helpers ────────────────────────────────────────────── */
const fmtTime = (s) => {
  if (!s || isNaN(s)) return '00:00.000'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toFixed(3).padStart(6, '0')
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${sec}` : `${String(m).padStart(2,'0')}:${sec}`
}
const fmtSize = (b) => {
  if (!b) return '—'
  const u = ['B','KB','MB','GB']; let i = 0, n = b
  while (n >= 1024 && i < 3) { n /= 1024; i++ }
  return `${n.toFixed(1)} ${u[i]}`
}
const basename = (p) => p ? p.replace(/\\/g,'/').split('/').pop() : '—'
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/* ── Toast hook ─────────────────────────────────────────── */
function useToast() {
  const [toasts, setToasts] = useState([])
  const add = useCallback((msg, type = 'ok') => {
    const id = Date.now()
    setToasts(t => [...t, { id, msg, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000)
  }, [])
  return { toasts, add }
}

/* ── Main Component ─────────────────────────────────────── */
export default function App() {
  const { toasts, add: toast } = useToast()
  const videoRef = useRef(null)
  const timelineRef = useRef(null)
  const scrubberRef = useRef(null)
  const draggingIdx = useRef(null)   // index of clip point being dragged
  const isScrubbing = useRef(false)  // whether user is dragging to seek
  const wasPlayingBeforeScrub = useRef(false)

  /* video state */
  const [videoPath, setVideoPath] = useState(null)
  const [videoInfo, setVideoInfo] = useState(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)

  /* editor state:
     clipPoints — sorted list of timestamps dividing video into segments.
     First element is always 0, last is always duration.
     deletedSegs — Set of segment indices (between clipPoints[i] and clipPoints[i+1]) marked for deletion. */
  const [clipPoints, setClipPoints] = useState([])   // [0, ..., duration]
  const [deletedSegs, setDeletedSegs] = useState(new Set())
  const [selectedSegIdx, setSelectedSegIdx] = useState(null)

  /* audio state */
  const [audioMode, setAudioMode] = useState('original')  // original | muted | replaced
  const [audioFile, setAudioFile] = useState(null)

  /* export settings */
  const [exportFormat, setExportFormat] = useState('mp4')
  const [videoCodec, setVideoCodec] = useState('libx264')
  const [videoBitrate, setVideoBitrate] = useState('5000k')
  const [audioBitrate, setAudioBitrate] = useState('128k')

  /* processing */
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState({ percent: 0, message: '' })
  const [ffmpegOk, setFfmpegOk] = useState(null)
  const [ffmpegInstalling, setFfmpegInstalling] = useState(false)
  const [installProgress, setInstallProgress] = useState({ percent: 0, message: '' })

  /* ── Init ─────────────────────────────────────────────── */
  useEffect(() => {
    goCall('CheckFFmpeg').then(ok => setFfmpegOk(ok))
    const unsubProgress = onEvent('export:progress', (data) => setProgress(data))
    const unsubInstall = onEvent('ffmpeg:install_progress', (data) => setInstallProgress(data))
    return () => { 
      if (typeof unsubProgress === 'function') unsubProgress() 
      if (typeof unsubInstall === 'function') unsubInstall()
    }
  }, [])

  /* ── Load video ───────────────────────────────────────── */
  const loadVideo = useCallback(async (path) => {
    if (!path) return
    setVideoPath(path)
    setDeletedSegs(new Set())
    setSelectedSegIdx(null)
    setIsPlaying(false)
    setCurrentTime(0)
    try {
      const info = await goCall('GetVideoInfo', path)
      setVideoInfo(info)
      setClipPoints([0, info.duration])
      setDuration(info.duration)
    } catch (e) {
      toast(`读取视频失败: ${e}`, 'err')
    }
  }, [toast])

  const handleOpenVideo = async () => {
    const path = await goCall('OpenVideoFile')
    loadVideo(path)
  }

  /* ── Playback ─────────────────────────────────────────── */
  const togglePlay = () => {
    const vid = videoRef.current
    if (!vid) return
    isPlaying ? vid.pause() : vid.play()
    setIsPlaying(!isPlaying)
  }
  const seekBy = (s) => {
    const vid = videoRef.current
    if (vid) vid.currentTime = clamp(vid.currentTime + s, 0, duration)
  }

  /* ── Clip point management ────────────────────────────── */
  const addClipPointAt = (t) => {
    t = clamp(parseFloat(t.toFixed(3)), 0.001, duration - 0.001)
    setClipPoints(pts => {
      if (pts.some(p => Math.abs(p - t) < 0.1)) return pts
      return [...pts, t].sort((a, b) => a - b)
    })
  }

  const addClipPointAtPlayhead = () => {
    if (!duration) return
    addClipPointAt(currentTime)
  }

  const removeClipPoint = (idx) => {
    // cannot remove head (0) or tail (duration)
    if (idx === 0 || idx === clipPoints.length - 1) return
    setClipPoints(pts => pts.filter((_, i) => i !== idx))
    // re-index deletedSegs
    setDeletedSegs(del => {
      const next = new Set()
      del.forEach(si => {
        if (si < idx) next.add(si)
        else if (si > idx) next.add(si - 1)
        // si === idx: the segment is removed, don't add
      })
      return next
    })
    setSelectedSegIdx(null)
  }

  const toggleSegmentDelete = (segIdx) => {
    setDeletedSegs(del => {
      const next = new Set(del)
      next.has(segIdx) ? next.delete(segIdx) : next.add(segIdx)
      return next
    })
  }

  const deleteSegment = (segIdx) => {
    if (clipPoints.length <= 2) {
      toast('整个视频仅剩一个区间，无法再删除', 'warn')
      return
    }
    if (segIdx === 0) {
      // Head segment: directly delete by slicing clipPoints[0]
      setClipPoints(pts => pts.slice(1))
      setDeletedSegs(del => {
        const next = new Set()
        del.forEach(si => { if (si > 0) next.add(si - 1) })
        return next
      })
      setSelectedSegIdx(null)
      toast('已直接删除头部区间', 'ok')
    } else if (segIdx === clipPoints.length - 2) {
      // Tail segment: directly delete by removing last clip point
      setClipPoints(pts => pts.slice(0, -1))
      setDeletedSegs(del => {
        const next = new Set(del)
        next.delete(segIdx)
        return next
      })
      setSelectedSegIdx(null)
      toast('已直接删除尾部区间', 'ok')
    } else {
      // Middle segment: mark as deleted (merge surrounding contents)
      setDeletedSegs(del => {
        const next = new Set(del)
        next.add(segIdx)
        return next
      })
      toast('已删除中间区间（导出时自动合并两侧）', 'ok')
    }
  }

  /* ── Timeline drag ────────────────────────────────────── */
  const pctToTime = useCallback((clientX) => {
    const rect = timelineRef.current?.getBoundingClientRect()
    if (!rect || !duration) return 0
    return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration)
  }, [duration])

  const handleTimelineMouseDown = (e, pointIdx) => {
    e.preventDefault()
    e.stopPropagation()
    // All clip points are draggable, including head (0) and tail (last)
    if (pointIdx !== null && pointIdx !== undefined) {
      draggingIdx.current = pointIdx
    }
  }

  useEffect(() => {
    const onMove = (e) => {
      if (isScrubbing.current) {
        handleScrubberAction(e)
        return
      }
      const idx = draggingIdx.current
      if (idx === null || idx === undefined) return
      const t = pctToTime(e.clientX)
      setClipPoints(pts => {
        const next = [...pts]
        // Clamp: head can go 0→next-0.1, tail prev+0.1→duration, middle between neighbors
        const lo = idx === 0 ? 0 : next[idx - 1] + 0.1
        const hi = idx === next.length - 1 ? duration : next[idx + 1] - 0.1
        next[idx] = clamp(t, lo, hi)
        return next
      })
    }
    const onUp = () => { 
      if (isScrubbing.current && wasPlayingBeforeScrub.current) {
        videoRef.current?.play()
      }
      draggingIdx.current = null
      isScrubbing.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [pctToTime, duration])

  const handleScrubberMouseDown = (e) => {
    e.preventDefault()
    const vid = videoRef.current
    if (vid) {
      wasPlayingBeforeScrub.current = !vid.paused
      vid.pause()
    }
    isScrubbing.current = true
    handleScrubberAction(e)
  }

  const handleScrubberAction = (e) => {
    const rect = scrubberRef.current?.getBoundingClientRect()
    if (!rect || !duration) return
    const t = clamp(((e.clientX - rect.left) / rect.width) * duration, 0, duration)
    const vid = videoRef.current
    if (vid) {
      vid.currentTime = t
      setCurrentTime(t)
    }
  }

  const handleTrackMouseDown = (e) => {
    // Timeline no longer handles scrubbing
  }

  const handleTrackClick = (e) => {
    // Timeline no longer handles seeking
  }

  /* ── Audio ────────────────────────────────────────────── */
  const handlePickAudio = async () => {
    const path = await goCall('OpenAudioFile')
    if (path) { setAudioFile(path); setAudioMode('replaced') }
  }

  /* ── Export ───────────────────────────────────────────── */
  /* ── Export Single Segment ────────────────────────────── */
  const exportSingleSegment = async (seg) => {
    if (!videoPath) return
    if (!ffmpegOk) return toast('未检测到 FFmpeg，请安装后重试', 'err')
    if (audioMode === 'replaced' && !audioFile) return toast('请选择替换音频文件', 'warn')

    const suffix = `_segment_${fmtTime(seg.start).replace(/[:.]/g,'')}.${exportFormat}`
    const defaultName = basename(videoPath).replace(/\.[^.]+$/, '') + suffix
    const outputPath = await goCall('SaveVideoFile', defaultName, exportFormat)
    if (!outputPath) return

    // To export ONLY this segment, trim out everything before seg.start and after seg.end
    const deletedRanges = []
    if (seg.start > 0.001) {
      deletedRanges.push({ start: 0, end: seg.start })
    }
    if (seg.end < duration - 0.001) {
      deletedRanges.push({ start: seg.end, end: duration })
    }

    const task = {
      inputPath: videoPath,
      outputPath,
      deletedRanges,
      audioMode,
      replacementAudio: audioFile || '',
      videoCodec,
      videoBitrate,
      videoCRF: 0,
      audioBitrate,
      format: exportFormat,
    }

    setExporting(true)
    setProgress({ percent: 0, message: '准备导出指定区间...' })
    try {
      await goCall('ProcessVideo', task)
      toast(`区间导出完成 → ${basename(outputPath)}`, 'ok')
    } catch (e) {
      toast(`导出失败: ${e}`, 'err')
    } finally {
      setExporting(false)
    }
  }

  const handleInstallFFmpeg = async () => {
    setFfmpegInstalling(true)
    setInstallProgress({ percent: 0, message: '初始化安装...' })
    try {
      await goCall('InstallFFmpeg')
      toast('FFmpeg 安装成功！', 'ok')
      const ok = await goCall('CheckFFmpeg')
      setFfmpegOk(ok)
    } catch (e) {
      toast(`安装失败: ${e}`, 'err')
    } finally {
      setFfmpegInstalling(false)
    }
  }

  /* ── Export ───────────────────────────────────────────── */
  const handleExport = async () => {
    if (!videoPath) return toast('请先打开视频文件', 'warn')
    if (!ffmpegOk) return toast('未检测到 FFmpeg，请安装后重试', 'err')
    if (audioMode === 'replaced' && !audioFile) return toast('请选择替换音频文件', 'warn')

    const suffix = `_edited.${exportFormat}`
    const defaultName = basename(videoPath).replace(/\.[^.]+$/, '') + suffix
    const outputPath = await goCall('SaveVideoFile', defaultName, exportFormat)
    if (!outputPath) return

    // Build deleted time ranges including trimmed head/tail and explicitly deleted segments
    const deletedRanges = []
    if (clipPoints[0] > 0.001) {
      deletedRanges.push({ start: 0, end: clipPoints[0] })
    }
    deletedSegs.forEach(si => {
      if (si < clipPoints.length - 1) {
        deletedRanges.push({ start: clipPoints[si], end: clipPoints[si + 1] })
      }
    })
    const lastPt = clipPoints[clipPoints.length - 1]
    if (lastPt < duration - 0.001) {
      deletedRanges.push({ start: lastPt, end: duration })
    }

    const task = {
      inputPath: videoPath,
      outputPath,
      deletedRanges,
      audioMode,
      replacementAudio: audioFile || '',
      videoCodec,
      videoBitrate,
      videoCRF: 0,
      audioBitrate,
      format: exportFormat,
    }

    setExporting(true)
    setProgress({ percent: 0, message: '准备中...' })
    try {
      await goCall('ProcessVideo', task)
      toast(`导出完成 → ${basename(outputPath)}`, 'ok')
    } catch (e) {
      toast(`导出失败: ${e}`, 'err')
    } finally {
      setExporting(false)
    }
  }

  /* ── Derived UI values ────────────────────────────────── */
  const pct = (t) => duration ? `${(t / duration * 100).toFixed(4)}%` : '0%'
  const playPct = duration ? currentTime / duration * 100 : 0

  const segments = clipPoints.length > 1
    ? clipPoints.slice(0, -1).map((t, i) => ({ i, start: t, end: clipPoints[i + 1] }))
    : []

  const totalDeleted = [...deletedSegs].reduce((acc, si) => {
    if (si < clipPoints.length - 1) acc += clipPoints[si + 1] - clipPoints[si]
    return acc
  }, 0)

  /* ── Render ───────────────────────────────────────────── */
  return (
    <div className="shell">

      {/* Header */}
      <header className="header">
        <div className="header-logo">
          <span className="logo-pip" />
          <Banana size={15} color="#fbbf24" />
          <span>One Video Cutter</span>
        </div>
        <div className="header-sep" />
        <div className="header-actions">
          <button id="btn-open" className="btn btn-ghost" onClick={handleOpenVideo}>
            <FolderOpen size={13} /> 打开视频
          </button>
          <button
            id="btn-export"
            className="btn btn-primary"
            onClick={handleExport}
            disabled={!videoPath || exporting}
          >
            <Download size={13} />
            {exporting ? '导出中…' : '导出'}
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="body">

        {/* ── Left Panel: Video Info + Clip Summary ── */}
        <aside className="panel-l">
          <div className="section">
            <div className="sec-title">视频信息</div>
            {videoInfo ? <>
              <div className="prop"><span className="prop-k">文件名</span><span className="prop-v" style={{maxWidth:130,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={basename(videoPath)}>{basename(videoPath)}</span></div>
              <div className="prop"><span className="prop-k">分辨率</span><span className="prop-v">{videoInfo.width}×{videoInfo.height}</span></div>
              <div className="prop"><span className="prop-k">时长</span><span className="prop-v mono">{fmtTime(videoInfo.duration)}</span></div>
              <div className="prop"><span className="prop-k">帧率</span><span className="prop-v">{videoInfo.fps} fps</span></div>
              <div className="prop"><span className="prop-k">视频编码</span><span className="prop-v">{videoInfo.vcodec || '—'}</span></div>
              <div className="prop"><span className="prop-k">音频编码</span><span className="prop-v">{videoInfo.hasAudio ? videoInfo.acodec : '无音轨'}</span></div>
              <div className="prop"><span className="prop-k">文件大小</span><span className="prop-v">{fmtSize(videoInfo.size)}</span></div>
            </> : <p className="text-muted">打开视频后显示信息</p>}
          </div>

          <div className="section">
            <div className="sec-title">剪辑摘要</div>
            {duration > 0 ? <>
              <div className="prop"><span className="prop-k">剪辑点</span><span className="prop-v">{clipPoints.length} 个</span></div>
              <div className="prop"><span className="prop-k">片段数</span><span className="prop-v">{segments.length} 段</span></div>
              <div className="prop"><span className="prop-k">标记删除</span><span className="prop-v text-red">{deletedSegs.size} 段 / {fmtTime(totalDeleted)}</span></div>
              <div className="prop"><span className="prop-k">保留时长</span><span className="prop-v text-green mono">{fmtTime(Math.max(0, duration - totalDeleted))}</span></div>
            </> : <p className="text-muted">加载视频后查看</p>}
          </div>

          <div className="section" style={{flex:1}} />
        </aside>

        {/* ── Center: Preview + Controls ── */}
        <main className="panel-c">
          <div className="preview-wrap">
            {videoPath ? (
              <video
                ref={videoRef}
                key={videoPath}
                src={videoPath ? `/video/${videoPath}` : ''}
                className="preview-video"
                muted={muted}
                onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime || 0)}
                onLoadedMetadata={() => {
                  const d = videoRef.current?.duration || 0
                  setDuration(d)
                  setClipPoints(prev => prev.length === 2 ? [0, d] : prev)
                }}
                onEnded={() => setIsPlaying(false)}
                onClick={togglePlay}
              />
            ) : (
              <div className="preview-empty">
                <div className="empty-icon"><Banana size={34} color="#fbbf24" /></div>
                <div style={{fontSize:14}}>尚未选择视频</div>
                <button className="btn btn-primary" onClick={handleOpenVideo} id="btn-open-empty">
                  <FolderOpen size={13} /> 选择视频文件
                </button>
              </div>
            )}
          </div>

          {/* Playback controls */}
          <div className="controls">
            <button className="btn btn-ghost btn-icon" onClick={() => seekBy(-5)} title="-5s"><SkipBack size={13} /></button>
            <button id="btn-play" className="play-btn" onClick={togglePlay}>
              {isPlaying ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button className="btn btn-ghost btn-icon" onClick={() => seekBy(5)} title="+5s"><SkipForward size={13} /></button>

            <span className="timecode mono">{fmtTime(currentTime)} / {fmtTime(duration)}</span>

            <div 
              className="scrubber-wrap" 
              ref={scrubberRef}
              onMouseDown={handleScrubberMouseDown}
            >
              <div className="scrubber-track">
                <div className="scrubber-fill" style={{ width: `${playPct}%` }} />
                <div className="scrubber-thumb" style={{ left: `${playPct}%` }} />
              </div>
            </div>

            <button
              id="btn-add-clip"
              className="btn btn-ghost btn-sm"
              onClick={addClipPointAtPlayhead}
              disabled={!videoPath}
              title="在当前时间添加剪辑点"
            >
              <Plus size={12} /> 剪辑点
            </button>

            <button className="btn btn-ghost btn-icon" onClick={() => setMuted(m => !m)}>
              {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
          </div>
        </main>

        {/* ── Right Panel: Audio + Export ── */}
        <aside className="panel-r">

          {/* Audio */}
          <div className="section">
            <div className="sec-title">音轨处理</div>
            <div className="radio-group">
              <label className="radio-opt">
                <input type="radio" name="audio" value="original" checked={audioMode==='original'} onChange={() => setAudioMode('original')} />
                <span>保留原始音轨</span>
              </label>
              <label className="radio-opt">
                <input type="radio" name="audio" value="muted" checked={audioMode==='muted'} onChange={() => setAudioMode('muted')} />
                <span>删除音轨（静音）</span>
              </label>
              <label className="radio-opt">
                <input type="radio" name="audio" value="replaced" checked={audioMode==='replaced'} onChange={() => setAudioMode('replaced')} />
                <span>替换音轨</span>
              </label>
            </div>
            {audioMode === 'replaced' && (
              <div className="mt-2">
                <button id="btn-pick-audio" className="btn btn-ghost btn-sm full-w" onClick={handlePickAudio}>
                  <Music size={12} /> 选择音频文件
                </button>
                {audioFile && (
                  <div className="audio-badge">
                    <span className="audio-badge-name" title={audioFile}>{basename(audioFile)}</span>
                    <button className="btn btn-icon btn-ghost" style={{width:20,height:20,padding:2}} onClick={() => setAudioFile(null)}>
                      <X size={11} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Export settings */}
          <div className="section">
            <div className="sec-title">导出设置</div>
            <div className="prop mt-2"><span className="prop-k">格式</span></div>
            <select id="sel-format" className="select" value={exportFormat} onChange={e => setExportFormat(e.target.value)}>
              <option value="mp4">MP4 (.mp4)</option>
              <option value="mov">MOV (.mov)</option>
              <option value="mkv">MKV (.mkv)</option>
              <option value="avi">AVI (.avi)</option>
              <option value="webm">WebM (.webm)</option>
            </select>

            <div className="prop mt-3"><span className="prop-k">视频编码</span></div>
            <select id="sel-vcodec" className="select" value={videoCodec} onChange={e => setVideoCodec(e.target.value)}>
              <option value="libx264">H.264 (libx264)</option>
              <option value="libx265">H.265 / HEVC (libx265)</option>
              <option value="libvpx-vp9">VP9 (WebM)</option>
              <option value="copy">Stream Copy（不重编码）</option>
            </select>

            <div className="prop mt-3"><span className="prop-k">视频码率</span></div>
            <select id="sel-vbitrate" className="select" value={videoBitrate} onChange={e => setVideoBitrate(e.target.value)}>
              <option value="2000k">2 Mbps（偏低）</option>
              <option value="4000k">4 Mbps</option>
              <option value="5000k">5 Mbps（推荐）</option>
              <option value="8000k">8 Mbps（高质量）</option>
              <option value="15000k">15 Mbps（超高质量）</option>
              <option value="25000k">25 Mbps（近无损）</option>
            </select>

            <div className="prop mt-3"><span className="prop-k">音频码率</span></div>
            <select id="sel-abitrate" className="select" value={audioBitrate} onChange={e => setAudioBitrate(e.target.value)}>
              <option value="96k">96 kbps</option>
              <option value="128k">128 kbps（推荐）</option>
              <option value="192k">192 kbps</option>
              <option value="320k">320 kbps（高质量）</option>
            </select>

            <button
              id="btn-export-main"
              className="btn btn-primary full-w mt-3"
              style={{ justifyContent: 'center' }}
              onClick={handleExport}
              disabled={!videoPath || exporting}
            >
              <Download size={13} />
              {exporting ? '导出中…' : '开始导出'}
            </button>

            {/* FFmpeg status */}
            <div className="prop mt-3">
              <span className="prop-k">FFmpeg</span>
              <span style={{ fontSize: 11, color: ffmpegOk === null ? 'var(--text-3)' : ffmpegOk ? 'var(--green)' : 'var(--red)' }}>
                {ffmpegOk === null ? '检测中…' : ffmpegOk ? '✓ 已就绪' : '✗ 未安装'}
              </span>
            </div>
            {!ffmpegOk && ffmpegOk !== null && !ffmpegInstalling && (
              <button 
                className="btn btn-success btn-sm full-w mt-2" 
                onClick={handleInstallFFmpeg}
              >
                自动安装 FFmpeg 组件
              </button>
            )}
          </div>
        </aside>
      </div>

      {/* ── Timeline ── */}
      <div className="timeline-panel">
        <div className="timeline-toolbar">
          <span className="timeline-label">时间轴</span>
          {videoPath && <>
            <button id="tl-btn-add" className="btn btn-ghost btn-sm" onClick={addClipPointAtPlayhead}>
              <Plus size={11} /> 在播放头添加剪辑点
            </button>
            {deletedSegs.size > 0 && (
              <button className="btn btn-danger btn-sm" onClick={() => setDeletedSegs(new Set())}>
                <Trash2 size={11} /> 清除删除标记
              </button>
            )}
          </>}
          <div className="tl-flex" />
          {videoPath && <span className="text-muted">右键单击轨道可在指定位置添加剪辑点</span>}
          {!videoPath && <span className="text-muted">打开视频后显示时间轴</span>}
        </div>

        {/* Selected Segment Action Bar */}
        {selectedSegIdx !== null && segments[selectedSegIdx] && (
          <div className="segment-action-bar">
            <div className="segment-info">
              <span>选中区间 #{selectedSegIdx + 1}:</span>
              <span className="mono text-accent">{fmtTime(segments[selectedSegIdx].start)} – {fmtTime(segments[selectedSegIdx].end)}</span>
              <span className="text-muted">({fmtTime(segments[selectedSegIdx].end - segments[selectedSegIdx].start)})</span>
              {deletedSegs.has(selectedSegIdx) && <span className="text-red">已标记删除</span>}
            </div>
            <div className="segment-actions">
              <button className="btn btn-primary btn-sm" onClick={() => exportSingleSegment(segments[selectedSegIdx])}>
                <Download size={11} /> 导出此区间
              </button>
              {deletedSegs.has(selectedSegIdx) ? (
                <button className="btn btn-ghost btn-sm" onClick={() => toggleSegmentDelete(selectedSegIdx)}>
                  恢复此区间
                </button>
              ) : (
                <button className="btn btn-danger btn-sm" onClick={() => deleteSegment(selectedSegIdx)}>
                  <Trash2 size={11} /> 删除此区间
                </button>
              )}
              <button className="btn btn-ghost btn-sm btn-icon" style={{width:22,height:22,padding:0}} onClick={() => setSelectedSegIdx(null)}>
                <X size={11} />
              </button>
            </div>
          </div>
        )}

        {/* Ruler */}
        <div className="timeline-ruler">
          {duration > 0 && [0,.1,.2,.3,.4,.5,.6,.7,.8,.9,1].map(f => (
            <div key={f} className="ruler-tick" style={{ left: `${f*100}%` }}>
              {fmtTime(duration * f)}
            </div>
          ))}
        </div>

        {/* Track */}
        <div
          id="timeline-track"
          className="timeline-track"
          ref={timelineRef}
          onContextMenu={(e) => {
            e.preventDefault()
            if (!duration || !videoPath) return
            const t = pctToTime(e.clientX)
            addClipPointAt(t)
            toast(`已在 ${fmtTime(t)} 添加剪辑点`, 'ok')
          }}
        >
          {/* Segments */}
          {segments.map(seg => {
            const isDel = deletedSegs.has(seg.i)
            const isSel = selectedSegIdx === seg.i
            const l = pct(seg.start), w = `${((seg.end - seg.start) / duration * 100).toFixed(4)}%`
            return (
              <div
                key={seg.i}
                className={`tl-segment ${isDel ? 'delete' : 'keep'} ${isSel ? 'selected' : ''}`}
                style={{ left: l, width: w }}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelectedSegIdx(seg.i)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  toggleSegmentDelete(seg.i)
                }}
                title={`${isDel ? '🗑 删除' : '✓ 保留'} ${fmtTime(seg.start)}–${fmtTime(seg.end)}\n单击选中操作，双击切换标记`}
              >
                {isDel ? '删除' : ''}
              </div>
            )
          })}

          {/* Clip point handles */}
          {clipPoints.map((t, i) => {
            const isEdge = i === 0 || i === clipPoints.length - 1
            return (
              <div
                key={i}
                className={`tl-clip-point ${isEdge ? 'edge' : ''}`}
                style={{ left: pct(t) }}
                onMouseDown={(e) => handleTimelineMouseDown(e, i)}
                onDoubleClick={() => removeClipPoint(i)}
                title={isEdge ? fmtTime(t) : `剪辑点 ${fmtTime(t)}\n双击删除`}
              >
                <div className="tl-clip-knob" />
                <div className="tl-clip-line" />
              </div>
            )
          })}

          {/* Playhead */}
          {duration > 0 && (
            <div className="tl-playhead" style={{ left: pct(currentTime) }}>
              <div className="tl-playhead-handle" />
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="statusbar">
        <div className={`status-dot ${exporting ? 'busy' : ffmpegOk ? 'ok' : 'err'}`} />
        <span>One Video Cutter v0.1.0</span>
        {videoPath && <><span>·</span><span>{basename(videoPath)}</span></>}
        {deletedSegs.size > 0 && <><span>·</span><span className="text-red">{deletedSegs.size} 段待删除</span></>}
        <div style={{ flex: 1 }} />
        <span>双击剪辑点可删除</span>
      </div>

      {/* Export progress overlay */}
      {(exporting || ffmpegInstalling) && (
        <div className="progress-overlay">
          <div className="progress-card">
            {ffmpegInstalling ? <Download size={28} color="var(--green)" /> : <Scissors size={28} color="var(--accent)" />}
            <div style={{ fontSize: 15, fontWeight: 700 }}>
              {ffmpegInstalling ? '正在安装 FFmpeg 组件' : '正在导出视频'}
            </div>
            <div className="progress-bar-wrap">
              <div className="progress-bar-fill" style={{ 
                width: `${(ffmpegInstalling ? installProgress.percent : progress.percent) || 0}%`,
                background: ffmpegInstalling ? 'var(--green)' : 'var(--accent)'
              }} />
            </div>
            <div className="progress-msg">
              {(ffmpegInstalling ? installProgress.message : progress.message) || '处理中…'} 
              ({(ffmpegInstalling ? installProgress.percent : progress.percent) || 0}%)
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="toast-wrap">
        {toasts.map(t => <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}
      </div>
    </div>
  )
}
