/**
 * 使用者個人字幕字典(localStorage)。
 * 每則影片辨識完後，自動把常錯字替換成正確字。
 */

export type DictEntry = { wrong: string; right: string };

const KEY = '50cut:dictionary';
const MAX_ENTRIES = 100;

export function loadDictionary(): DictEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e) =>
          e &&
          typeof e.wrong === 'string' &&
          typeof e.right === 'string' &&
          e.wrong.length > 0 &&
          e.wrong.length <= 50 &&
          e.right.length <= 50
      )
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveDictionary(entries: DictEntry[]): void {
  if (typeof window === 'undefined') return;
  const clean = entries
    .filter(
      (e) =>
        e.wrong.trim().length > 0 &&
        e.wrong.length <= 50 &&
        e.right.length <= 50
    )
    .slice(0, MAX_ENTRIES);
  window.localStorage.setItem(KEY, JSON.stringify(clean));
}

/**
 * 依字典替換文字中的錯字。長 key 先替換，避免子字串衝突。
 */
export function applyDictionary(text: string, dict: DictEntry[]): string {
  if (!text || dict.length === 0) return text;
  const sorted = [...dict].sort((a, b) => b.wrong.length - a.wrong.length);
  let out = text;
  for (const { wrong, right } of sorted) {
    if (!wrong) continue;
    // 用 split/join 做全部替換，避免 regex 特殊字元問題
    out = out.split(wrong).join(right);
  }
  return out;
}

/**
 * 從「原句 → 改後句」推出使用者實際改了哪段文字。
 * 用最長共同前綴+後綴夾出中間差異，只取有意義(≥1 字)且不太長(≤30 字)的替換。
 * 回 null 表示無法或不值得記錄。
 */
export function extractDiff(
  original: string,
  edited: string
): { wrong: string; right: string } | null {
  const a = original ?? '';
  const b = edited ?? '';
  if (!a || !b || a === b) return null;

  // 共同前綴
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  // 共同後綴
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const wrong = a.slice(start, endA);
  const right = b.slice(start, endB);

  // 過濾：太短(容易誤學)、太長(整句改寫沒學習意義)、只是標點差異
  if (wrong.length === 0 || wrong.length > 30) return null;
  if (right.length > 30) return null;

  // 只有標點/空白差異不學
  const stripPunct = (s: string) =>
    s.replace(/[\s。,、!?!?:;:()()"'「」『』…\-—\.]/g, '');
  if (stripPunct(wrong) === stripPunct(right)) return null;

  // wrong 不能全部是常見標點/單一字元(容易誤學)
  if (stripPunct(wrong).length < 1) return null;

  return { wrong, right };
}

/**
 * 加一組學到的對照。若 wrong 已存在，更新 right；否則加到最前面。
 * 回新的 entries array。
 */
export function upsertEntry(
  entries: DictEntry[],
  entry: DictEntry
): DictEntry[] {
  const idx = entries.findIndex((e) => e.wrong === entry.wrong);
  if (idx >= 0) {
    const next = [...entries];
    next[idx] = entry;
    return next;
  }
  return [entry, ...entries].slice(0, MAX_ENTRIES);
}
