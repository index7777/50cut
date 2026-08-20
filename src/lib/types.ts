/**
 * 共用型別。
 *
 * 時間軸原則(不可違反):
 *  - TranscriptWord.start/end 一律來自 ASR 的真實語音時間戳。
 *  - SubtitleCue.start/end 一律由 deterministic segmenter 從 word 邊界取得,
 *    絕不由 LLM 產生或修改。
 *  - 只有在 ASR 拿不到 word-level 時間戳時,才在 segment 內做保守 subdivision,
 *    並把 timing 標成 'estimated',讓 UI 有辦法誠實呈現。
 */

/** 時間精度來源 */
export type TimingSource = 'exact' | 'estimated';

/** ASR 回傳的最小時間單位(中文通常是字或短詞) */
export type TranscriptWord = {
  text: string;
  start: number; // seconds
  end: number; // seconds
  confidence?: number;
};

/** 一段可顯示的字幕 */
export type SubtitleCue = {
  start: number; // seconds
  end: number; // seconds
  text: string;
  words: TranscriptWord[];
  /** 這段時間是精準語音時間戳,還是 segment 內的估算 */
  timing: TimingSource;
};

/**
 * Whisper verbose_json 的 segment(utterance 級,較粗)。
 * 保留下來只為了 fallback 與除錯,不直接當最終字幕。
 */
export type TranscriptSegment = {
  start: number; // seconds
  end: number; // seconds
  text: string;
};

export type TranscribeResponse = {
  language: string;
  duration: number;
  /** ASR 最細粒度時間戳。可能為空(provider 沒給) */
  words: TranscriptWord[];
  /** ASR 自己的粗分段,fallback 用 */
  segments: TranscriptSegment[];
  /** words 是否可用 → 決定字幕時間是 exact 還是 estimated */
  timingSource: TimingSource;
  full_text: string;
};

export type ApiError = {
  error: string;
  code?: string;
};

// ---------------------------------------------------------------------------
// Proofreading:AI 只能回文字 patch,不能碰時間
// ---------------------------------------------------------------------------

export type ProofreadCorrection = {
  /** 對應 cue 的索引 */
  index: number;
  /** 原本的錯字片段 */
  from: string;
  /** 要改成的正確文字 */
  to: string;
};

export type ProofreadResponse = {
  corrections: ProofreadCorrection[];
};

// ---------------------------------------------------------------------------
// Highlight:系統產生候選,AI 只做排序
// ---------------------------------------------------------------------------

export type HighlightCandidate = {
  id: string;
  /** 一律等於某個 cue 的 start */
  start: number;
  /** 一律等於某個 cue 的 end */
  end: number;
  duration: number;
  /** 該範圍內的 cue 索引(含頭尾) */
  cueStartIndex: number;
  cueEndIndex: number;
  text: string;
};

export type HighlightScores = {
  hook: number;
  completeness: number;
  emotion: number;
  shareability: number;
};

/** Gemini 排序後回傳的原始形狀 */
export type HighlightRanking = {
  selectedCandidateId: string;
  title: string;
  reason: string;
  scores: HighlightScores;
  hashtags?: string[];
};

export type Highlight = {
  start: number; // seconds — 取自候選片段,非 AI 產生
  end: number; // seconds
  reason: string;
};

export type HighlightResponse = {
  highlight: Highlight;
  title: string;
  hashtags: string[];
  scores?: HighlightScores;
  /** 選中的候選 id;手動選取時為 null */
  candidateId: string | null;
  /** 候選清單,讓使用者可以換一個 */
  candidates: HighlightCandidate[];
};
