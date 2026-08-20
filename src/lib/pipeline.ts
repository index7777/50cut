'use client';

/**
 * 一鍵流程的協調層。
 *
 * 責任邊界:
 *   ASR / alignment   → 真實語音時間(transcribe API)
 *   subtitleSegmenter → deterministic 字幕切分(本機、可測)
 *   Gemini            → 只做校字 patch 與候選排序
 *   ffmpeg            → deterministic 影片執行(瀏覽器端)
 *
 * 每個階段獨立可重試:失敗時保留已完成階段的產物,不整條重跑。
 */

import { extractAudio, splitAudioIntoChunks } from '@/lib/ffmpeg';
import { generateShortVideo, type SubtitlePosition } from '@/lib/video-generator';
import { buildSubtitleTimeline } from '@/lib/subtitle-segmenter';
import { applyDictionary, type DictEntry } from '@/lib/dictionary';
import { getBuiltinDictionary } from '@/lib/builtin-dictionary';
import { normalizeWords } from '@/lib/token-normalizer';
import type {
  HighlightResponse,
  ProofreadResponse,
  SubtitleCue,
  TranscribeResponse,
  TranscriptSegment,
  TranscriptWord,
} from '@/lib/types';

// 超過這個秒數就分段轉錄(避免 Vercel Hobby 60s timeout + Groq 單檔上限)
const CHUNK_THRESHOLD_SEC = 6 * 60;
const CHUNK_SEC = 5 * 60;

export type StageId =
  | 'extract'
  | 'transcribe'
  | 'proofread'
  | 'highlight'
  | 'subtitle'
  | 'render';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type StageState = {
  id: StageId;
  label: string;
  status: StageStatus;
  /** 0..1,只有 extract / render 有實際進度 */
  progress?: number;
  message?: string;
};

export const STAGE_LABELS: Record<StageId, string> = {
  extract: '讀取影片',
  transcribe: '辨識語音',
  proofread: '修正字幕',
  highlight: '選精彩片段',
  subtitle: '加入字幕',
  render: '產生短片',
};

export function initialStages(): StageState[] {
  return (Object.keys(STAGE_LABELS) as StageId[]).map((id) => ({
    id,
    label: STAGE_LABELS[id],
    status: 'pending',
  }));
}

/** 流程中累積的產物;重試某階段時從這裡取用前面的結果 */
export type PipelineArtifacts = {
  audioBlob: Blob | null;
  transcript: TranscribeResponse | null;
  cues: SubtitleCue[];
  highlight: HighlightResponse | null;
  outputBlob: Blob | null;
};

export function emptyArtifacts(): PipelineArtifacts {
  return {
    audioBlob: null,
    transcript: null,
    cues: [],
    highlight: null,
    outputBlob: null,
  };
}

export class StageError extends Error {
  stage: StageId;
  code?: string;
  constructor(stage: StageId, message: string, code?: string) {
    super(message);
    this.stage = stage;
    this.code = code;
  }
}

type Ctx = {
  onStage: (id: StageId, patch: Partial<StageState>) => void;
  dict: DictEntry[];
};

// ---------------------------------------------------------------------------
// 各階段
// ---------------------------------------------------------------------------

export async function runExtract(file: File, ctx: Ctx): Promise<Blob> {
  ctx.onStage('extract', { status: 'running', progress: 0 });
  try {
    const blob = await extractAudio(file, (p) =>
      ctx.onStage('extract', { status: 'running', progress: p })
    );
    ctx.onStage('extract', { status: 'done', progress: 1 });
    return blob;
  } catch (err) {
    ctx.onStage('extract', { status: 'failed', message: (err as Error).message });
    throw new StageError('extract', '讀不到這支影片的聲音，換一支試試');
  }
}

/**
 * 呼叫轉錄 API。單支音訊 → 一次 POST;長音訊 → 前端切段、平行 POST、合併。
 * @param videoDuration 影片長度秒(用來判斷要不要分段;未給則以 blob size 估算)
 */
