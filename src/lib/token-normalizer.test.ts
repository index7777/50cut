import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWords } from './token-normalizer';
import type { TranscriptWord } from './types';
import type { DictEntry } from './dictionary';

function w(text: string, start: number, end: number): TranscriptWord {
  return { text, start, end };
}

const DICT: DictEntry[] = [
  { wrong: 'App le Watch', right: 'Apple Watch' },
  { wrong: 'App le', right: 'Apple' },
  { wrong: 'i Phone', right: 'iPhone' },
  { wrong: 'P ock ets', right: 'Podcasts' },
  { wrong: 'Air Pods', right: 'AirPods' },
  { wrong: 'Pod cast', right: 'Podcast' },
];

test('中文原樣通過', () => {
  const out = normalizeWords([w('你', 0, 0.2), w('好', 0.2, 0.4)], DICT);
  assert.deepEqual(out.map((t) => t.text), ['你', '好']);
});

test('相鄰 ASCII sub-word 合併(無空格)', () => {
  // "App" + "le" gap 0.02 秒 → "Apple"
  const out = normalizeWords(
    [w('App', 1.0, 1.2), w('le', 1.22, 1.4)],
    []
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Apple');
  assert.equal(out[0].start, 1.0);
  assert.equal(out[0].end, 1.4);
});

test('字典把「App le Watch」修成「Apple Watch」', () => {
  const out = normalizeWords(
    [w('App', 1.0, 1.2), w('le', 1.22, 1.4), w('Watch', 1.5, 1.9)],
    DICT
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Apple Watch');
  assert.equal(out[0].start, 1.0);
  assert.equal(out[0].end, 1.9);
});

test('字典把「i Phone」修成「iPhone」', () => {
  const out = normalizeWords(
    [w('i', 2.0, 2.1), w('Phone', 2.12, 2.5)],
    DICT
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'iPhone');
});

test('字典把「P ock ets」修成「Podcasts」', () => {
  const out = normalizeWords(
    [w('P', 0.5, 0.6), w('ock', 0.6, 0.8), w('ets', 0.8, 1.0)],
    DICT
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Podcasts');
});

test('中英夾雜:中文 + Apple Watch + 中文', () => {
  const words = [
    w('我', 0.0, 0.2),
    w('用', 0.2, 0.4),
    w('App', 0.5, 0.7),
    w('le', 0.72, 0.85),
    w('Watch', 0.9, 1.2),
    w('聽', 1.3, 1.5),
  ];
  const out = normalizeWords(words, DICT);
  assert.deepEqual(out.map((t) => t.text), ['我', '用', 'Apple Watch', '聽']);
});

test('停頓超過 PHRASE_GAP 則不合併', () => {
  // "Apple" 說完後停 0.8 秒才說 "Watch"
  const out = normalizeWords(
    [w('Apple', 0.0, 0.4), w('Watch', 1.2, 1.6)],
    DICT
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'Apple');
  assert.equal(out[1].text, 'Watch');
});

test('大小寫不敏感', () => {
  const out = normalizeWords(
    [w('app', 0, 0.2), w('LE', 0.21, 0.4)],
    DICT
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Apple');
});

test('數字 + 單字元字母 → 合併(3 C → 3C)', () => {
  const out = normalizeWords(
    [w('3', 0, 0.2), w('C', 0.22, 0.4)],
    []
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '3C');
});

test('沒被字典命中的英文 phrase 保留空格', () => {
  // 兩個英文詞 gap 較大(0.15s),不字典也不合子詞判定
  const out = normalizeWords(
    [w('hello', 0.0, 0.3), w('world', 0.5, 0.9)],
    []
  );
  // 兩個 tokens gap 0.2 > SUBWORD_GAP 但 < PHRASE_GAP → 合併保留空格
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'hello world');
});

test('保留時間戳的絕對範圍', () => {
  const out = normalizeWords(
    [w('App', 3.14, 3.28), w('le', 3.30, 3.50), w('Watch', 3.55, 3.99)],
    DICT
  );
  assert.equal(out[0].start, 3.14);
  assert.equal(out[0].end, 3.99);
});

test('空白/空 token 過濾', () => {
  const out = normalizeWords(
    [w('', 0, 0), w(' ', 0.1, 0.2), w('你好', 0.3, 0.6)],
    []
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '你好');
});
