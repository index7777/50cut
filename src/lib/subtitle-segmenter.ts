/**
 * Deterministic 字幕切分器。
 *
 * 唯一的時間來源是 ASR 的 word timestamp;這個模組不呼叫任何 AI,
 * 同樣的輸入永遠得到同樣的輸出。
 *
 * 切分同時參考:word timestamp、語音停頓、標點、字數、顯示時間。
 */

import type {
  SubtitleCue,
  TranscriptSegment,
  TranscriptWord,
} from '@/lib/types';

export type SegmenterConfig = {
  /** 一段字幕最多幾個字(中文字計 1) */
  maxChars: number;
  /** 一段字幕最長幾秒 */
  maxDuration: number;
  /** 一段字幕最短幾秒(低於此值會嘗試與鄰居合併) */
  minDuration: number;
  /** word 之間停頓超過幾秒就優先切 */
  pauseSplit: number;
};

export const DEFAULT_SEGMENTER_CONFIG: SegmenterConfig = {
  maxChars: 14,
  maxDuration: 3.5,
  minDuration: 0.7,
  pauseSplit: 0.45,
};

/** 句末標點:出現就優先斷句 */
const SENTENCE_END = /[。！？!?…]$/;
/** 句中標點:可以當次要斷點 */
const CLAUSE_END = /[，,、；;：:]$/;
/** 只有標點/空白,沒有實質內容 */
const PUNCT_ONLY = /^[\s。，、！？!?：；:;（）()"'「」『』…\-—.,]*$/;

const ASCII_WORD = /[A-Za-z0-9]/;

/** 中文不加空格,拉丁字母/數字之間才加 */
function joinTokens(tokens: string[]): string {
  let out = '';
  for (const t of tokens) {
    if (!t) continue;
    if (out === '') {
      out = t;
      continue;
    }
    const prev = out[out.length - 1];
    const next = t[0];
    const needSpace =
      ASCII_WORD.test(prev) && ASCII_WORD.test(next);
    out += needSpace ? ` ${t}` : t;
  }
  return out;
}

/** 計算顯示長度:忽略空白 */
function displayLength(text: string): number {
  return text.replace(/\s/g, '').length;
}

function cueFromWords(words: TranscriptWord[], timing: 'exact'): SubtitleCue {
  const text = joinTokens(words.map((w) => w.text)).trim();
  return {
    start: words[0].start,
    end: words[words.length - 1].end,
    text,
    words,
    timing,
  };
}

/**
 * 主要路徑:有 word-level timestamp 時使用。
 * cue 的 start/end 一律直接取 word 的 start/end,不做任何內插。
 */
export function segmentWords(
  rawWords: TranscriptWord[],
  config: SegmenterConfig = DEFAULT_SEGMENTER_CONFIG
): SubtitleCue[] {
  const words = rawWords
    .filter(
      (w) =>
        w &&
        typeof w.start === 'number' &&
        typeof w.end === 'number' &&
        w.end >= w.start &&
        typeof w.text === 'string'
    )
    .sort((a, b) => a.start - b.start);

  if (words.length === 0) return [];

  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];

    if (current.length === 0) {
      current.push(w);
      continue;
    }

    const prev = current[current.length - 1];
    const gap = w.start - prev.end;
    const currentText = joinTokens(current.map((x) => x.text));
    const currentChars = displayLength(currentText);
    const wordChars = displayLength(w.text);
    const spanIfAdded = w.end - current[0].start;

    // 純標點的 token 永遠黏在前一段,避免字幕開頭出現孤立標點
    const isPunctOnly = PUNCT_ONLY.test(w.text);

    const shouldBreak =
      !isPunctOnly &&
      (gap >= config.pauseSplit ||
        currentChars + wordChars > config.maxChars ||
        spanIfAdded > config.maxDuration);

    if (shouldBreak) {
      groups.push(current);
      current = [w];
    } else {
      current.push(w);
    }

    // 句末標點:先收這段(下一個字重新開始)
    const joined = joinTokens(current.map((x) => x.text)).trim();
    if (SENTENCE_END.test(joined) && i < words.length - 1) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  const cues = groups
    .filter((g) => g.length > 0)
    .map((g) => cueFromWords(g, 'exact'))
    .filter((c) => c.text.length > 0);

  return mergeTooShort(cues, config);
}

/**
 * 合併「過短且沒有語意」的 cue。
 * 只在合併後不會超出 maxChars / maxDuration 太多時才合併,
 * 避免為了消除短 cue 反而生出超長字幕。
 */