export async function runTranscribe(
  audioBlob: Blob,
  ctx: Ctx,
  videoDuration?: number
): Promise<TranscribeResponse> {
  ctx.onStage('transcribe', { status: 'running' });

  // 判斷是否需分段:優先看 videoDuration,退回用 blob size(~64kbps: 480KB/分)
  const estDurationSec =
    videoDuration && videoDuration > 0
      ? videoDuration
      : Math.max(0, audioBlob.size / (64 * 1024 / 8)); // bytes / (bytes per sec)

  const needChunk = estDurationSec > CHUNK_THRESHOLD_SEC;

  // 單段路徑
  if (!needChunk) {
    return await transcribeChunk(audioBlob, 0, false, ctx);
  }

  // 多段:切音訊、平行送、合併
  ctx.onStage('transcribe', { status: 'running', message: '切割音訊...' });
  let chunks: Blob[];
  try {
    chunks = await splitAudioIntoChunks(audioBlob, CHUNK_SEC);
  } catch (err) {
    ctx.onStage('transcribe', { status: 'failed' });
    throw new StageError('transcribe', `切割音訊失敗:${(err as Error).message}`);
  }

  if (chunks.length === 0) {
    ctx.onStage('transcribe', { status: 'failed' });
    throw new StageError('transcribe', '切不出音訊段');
  }

  ctx.onStage('transcribe', {
    status: 'running',
    message: `辨識 ${chunks.length} 段...`,
  });

  // 依序送第一段(消耗用量),其餘 isChunk=1 平行
  let head: TranscribeResponse;
  try {
    head = await transcribeChunk(chunks[0], 0, false, ctx);
  } catch (err) {
    ctx.onStage('transcribe', { status: 'failed' });
    throw err;
  }

  const restResults = await Promise.all(
    chunks.slice(1).map((blob, idx) => {
      const offset = (idx + 1) * CHUNK_SEC;
      return transcribeChunk(blob, offset, true, ctx);
    })
  );

  // 合併:words + segments 拼起來,duration 用最後一段的 end
  const allWords: TranscriptWord[] = [...head.words];
  const allSegments: TranscriptSegment[] = [...head.segments];
  const allText: string[] = [head.full_text];
  let maxEnd = head.duration;

  for (const r of restResults) {
    allWords.push(...r.words);
    allSegments.push(...r.segments);
    if (r.full_text) allText.push(r.full_text);
    if (r.duration > maxEnd) maxEnd = r.duration;
  }

  allWords.sort((a, b) => a.start - b.start);
  allSegments.sort((a, b) => a.start - b.start);

  const merged: TranscribeResponse = {
    language: head.language,
    duration: videoDuration && videoDuration > 0 ? videoDuration : maxEnd,
    words: allWords,
    segments: allSegments,
    timingSource: head.timingSource,
    full_text: allText.join(' ').trim(),
  };

  ctx.onStage('transcribe', {
    status: 'done',
    message: `${chunks.length} 段,共 ${allWords.length} 個字`,
  });
  return merged;
}

async function transcribeChunk(
  audioBlob: Blob,
  chunkStartSeconds: number,
  isChunk: boolean,
  ctx: Ctx
): Promise<TranscribeResponse> {
  const form = new FormData();
  form.append('audio', audioBlob, 'audio.mp3');
  if (chunkStartSeconds > 0) form.append('chunkStartSeconds', String(chunkStartSeconds));
  if (isChunk) form.append('isChunk', '1');

  let resp: Response;
  try {
    resp = await fetch('/api/transcribe', { method: 'POST', body: form });
  } catch {
    ctx.onStage('transcribe', { status: 'failed' });
    throw new StageError('transcribe', '網路不穩,辨識沒送出去');
  }
  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    ctx.onStage('transcribe', { status: 'failed' });
    throw new StageError('transcribe', err.error ?? '辨識失敗', err.code);
  }
  const data = (await resp.json()) as TranscribeResponse;
  return data;
}

/**
 * 校字 + 建字幕時間軸。
 *
 * 順序(照規格):
 *   word timestamp → 內建字典 → 個人字典 → Gemini patch → 內建+個人字典再套 → segmenter
 *
 * 內建字典修常見英文品牌詞的空格問題(App le → Apple);
 * 個人字典套使用者自己學的錯字;
 * Gemini 只回 patch,套在 cue 文字上,cue 與 word 的時間完全不動。
 */
