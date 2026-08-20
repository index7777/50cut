import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SEGMENTER_CONFIG,
  buildSubtitleTimeline,
  segmentWords,
  subdivideSegments,
} from './subtitle-segmenter';
import type { TranscriptWord } from './types';

const CFG = DEFAULT_SEGMENTER_CONFIG;

/** 依每字固定時長造 word,gaps 指定第 n 個字之前要插入多長的停頓 */
function words(
  text: string,
  perChar = 0.18,
  gaps: Record<number, number> = {}
): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let t = 0;
  [...text].forEach((ch, i) => {
    t += gaps[i] ?? 0;
    out.push({ text: ch, start: Number(t.toFixed(3)), end: Number((t + perChar).toFixed(3)) });
    t += perChar;
  });
  return out;
}

describe('segmentWords', () => {
  it('cue 的 start/end 一律等於實際 word 的時間戳', () => {
    const w = words('別走今晚別走');
    const cues = segmentWords(w, CFG);
    assert.ok(cues.length >= 1);
    for (const cue of cues) {
      const first = cue.words[0];
      const last = cue.words[cue.words.length - 1];
      assert.equal(cue.start, first.start, 'cue.start 必須來自 word');
      assert.equal(cue.end, last.end, 'cue.end 必須來自 word');
      assert.equal(cue.timing, 'exact');
    }
  });

  it('停頓超過 pauseSplit 時切開', () => {
    // 第 3 個字之前插入 0.8 秒停頓
    const w = words('別走今晚別走', 0.18, { 3: 0.8 });
    const cues = segmentWords(w, CFG);
    assert.ok(cues.length >= 2, `應該切成至少 2 段，實際 ${cues.length}`);
    assert.equal(cues[0].text, '別走今');
    assert.equal(cues[1].text, '晚別走');
  });

  it('不超過 maxChars', () => {
    const w = words('一二三四五六七八九十十一十二十三十四十五十六十七十八');
    const cues = segmentWords(w, CFG);
    for (const cue of cues) {
      assert.ok(
        cue.text.replace(/\s/g, '').length <= CFG.maxChars + 4,
        `cue「${cue.text}」超過字數上限`
      );
    }
  });

  it('不超過 maxDuration', () => {
    // 每字 0.5 秒 → 光 8 個字就 4 秒,必須被時間規則切開
    const w = words('一二三四五六七八九十', 0.5);
    const cues = segmentWords(w, CFG);
    for (const cue of cues) {
      assert.ok(
        cue.end - cue.start <= CFG.maxDuration + 1,
        `cue「${cue.text}」長 ${(cue.end - cue.start).toFixed(2)}s 超過上限`
      );
    }
  });

  it('遇到句末標點優先切', () => {
    const w = words('別走。是我', 0.18);
    const cues = segmentWords(w, CFG);
    assert.ok(cues.length >= 2, '句號後應該換一段');
    assert.equal(cues[0].text, '別走。');
  });

  it('標點不會單獨成為一段字幕的開頭', () => {
    const w = words('別走今晚別走，是我', 0.18, { 6: 0.9 });
    const cues = segmentWords(w, CFG);
    for (const cue of cues) {
      assert.ok(
        !/^[，,。、！？]/.test(cue.text),
        `cue「${cue.text}」不該以標點開頭`
      );
    }
  });

  it('不產生極短且沒語意的字幕', () => {
    const w = words('好啊我知道了', 0.1);
    const cues = segmentWords(w, CFG);
    for (const cue of cues) {
      const stripped = cue.text.replace(/[\s。，、！？!?]/g, '');
      assert.ok(stripped.length >= 1, `cue「${cue.text}」沒有實質內容`);
    }
  });

  it('文字不遺漏、不重複', () => {
    const text = '別走今晚別走是你那就記住是我';
    const cues = segmentWords(words(text), CFG);
    assert.equal(cues.map((c) => c.text).join(''), text);
  });

  it('cue 之間時間單調遞增且不重疊', () => {
    const w = words('別走今晚別走是你那就記住是我', 0.18, { 6: 0.6, 9: 0.5 });
    const cues = segmentWords(w, CFG);
    for (let i = 1; i < cues.length; i++) {
      assert.ok(
        cues[i].start >= cues[i - 1].end - 1e-9,
        `cue ${i} 與前一段重疊`
      );
    }
  });

  it('27 秒對話不會只產生 1 段字幕(回歸測試)', () => {
    // 模擬 27 秒、150 個字、中間有數次停頓
    const text = '別'.repeat(150);
    const gaps: Record<number, number> = {};
    for (let i = 10; i < 150; i += 10) gaps[i] = 0.6;
    const cues = segmentWords(words(text, 0.12, gaps), CFG);
    assert.ok(cues.length >= 10, `27 秒應該切成多段，實際只有 ${cues.length} 段`);
  });

  it('空輸入回空陣列', () => {
    assert.deepEqual(segmentWords([], CFG), []);
  });
});

describe('subdivideSegments (fallback)', () => {
  it('沒有 word 時在 segment 內保守切分，並標記 estimated', () => {
    const cues = subdivideSegments(
      [{ start: 0, end: 20, text: '別走，今晚別走。是你？那就記住，是我。' }],
      CFG
    );
    assert.ok(cues.length > 1, '應該在 segment 內切成多段');
    for (const cue of cues) {
      assert.equal(cue.timing, 'estimated', '必須標記為估算');
      assert.deepEqual(cue.words, [], '不可假造 word 時間戳');
    }
  });

  it('estimated cue 覆蓋整個 segment 且不超出邊界', () => {
    const cues = subdivideSegments(
      [{ start: 5, end: 15, text: '一句。兩句。三句。' }],
      CFG
    );
    assert.equal(cues[0].start, 5);
    assert.equal(cues[cues.length - 1].end, 15);
    for (const cue of cues) {
      assert.ok(cue.start >= 5 && cue.end <= 15);
      assert.ok(cue.end > cue.start);
    }
  });
});

describe('buildSubtitleTimeline', () => {
  it('有 word 就走精準路徑', () => {
    const cues = buildSubtitleTimeline({
      words: words('別走今晚別走'),
      segments: [{ start: 0, end: 30, text: '別走今晚別走' }],
    });
    assert.equal(cues[0].timing, 'exact');
  });

  it('沒有 word 才退回估算', () => {
    const cues = buildSubtitleTimeline({
      words: [],
      segments: [{ start: 0, end: 30, text: '別走，今晚別走。是你？' }],
    });
    assert.ok(cues.length > 0);
    assert.equal(cues[0].timing, 'estimated');
  });
});
