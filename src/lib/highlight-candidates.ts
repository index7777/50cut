/**
 * 候選短片產生器(deterministic)。
 *
 * 規則:
 *  - 候選的 start/end 一律等於某個 cue 的 start/end,絕不落在句子中間。
 *  - 起點必須是「一句話的開頭」,終點必須是「一句話的結尾」。
 *  - 長度落在目標區間(預設 25~60 秒)。
 *
 * AI 只會收到這份清單,然後回一個 id。AI 不產生時間。
 */

import type { HighlightCandidate, SubtitleCue } from '@/lib/types';
import { endsSentence } from '@/lib/subtitle-segmenter';

export type CandidateConfig = {
  minDuration: number;
  maxDuration: number;
  /** 判斷「換句」的停頓門檻 */
  pauseGap: number;
  /** 最多產生幾個候選(避免 prompt 過長) */
  maxCandidates: number;
};

export const DEFAULT_CANDIDATE_CONFIG: CandidateConfig = {
  minDuration: 25,
  maxDuration: 60,
  pauseGap: 0.45,
  maxCandidates: 12,
};

function cueText(cues: SubtitleCue[], from: number, to: number): string {
  return cues
    .slice(from, to + 1)
    .map((c) => c.text)
    .join(' ')
    .trim();
}

/** cue i 是否可以當作片段開頭:前一句已結束,或有明顯停頓 */
function isSentenceStart(cues: SubtitleCue[], i: number, pauseGap: number): boolean {
  if (i === 0) return true;
  const prev = cues[i - 1];
  const cur = cues[i];
  if (endsSentence(prev.text)) return true;
  return cur.start - prev.end >= pauseGap;
}

/** cue i 是否可以當作片段結尾:本句已結束,或後面有明顯停頓 */
function isSentenceEnd(cues: SubtitleCue[], i: number, pauseGap: number): boolean {
  if (i === cues.length - 1) return true;
  const cur = cues[i];
  const next = cues[i + 1];
  if (endsSentence(cur.text)) return true;
  return next.start - cur.end >= pauseGap;
}

/**
 * 產生候選片段。
 * 找不到符合嚴格邊界的候選時,會逐步放寬(先放寬邊界,再放寬長度),
 * 但永遠維持「start/end 對齊 cue 邊界」這個硬條件。
 */
export function buildCandidates(
  cues: SubtitleCue[],
  config: CandidateConfig = DEFAULT_CANDIDATE_CONFIG
): HighlightCandidate[] {
  if (cues.length === 0) return [];

  const strict = collect(cues, config, { requireBoundaries: true, relaxDuration: false });
  if (strict.length > 0) return trim(strict, config.maxCandidates);

  const looseBoundary = collect(cues, config, { requireBoundaries: false, relaxDuration: false });
  if (looseBoundary.length > 0) return trim(looseBoundary, config.maxCandidates);

  const looseAll = collect(cues, config, { requireBoundaries: false, relaxDuration: true });
  if (looseAll.length > 0) return trim(looseAll, config.maxCandidates);

  // 最後手段:整支影片(仍對齊首尾 cue 邊界)
  const first = cues[0];
  const last = cues[cues.length - 1];
  return [
    {
      id: 'candidate_1',
      start: first.start,
      end: last.end,
      duration: Number((last.end - first.start).toFixed(3)),
      cueStartIndex: 0,
      cueEndIndex: cues.length - 1,
      text: cueText(cues, 0, cues.length - 1),
    },
  ];
}

function collect(
  cues: SubtitleCue[],
  config: CandidateConfig,
  opts: { requireBoundaries: boolean; relaxDuration: boolean }
): HighlightCandidate[] {
  const minD = opts.relaxDuration ? Math.min(8, config.minDuration) : config.minDuration;
  const maxD = opts.relaxDuration ? config.maxDuration * 1.5 : config.maxDuration;

  const found: Omit<HighlightCandidate, 'id'>[] = [];

  for (let i = 0; i < cues.length; i++) {
    if (opts.requireBoundaries && !isSentenceStart(cues, i, config.pauseGap)) continue;

    for (let j = i; j < cues.length; j++) {
      const dur = cues[j].end - cues[i].start;
      if (dur < minD) continue;
      if (dur > maxD) break;
      if (opts.requireBoundaries && !isSentenceEnd(cues, j, config.pauseGap)) continue;

      found.push({
        start: cues[i].start,
        end: cues[j].end,
        duration: Number(dur.toFixed(3)),
        cueStartIndex: i,
        cueEndIndex: j,
        text: cueText(cues, i, j),
      });
      // 同一個起點只取最短的合格片段,避免同起點爆量
      break;
    }
  }

  return dedupe(found).map((c, idx) => ({ ...c, id: `candidate_${idx + 1}` }));
}

function dedupe(list: Omit<HighlightCandidate, 'id'>[]): Omit<HighlightCandidate, 'id'>[] {
  const seen = new Set<string>();
  const out: Omit<HighlightCandidate, 'id'>[] = [];
  for (const c of list) {
    const key = `${c.cueStartIndex}:${c.cueEndIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * 平均取樣到 maxCandidates 個,讓候選散佈在整支影片,
 * 而不是全部擠在開頭。第一個與最後一個一定保留。
 */
function trim(list: HighlightCandidate[], max: number): HighlightCandidate[] {
  if (list.length <= max) {
    return list.map((c, i) => ({ ...c, id: `candidate_${i + 1}` }));
  }
  const step = (list.length - 1) / (max - 1);
  const picked: HighlightCandidate[] = [];
  for (let i = 0; i < max; i++) {
    picked.push(list[Math.round(i * step)]);
  }
  return dedupe(picked).map((c, i) => ({ ...c, id: `candidate_${i + 1}` }));
}

/**
 * 沒有 AI 時的預設選擇:挑最接近目標長度中位數、且盡量靠前的候選。
 * 完全 deterministic,用在 AI 額度用完或失敗時。
 */
export function pickDefaultCandidate(
  candidates: HighlightCandidate[],
  config: CandidateConfig = DEFAULT_CANDIDATE_CONFIG
): HighlightCandidate | null {
  if (candidates.length === 0) return null;
  const target = (config.minDuration + config.maxDuration) / 2;
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    // 長度接近目標為主,起點較早為次要
    const score = Math.abs(c.duration - target) + c.start * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
