/**
 * Gemini(或其他 provider)錯誤分類。
 *
 * 使用場景:route 呼叫 Gemini 失敗時,把原始 status + snippet 送進 classify,
 * 得到穩定的 reason code。前端可依 reason 顯示精準訊息。
 */

export type AiFailureReason =
  | 'model_unavailable'  // 404 model 不存在 / 已停用
  | 'quota'              // 每日/月配額用完
  | 'rate_limit'         // RPM/TPM 短時超限
  | 'timeout'            // 逾時
  | 'provider_error'     // 5xx / 內部錯誤
  | 'invalid_response'   // JSON parse 失敗 / schema 不對
  | 'network_error'      // fetch 失敗
  | 'missing_key';       // env 未設定

/** HTTP status + response snippet → reason code */
export function classifyGeminiError(
  status: number,
  snippet: string = ''
): AiFailureReason {
  if (status === 404) return 'model_unavailable';
  if (status === 429) {
    // Gemini 有時把 quota 與 rate limit 都塞在 429
    if (/quota|billing|exceeded your current quota/i.test(snippet)) return 'quota';
    return 'rate_limit';
  }
  if (status === 408) return 'timeout';
  if (status >= 500 && status < 600) return 'provider_error';
  return 'provider_error';
}

/** reason → 中文使用者訊息(短,前端可直接顯示) */
export function reasonToUiText(reason: AiFailureReason): string {
  switch (reason) {
    case 'model_unavailable':
      return 'AI 模型暫時不可用';
    case 'quota':
      return 'AI 今日免費額度已用完';
    case 'rate_limit':
      return 'AI 呼叫過於頻繁,稍後再試';
    case 'timeout':
      return 'AI 回應逾時';
    case 'provider_error':
      return 'AI 服務暫時異常';
    case 'invalid_response':
      return 'AI 回應格式錯誤';
    case 'network_error':
      return '網路連線異常';
    case 'missing_key':
      return 'AI 服務未設定';
  }
}
