'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { probeVideoDuration } from '@/lib/ffmpeg';
import { type SubtitlePosition } from '@/lib/video-generator';
import { SubtitleEditor } from '@/components/subtitle-editor';
import { ProcessingSteps } from '@/components/processing-steps';
import { LIMITS } from '@/lib/constants';
import { formatBytes, formatDuration, formatCueTime, cn } from '@/lib/utils';
import {
  initialStages,
  emptyArtifacts,
  runExtract,
  runTranscribe,
  runProofreadAndSegment,
  runHighlight,
  runRender,
  StageError,
  type PipelineArtifacts,
  type StageId,
  type StageState,
} from '@/lib/pipeline';
import {
  loadDictionary,
  saveDictionary,
  applyDictionary,
  extractDiff,
  upsertEntry,
  type DictEntry,
} from '@/lib/dictionary';
import type { HighlightCandidate, SubtitleCue } from '@/lib/types';

/** 畫面只有三層:選檔 → 處理中 → 完成。編輯器是完成頁的第二層 */
type Phase = 'upload' | 'processing' | 'result';

export function VideoUploader() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ?debug=1 → 顯示 candidate scoring 明細
  const [debugMode, setDebugMode] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    setDebugMode(sp.get('debug') === '1');
  }, []);

  const [phase, setPhase] = useState<Phase>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [validating, setValidating] = useState(false);

  const [stages, setStages] = useState<StageState[]>(initialStages());
  const [artifacts, setArtifacts] = useState<PipelineArtifacts>(emptyArtifacts());
  const [failedStage, setFailedStage] = useState<StageId | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const [outputUrl, setOutputUrl] = useState('');
  const [subtitlePos, setSubtitlePos] = useState<SubtitlePosition>('middle');
  const [showEditor, setShowEditor] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');

  const [dict, setDict] = useState<DictEntry[]>([]);
  const [showDictModal, setShowDictModal] = useState(false);
  const [learnedToast, setLearnedToast] = useState<DictEntry | null>(null);
  const originalTextsRef = useRef<string[]>([]);

  useEffect(() => {
    setDict(loadDictionary());
  }, []);

  useEffect(() => {
    return () => {
      if (outputUrl) URL.revokeObjectURL(outputUrl);
    };
  }, [outputUrl]);

  const patchStage = useCallback((id: StageId, patch: Partial<StageState>) => {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  // 用 ref 讓 pipeline 拿到最新字典,避免 stale closure
  const dictRef = useRef<DictEntry[]>([]);
  useEffect(() => {
    dictRef.current = dict;
  }, [dict]);

  const ctx = { onStage: patchStage, get dict() { return dictRef.current; } };

  // ---------------------------------------------------------------- 選檔

  async function handleFile(picked: File) {
    setValidating(true);
    setErrorMsg('');
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    setOutputUrl('');
    setArtifacts(emptyArtifacts());
    setStages(initialStages());
    setFailedStage(null);
    setShowEditor(false);
    setTitle('');

    if (!picked.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(picked.name)) {
      setValidating(false);
      setErrorMsg('請選影片檔');
      return;
    }
    if (picked.size > LIMITS.MAX_FILE_SIZE_BYTES) {
      setValidating(false);
      setErrorMsg(`檔案超過 ${formatBytes(LIMITS.MAX_FILE_SIZE_BYTES)}`);
      return;
    }
    try {
      const dur = await probeVideoDuration(picked);
      if (dur > LIMITS.MAX_DURATION_SECONDS) {
        setValidating(false);
        setErrorMsg(`影片超過 ${LIMITS.MAX_DURATION_SECONDS / 60} 分鐘`);
        return;
      }
      setDuration(dur);
      setFile(picked);
      setValidating(false);
      // 一鍵:選完檔直接跑,不用再按「開始處理」
      void runAll(picked, dur);
    } catch {
      setValidating(false);
      setErrorMsg('影片格式讀不到，換一支試試');
    }
  }

  // ---------------------------------------------------------------- 主流程

  async function runAll(target: File, dur: number) {
    setPhase('processing');
    setErrorMsg('');
    setFailedStage(null);

    const acc: PipelineArtifacts = emptyArtifacts();
    try {
      acc.audioBlob = await runExtract(target, ctx);
      setArtifacts({ ...acc });

      acc.transcript = await runTranscribe(acc.audioBlob, ctx, dur);
      setArtifacts({ ...acc });

      acc.cues = await runProofreadAndSegment(acc.transcript, ctx);
      originalTextsRef.current = acc.cues.map((c) => c.text);
      setArtifacts({ ...acc });

      acc.highlight = await runHighlight(
        acc.cues,
        acc.transcript.duration || dur,
        ctx
      );
      setTitle(acc.highlight.title);
      setArtifacts({ ...acc });

      acc.outputBlob = await runRender(
        {
          file: target,
          cues: acc.cues,
          highlight: acc.highlight.highlight,
          position: subtitlePos,
        },
        ctx
      );
      const url = URL.createObjectURL(acc.outputBlob);
      setOutputUrl(url);
      setArtifacts({ ...acc });
      setPhase('result');
    } catch (err) {
      const se = err as StageError;
      setFailedStage(se.stage ?? null);
      setErrorMsg(se.message ?? '處理失敗');
      // 標記後續階段為未執行
      setStages((prev) => {
        const idx = prev.findIndex((s) => s.id === se.stage);
        if (idx < 0) return prev;
        return prev.map((s, i) => (i > idx && s.status === 'pending' ? s : s));
      });
    }
  }

  /** 只重跑失敗的那個階段,以及它之後的階段 */
  async function retryFrom(stage: StageId) {
    if (!file) return;
    setErrorMsg('');
    setFailedStage(null);
    setPhase('processing');
    patchStage(stage, { status: 'pending', message: undefined });

    const acc: PipelineArtifacts = { ...artifacts };
    try {
      if (stage === 'extract' || !acc.audioBlob) {
        acc.audioBlob = await runExtract(file, ctx);
        setArtifacts({ ...acc });
      }
      if (
        stage === 'extract' ||
        stage === 'transcribe' ||
        !acc.transcript
      ) {
        acc.transcript = await runTranscribe(acc.audioBlob!, ctx, duration);
        setArtifacts({ ...acc });
      }
      if (
        stage === 'extract' ||
        stage === 'transcribe' ||
        stage === 'proofread' ||
        acc.cues.length === 0
      ) {
        acc.cues = await runProofreadAndSegment(acc.transcript!, ctx);
        originalTextsRef.current = acc.cues.map((c) => c.text);
        setArtifacts({ ...acc });
      }
      if (stage !== 'subtitle' && stage !== 'render') {
        acc.highlight = await runHighlight(
          acc.cues,
          acc.transcript!.duration || duration,
          ctx
        );
        setTitle(acc.highlight.title);
        setArtifacts({ ...acc });
      }
      acc.outputBlob = await runRender(
        {
          file,
          cues: acc.cues,
          highlight: acc.highlight!.highlight,
          position: subtitlePos,
        },
        ctx
      );
      if (outputUrl) URL.revokeObjectURL(outputUrl);
      setOutputUrl(URL.createObjectURL(acc.outputBlob));
      setArtifacts({ ...acc });
      setPhase('result');
    } catch (err) {
      const se = err as StageError;
      setFailedStage(se.stage ?? null);
      setErrorMsg(se.message ?? '處理失敗');
    }
  }

  /** 不靠 AI:自己框範圍。字幕已經在手上,直接進編輯器 */
  function manualPick() {
    if (!artifacts.transcript || artifacts.cues.length === 0) return;
    const cues = artifacts.cues;
    const dur = artifacts.transcript.duration || duration;
    // 從第一句開始,湊到接近 40 秒為止,結尾一律落在 cue 邊界
    let end = cues[0].end;
    for (const c of cues) {
      if (c.end - cues[0].start > 40) break;
      end = c.end;
    }
    setArtifacts((prev) => ({
      ...prev,
      highlight: {
        highlight: {
          start: cues[0].start,
          end: Math.min(dur, end),
          reason: '手動選取範圍',
        },
        title: '',
        hashtags: [],
        candidateId: null,
        candidates: prev.highlight?.candidates ?? [],
      },
    }));
    patchStage('highlight', { status: 'skipped', message: '手動選取' });
    setFailedStage(null);
    setErrorMsg('');
    setPhase('result');
    setShowEditor(true);
  }

  /** 換一個候選片段:同步更新時間段 + 為什麼選這段 + editor 捲軸 */
  function chooseCandidate(c: HighlightCandidate) {
    setArtifacts((prev) =>
      prev.highlight
        ? {
            ...prev,
            highlight: {
              ...prev.highlight,
              highlight: {
                ...prev.highlight.highlight,
                start: c.start,
                end: c.end,
                // 若候選有 deterministic reason,用它;否則保留原 AI reason
                reason: c.reasonText ?? prev.highlight.highlight.reason,
              },
              candidateId: c.id,
            },
          }
        : prev
    );
  }

  async function rerender() {
    if (!file || !artifacts.highlight) return;
    setPhase('processing');
    patchStage('subtitle', { status: 'pending' });
    patchStage('render', { status: 'pending' });
    setErrorMsg('');
    setFailedStage(null);
    try {
      const blob = await runRender(
        {
          file,
          cues: artifacts.cues,
          highlight: artifacts.highlight.highlight,
          position: subtitlePos,
        },
        ctx
      );
      if (outputUrl) URL.revokeObjectURL(outputUrl);
      setOutputUrl(URL.createObjectURL(blob));
      setArtifacts((prev) => ({ ...prev, outputBlob: blob }));
      setPhase('result');
    } catch (err) {
      const se = err as StageError;
      setFailedStage(se.stage ?? 'render');
      setErrorMsg(se.message ?? '合成失敗');
    }
  }

  function reset() {
    setPhase('upload');
    setFile(null);
    setDuration(0);
    setStages(initialStages());
    setArtifacts(emptyArtifacts());
    setFailedStage(null);
    setErrorMsg('');
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    setOutputUrl('');
    setShowEditor(false);
    setTitle('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // ---------------------------------------------------------------- 字典自動學習

  function commitCueEdit(index: number) {
    const original = originalTextsRef.current[index];
    const edited = artifacts.cues[index]?.text ?? '';
    if (!original) return;
    const diff = extractDiff(original, edited);
    if (!diff) return;
    const already = dict.find((e) => e.wrong === diff.wrong && e.right === diff.right);
    const next = upsertEntry(dict, diff);
    setDict(next);
    saveDictionary(next);
    if (!already) {
      setLearnedToast(diff);
      setTimeout(() => setLearnedToast(null), 3000);
    }
  }

  function setCues(next: SubtitleCue[]) {
    setArtifacts((prev) => ({ ...prev, cues: next }));
  }

  // ---------------------------------------------------------------- render

  const hl = artifacts.highlight;
  const cues = artifacts.cues;
  const estimatedTiming = cues.length > 0 && cues.some((c) => c.timing === 'estimated');
  // 字幕做完了嗎(用來區分「字幕失敗」與「只有選片失敗」)
  const subtitlesReady = cues.length > 0;

  return (
    <div className="w-full">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) void handleFile(picked);
        }}
        className="hidden"
      />

      <div className="flex justify-end mb-3">
        <button
          onClick={() => setShowDictModal(true)}
          className="text-[11px] uppercase tracking-wider opacity-50 hover:opacity-100 transition"
        >
          字典{dict.length > 0 && <span className="opacity-70"> · {dict.length}</span>}
        </button>
      </div>

      {showDictModal && (
        <DictionaryModal
          entries={dict}
          onClose={() => setShowDictModal(false)}
          onSave={(next) => {
            saveDictionary(next);
            setDict(next);
          }}
        />
      )}

      {learnedToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-white text-black text-[13px] px-4 py-2 rounded-full shadow-2xl">
          已記住:<span className="opacity-60">「{learnedToast.wrong}」</span>
          <span className="opacity-40 mx-1.5">→</span>
          <span>「{learnedToast.right}」</span>
        </div>
      )}

      {/* ---------------- 選檔 ---------------- */}
      {phase === 'upload' && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!dragActive) setDragActive(true);
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragActive(false);
            const picked = e.dataTransfer.files?.[0];
            if (picked) void handleFile(picked);
          }}
          onClick={() => !validating && fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
          }}
          className={cn(
            'w-full rounded-2xl border-2 border-dashed p-10 text-center transition cursor-pointer select-none',
            dragActive
              ? 'border-white/60 bg-white/10 scale-[1.01]'
              : 'border-white/20 hover:border-white/40 hover:bg-white/5',
            validating && 'opacity-50 pointer-events-none'
          )}
        >
          <p className="text-xl font-light tracking-wide mb-2">
            {validating ? '檢查中' : dragActive ? '放開就好' : '選一支影片'}
          </p>
          <p className="text-xs opacity-40 tracking-wide">
            <span className="hidden sm:inline">拖進來 · </span>
            點一下選檔
          </p>
          <p className="text-[11px] opacity-30 mt-4 tracking-wider tabular-nums">
            最長 {LIMITS.MAX_DURATION_SECONDS / 60} 分鐘 · 最大{' '}
            {formatBytes(LIMITS.MAX_FILE_SIZE_BYTES)}
          </p>
        </div>
      )}

      {/* ---------------- 處理中 ---------------- */}
      {phase === 'processing' && (
        <div className="rounded-2xl bg-white/5 border border-white/10 p-5">
          {file && (
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">{file.name}</p>
                <p className="text-xs opacity-50 mt-1 tabular-nums">
                  {formatDuration(duration)} · {formatBytes(file.size)}
                </p>
              </div>
              <button
                onClick={reset}
                className="text-xs opacity-50 hover:opacity-100 shrink-0"
              >
                換一支
              </button>
            </div>
          )}

          <ProcessingSteps stages={stages} />

          {/* 分階段錯誤處理 */}
          {failedStage && (
            <div className="mt-4">
              {failedStage === 'highlight' && subtitlesReady ? (
                <div className="rounded-xl bg-white/[0.04] border border-white/10 p-4">
                  <p className="text-sm mb-1">
                    字幕已完成 <span className="text-emerald-400">✓</span>
                  </p>
                  <p className="text-xs opacity-60 mb-1">精彩片段目前無法產生</p>
                  {errorMsg && (
                    <p className="text-[11px] opacity-40 mb-3">{errorMsg}</p>
                  )}
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => void retryFrom('highlight')}
                      className="w-full py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-sm font-medium transition"
                    >
                      重新選片段
                    </button>
                    <button
                      onClick={manualPick}
                      className="w-full py-2.5 rounded-xl bg-white text-black text-sm font-medium hover:opacity-90 transition"
                    >
                      自己選片段
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-red-500/[0.07] border border-red-500/25 p-4">
                  <p className="text-sm text-red-200 mb-1">
                    {stages.find((s) => s.id === failedStage)?.label}失敗
                  </p>
                  {errorMsg && <p className="text-xs opacity-70 mb-3">{errorMsg}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => void retryFrom(failedStage)}
                      className="flex-1 py-2.5 rounded-xl bg-white text-black text-sm font-medium hover:opacity-90 transition"
                    >
                      重試這個步驟
                    </button>
                    <button
                      onClick={reset}
                      className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-sm transition"
                    >
                      換一支
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---------------- 完成 ---------------- */}
      {phase === 'result' && hl && (
        <div className="rounded-2xl bg-white/5 border border-white/10 p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <p className="text-[11px] uppercase tracking-widest opacity-50">
              {artifacts.outputBlob ? '短片好了' : '待合成'}
            </p>
            <button onClick={reset} className="text-xs opacity-50 hover:opacity-100">
              再剪一支
            </button>
          </div>

          {outputUrl && (
            <video
              src={outputUrl}
              controls
              playsInline
              className="w-full rounded-xl bg-black mb-4 max-h-[50vh]"
            />
          )}

          {/* 主 CTA */}
          {outputUrl && artifacts.outputBlob && (
            <a
              href={outputUrl}
              download={buildDownloadName(title)}
              className="block w-full py-3.5 rounded-xl bg-white text-black font-medium hover:opacity-90 transition text-center tracking-wide mb-3"
            >
              下載影片 ({formatBytes(artifacts.outputBlob.size)})
            </a>
          )}

          {/* 摘要 */}
          <div className="rounded-xl bg-black/30 border border-white/10 p-4 mb-3">
            <p className="text-[11px] uppercase tracking-widest opacity-40 mb-2">
              建議標題 · 點一下改
            </p>
            {editingTitle ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => setEditingTitle(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') setEditingTitle(false);
                }}
                maxLength={40}
                className="w-full text-lg font-medium mb-3 bg-white/10 rounded px-2 py-1 outline-none focus:bg-white/15"
              />
            ) : (
              <p
                onClick={() => setEditingTitle(true)}
                className="text-lg font-medium mb-3 rounded px-2 py-1 -mx-2 cursor-text hover:bg-white/5"
              >
                {title || <span className="opacity-30">(沒有標題，點我輸入)</span>}
              </p>
            )}

            <p className="text-[11px] uppercase tracking-widest opacity-40 mb-1">片段</p>
            <p className="text-sm mb-3 tabular-nums">
              {formatCueTime(hl.highlight.start)} – {formatCueTime(hl.highlight.end)}
              <span className="opacity-40 ml-2">
                ({(hl.highlight.end - hl.highlight.start).toFixed(1)} 秒)
              </span>
            </p>

            <p className="text-[11px] uppercase tracking-widest opacity-40 mb-1">
              為什麼選這段
            </p>
            <p className="text-sm mb-3 opacity-80">{hl.highlight.reason}</p>

            {hl.scores && (
              <>
                <p className="text-[11px] uppercase tracking-widest opacity-40 mb-1">評分</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums opacity-70 mb-3">
                  <span>Hook {hl.scores.hook}</span>
                  <span>完整 {hl.scores.completeness}</span>
                  <span>情緒 {hl.scores.emotion}</span>
                  <span>分享 {hl.scores.shareability}</span>
                </div>
              </>
            )}

            {hl.hashtags.length > 0 && (
              <>
                <p className="text-[11px] uppercase tracking-widest opacity-40 mb-1">
                  建議 hashtag
                </p>
                <div className="flex flex-wrap gap-2">
                  {hl.hashtags.map((t) => (
                    <span key={t} className="text-xs px-2 py-1 rounded-full bg-white/10">
                      #{t}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* 字幕摘要 */}
          <div className="rounded-xl bg-black/30 border border-white/10 p-3 mb-3">
            <p className="text-[11px] uppercase tracking-widest opacity-40 mb-2">
              已辨識 {(artifacts.transcript?.duration || duration).toFixed(0)} 秒 ·{' '}
              {cues.length} 段字幕
              {estimatedTiming && (
                <span className="ml-2 text-amber-300/80 normal-case tracking-normal">
                  時間為估算
                </span>
              )}
            </p>
            <div className="max-h-40 overflow-y-auto text-sm leading-relaxed">
              {cues.slice(0, 40).map((c, i) => {
                const inHL =
                  c.start >= hl.highlight.start - 0.01 && c.end <= hl.highlight.end + 0.01;
                return (
                  <div key={i} className={cn('mb-2', inHL ? '' : 'opacity-30')}>
                    <div className="text-[11px] tabular-nums opacity-50">
                      {c.timing === 'estimated' && <span className="mr-1">約</span>}
                      {formatCueTime(c.start)} – {formatCueTime(c.end)}
                    </div>
                    <div>{c.text}</div>
                  </div>
                );
              })}
              {cues.length > 40 && (
                <p className="text-[11px] opacity-30">…還有 {cues.length - 40} 段</p>
              )}
            </div>
          </div>

          {/* 第二層:微調 */}
          <button
            onClick={() => setShowEditor((v) => !v)}
            className="w-full py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-sm transition"
          >
            {showEditor ? '收起微調' : '微調字幕與片段'}
          </button>

          {showEditor && file && (
            <div className="mt-4">
              {estimatedTiming && (
                <p className="text-[11px] text-amber-300/80 mb-2 leading-relaxed">
                  這支影片拿不到逐字時間戳，字幕時間是依字數在段落內估算的，
                  不是實際語音時間。建議對照波形手動校正。
                </p>
              )}

              {hl.candidates.length > 1 && (
                <div className="mb-3">
                  <p className="text-[11px] uppercase tracking-widest opacity-40 mb-2">
                    其他候選片段
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {hl.candidates.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => chooseCandidate(c)}
                        className={cn(
                          'px-2 py-1 rounded text-[11px] tabular-nums transition',
                          hl.candidateId === c.id
                            ? 'bg-white text-black'
                            : 'bg-white/10 hover:bg-white/20'
                        )}
                        title={c.reasonText}
                      >
                        {formatCueTime(c.start)} · {c.duration.toFixed(0)}s
                        {debugMode && c.scores && (
                          <span className="ml-1 opacity-60">
                            [{c.scores.totalScore.toFixed(2)}]
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Debug mode:candidate scoring 明細 */}
              {debugMode && hl.candidates.length > 0 && (
                <div className="mb-3 rounded-lg bg-black/50 border border-yellow-500/40 p-3 overflow-x-auto">
                  <p className="text-[11px] uppercase tracking-widest text-yellow-400/80 mb-2">
                    debug: candidate scoring
                  </p>
                  <table className="text-[10px] tabular-nums w-full min-w-[720px]">
                    <thead className="opacity-60">
                      <tr>
                        <th className="text-left pr-2 py-0.5">id</th>
                        <th className="text-left pr-2 py-0.5">range</th>
                        <th className="text-right pr-2">dur</th>
                        <th className="text-right pr-2">total</th>
                        <th className="text-right pr-2">comp</th>
                        <th className="text-right pr-2">hook</th>
                        <th className="text-right pr-2">ctx</th>
                        <th className="text-right pr-2">spd</th>
                        <th className="text-right pr-2">bnd</th>
                        <th className="text-right pr-2">info</th>
                        <th className="text-right pr-2">durS</th>
                        <th className="text-right pr-2">−intro</th>
                        <th className="text-right pr-2">−outro</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hl.candidates.map((c) => {
                        const s = c.scores;
                        return (
                          <tr
                            key={c.id}
                            className={cn(
                              hl.candidateId === c.id
                                ? 'text-yellow-300'
                                : 'opacity-80'
                            )}
                          >
                            <td className="pr-2 py-0.5">{c.id}</td>
                            <td className="pr-2">
                              {formatCueTime(c.start)}–{formatCueTime(c.end)}
                            </td>
                            <td className="text-right pr-2">{c.duration.toFixed(1)}s</td>
                            <td className="text-right pr-2 font-bold">
                              {s?.totalScore.toFixed(2) ?? '—'}
                            </td>
                            <td className="text-right pr-2">{s?.completeness.toFixed(2) ?? '—'}</td>
                            <td className="text-right pr-2">{s?.hook.toFixed(2) ?? '—'}</td>
                            <td className="text-right pr-2">{s?.contextIndependence.toFixed(2) ?? '—'}</td>
                            <td className="text-right pr-2">{s?.speechDensity.toFixed(2) ?? '—'}</td>
                            <td className="text-right pr-2">{s?.boundaryQuality.toFixed(2) ?? '—'}</td>
                            <td className="text-right pr-2">{s?.informationDensity.toFixed(2) ?? '—'}</td>
                            <td className="text-right pr-2">{s?.durationScore.toFixed(2) ?? '—'}</td>
                            <td className="text-right pr-2 text-red-300/80">
                              {s?.introPenalty ? s.introPenalty.toFixed(2) : '—'}
                            </td>
                            <td className="text-right pr-2 text-red-300/80">
                              {s?.outroPenalty ? s.outroPenalty.toFixed(2) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="text-[10px] opacity-40 mt-2">
                    加權:comp·.20 + hook·.15 + ctx/spd/bnd/info/durS 各·.10 − intro·.10 − outro·.05
                  </p>
                </div>
              )}

              <SubtitleEditor
                file={file}
                audioBlob={artifacts.audioBlob}
                duration={artifacts.transcript?.duration || duration}
                cues={cues}
                onCuesChange={setCues}
                highlight={hl.highlight}
                onHighlightChange={(next) =>
                  setArtifacts((prev) =>
                    prev.highlight
                      ? {
                          ...prev,
                          highlight: {
                            ...prev.highlight,
                            highlight: { ...prev.highlight.highlight, ...next },
                            candidateId: null,
                          },
                        }
                      : prev
                  )
                }
                onTextCommit={commitCueEdit}
              />

              <div className="mb-3">
                <p className="text-[11px] uppercase tracking-widest opacity-40 mb-2">
                  字幕位置
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {(['high', 'middle', 'low'] as SubtitlePosition[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setSubtitlePos(p)}
                      className={cn(
                        'py-2 rounded-xl text-sm border transition',
                        subtitlePos === p
                          ? 'bg-white text-black border-white'
                          : 'bg-white/5 border-white/10 hover:bg-white/10'
                      )}
                    >
                      {p === 'high' ? '偏上' : p === 'middle' ? '中間' : '偏下'}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={() => void rerender()}
                className="w-full py-3 rounded-xl bg-white text-black font-medium hover:opacity-90 transition tracking-wide"
              >
                用這些設定重新合成
              </button>
            </div>
          )}
        </div>
      )}

      {errorMsg && phase === 'upload' && (
        <p className="mt-4 text-sm text-red-400 text-center">{errorMsg}</p>
      )}
    </div>
  );
}

function buildDownloadName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '50cut';
  return `${safe}.mp4`;
}

function DictionaryModal({
  entries,
  onClose,
  onSave,
}: {
  entries: DictEntry[];
  onClose: () => void;
  onSave: (next: DictEntry[]) => void;
}) {
  const [rows, setRows] = useState<DictEntry[]>(entries);

  function remove(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next);
    onSave(next);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 border border-white/10 rounded-2xl p-5 w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-medium">已學到的字典</h3>
          <button onClick={onClose} className="text-sm opacity-50 hover:opacity-100">
            ✕
          </button>
        </div>
        <p className="text-xs opacity-60 mb-3 leading-relaxed">
          你每改一句字幕，系統會自動記下「原本認錯的字 → 你改成的字」，下次同樣的錯自動修好。
          不用手動維護，越用越準。要移除某條點右邊 ✕ 就好。
        </p>
        <div className="overflow-y-auto flex-1 -mx-1 px-1">
          {rows.length === 0 ? (
            <p className="text-center opacity-40 py-8 text-sm">
              還沒有學到任何對照。
              <br />
              改一次字幕就會自動加進來。
            </p>
          ) : (
            rows.map((r, i) => (
              <div key={i} className="flex gap-2 mb-2 items-center text-sm">
                <span className="flex-1 bg-white/5 rounded px-2 py-1.5 opacity-60 truncate">
                  {r.wrong}
                </span>
                <span className="opacity-40 shrink-0">→</span>
                <span className="flex-1 bg-white/10 rounded px-2 py-1.5 truncate">
                  {r.right}
                </span>
                <button
                  onClick={() => remove(i)}
                  className="opacity-40 hover:opacity-100 hover:text-red-400 shrink-0 px-1"
                  title="移除"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
        <button
          onClick={onClose}
          className="w-full py-2 rounded-xl bg-white/5 hover:bg-white/10 text-sm mt-4"
        >
          關閉
        </button>
      </div>
    </div>
  );
}
