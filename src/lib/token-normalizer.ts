/**
 * Token 正規化層。
 *
 * 責任邊界:
 *   ASR 決定「什麼時候說」 → words[] (word-level timestamp)
 *   Normalizer 決定「這些 token 是什麼詞」 ← 本檔
 *   Segmenter 決定「字幕在哪裡換行、切段」
 *   AI 只協助語意與拼字
 *
 * 這一層負責:
 * 1. 相鄰 ASCII tokens(如「App」「le」)合併成原子詞「Apple」
 * 2. 套用字典把常見錯拆修回(「i Phone」→「iPhone」)
 * 3. 標記為 protected → 下游 segmenter 不得從中間切開
 *
 * 時間戳一律取 group 首尾 token 的真實時間,絕不由字典改動。
 */

import type { TranscriptWord } from '@/lib/types';
import type { DictEntry } from '@/lib/dictionary';

/** 只含 ASCII 字母、數字、apostrophe、hyphen、dot,允許前後空白 */
const ASCII_ONLY = /^[A-Za-z0-9'\-.]+$/;

/** phrase 內部 tokens 之間可容忍的最大停頓(超過就不算同一詞組) */
const PHRASE_GAP = 0.35;

/** 判定「Whisper 把一個詞拆成子詞」的最大停頓(比 PHRASE_GAP 嚴) */
const SUBWORD_GAP = 0.06;

/**
 * 把 raw words 正規化成「原子詞」。
 *
 * 輸出仍然是 TranscriptWord[](保留下游相容),但 text 已經是合併好的字串,
 * 例如 ["App", "le", "Watch"] → 一個 text="Apple Watch" 的 token。
 *
 * 下游 segmenter 只會用每個 token 的 text/start/end,不會、也不應再拆。
 */
export function normalizeWords(
  words: TranscriptWord[],
  dict: DictEntry[] = []
): TranscriptWord[] {
  if (!words || words.length === 0) return [];

  // 長 key 先(避免子字串衝突,例如「App le Watch」要早於「App le」)
  const sortedDict = [...dict].sort((a, b) => b.wrong.length - a.wrong.length);

  const out: TranscriptWord[] = [];
  let i = 0;

  while (i < words.length) {
    const w = words[i];
    const text = w.text.trim();

    if (!text || !isAsciiToken(text)) {
      // 中文、標點或空 token → pass through
      if (text) out.push({ ...w, text });
      i++;
      continue;
    }

    // 收集相鄰 ASCII tokens 成 group
    const group: TranscriptWord[] = [w];
    let j = i + 1;
    while (j < words.length) {
      const next = words[j];
      const nextText = next.text.trim();
      if (!isAsciiToken(nextText)) break;
      const gap = next.start - words[j - 1].end;
      if (gap > PHRASE_GAP) break;
      group.push({ ...next, text: nextText });
      j++;
    }

    const noSpace = group.map((g) => g.text).join('');
    const spaced = group.map((g) => g.text).join(' ');

    let normalizedText = spaced;

    // 1. 先試字典(case-insensitive + 空格彈性)
    let dictHit = false;
    for (const e of sortedDict) {
      const rx = dictPattern(e.wrong);
      if (!rx) continue;
      if (rx.test(spaced) || rx.test(noSpace)) {
        normalizedText = e.right;
        dictHit = true;
        break;
      }
    }

    // 2. 沒字典命中但看起來是子詞(gap 極小)→ 合併時不加空格
    if (!dictHit && group.length > 1) {
      const allSub = group.slice(1).every(
        (g, k) => g.start - group[k].end <= SUBWORD_GAP
      );
      if (allSub) normalizedText = noSpace;
    }

    // 3. 常見數字+單字元 pattern:「3 C」→「3C」、「4 K」→「4K」
    //    只在單字元 letter 前接 digit 且無字典結果時處理
    if (!dictHit && !ASCII_ONLY.test(normalizedText)) {
      // do nothing
    } else if (!dictHit && /^\d+\s+[A-Za-z]$/.test(normalizedText)) {
      normalizedText = normalizedText.replace(/\s+/g, '');
    }

    out.push({
      text: normalizedText,
      start: group[0].start,
      end: group[group.length - 1].end,
    });
    i = j;
  }

  // 4. 二次掃描:相鄰兩個原子詞的合併(當兩詞連寫命中字典)
  //    例如已產出 ["Apple", "Watch"] 兩個原子詞,字典有「Apple Watch」→「Apple Watch」的話沒差,
  //    但若字典裡的 key 是跨組(例如「App le Watch」→「Apple Watch」)在上一輪已合併掉。
  //    保留這個掃描以便未來加更複雜的 phrase(暫時 no-op)
  return out;
}

function isAsciiToken(s: string): boolean {
  return ASCII_ONLY.test(s);
}

/**
 * 字典字串 → case-insensitive、空格彈性的完整比對 regex。
 * `"App le Watch"` 可比對 `"App le Watch"`、`"AppleWatch"`、`"app  le  watch"`。
 */
function dictPattern(wrong: string): RegExp | null {
  const trimmed = wrong.trim();
  if (!trimmed) return null;
  const escaped = trimmed
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s*');
  try {
    return new RegExp(`^${escaped}$`, 'i');
  } catch {
    return null;
  }
}
