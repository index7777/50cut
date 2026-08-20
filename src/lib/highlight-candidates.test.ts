import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CANDIDATE_CONFIG,
  buildCandidates,
  pickDefaultCandidate,
} from './highlight-candidates';
import type { SubtitleCue } from './types';

const CFG = DEFAULT_CANDIDATE_CONFIG;

/** 造一串 cue:每段 2 秒,每 3 段結尾加句號 */
function makeCues(count: number, perCue = 2): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * perCue;
    const end = start + perCue;
    const sentenceEnd = (i + 1) % 3 === 0;
    out.push({
      start,
      end,
      text: `第${i}句${sentenceEnd ? '。' : '，'}`,
      words: [{ text: `第${i}句`, start, end }],
      timing: 'exact',
    });
  }
  return out;
}

describe('buildCandidates', () => {
  it('候選的 start/end 一律等於某個 cue 的邊界', () => {
    const cues = makeCues(40);
    const starts = new Set(cues.map((c) => c.start));
    const ends = new Set(cues.map((c) => c.end));
    const candidates = buildCandidates(cues, CFG);
    assert.ok(candidates.length > 0);
    for (const c of candidates) {
      assert.ok(starts.has(c.start), `start ${c.start} 不在 cue 邊界上`);
      assert.ok(ends.has(c.end), `end ${c.end} 不在 cue 邊界上`);
    }
  });

  it('候選長度落在目標區間', () => {
    const candidates = buildCandidates(makeCues(60), CFG);
    for (const c of candidates) {
      assert.ok(
        c.duration >= CFG.minDuration && c.duration <= CFG.maxDuration,
        `候選 ${c.id} 長 ${c.duration}s 不在 ${CFG.minDuration}-${CFG.maxDuration} 區間`
      );
    }
  });

  it('起點是完整句子的開頭(前一句以句號結束)', () => {
    const cues = makeCues(60);
    const candidates = buildCandidates(cues, CFG);
    for (const c of candidates) {
      if (c.cueStartIndex === 0) continue;
      const prev = cues[c.cueStartIndex - 1];
      const gap = cues[c.cueStartIndex].start - prev.end;
      assert.ok(
        /[。！？!?…]$/.test(prev.text.trim()) || gap >= CFG.pauseGap,
        `候選 ${c.id} 從半句開始(前一句「${prev.text}」)`
      );
    }
  });

  it('終點是完整句子的結尾', () => {
    const cues = makeCues(60);
    const candidates = buildCandidates(cues, CFG);
    for (const c of candidates) {
      if (c.cueEndIndex === cues.length - 1) continue;
      const cur = cues[c.cueEndIndex];
      const gap = cues[c.cueEndIndex + 1].start - cur.end;
      assert.ok(
        /[。！？!?…]$/.test(cur.text.trim()) || gap >= CFG.pauseGap,
        `候選 ${c.id} 結尾切在半句(「${cur.text}」)`
      );
    }
  });

  it('不超過 maxCandidates', () => {
    const candidates = buildCandidates(makeCues(200), CFG);
    assert.ok(
      candidates.length <= CFG.maxCandidates,
      `候選 ${candidates.length} 個超過上限 ${CFG.maxCandidates}`
    );
  });

  it('id 唯一且連號', () => {
    const candidates = buildCandidates(makeCues(80), CFG);
    const ids = candidates.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, 'id 有重複');
    candidates.forEach((c, i) => assert.equal(c.id, `candidate_${i + 1}`));
  });

  it('影片太短時仍給得出至少一個對齊邊界的候選', () => {
    const cues = makeCues(3); // 只有 6 秒
    const candidates = buildCandidates(cues, CFG);
    assert.ok(candidates.length >= 1);
    assert.equal(candidates[0].start, cues[0].start);
    assert.equal(candidates[0].end, cues[cues.length - 1].end);
  });

  it('空 cue 回空陣列', () => {
    assert.deepEqual(buildCandidates([], CFG), []);
  });
});

describe('pickDefaultCandidate', () => {
  it('沒有 AI 時也能 deterministic 選出一個', () => {
    const candidates = buildCandidates(makeCues(60), CFG);
    const a = pickDefaultCandidate(candidates, CFG);
    const b = pickDefaultCandidate(candidates, CFG);
    assert.ok(a);
    assert.equal(a!.id, b!.id, '同樣輸入必須得到同樣結果');
  });

  it('空清單回 null', () => {
    assert.equal(pickDefaultCandidate([], CFG), null);
  });
});
