'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatTimecode, formatCueTime, cn } from '@/lib/utils';
import type { SubtitleCue } from '@/lib/types';

type Props = {
  file: File;
  /** ffmpeg 抽出來的音訊(16kHz mono),用來畫波形 */
  audioBlob: Blob | null;
  duration: number;
  cues: SubtitleCue[];
  onCuesChange: (next: SubtitleCue[]) => void;
  highlight: { start: number; end: number };
  onHighlightChange: (next: { start: number; end: number }) => void;
  /** 使用者改完某句文字時通知(用來自動學字典) */
  onTextCommit?: (index: number) => void;
};

type DragState =
  | { kind: 'seg-start'; index: number }
  | { kind: 'seg-end'; index: number }
  | { kind: 'seg-move'; index: number; grabOffset: number }
  | { kind: 'hl-start' }
  | { kind: 'hl-end' }
  | { kind: 'scrub' }
  | null;

// px per second — 最細到 800，等於 1px ≈ 1.25ms
const ZOOM_LEVELS = [20, 40, 80, 150, 300, 500, 800];
const DEFAULT_ZOOM_INDEX = 2;
const MIN_SEG_SEC = 0.05;

// 波形取樣解析度(每秒幾個峰值點)
const PEAKS_PER_SEC = 800;
const WAVE_H = 44;
const RULER_H = 22;
const HL_H = 16;
const SEG_H = 76;

type Gap = { start: number; end: number };

/**
 * 從波形峰值找出靜音區間。
 * @param peaks 正規化(0..1)峰值陣列
 * @param threshold 低於這個振幅視為靜音
 * @param minSilence 靜音要連續這麼久(秒)才算一個斷點
 */
export function findSilenceGaps(
  peaks: Float32Array,
  threshold: number,
  minSilence: number
): Gap[] {
  const gaps: Gap[] = [];
  const minLen = Math.max(1, Math.round(minSilence * PEAKS_PER_SEC));
  let runStart = -1;
  for (let i = 0; i < peaks.length; i++) {
    const quiet = peaks[i] < threshold;
    if (quiet) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      if (i - runStart >= minLen) {
        gaps.push({ start: runStart / PEAKS_PER_SEC, end: i / PEAKS_PER_SEC });
      }
      runStart = -1;
    }
  }
  if (runStart !== -1 && peaks.length - runStart >= minLen) {
    gaps.push({ start: runStart / PEAKS_PER_SEC, end: peaks.length / PEAKS_PER_SEC });
  }
  return gaps;
}

/**
 * 依靜音區間把字幕切開。字幕文字按各片段時間長度比例分配。
 * 靜音本身不放字幕(前一句在靜音開始前結束,下一句在靜音結束後開始)。
 */
export function splitSegmentsByGaps(
  segments: SubtitleCue[],
  gaps: Gap[],
  minSegSec: number
): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const seg of segments) {
    // 落在這句「內部」的靜音(頭尾的靜音只用來修邊,不算切點)
    const inner = gaps.filter(
      (g) => g.start > seg.start + minSegSec && g.end < seg.end - minSegSec
    );
    if (inner.length === 0) {
      out.push({ ...seg });
      continue;
    }
    // 依靜音切出時間片段
    const pieces: { start: number; end: number }[] = [];
    let cursor = seg.start;
    for (const g of inner) {
      if (g.start - cursor >= minSegSec) pieces.push({ start: cursor, end: g.start });
      cursor = g.end;
    }
    if (seg.end - cursor >= minSegSec) pieces.push({ start: cursor, end: seg.end });
    if (pieces.length <= 1) {
      out.push({ ...seg });
      continue;
    }
    // 文字按時長比例分配
    const totalLen = pieces.reduce((a, p) => a + (p.end - p.start), 0) || 1;
    const chars = seg.text.length;
    let consumed = 0;
    pieces.forEach((p, idx) => {
      const share = (p.end - p.start) / totalLen;
      const take =
        idx === pieces.length - 1
          ? chars - consumed
          : Math.max(0, Math.round(chars * share));
      const text = seg.text.slice(consumed, consumed + take).trim();
      consumed += take;
      out.push({
        start: p.start,
        end: p.end,
        text,
        // 只保留落在這個片段內的 word,時間戳不動
        words: seg.words.filter((w) => w.start >= p.start - 1e-6 && w.end <= p.end + 1e-6),
        timing: seg.timing,
      });
    });
  }
  return out;
}

