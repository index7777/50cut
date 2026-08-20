import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSubtitleText,
  removeDisplayPunctuation,
} from './subtitle-format';

test('show 模式:原樣', () => {
  assert.equal(
    formatSubtitleText('如果對這類影片有興趣,歡迎訂閱!', 'show'),
    '如果對這類影片有興趣,歡迎訂閱!'
  );
});

test('auto 模式:目前等同 show', () => {
  assert.equal(
    formatSubtitleText('你好,世界!', 'auto'),
    '你好,世界!'
  );
});

test('hide:移除中文標點', () => {
  assert.equal(
    formatSubtitleText('如果各位對這類影片有興趣,歡迎訂閱我的頻道,並打開小鈴鐺!', 'hide'),
    '如果各位對這類影片有興趣歡迎訂閱我的頻道並打開小鈴鐺'
  );
});

test('hide:保留英文品牌', () => {
  assert.equal(
    removeDisplayPunctuation('我用 Apple Watch 聽 Podcast,超方便!'),
    '我用 Apple Watch 聽 Podcast超方便'
  );
});

test('hide:保留版本號小數', () => {
  assert.equal(
    removeDisplayPunctuation('iPhone 17.2 剛更新!'),
    'iPhone 17.2 剛更新'
  );
});

test('hide:保留 URL', () => {
  assert.equal(
    removeDisplayPunctuation('請看 example.com 的說明。'),
    '請看 example.com 的說明'
  );
});

test('hide:保留 email', () => {
  assert.equal(
    removeDisplayPunctuation('寄到 test@email.com。'),
    '寄到 test@email.com'
  );
});

test('hide:保留 contractions', () => {
  assert.equal(
    removeDisplayPunctuation("I'm using Apple Watch。"),
    "I'm using Apple Watch"
  );
});

test('hide:結尾 ASCII 句號移除', () => {
  assert.equal(removeDisplayPunctuation('hello world.'), 'hello world');
});

test('hide:中間 ASCII 句號在字母間保留', () => {
  assert.equal(
    removeDisplayPunctuation('用 example.com 網站'),
    '用 example.com 網站'
  );
});

test('hide:空字串安全', () => {
  assert.equal(formatSubtitleText('', 'hide'), '');
});

test('hide:純標點會清空', () => {
  assert.equal(formatSubtitleText(',。!?', 'hide'), '');
});

test('hide:全形省略號會移除', () => {
  assert.equal(removeDisplayPunctuation('然後……就這樣'), '然後就這樣');
});

test('hide:破折號會移除', () => {
  assert.equal(removeDisplayPunctuation('答案是——沒有'), '答案是沒有');
});
