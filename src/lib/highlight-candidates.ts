/**
 * 候選短片產生器(deterministic scoring)。
 *
 * 流程:
 *  1. 從 cue 邊界枚舉合格候選(25-60s、對齊完整句)
 *  2. deterministic scoring:
 *       completeness / hook / contextIndependence / speechDensity /
 *       boundaryQuality / informationDensity / durationScore /
 *       introPenalty / outroPenalty
 *  3. 依 totalScore 排序、移除 overlap > 75% 的重複、取 Top N(預設 5)
 *  4. 依 start 時間軸重排讓 UI 有序
 *
 * AI 只會收到這 Top N 清單並回一個 candidateId。AI 不產生時間、不 rerank 邏輯。
 * 時間戳一律取自 cue 邊界(絕對時間),AI 不得改動。
 */

import type {
  CandidateScores,
  HighlightCandidate,
  SubtitleCue,
} from '@/lib/types';
import { endsSentence } from '@/lib/subtitle-segmenter';

export type CandidateConfig = {
  minDuration: number;
  maxDuration: number;
  targetDurationMin: number;
  targetDurationMax: number;
  pauseGap: number;
  maxCandidates: number;
  overlapThreshold: number;
};

export const DEFAULT_CANDIDATE_CONFIG: CandidateConfig = {
  minDuration: 25,
  maxDuration: 60,
  targetDurationMin: 30,
  targetDurationMax: 45,
  pauseGap: 0.45,
  maxCandidates: 5,
  overlapThreshold: 0.75,
};

// ---------------------------------------------------------------------------
// 詞庫(scoring 用,不涉及文字修改)
// ---------------------------------------------------------------------------

const HOOK_WORDS =
  /為什麼|你知道嗎|竟然|原來|結果|沒想到|最重要|一定要|千萬不要|你可能不知道|其實|重點是|關鍵是|真的|老實說|超怪|超奇|等等|告訴你|告訴各位|其中最|想像一下|你有沒有/;

const INTRO_WORDS =
  /大家好|哈囉|嗨,|嗨。|歡迎來到|歡迎收看|今天要跟大家分享|今天要來|各位觀眾|各位朋友|訂閱|按讚|開啟小鈴鐺|開啟通知|小鈴鐺|請追蹤|如果各位對|如果對這類/;

const OUTRO_WORDS =
  /感謝收看|感謝觀看|我們下次見|下集再見|下次再見|下集見|下一集見|記得訂閱|按讚訂閱|留言分享|請按讚|請訂閱|支持頻道|留言告訴我|以上就是|節目就到這|節目到這|節目結束|感謝各位|拜拜|掰掰/;

const CONTINUATION_WORDS =
  /^(然後|所以|但是|因為|接下來|另外|不過|而且|還有|於是|因此|接著|後來|再來)/;

const PRONOUN_START =
  /^(這|那|它|他|她|這個|那個|這些|那些|這裡|那裡|這樣|那樣|它們|他們|她們)/;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

type RawCandidate = Omit<HighlightCandidate, 'id' | 'scores' | 'reasonText'>;

