/**
 * 字幕顯示層格式化。
 *
 * 職責:只影響「顯示與輸出」,不動 canonical transcript。
 *
 * 呼叫端契約:
 *   preview UI 顯示字幕文字前 → formatSubtitleText(cue.text, mode)
 *   ffmpeg 燒字幕前          → formatSubtitleText(cue.text, mode)
 *
 * 底層 SubtitleCue.text 永遠保留完整標點,不會因為 mode 而被改動。
 * mode 不可影響:start / end / cue 順序 / cue 數量。
 */

export type PunctuationMode = 'auto' | 'show' | 'hide';

export const DEFAULT_PUNCTUATION_MODE: PunctuationMode = 'auto';

/** CJK Unified Ideographs 判斷用 */
const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf';

/**
 * 全形標點 — 一律移除(不會影響英文/URL/數字/版本號)。
 * 包含常見的中文標點、書名號、引號、破折、間隔等。
 */
const FULL_WIDTH_PUNCT_RE =
  /[，。！？、；：（）「」『』《》〈〉〝〞……—·・‧]/g;

/**
 * 字幕顯示格式化。
 *  - show:  原樣回傳(canonical)
 *  - hide:  移除顯示用標點
 *  - auto:  MVP 階段等同 show(未來可依影片類型自動判斷)
 */
export function formatSubtitleText(text: string, mode: PunctuationMode): string {
  if (!text) return text;
  if (mode === 'hide') return removeDisplayPunctuation(text);
  return text; // show / auto → 原樣
}

/**
 * 只移除「顯示標點」,保留:
 *   英文單字 / 品牌 / URL / email / 版本號 / 小數 / 縮寫
 * 規則:
 *   1. 全形中文標點:一律移除
 *   2. ASCII 標點(. , ! ? ; :):只在「與 CJK 相鄰」時移除
 *   3. 結尾懸掛的 ASCII 標點:移除
 *   4. 保留多字元 ellipsis(如 "..."):不動(除非結尾)
 */
export function removeDisplayPunctuation(text: string): string {
  let out = text;

  // 1. 全形標點
  out = out.replace(FULL_WIDTH_PUNCT_RE, '');

  // 2. ASCII 標點與 CJK 相鄰:移除
  //    "有興趣," → "有興趣"
  //    ",歡迎" → "歡迎"
  out = out.replace(new RegExp(`([${CJK}])[.,!?;:]+`, 'g'), '$1');
  out = out.replace(new RegExp(`[.,!?;:]+([${CJK}])`, 'g'), '$1');

  // 3. 字串結尾懸掛的 ASCII 標點:移除
  //    "great." → "great"
  //    "17.2" → "17.2"(前面不是標點,不會被吃)
  out = out.replace(/[.,!?;:]+\s*$/, '');

  // 4. 收合連續空白但不 trim 前後單一 space(避免破壞 "Apple Watch")
  out = out.replace(/[ \t]{2,}/g, ' ').trim();

  return out;
}