export function SubtitleEditor({
  file,
  audioBlob,
  duration,
  cues: segments,
  onCuesChange: onSegmentsChange,
  highlight,
  onHighlightChange,
  onTextCommit,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState>(null);
  const programmaticScrollRef = useRef(false);

  const [videoUrl, setVideoUrl] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [selected, setSelected] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<number | null>(null);
  const [followPlayhead, setFollowPlayhead] = useState(true);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [waveError, setWaveError] = useState(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportW, setViewportW] = useState(0);

  // 依波形自動切(使用者自行開啟)
  const [autoSplitOpen, setAutoSplitOpen] = useState(false);
  const [silenceThreshold, setSilenceThreshold] = useState(0.06);
  const [minSilenceSec, setMinSilenceSec] = useState(0.25);
  const [undoStack, setUndoStack] = useState<SubtitleCue[] | null>(null);

  // 偵測到的靜音區間(只在面板開啟時計算)
  const silenceGaps = useMemo(() => {
    if (!autoSplitOpen || !peaks) return [];
    return findSilenceGaps(peaks, silenceThreshold, minSilenceSec);
  }, [autoSplitOpen, peaks, silenceThreshold, minSilenceSec]);

  // 預覽:會切成幾句
  const previewCount = useMemo(() => {
    if (!autoSplitOpen || silenceGaps.length === 0) return segments.length;
    return splitSegmentsByGaps(segments, silenceGaps, MIN_SEG_SEC).length;
  }, [autoSplitOpen, segments, silenceGaps]);

  function applyAutoSplit() {
    if (silenceGaps.length === 0) return;
    const next = splitSegmentsByGaps(segments, silenceGaps, MIN_SEG_SEC);
    if (next.length === segments.length) return;
    setUndoStack(segments);
    onSegmentsChange(next);
    setSelected(null);
  }

  function undoAutoSplit() {
    if (!undoStack) return;
    onSegmentsChange(undoStack);
    setUndoStack(null);
    setSelected(null);
  }

  const pxPerSec = ZOOM_LEVELS[zoomIndex];
  const trackWidth = Math.max(1, duration * pxPerSec);
  const trackHeight = RULER_H + WAVE_H + HL_H + SEG_H + 8;

  // 影片 URL
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // 解碼音訊算波形峰值
  useEffect(() => {
    if (!audioBlob) return;
    let cancelled = false;
    (async () => {
      try {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        const buf = await ctx.decodeAudioData(await audioBlob.arrayBuffer());
        const ch = buf.getChannelData(0);
        const total = Math.max(1, Math.ceil(buf.duration * PEAKS_PER_SEC));
        const out = new Float32Array(total);
        const per = ch.length / total;
        let max = 0;
        for (let i = 0; i < total; i++) {
          const s = Math.floor(i * per);
          const e = Math.min(ch.length, Math.floor((i + 1) * per));
          let m = 0;
          for (let j = s; j < e; j++) {
            const a = Math.abs(ch[j]);
            if (a > m) m = a;
          }
          out[i] = m;
          if (m > max) max = m;
        }
        // 正規化,讓小聲的影片也看得見
        if (max > 0) for (let i = 0; i < total; i++) out[i] /= max;
        ctx.close().catch(() => {});
        if (!cancelled) setPeaks(out);
      } catch {
        if (!cancelled) setWaveError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audioBlob]);

  // 追蹤 viewport 寬度
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const update = () => setViewportW(sc.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);

  // 畫波形(只畫可視範圍,避免超寬 canvas 上限)
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !peaks || viewportW === 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.floor(viewportW * dpr);
    c.height = Math.floor(WAVE_H * dpr);
    c.style.width = `${viewportW}px`;
    c.style.height = `${WAVE_H}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewportW, WAVE_H);
    const mid = WAVE_H / 2;

    // 面板開啟時,先把偵測到的靜音區間畫成底色(預覽切點)
    if (autoSplitOpen && silenceGaps.length > 0) {
      ctx.fillStyle = 'rgba(251,191,36,0.16)';
      for (const g of silenceGaps) {
        const x0 = g.start * pxPerSec - scrollLeft;
        const x1 = g.end * pxPerSec - scrollLeft;
        if (x1 < 0 || x0 > viewportW) continue;
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), WAVE_H);
      }
      // 切點虛線
      ctx.strokeStyle = 'rgba(251,191,36,0.75)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const g of silenceGaps) {
        for (const t of [g.start, g.end]) {
          const x = t * pxPerSec - scrollLeft;
          if (x < 0 || x > viewportW) continue;
          ctx.beginPath();
          ctx.moveTo(x + 0.5, 0);
          ctx.lineTo(x + 0.5, WAVE_H);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(0, mid, viewportW, 1);

    // 波形
    ctx.fillStyle = 'rgba(190,230,255,0.55)';
    for (let x = 0; x < viewportW; x++) {
      const t0 = (scrollLeft + x) / pxPerSec;
      const t1 = (scrollLeft + x + 1) / pxPerSec;
      const i0 = Math.floor(t0 * PEAKS_PER_SEC);
      const i1 = Math.max(i0 + 1, Math.floor(t1 * PEAKS_PER_SEC));
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) {
        if (peaks[i] > m) m = peaks[i];
      }
      if (m <= 0) continue;
      const h = Math.max(1, m * (WAVE_H - 4));
      ctx.fillRect(x, mid - h / 2, 1, h);
    }

    // 靜音門檻線(讓使用者知道自己把線拉在哪)
    if (autoSplitOpen) {
      const th = silenceThreshold * (WAVE_H - 4);
      ctx.strokeStyle = 'rgba(251,191,36,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid - th / 2 + 0.5);
      ctx.lineTo(viewportW, mid - th / 2 + 0.5);
      ctx.moveTo(0, mid + th / 2 + 0.5);
      ctx.lineTo(viewportW, mid + th / 2 + 0.5);
      ctx.stroke();
    }
  }, [
    peaks,
    scrollLeft,
    pxPerSec,
    viewportW,
    autoSplitOpen,
    silenceGaps,
    silenceThreshold,
  ]);

  // 播放時用 rAF 追蹤播放頭
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setCurrentTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // 播放時讓播放頭保持在可視範圍
  useEffect(() => {
    if (!followPlayhead || !playing) return;
    const sc = scrollRef.current;
    if (!sc) return;
    const x = currentTime * pxPerSec;
    if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 80) {
      programmaticScrollRef.current = true;
      sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.35);
    }
  }, [currentTime, pxPerSec, followPlayhead, playing]);

  // 換候選 / 手動改 highlight 起點 → 時間軸捲到那裡、影片跳到那裡
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const x = highlight.start * pxPerSec;
    programmaticScrollRef.current = true;
    sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.15);
    const v = videoRef.current;
    if (v && !playing) {
      v.currentTime = highlight.start;
      setCurrentTime(highlight.start);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight.start, highlight.end]);

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(duration, t));
      const v = videoRef.current;
      if (v) v.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [duration]
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      setFollowPlayhead(true);
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, []);

  /** 只播選中這句(對時間軸最好用) */
  function playSelected() {
    const i = selected;
    if (i === null) return;
    const s = segments[i];
    const v = videoRef.current;
    if (!v) return;
    seek(s.start);
    setFollowPlayhead(true);
    v.play().catch(() => {});
    const stopAt = s.end;
    const check = () => {
      if (!videoRef.current) return;
      if (videoRef.current.currentTime >= stopAt) {
        videoRef.current.pause();
        return;
      }
      if (!videoRef.current.paused) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  const activeIndex = useMemo(() => {
    for (let i = 0; i < segments.length; i++) {
      if (currentTime >= segments[i].start && currentTime < segments[i].end) return i;
    }
    return -1;
  }, [segments, currentTime]);

  // ---- 編輯操作 ----

  function patchSegment(index: number, patch: Partial<SubtitleCue>) {
    onSegmentsChange(segments.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function splitAtPlayhead() {
    const i = selected;
    if (i === null) return;
    const s = segments[i];
    if (currentTime <= s.start + MIN_SEG_SEC || currentTime >= s.end - MIN_SEG_SEC) return;
    const ratio = (currentTime - s.start) / (s.end - s.start);
    const cut = Math.max(1, Math.min(Math.max(1, s.text.length - 1), Math.round(s.text.length * ratio)));
    const next = [...segments];
    next.splice(
      i,
      1,
      {
        start: s.start,
        end: currentTime,
        text: s.text.slice(0, cut).trim(),
        words: s.words.filter((w) => w.end <= currentTime + 1e-6),
        timing: s.timing,
      },
      {
        start: currentTime,
        end: s.end,
        text: s.text.slice(cut).trim(),
        words: s.words.filter((w) => w.start >= currentTime - 1e-6),
        timing: s.timing,
      }
    );
    onSegmentsChange(next);
    setSelected(i);
  }

  function snapToPlayhead(field: 'start' | 'end') {
    const i = selected;
    if (i === null) return;
    const s = segments[i];
    if (field === 'start' && currentTime < s.end - MIN_SEG_SEC) {
      patchSegment(i, { start: currentTime });
    } else if (field === 'end' && currentTime > s.start + MIN_SEG_SEC) {
      patchSegment(i, { end: currentTime });
    }
  }

  function nudge(field: 'start' | 'end', delta: number) {
    const i = selected;
    if (i === null) return;
    const s = segments[i];
    if (field === 'start') {
      patchSegment(i, { start: Math.max(0, Math.min(s.end - MIN_SEG_SEC, s.start + delta)) });
    } else {
      patchSegment(i, { end: Math.min(duration, Math.max(s.start + MIN_SEG_SEC, s.end + delta)) });
    }
  }

  function mergeWithNext() {
    const i = selected;
    if (i === null || i >= segments.length - 1) return;
    const a = segments[i];
    const b = segments[i + 1];
    const next = [...segments];
    next.splice(i, 2, {
      start: a.start,
      end: b.end,
      text: `${a.text}${b.text}`,
      words: [...a.words, ...b.words],
      timing: a.timing === 'exact' && b.timing === 'exact' ? 'exact' : 'estimated',
    });
    onSegmentsChange(next);
    setSelected(i);
  }

  function deleteSegment() {
    const i = selected;
    if (i === null) return;
    onSegmentsChange(segments.filter((_, idx) => idx !== i));
    setSelected(null);
  }

  function addSegmentAtPlayhead() {
    const start = currentTime;
    const end = Math.min(duration, start + 1.5);
    if (end - start < MIN_SEG_SEC) return;
    const next = [
      ...segments,
      { start, end, text: '', words: [], timing: 'estimated' as const },
    ].sort((a, b) => a.start - b.start);
    onSegmentsChange(next);
    const idx = next.findIndex((s) => s.start === start && s.text === '');
    setSelected(idx);
    setEditingText(idx);
  }

  // ---- 拖拉 ----

  function xToTime(clientX: number): number {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - rect.left) / pxPerSec));
  }

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const t = xToTime(e.clientX);

      if (d.kind === 'scrub') {
        seek(t);
        return;
      }
      if (d.kind === 'hl-start') {
        onHighlightChange({ start: Math.min(t, highlight.end - 0.5), end: highlight.end });
        return;
      }
      if (d.kind === 'hl-end') {
        onHighlightChange({ start: highlight.start, end: Math.max(t, highlight.start + 0.5) });
        return;
      }
      const s = segments[d.index];
      if (!s) return;
      if (d.kind === 'seg-start') {
        patchSegment(d.index, { start: Math.min(t, s.end - MIN_SEG_SEC) });
      } else if (d.kind === 'seg-end') {
        patchSegment(d.index, { end: Math.max(t, s.start + MIN_SEG_SEC) });
      } else if (d.kind === 'seg-move') {
        const len = s.end - s.start;
        const newStart = Math.max(0, Math.min(duration - len, t - d.grabOffset));
        patchSegment(d.index, { start: newStart, end: newStart + len });
      }
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  });

  // 刻度間隔隨縮放調整
  const tickStep =
    pxPerSec >= 500 ? 0.1 : pxPerSec >= 300 ? 0.25 : pxPerSec >= 150 ? 0.5 : pxPerSec >= 80 ? 1 : pxPerSec >= 40 ? 2 : 5;
  const ticks = useMemo(() => {
    const arr: number[] = [];
    for (let t = 0; t <= duration + 1e-6; t += tickStep) arr.push(Number(t.toFixed(3)));
    return arr;
  }, [duration, tickStep]);

  const sel = selected !== null ? segments[selected] ?? null : null;

  return (
    <div className="mb-4">
      {/* 影片 + 字幕疊層 */}
      <div className="relative rounded-xl overflow-hidden bg-black mb-2">
        {videoUrl && (
          <video
            ref={videoRef}
            src={videoUrl}
            playsInline
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onSeeked={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
            onLoadedMetadata={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
            onClick={togglePlay}
            className="w-full max-h-[42vh] object-contain bg-black cursor-pointer"
          />
        )}
        {activeIndex >= 0 && segments[activeIndex].text && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[14%] flex justify-center px-4">
            <span
              className="text-center text-white font-medium leading-snug"
              style={{
                fontSize: 'clamp(14px, 3.4vw, 22px)',
                textShadow:
                  '0 0 4px rgba(0,0,0,.95), 0 0 8px rgba(0,0,0,.9), 0 2px 3px rgba(0,0,0,1)',
              }}
            >
              {segments[activeIndex].text}
            </span>
          </div>
        )}
      </div>

      {/* 播放控制列 */}
      <div className="flex items-center gap-1.5 mb-2">
        <button
          onClick={togglePlay}
          className="px-3 py-1.5 rounded-lg bg-white text-black text-xs font-medium hover:opacity-90 transition min-w-[50px]"
        >
          {playing ? '暫停' : '播放'}
        </button>
        <button
          onClick={() => seek(currentTime - 0.05)}
          className="px-1.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] tabular-nums transition"
        >
          −50ms
        </button>
        <button
          onClick={() => seek(currentTime + 0.05)}
          className="px-1.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] tabular-nums transition"
        >
          +50ms
        </button>
        <span className="text-xs tabular-nums opacity-70 ml-auto mr-1">
          {formatTimecode(currentTime)}
        </span>
        <button
          onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
          disabled={zoomIndex === 0}
          className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 text-xs transition"
          title="縮小"
        >
          −
        </button>
        <span className="text-[10px] tabular-nums opacity-40 w-[52px] text-center">
          {pxPerSec}px/s
        </span>
        <button
          onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
          disabled={zoomIndex === ZOOM_LEVELS.length - 1}
          className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 text-xs transition"
          title="放大"
        >
          +
        </button>
      </div>

      {/* 橫向時間軸 */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          setScrollLeft(e.currentTarget.scrollLeft);
          if (programmaticScrollRef.current) {
            programmaticScrollRef.current = false;
          } else {
            setFollowPlayhead(false);
          }
        }}
        className="relative overflow-x-auto overflow-y-hidden rounded-xl bg-black/50 border border-white/10 select-none"
        style={{ touchAction: 'pan-x' }}
      >
        <div
          ref={trackRef}
          className="relative"
          style={{ width: trackWidth, height: trackHeight }}
        >
          {/* 刻度 + 點擊移動播放頭 */}
          <div
            className="absolute inset-x-0 top-0 border-b border-white/10 cursor-text"
            style={{ height: RULER_H }}
            onPointerDown={(e) => {
              e.stopPropagation();
              setFollowPlayhead(false);
              dragRef.current = { kind: 'scrub' };
              seek(xToTime(e.clientX));
            }}
          >
            {ticks.map((t) => (
              <div
                key={t}
                className="absolute top-0 h-full flex items-start pointer-events-none"
                style={{ left: t * pxPerSec }}
              >
                <div className="w-px h-2 bg-white/25" />
                <span className="text-[9px] tabular-nums opacity-40 ml-1">
                  {formatTimecode(t).replace(/\.000$/, '')}
                </span>
              </div>
            ))}
          </div>

          {/* 波形(固定在可視範圍,隨捲動重畫) */}
          <div
            className="absolute overflow-hidden"
            style={{ top: RULER_H, height: WAVE_H, left: scrollLeft, width: viewportW }}
          >
            {peaks ? (
              <canvas ref={canvasRef} className="block" />
            ) : (
              <div className="h-full flex items-center justify-center text-[10px] opacity-30">
                {waveError ? '波形讀不到(仍可編輯時間)' : '正在算波形...'}
              </div>
            )}
          </div>
          {/* 波形區也可以拖動播放頭 */}
          <div
            className="absolute inset-x-0 cursor-text"
            style={{ top: RULER_H, height: WAVE_H }}
            onPointerDown={(e) => {
              e.stopPropagation();
              setFollowPlayhead(false);
              dragRef.current = { kind: 'scrub' };
              seek(xToTime(e.clientX));
            }}
          />

          {/* 亮點區間 */}
          <div
            className="absolute bg-emerald-400/20 border-y border-emerald-400/40"
            style={{
              top: RULER_H + WAVE_H,
              height: HL_H,
              left: highlight.start * pxPerSec,
              width: Math.max(2, (highlight.end - highlight.start) * pxPerSec),
            }}
          >
            <span
              className="absolute left-1.5 text-[9px] text-emerald-200/80"
              style={{ lineHeight: `${HL_H}px` }}
            >
              輸出範圍
            </span>
            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                dragRef.current = { kind: 'hl-start' };
              }}
              className="absolute left-0 top-0 w-2.5 h-full -ml-1 cursor-ew-resize bg-emerald-400/70 hover:bg-emerald-300"
            />
            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                dragRef.current = { kind: 'hl-end' };
              }}
              className="absolute right-0 top-0 w-2.5 h-full -mr-1 cursor-ew-resize bg-emerald-400/70 hover:bg-emerald-300"
            />
          </div>

          {/* 字幕軌 */}
          <div
            className="absolute inset-x-0"
            style={{ top: RULER_H + WAVE_H + HL_H + 4, height: SEG_H }}
          >
            {segments.map((s, i) => {
              const left = s.start * pxPerSec;
              const width = Math.max(6, (s.end - s.start) * pxPerSec);
              const isSel = selected === i;
              return (
                <div
                  key={i}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelected(i);
                    dragRef.current = {
                      kind: 'seg-move',
                      index: i,
                      grabOffset: xToTime(e.clientX) - s.start,
                    };
                  }}
                  onDoubleClick={() => {
                    setSelected(i);
                    setEditingText(i);
                  }}
                  className={cn(
                    'absolute top-0 h-full rounded-md border overflow-hidden cursor-grab active:cursor-grabbing transition-colors',
                    isSel
                      ? 'bg-white/25 border-white/70 z-10'
                      : 'bg-white/[0.09] border-white/20 hover:bg-white/[0.14]'
                  )}
                  style={{ left, width }}
                >
                  <div className="px-1.5 pt-1 text-[10px] tabular-nums opacity-50 truncate">
                    {formatTimecode(s.start)}
                  </div>
                  <div className="px-1.5 text-[11px] leading-tight break-all">
                    {s.text || <span className="opacity-30">(空)</span>}
                  </div>
                  <div
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelected(i);
                      dragRef.current = { kind: 'seg-start', index: i };
                    }}
                    className="absolute left-0 top-0 w-2.5 h-full cursor-ew-resize bg-white/25 hover:bg-white/60"
                  />
                  <div
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelected(i);
                      dragRef.current = { kind: 'seg-end', index: i };
                    }}
                    className="absolute right-0 top-0 w-2.5 h-full cursor-ew-resize bg-white/25 hover:bg-white/60"
                  />
                </div>
              );
            })}
          </div>

          {/* 播放頭 */}
          <div
            className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none z-20"
            style={{ left: currentTime * pxPerSec }}
          >
            <div className="absolute top-0 -left-[3px] w-[7px] h-[7px] rounded-full bg-red-500" />
          </div>
        </div>
      </div>

      {/* 依波形自動切(預設關閉,使用者自己開) */}
      <div className="mt-2 rounded-xl bg-white/[0.04] border border-white/10">
        <button
          onClick={() => setAutoSplitOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.03] transition rounded-xl"
        >
          <span className="text-xs">依波形自動切</span>
          <span className="text-[10px] opacity-40">偵測靜音分段</span>
          <span className="ml-auto text-[10px] opacity-40">
            {autoSplitOpen ? '收起' : '展開'}
          </span>
        </button>

        {autoSplitOpen && (
          <div className="px-3 pb-3 border-t border-white/10 pt-3">
            {!peaks ? (
              <p className="text-[11px] opacity-40">
                {waveError ? '沒有波形資料，無法自動切' : '正在算波形...'}
              </p>
            ) : (
              <>
                <div className="mb-3">
                  <div className="flex items-center justify-between text-[10px] mb-1">
                    <span className="opacity-50">靜音門檻</span>
                    <span className="tabular-nums opacity-70">
                      {(silenceThreshold * 100).toFixed(0)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={30}
                    value={Math.round(silenceThreshold * 100)}
                    onChange={(e) => setSilenceThreshold(Number(e.target.value) / 100)}
                    className="w-full accent-amber-400"
                  />
                  <p className="text-[10px] opacity-30 mt-0.5">
                    調高抓到更多停頓(切更碎)，調低只抓明顯的空白
                  </p>
                </div>

                <div className="mb-3">
                  <div className="flex items-center justify-between text-[10px] mb-1">
                    <span className="opacity-50">最短靜音</span>
                    <span className="tabular-nums opacity-70">
                      {(minSilenceSec * 1000).toFixed(0)}ms
                    </span>
                  </div>
                  <input
                    type="range"
                    min={100}
                    max={1000}
                    step={50}
                    value={Math.round(minSilenceSec * 1000)}
                    onChange={(e) => setMinSilenceSec(Number(e.target.value) / 1000)}
                    className="w-full accent-amber-400"
                  />
                  <p className="text-[10px] opacity-30 mt-0.5">
                    停頓要多久才算一個切點
                  </p>
                </div>

                <div className="flex items-center gap-2 text-[11px] mb-2">
                  <span className="opacity-50">
                    偵測到 <span className="tabular-nums text-amber-200">{silenceGaps.length}</span> 段靜音
                  </span>
                  <span className="opacity-40">·</span>
                  <span className="opacity-50">
                    會從 <span className="tabular-nums">{segments.length}</span> 句變{' '}
                    <span className="tabular-nums text-amber-200">{previewCount}</span> 句
                  </span>
                </div>
                <p className="text-[10px] opacity-40 mb-2">
                  波形上黃色區塊就是會切開的地方，先調到你要的再套用。
                  文字會按時間長度粗略分配，套用後再逐句改。
                </p>

                <div className="flex gap-1.5">
                  <button
                    onClick={applyAutoSplit}
                    disabled={silenceGaps.length === 0 || previewCount === segments.length}
                    className="px-3 py-1.5 rounded-lg bg-amber-400 text-black text-[11px] font-medium hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition"
                  >
                    套用切分
                  </button>
                  {undoStack && (
                    <button
                      onClick={undoAutoSplit}
                      className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] transition"
                    >
                      還原上一步
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 選中句子的操作區 */}
      <div className="mt-2 rounded-xl bg-white/[0.04] border border-white/10 p-3">
        {sel ? (
          <>
            <div className="flex items-center gap-2 mb-2 text-[11px] tabular-nums flex-wrap">
              <span className="opacity-50">第 {selected! + 1} 句</span>
              <span className="opacity-70">
                {formatTimecode(sel.start)} → {formatTimecode(sel.end)}
              </span>
              <span className="opacity-40">({(sel.end - sel.start).toFixed(3)}s)</span>
              <button
                onClick={playSelected}
                className="ml-auto px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition"
              >
                只播這句
              </button>
            </div>

            {editingText === selected ? (
              <input
                autoFocus
                value={sel.text}
                onChange={(e) => patchSegment(selected!, { text: e.target.value })}
                onBlur={() => {
                  onTextCommit?.(selected!);
                  setEditingText(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') {
                    onTextCommit?.(selected!);
                    setEditingText(null);
                  }
                }}
                maxLength={300}
                className="w-full bg-white/10 rounded px-2 py-1.5 text-sm outline-none focus:bg-white/15 mb-2"
              />
            ) : (
              <div
                onClick={() => setEditingText(selected)}
                className="w-full rounded px-2 py-1.5 text-sm cursor-text hover:bg-white/5 mb-2 min-h-[34px]"
              >
                {sel.text || <span className="opacity-30">(空，點我輸入)</span>}
              </div>
            )}

            {/* 毫秒微調 */}
            <div className="flex items-center gap-1 mb-2 text-[10px] tabular-nums">
              <span className="opacity-40 w-7">起點</span>
              <button onClick={() => nudge('start', -0.05)} className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20">−50</button>
              <button onClick={() => nudge('start', -0.01)} className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20">−10</button>
              <button onClick={() => nudge('start', 0.01)} className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20">+10</button>
              <button onClick={() => nudge('start', 0.05)} className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20">+50</button>
              <span className="opacity-30 ml-1">ms</span>
            </div>
            <div className="flex items-center gap-1 mb-2 text-[10px] tabular-nums">
              <span className="opacity-40 w-7">終點</span>
              <button onClick={() => nudge('end', -0.05)} className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20">−50</button>
              <button onClick={() => nudge('end', -0.01)} className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20">−10</button>
              <button onClick={() => nudge('end', 0.01)} className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20">+10</button>
              <button onClick={() => nudge('end', 0.05)} className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20">+50</button>
              <span className="opacity-30 ml-1">ms</span>
            </div>

            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <button
                onClick={() => snapToPlayhead('start')}
                className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition"
              >
                起點對播放頭
              </button>
              <button
                onClick={() => snapToPlayhead('end')}
                className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition"
              >
                終點對播放頭
              </button>
              <button
                onClick={splitAtPlayhead}
                className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition"
              >
                在播放頭切開
              </button>
              <button
                onClick={mergeWithNext}
                disabled={selected === null || selected >= segments.length - 1}
                className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 transition"
              >
                跟下句合併
              </button>
              <button
                onClick={addSegmentAtPlayhead}
                className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition"
              >
                加一句
              </button>
              <button
                onClick={deleteSegment}
                className="px-2 py-1 rounded bg-red-500/15 text-red-300 hover:bg-red-500/25 transition ml-auto"
              >
                刪除
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <p className="text-xs opacity-50 leading-relaxed">
              點字幕塊選它 · 拖邊緣調時間 · 雙擊改字
              <br />
              <span className="opacity-70">看波形對時間軸，放大到 800px/s 可調到毫秒</span>
            </p>
            <button
              onClick={addSegmentAtPlayhead}
              className="ml-auto px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-[11px] transition shrink-0"
            >
              加一句
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