function scoreCandidate(
  cand: RawCandidate,
  cues: SubtitleCue[],
  totalVideoDuration: number,
  config: CandidateConfig
): CandidateScores {
  const startCue = cues[cand.cueStartIndex];
  const endCue = cues[cand.cueEndIndex];
  const prevCue = cand.cueStartIndex > 0 ? cues[cand.cueStartIndex - 1] : null;
  const nextCue =
    cand.cueEndIndex < cues.length - 1 ? cues[cand.cueEndIndex + 1] : null;
  const startText = startCue.text.trim();

  // ─── completeness ────────────────────────────
  const startsFresh = !prevCue || endsSentence(prevCue.text);
  const endsClean = endsSentence(endCue.text);
  const completeness = clamp01(
    (startsFresh ? 0.5 : 0.2) + (endsClean ? 0.5 : 0.15)
  );

  // ─── hook ────────────────────────────────────
  const openingText = cues
    .slice(cand.cueStartIndex, Math.min(cand.cueEndIndex + 1, cand.cueStartIndex + 2))
    .map((c) => c.text)
    .join('');
  const hook = HOOK_WORDS.test(openingText) ? 0.9 : 0.55;

  // ─── contextIndependence(高=不依賴前文) ─────
  let contextIndependence = 1.0;
  if (CONTINUATION_WORDS.test(startText)) contextIndependence -= 0.5;
  if (PRONOUN_START.test(startText)) contextIndependence -= 0.3;
  contextIndependence = clamp01(contextIndependence);

  // ─── speechDensity(語音實際覆蓋率) ──────────
  let sumCueDur = 0;
  for (let i = cand.cueStartIndex; i <= cand.cueEndIndex; i++) {
    sumCueDur += cues[i].end - cues[i].start;
  }
  const speechDensity =
    cand.duration > 0 ? clamp01(sumCueDur / cand.duration) : 0;

  // ─── boundaryQuality(前後停頓越大越好) ─────
  const gapBefore = prevCue ? Math.max(0, startCue.start - prevCue.end) : 1.0;
  const gapAfter = nextCue ? Math.max(0, nextCue.start - endCue.end) : 1.0;
  const boundaryQuality = clamp01((gapBefore + gapAfter) / 1.4);

  // ─── informationDensity(unique chars / total chars) ─
  const informationDensity = computeInformationDensity(cand.text);

  // ─── durationScore ──────────────────────────
  const durationScore = computeDurationScore(cand.duration, config);

  // ─── introPenalty ───────────────────────────
  const nearStart = cand.start < 20;
  const hasIntro = INTRO_WORDS.test(cand.text.slice(0, 80));
  let introPenalty = 0;
  if (hasIntro && nearStart) introPenalty = 0.9;
  else if (hasIntro) introPenalty = 0.4;
  else if (nearStart) introPenalty = 0.15;

  // ─── outroPenalty ───────────────────────────
  const nearEnd =
    totalVideoDuration > 0 && cand.end > totalVideoDuration - 30;
  const hasOutro = OUTRO_WORDS.test(cand.text.slice(-100));
  let outroPenalty = 0;
  if (hasOutro && nearEnd) outroPenalty = 0.9;
  else if (hasOutro) outroPenalty = 0.4;
  else if (nearEnd) outroPenalty = 0.1;

  const totalScore =
    completeness * 0.20 +
    hook * 0.15 +
    contextIndependence * 0.10 +
    speechDensity * 0.10 +
    boundaryQuality * 0.10 +
    informationDensity * 0.10 +
    durationScore * 0.10 -
    introPenalty * 0.10 -
    outroPenalty * 0.05;

  return {
    completeness: round2(completeness),
    hook: round2(hook),
    contextIndependence: round2(contextIndependence),
    speechDensity: round2(speechDensity),
    boundaryQuality: round2(boundaryQuality),
    informationDensity: round2(informationDensity),
    durationScore: round2(durationScore),
    introPenalty: round2(introPenalty),
    outroPenalty: round2(outroPenalty),
    totalScore: round2(totalScore),
  };
}

