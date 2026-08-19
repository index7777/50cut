'use client';

import { useRef, useState } from 'react';
import { extractAudio, probeVideoDuration } from '@/lib/ffmpeg';
import { generateShortVideo, type SubtitlePosition } from '@/lib/video-generator';
import { LIMITS } from '@/lib/constants';
import { formatBytes, formatDuration, cn } from '@/lib/utils';
import type { TranscribeResponse, HighlightResponse } from '@/lib/types';

type Stage =
  | 'idle'
  | 'validating'
  | 'ready'
  | 'extracting'
  | 'transcribing'
  | 'picking'
  | 'reviewing'
  | 'generating'
  | 'done'
  | 'error';

export function VideoUploader() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [transcript, setTranscript] = useState<TranscribeResponse | null>(null);
  const [highlight, setHighlight] = useState<HighlightResponse | null>(null);
  const [outputBlob, setOutputBlob] = useState<Blob | null>(null);
  const [outputUrl, setOutputUrl] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [subtitlePos, setSubtitlePos] = useState<SubtitlePosition>('middle');

  async function handleFile(picked: File) {
    setStage('validating');
    setErrorMsg('');
    setTranscript(null);
    setHighlight(null);
    setOutputBlob(null);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    setOutputUrl('');

    if (!picked.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(picked.name)) {
      setStage('error');
      setErrorMsg('請選影片檔');
      return;
    }
    if (picked.size > LIMITS.MAX_FILE_SIZE_BYTES) {
      setStage('error');
      setErrorMsg(`檔案超過 ${formatBytes(LIMITS.MAX_FILE_SIZE_BYTES)}`);
      return;
    }
    try {
      const dur = await probeVideoDuration(picked);
      if (dur > LIMITS.MAX_DURATION_SECONDS) {
        setStage('error');
        setErrorMsg(`影片超過 ${LIMITS.MAX_DURATION_SECONDS / 60} 分鐘`);
        return;
      }
      setDuration(dur);
      setFile(picked);
      setStage('ready');
    } catch {
      setStage('error');
      setErrorMsg('影片格式讀不到,換一支試試');
    }
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (picked) await handleFile(picked);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragActive) setDragActive(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const picked = e.dataTransfer.files?.[0];
    if (picked) await handleFile(picked);
  }

  async function onStart() {
    if (!file) return;

    // 1. 抽音訊
    setStage('extracting');
    setProgress(0);
    setErrorMsg('');

    let audioBlob: Blob;
    try {
      audioBlob = await extractAudio(file, (p) => setProgress(p));
    } catch {
      setStage('error');
      setErrorMsg('抽音訊失敗,換一支試試');
      return;
    }

    // 2. Whisper
    setStage('transcribing');
    let transcribeData: TranscribeResponse;
    try {
      const form = new FormData();
      form.append('audio', audioBlob, 'audio.mp3');
      const resp = await fetch('/api/transcribe', { method: 'POST', body: form });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: '辨識失敗' }));
        setStage('error');
        setErrorMsg(err.error ?? '辨識失敗');
        return;
      }
      transcribeData = await resp.json();
      setTranscript(transcribeData);
    } catch {
      setStage('error');
      setErrorMsg('網路錯誤,再試一次');
      return;
    }

    // 3. Gemini 選亮點
    setStage('picking');
    try {
      const resp = await fetch('/api/highlight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          duration: transcribeData.duration,
          segments: transcribeData.segments,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: '選段失敗' }));
        setStage('error');
        setErrorMsg(err.error ?? '選段失敗');
        return;
      }
      const hl: HighlightResponse = await resp.json();
      setHighlight(hl);
      setStage('reviewing');
    } catch {
      setStage('error');
      setErrorMsg('網路錯誤,再試一次');
    }
  }

  async function onGenerate() {
    if (!file || !transcript || !highlight) return;
    setStage('generating');
    setProgress(0);
    setProgressLabel('準備字型...');
    setErrorMsg('');

    try {
      const blob = await generateShortVideo({
        file,
        highlight: highlight.highlight,
        segments: transcript.segments,
        position: subtitlePos,
        onProgress: (p, phase) => {
          setProgress(p);
          setProgressLabel(phase);
        },
      });
      const url = URL.createObjectURL(blob);
      setOutputBlob(blob);
      setOutputUrl(url);
      setStage('done');
    } catch (err) {
      setStage('error');
      setErrorMsg(`合成失敗: ${(err as Error).message ?? '未知錯誤'}`);
    }
  }

  function reset() {
    setFile(null);
    setDuration(0);
    setTranscript(null);
    setHighlight(null);
    setOutputBlob(null);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    setOutputUrl('');
    setStage('idle');
    setProgress(0);
    setProgressLabel('');
    setErrorMsg('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const showPicker = stage === 'idle' || stage === 'validating' || stage === 'error';

  return (
    <div className="w-full">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        onChange={onFilePicked}
        className="hidden"
      />

      {showPicker ? (
        <div
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => stage !== 'validating' && fileInputRef.current?.click()}
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
            stage === 'validating' && 'opacity-50 pointer-events-none'
          )}
        >
          <div className="text-4xl mb-2">{dragActive ? '📥' : '📹'}</div>
          <p className="font-medium">
            {stage === 'validating' ? '檢查中...' : dragActive ? '放開就好' : '選一支影片'}
          </p>
          <p className="text-xs opacity-40 mt-2">
            <span className="hidden sm:inline">拖進來 或 </span>
            點一下選檔
          </p>
          <p className="text-xs opacity-30 mt-1">
            最長 {LIMITS.MAX_DURATION_SECONDS / 60} 分鐘 · 最大 {formatBytes(LIMITS.MAX_FILE_SIZE_BYTES)}
          </p>
        </div>
      ) : null}

      {file && !showPicker ? (
        <div className="rounded-2xl bg-white/5 border border-white/10 p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium truncate">{file.name}</p>
              <p className="text-xs opacity-50 mt-1">
                {formatDuration(duration)} · {formatBytes(file.size)}
              </p>
            </div>
            <button onClick={reset} className="text-xs opacity-50 hover:opacity-100 shrink-0">
              換一支
            </button>
          </div>

          {stage === 'ready' && (
            <button
              onClick={onStart}
              className="w-full py-3 rounded-xl bg-white text-black font-medium hover:opacity-90 transition"
            >
              開始處理
            </button>
          )}

          {stage === 'extracting' && (
            <ProgressBlock label={`抽取音訊... ${(progress * 100).toFixed(0)}%`} progress={progress} />
          )}
          {stage === 'transcribing' && (
            <ProgressBlock label="AI 辨識中..." progress={0} indeterminate />
          )}
          {stage === 'picking' && (
            <ProgressBlock label="AI 挑亮點中..." progress={0} indeterminate />
          )}

          {(stage === 'reviewing' || stage === 'generating' || stage === 'done') &&
            highlight &&
            transcript && (
              <div>
                <p className="text-sm opacity-70 mb-3">
                  {stage === 'done' ? '✅ 短片好了' : '✅ 找到亮點'}
                </p>

                <div className="rounded-xl bg-black/30 border border-white/10 p-4 mb-4">
                  <p className="text-xs opacity-40 mb-2">建議標題</p>
                  <p className="text-lg font-medium mb-3">{highlight.title}</p>

                  <p className="text-xs opacity-40 mb-1">時間段</p>
                  <p className="text-sm mb-3 tabular-nums">
                    {formatDuration(highlight.highlight.start)} –{' '}
                    {formatDuration(highlight.highlight.end)}
                    <span className="opacity-40 ml-2">
                      (約 {(highlight.highlight.end - highlight.highlight.start).toFixed(0)} 秒)
                    </span>
                  </p>

                  <p className="text-xs opacity-40 mb-1">為什麼選這段</p>
                  <p className="text-sm mb-3 opacity-80">{highlight.highlight.reason}</p>

                  {highlight.hashtags.length > 0 && (
                    <>
                      <p className="text-xs opacity-40 mb-1">建議 hashtag</p>
                      <div className="flex flex-wrap gap-2">
                        {highlight.hashtags.map((t) => (
                          <span key={t} className="text-xs px-2 py-1 rounded-full bg-white/10">
                            #{t}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* 字幕清單:高亮落在亮點內的段落 */}
                <div className="rounded-xl bg-black/30 border border-white/10 p-3 max-h-48 overflow-y-auto text-sm leading-relaxed mb-4">
                  {transcript.segments.map((s, i) => {
                    const inHL =
                      s.start >= highlight.highlight.start - 0.5 &&
                      s.end <= highlight.highlight.end + 0.5;
                    return (
                      <div key={i} className={cn('flex gap-2 mb-2', inHL ? '' : 'opacity-30')}>
                        <span className="text-xs shrink-0 mt-0.5 tabular-nums opacity-60">
                          {formatDuration(s.start)}
                        </span>
                        <span>{s.text}</span>
                      </div>
                    );
                  })}
                </div>

                {/* 字幕位置選擇 */}
                {stage === 'reviewing' && (
                  <div className="mb-4">
                    <p className="text-xs opacity-40 mb-2">字幕位置</p>
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
                )}

                {stage === 'reviewing' && (
                  <button
                    onClick={onGenerate}
                    className="w-full py-3 rounded-xl bg-white text-black font-medium hover:opacity-90 transition"
                  >
                    合成短片
                  </button>
                )}

                {stage === 'generating' && (
                  <ProgressBlock label={`${progressLabel} ${(progress * 100).toFixed(0)}%`} progress={progress} />
                )}

                {stage === 'done' && outputUrl && outputBlob && (
                  <div>
                    <video
                      src={outputUrl}
                      controls
                      playsInline
                      className="w-full rounded-xl bg-black mb-4 max-h-96"
                    />
                    <a
                      href={outputUrl}
                      download={buildDownloadName(highlight.title)}
                      className="block w-full py-3 rounded-xl bg-white text-black font-medium hover:opacity-90 transition text-center"
                    >
                      下載短片 ({formatBytes(outputBlob.size)})
                    </a>
                    <button
                      onClick={reset}
                      className="mt-3 w-full py-2 text-sm opacity-50 hover:opacity-100 transition"
                    >
                      再剪一支
                    </button>
                  </div>
                )}
              </div>
            )}
        </div>
      ) : null}

      {errorMsg && <p className="mt-4 text-sm text-red-400 text-center">{errorMsg}</p>}

      {stage === 'error' && transcript && (
        <div className="mt-4 rounded-xl bg-black/30 border border-white/10 p-3 max-h-48 overflow-y-auto text-sm leading-relaxed">
          <p className="text-xs opacity-40 mb-2">已辨識的字幕({transcript.segments.length} 句)</p>
          {transcript.segments.map((s, i) => (
            <div key={i} className="flex gap-2 mb-2">
              <span className="opacity-40 text-xs shrink-0 mt-0.5 tabular-nums">
                {formatDuration(s.start)}
              </span>
              <span>{s.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressBlock({
  label,
  progress,
  indeterminate = false,
}: {
  label: string;
  progress: number;
  indeterminate?: boolean;
}) {
  return (
    <div>
      <div className="text-sm mb-2 opacity-70">{label}</div>
      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
        {indeterminate ? (
          <div className="h-full w-1/3 bg-white/60 animate-[slide_1.5s_ease-in-out_infinite]" />
        ) : (
          <div className="h-full bg-white transition-all" style={{ width: `${progress * 100}%` }} />
        )}
      </div>
      <p className="text-xs opacity-40 mt-3">影片留在你的電腦/手機,只有聲音會上傳做辨識</p>
    </div>
  );
}

function buildDownloadName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '50cut';
  return `${safe}.mp4`;
}
