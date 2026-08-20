/**
 * AI provider 集中設定。
 * 所有 Gemini 呼叫端(/api/proofread、/api/highlight)必須從這裡取 model 名稱。
 * 未來要換 model 只改這一個位置 + .env。
 */

/**
 * Gemini model 名稱。
 * 預設 gemini-3.5-flash-lite:
 *   - GA(非 preview)
 *   - 高吞吐/低成本定位,免費層 RPM 較寬
 *   - 對簡單 JSON 任務(選段/校字)品質夠
 * 可用 GEMINI_MODEL env var 覆蓋。
 */
export const GEMINI_MODEL: string =
  process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

/** Gemini generateContent endpoint URL builder */
export function geminiEndpoint(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
}