function mergeTooShort(
  cues: SubtitleCue[],
  config: SegmenterConfig
): SubtitleCue[] {
  if (cues.length <= 1) return cues;

  const out: SubtitleCue[] = [];
  for (const cue of cues) {
    const tooShort =
      cue.end - cue.start < config.minDuration ||
      PUNCT_ONLY.test(cue.text);

    if (!tooShort || out.length === 0) {
      out.push({ ...cue });
      continue;
    }

    const prev = out[out.length - 1];
    const mergedChars = displayLength(prev.text) + displayLength(cue.text);
    const mergedSpan = cue.end - prev.start;
    const gap = cue.start - prev.end;
    // 句界比 minDuration 優先:前一段已經是完整句子就不要黏回去,
    // 否則短句會被合併成長字幕(這是「字幕太黏」的主因之一)。
    // 例外:只有標點的碎片一定要併回去,不能單獨成段。
    const crossesSentence = SENTENCE_END.test(prev.text.trim());
    const punctOnly = PUNCT_ONLY.test(cue.text);

    // 只有在「緊接著」且合併後仍在容忍範圍內才併
    const canMerge =
      (punctOnly || !crossesSentence) &&
      gap < config.pauseSplit &&
      mergedChars <= config.maxChars + 4 &&
      mergedSpan <= config.maxDuration + 1;

    if (canMerge) {
      prev.end = cue.end;
      prev.text = joinTokens([prev.text, cue.text]).trim();
      prev.words = [...prev.words, ...cue.words];
    } else {
      out.push({ ...cue });
    }
  }

  // 開頭若是過短碎片,往後併一次(同樣不跨句界)
  if (out.length > 1) {
    const first = out[0];
    if (
      first.end - first.start < config.minDuration &&
      !SENTENCE_END.test(first.text.trim()) &&
      out[1].start - first.end < config.pauseSplit &&
      displayLength(first.text) + displayLength(out[1].text) <= config.maxChars + 4
    ) {
      out[1] = {
        ...out[1],
        start: first.start,
        text: joinTokens([first.text, out[1].text]).trim(),
        words: [...first.words, ...out[1].words],
      };
      out.shift();
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Fallback:只有 segment-level 時間戳
// ---------------------------------------------------------------------------

/**
 * 沒有 word timestamp 時的保守 subdivision。
 *
 * 依標點把 segment 文字切成語意片段,時間**按字數比例分配**。
 * 這是估算,不是實際語音時間 → cue.timing = 'estimated',
 * words 一律留空(不假造每個字的時間戳)。
 */
export function subdivideSegments(
  segments: TranscriptSegment[],
  config: SegmenterConfig = DEFAULT_SEGMENTER_CONFIG
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];

  for (const seg of segments) {
    const text = seg.text.trim();
    const span = seg.end - seg.start;
    if (!text || span <= 0) continue;

    // 先依標點切,再把過長的片段依字數硬切
    const chunks: string[] = [];
    for (const piece of splitByPunctuation(text)) {
      if (displayLength(piece) <= config.maxChars) {
        chunks.push(piece);
        continue;
      }
      for (let i = 0; i < piece.length; i += config.maxChars) {
        chunks.push(piece.slice(i, i + config.maxChars));
      }
    }
    const usable = chunks.map((c) => c.trim()).filter((c) => c.length > 0);
    if (usable.length === 0) continue;

    if (usable.length === 1) {
      cues.push({
        start: seg.start,
        end: seg.end,
        text: usable[0],
        words: [],
        timing: 'estimated',
      });
      continue;
    }

    const totalChars = usable.reduce((a, c) => a + displayLength(c), 0) || 1;
    let cursor = seg.start;
    usable.forEach((chunk, idx) => {
      const share = displayLength(chunk) / totalChars;
      const last = idx === usable.length - 1;
      const end = last ? seg.end : Math.min(seg.end, cursor + span * share);
      cues.push({
        start: cursor,
        end,
        text: chunk,
        words: [],
        timing: 'estimated',
      });
      cursor = end;
    });
  }

  return cues.filter((c) => c.end > c.start);
}

function splitByPunctuation(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (SENTENCE_END.test(ch) || CLAUSE_END.test(ch)) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf);
  return out.filter((s) => s.trim().length > 0);
}

// ---------------------------------------------------------------------------
// 對外入口
// ---------------------------------------------------------------------------

/**
 * 建立字幕時間軸。
 * 有 word timestamp 就用精準路徑;沒有才退回 segment 內保守估算。
 */
export function buildSubtitleTimeline(
  input: {
    words: TranscriptWord[];
    segments: TranscriptSegment[];
  },
  config: SegmenterConfig = DEFAULT_SEGMENTER_CONFIG
): SubtitleCue[] {
  if (input.words && input.words.length > 0) {
    const cues = segmentWords(input.words, config);
    if (cues.length > 0) return cues;
  }
  return subdivideSegments(input.segments ?? [], config);
}

/** 句尾是否為完整句子結束(給候選片段判斷邊界用) */
export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim());
}

/** 是否只有標點,沒有實質內容 */
export function isPunctuationOnly(text: string): boolean {
  return PUNCT_ONLY.test(text);
}