function computeInformationDensity(text: string): number {
  // 去掉空白與標點,計算 unique / total
  const clean = text.replace(/[\s，。!?！？、;;:「」『』()（）'"…—-]/g, '');
  if (clean.length === 0) return 0;
  const uniq = new Set<string>();
  // 用 2-gram(中文 bi-gram)當粗略資訊量指標
  if (clean.length < 2) {
    uniq.add(clean);
  } else {
    for (let i = 0; i < clean.length - 1; i++) {
      uniq.add(clean.slice(i, i + 2));
    }
  }
  const total = clean.length - 1 || 1;
  return clamp01(uniq.size / total);
}

function computeDurationScore(dur: number, cfg: CandidateConfig): number {
  const { targetDurationMin: tMin, targetDurationMax: tMax } = cfg;
  const { minDuration: hMin, maxDuration: hMax } = cfg;
  if (dur >= tMin && dur <= tMax) return 1;
  if (dur < tMin) {
    if (dur <= hMin) return 0.5;
    return 0.5 + ((dur - hMin) / (tMin - hMin)) * 0.5;
  }
  if (dur >= hMax) return 0.5;
  return 1 - ((dur - tMax) / (hMax - tMax)) * 0.5;
}

function reasonText(s: CandidateScores): string {
  const bullets: string[] = [];
  if (s.completeness >= 0.75) bullets.push('段落完整');
  if (s.hook >= 0.75) bullets.push('開頭有明確重點');
  if (s.speechDensity >= 0.75) bullets.push('語音密度高');
  if (s.boundaryQuality >= 0.65) bullets.push('前後有自然停頓');
  if (s.informationDensity >= 0.75 && bullets.length < 3) bullets.push('資訊量豐富');
  if (s.contextIndependence >= 0.85 && bullets.length < 3) bullets.push('不需前文也懂');
  if (bullets.length === 0) {
    if (s.introPenalty > 0.5) return '雖偏向開場但目前語意最完整';
    if (s.outroPenalty > 0.5) return '雖偏向收尾但目前語意最完整';
    return '目前語意最完整的一段';
  }
  return bullets.slice(0, 3).join('、');
}

// ---------------------------------------------------------------------------
// Candidate enumeration
// ---------------------------------------------------------------------------

function cueText(cues: SubtitleCue[], from: number, to: number): string {
  return cues
    .slice(from, to + 1)
    .map((c) => c.text)
    .join(' ')
    .trim();
}

function isSentenceStart(cues: SubtitleCue[], i: number, pauseGap: number): boolean {
  if (i === 0) return true;
  const prev = cues[i - 1];
  const cur = cues[i];
  if (endsSentence(prev.text)) return true;
  return cur.start - prev.end >= pauseGap;
}

function isSentenceEnd(cues: SubtitleCue[], i: number, pauseGap: number): boolean {
  if (i === cues.length - 1) return true;
  const cur = cues[i];
  const next = cues[i + 1];
  if (endsSentence(cur.text)) return true;
  return next.start - cur.end >= pauseGap;
}

export function buildCandidates(
  cues: SubtitleCue[],
  config: CandidateConfig = DEFAULT_CANDIDATE_CONFIG
): HighlightCandidate[] {
  if (cues.length === 0) return [];

  let raw = collect(cues, config, { requireBoundaries: true, relaxDuration: false });
  if (raw.length === 0)
    raw = collect(cues, config, { requireBoundaries: false, relaxDuration: false });
  if (raw.length === 0)
    raw = collect(cues, config, { requireBoundaries: false, relaxDuration: true });
  if (raw.length === 0) {
    const first = cues[0];
    const last = cues[cues.length - 1];
    raw = [
      {
        start: first.start,
        end: last.end,
        duration: Number((last.end - first.start).toFixed(3)),
        cueStartIndex: 0,
        cueEndIndex: cues.length - 1,
        text: cueText(cues, 0, cues.length - 1),
      },
    ];
  }

  const totalVideoDuration = cues[cues.length - 1].end;

  const scored: HighlightCandidate[] = raw.map((c, idx) => {
    const scores = scoreCandidate(c, cues, totalVideoDuration, config);
    return {
      ...c,
      id: `tmp_${idx}`,
      scores,
      reasonText: reasonText(scores),
    };
  });

  scored.sort((a, b) => b.scores!.totalScore - a.scores!.totalScore);
  const deduped = removeOverlaps(scored, config.overlapThreshold);
  const top = deduped.slice(0, config.maxCandidates);
  top.sort((a, b) => a.start - b.start);

  return top.map((c, i) => ({ ...c, id: `candidate_${i + 1}` }));
}

function collect(
  cues: SubtitleCue[],
  config: CandidateConfig,
  opts: { requireBoundaries: boolean; relaxDuration: boolean }
): RawCandidate[] {
  const minD = opts.relaxDuration ? Math.min(8, config.minDuration) : config.minDuration;
  const maxD = opts.relaxDuration ? config.maxDuration * 1.5 : config.maxDuration;

  const found: RawCandidate[] = [];

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
      break;
    }
  }
  return dedupeExact(found);
}

function dedupeExact<T extends { cueStartIndex: number; cueEndIndex: number }>(
  list: T[]
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of list) {
    const key = `${c.cueStartIndex}:${c.cueEndIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function removeOverlaps(
  sortedDesc: HighlightCandidate[],
  threshold: number
): HighlightCandidate[] {
  const kept: HighlightCandidate[] = [];
  outer: for (const cand of sortedDesc) {
    for (const k of kept) {
      const overlap = Math.max(
        0,
        Math.min(cand.end, k.end) - Math.max(cand.start, k.start)
      );
      const minDur = Math.min(cand.duration, k.duration);
      if (minDur > 0 && overlap / minDur > threshold) continue outer;
    }
    kept.push(cand);
  }
  return kept;
}

export function pickDefaultCandidate(
  candidates: HighlightCandidate[]
): HighlightCandidate | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = best.scores?.totalScore ?? -Infinity;
  for (const c of candidates) {
    const s = c.scores?.totalScore ?? -Infinity;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
