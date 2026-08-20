/**
 * 內建常見英文科技詞、專有名詞的修正字典。
 *
 * 適用順序(pipeline.runProofreadAndSegment):
 *   Whisper 輸出 → 合併相鄰 ASCII words → 內建字典 → 使用者個人字典 → Gemini proofread
 *
 * 目的:即使 Gemini 掛掉或額度用完,常見錯字也能自動修正。
 *
 * 收錄原則:只放**wrong 側不可能有其他語意**的對照。
 * 例如「App le」在正常文本裡不會出現,可安全替換為「Apple」。
 * 有歧義的詞(例如 pockets 可能真的指口袋)不放這裡。
 */

import type { DictEntry } from './dictionary';

export const BUILTIN_DICTIONARY: DictEntry[] = [
  // ── Apple 生態系 ──
  { wrong: 'i Phone', right: 'iPhone' },
  { wrong: 'I Phone', right: 'iPhone' },
  { wrong: 'iPhone se', right: 'iPhone SE' },
  { wrong: 'App le Watch', right: 'Apple Watch' },
  { wrong: 'App le watch', right: 'Apple Watch' },
  { wrong: 'App le', right: 'Apple' },
  { wrong: 'i Pad', right: 'iPad' },
  { wrong: 'I Pad', right: 'iPad' },
  { wrong: 'i Cloud', right: 'iCloud' },
  { wrong: 'I Cloud', right: 'iCloud' },
  { wrong: 'i Mac', right: 'iMac' },
  { wrong: 'i OS', right: 'iOS' },
  { wrong: 'i Message', right: 'iMessage' },
  { wrong: 'i Tunes', right: 'iTunes' },
  { wrong: 'Mac Book', right: 'MacBook' },
  { wrong: 'mac Book', right: 'MacBook' },
  { wrong: 'mac book', right: 'MacBook' },
  { wrong: 'Air Pods', right: 'AirPods' },
  { wrong: 'air pods', right: 'AirPods' },
  { wrong: 'Air Pod', right: 'AirPod' },
  { wrong: 'Air Tag', right: 'AirTag' },
  { wrong: 'Home Pod', right: 'HomePod' },
  { wrong: 'Apple TV', right: 'Apple TV' },
  { wrong: 'app store', right: 'App Store' },
  { wrong: 'App store', right: 'App Store' },
  { wrong: 'Face ID', right: 'Face ID' },
  { wrong: 'Touch ID', right: 'Touch ID' },

  // ── Podcast / 音訊 ──
  { wrong: 'Pod cast', right: 'Podcast' },
  { wrong: 'pod cast', right: 'Podcast' },
  { wrong: 'Pod casts', right: 'Podcasts' },
  { wrong: 'pod casts', right: 'Podcasts' },
  { wrong: 'Pock ets', right: 'Podcasts' }, // Whisper 常誤聽成 Pockets
  { wrong: 'P ock ets', right: 'Podcasts' },
  { wrong: 'p ock ets', right: 'Podcasts' },
  { wrong: 'Pod Cast', right: 'Podcast' },

  // ── 網路服務 / 社群 ──
  { wrong: 'You Tube', right: 'YouTube' },
  { wrong: 'you tube', right: 'YouTube' },
  { wrong: 'Face book', right: 'Facebook' },
  { wrong: 'face book', right: 'Facebook' },
  { wrong: 'Insta gram', right: 'Instagram' },
  { wrong: 'insta gram', right: 'Instagram' },
  { wrong: 'Tik Tok', right: 'TikTok' },
  { wrong: 'tik tok', right: 'TikTok' },
  { wrong: 'What sApp', right: 'WhatsApp' },
  { wrong: 'Line Pay', right: 'LINE Pay' },
  { wrong: 'Google Pay', right: 'Google Pay' },
  { wrong: 'Chat GPT', right: 'ChatGPT' },
  { wrong: 'chat GPT', right: 'ChatGPT' },
  { wrong: 'chat gpt', right: 'ChatGPT' },
  { wrong: 'chatgpt', right: 'ChatGPT' },
  { wrong: 'Open AI', right: 'OpenAI' },
  { wrong: 'open ai', right: 'OpenAI' },
  { wrong: 'Anthro pic', right: 'Anthropic' },
  { wrong: 'Deep Seek', right: 'DeepSeek' },
  { wrong: 'deep seek', right: 'DeepSeek' },
  { wrong: 'Git Hub', right: 'GitHub' },
  { wrong: 'git hub', right: 'GitHub' },
  { wrong: 'Threads', right: 'Threads' },
  { wrong: 'LinkedIn', right: 'LinkedIn' },

  // ── 常見裝置 / 系統 ──
  { wrong: 'Note book', right: 'Notebook' },
  { wrong: 'note book', right: 'Notebook' },
  { wrong: 'Wi Fi', right: 'Wi-Fi' },
  { wrong: 'wi fi', right: 'Wi-Fi' },
  { wrong: 'Blue tooth', right: 'Bluetooth' },
  { wrong: 'blue tooth', right: 'Bluetooth' },
  { wrong: 'Type C', right: 'Type-C' },
  { wrong: 'type c', right: 'Type-C' },
  { wrong: 'USB C', right: 'USB-C' },
  { wrong: 'HDMI', right: 'HDMI' },
];

/**
 * 排序後的字典:長 key 先(避免子字串衝突)。
 * 例如「App le Watch」要先於「App le」被匹配。
 */
export function getBuiltinDictionary(): DictEntry[] {
  return [...BUILTIN_DICTIONARY].sort((a, b) => b.wrong.length - a.wrong.length);
}