export async function runProofreadAndSegment(
  transcript: TranscribeResponse,
  ctx: Ctx
): Promise<SubtitleCue[]> {
  ctx.onStage('proofread', { status: 'running' });

  // 合併字典:內建先套(基本盤),使用者字典後套(可覆蓋)
  const builtin = getBuiltinDictionary();
  const combinedDict = [...builtin, ...ctx.dict];

  // 1. Lexical normalization:相鄰 ASCII tokens 合併成原子詞,套字典修 App|le → Apple。
  //    這步驟在 segmentation 之前,segmenter 不會從原子詞中間切開。
  //    參考 token-normalizer.ts 的責任邊界註解。
  const normalizedWords: TranscriptWord[] = normalizeWords(transcript.words, combinedDict);
  const normalizedSegments = combinedDict.length
    ? transcript.segments.map((s) => ({ ...s, text: applyDictionary(s.text, combinedDict) }))
    : transcript.segments;

  // 2. deterministic 切分 → 得到 cue 邊界(時間全部來自 normalized token)
  const baseCues = buildSubtitleTimeline({
    words: normalizedWords,
    segments: normalizedSegments,
  });

  if (baseCues.length === 0) {
    ctx.onStage('proofread', { status: 'failed' });
    throw new StageError('proofread', '沒有可用的字幕內容');
  }

  // 3. Gemini 校字:只收文字、只回 patch
  let corrections: ProofreadResponse['corrections'] = [];
  try {
    const resp = await fetch('/api/proofread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: baseCues.map((c) => c.text) }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as ProofreadResponse;
      if (Array.isArray(data.corrections)) corrections = data.corrections;
    }
  } catch {
    // 校字失敗不擋流程
  }

  // 4. 套 patch(只動文字)+ 字典再套一次
  //    這次是關鍵:cue.text 已經有跨 word 的完整文本(例如「App le Watch」),
  //    內建字典能一次修對整組品牌詞。
  const cues = baseCues.map((cue, index) => {
    let text = cue.text;
    for (const c of corrections) {
      if (c.index !== index) continue;
      if (!text.includes(c.from)) continue;
      text = text.split(c.from).join(c.to);
    }
    if (combinedDict.length) text = applyDictionary(text, combinedDict);
    // start / end / words 一律保持原樣
    return { ...cue, text };
  });

  ctx.onStage('proofread', {
    status: 'done',
    message: corrections.length ? `修正 ${corrections.length} 處` : undefined,
  });
  return cues;
}

export async function runHighlight(
  cues: SubtitleCue[],
  duration: number,
  ctx: Ctx
): Promise<HighlightResponse> {
  ctx.onStage('highlight', { status: 'running' });
  let resp: Response;
  try {
    resp = await fetch('/api/highlight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        duration,
        cues: cues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
      }),
    });
  } catch {
    ctx.onStage('highlight', { status: 'failed' });
    throw new StageError('highlight', '網路不穩，選片沒送出去');
  }
  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    ctx.onStage('highlight', { status: 'failed' });
    throw new StageError('highlight', err.error ?? '選片段失敗', err.code);
  }
  const data = (await resp.json()) as HighlightResponse;
  ctx.onStage('highlight', { status: 'done' });
  return data;
}

export async function runRender(
  opts: {
    file: File;
    cues: SubtitleCue[];
    highlight: { start: number; end: number };
    position: SubtitlePosition;
  },
  ctx: Ctx
): Promise<Blob> {
  ctx.onStage('subtitle', { status: 'running' });
  try {
    const blob = await generateShortVideo({
      file: opts.file,
      highlight: opts.highlight,
      segments: opts.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
      position: opts.position,
      onProgress: (p, phase) => {
        // 字型/字幕準備階段 → subtitle;實際 encode → render
        if (p < 0.2) {
          ctx.onStage('subtitle', { status: 'running', progress: p / 0.2, message: phase });
        } else {
          ctx.onStage('subtitle', { status: 'done', progress: 1 });
          ctx.onStage('render', {
            status: 'running',
            progress: (p - 0.2) / 0.8,
            message: phase,
          });
        }
      },
    });
    ctx.onStage('subtitle', { status: 'done', progress: 1 });
    ctx.onStage('render', { status: 'done', progress: 1 });
    return blob;
  } catch (err) {
    ctx.onStage('render', { status: 'failed' });
    throw new StageError('render', `合成失敗:${(err as Error).message ?? '未知錯誤'}`);
  }
}
