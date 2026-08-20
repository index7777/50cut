/**
 * 選片 API。
 *
 * 流程:
 *   client 傳完整字幕 timeline
 *     → 這裡用 deterministic 規則產生候選片段(邊界一律對齊 cue)
 *     → Gemini 只回 selectedCandidateId + 標題 + 理由 + 評分
 *     → 時間一律取自候選,Gemini 回的任何數字都不會被當成時間使用
 *
 * 也就是說 AI 只做「判斷」,不做「計時」。
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { log } from '@/lib/logger';
import {
  buildCandidates,
  pickDefaultCandidate,
  DEFAULT_CANDIDATE_CONFIG,
} from '@/lib/highlight-candidates';
import { GEMINI_MODEL, geminiEndpoint } from '@/lib/ai-config';
import { classifyGeminiError, reasonToUiText } from '@/lib/ai-errors';
import type {
  ApiError,
  HighlightCandidate,
  HighlightResponse,
  HighlightScores,
  SubtitleCue,
} from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_CUES = 800;
const MAX_CUE_CHARS = 300;

type ClientPayload = {
  duration: number;
  cues: Pick<SubtitleCue, 'start' | 'end' | 'text'>[];
};

const RANKING_SCHEMA = {
  type: 'object',
  properties: {
    selectedCandidateId: {
      type: 'string',
      description: '從候選清單挑一個 id,例如 candidate_2。只能是清單裡出現過的 id',
    },
    title: { type: 'string', description: '適合 Threads 的短標題,15 字內' },
    reason: { type: 'string', description: '為什麼選這段(一句話)' },
    scores: {
      type: 'object',
      properties: {
        hook: { type: 'integer', description: '開頭吸引力 1-10' },
        completeness: { type: 'integer', description: '語意完整度 1-10' },
        emotion: { type: 'integer', description: '情緒強度 1-10' },
        shareability: { type: 'integer', description: '分享意願 1-10' },
      },
      required: ['hook', 'completeness', 'emotion', 'shareability'],
    },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 個 hashtag,不含 # 符號',
    },
  },
  required: ['selectedCandidateId', 'title', 'reason', 'scores'],
};

function buildPrompt(candidates: HighlightCandidate[], duration: number): string {
  const list = candidates
    .map(
      (c) =>
        `${c.id} | ${c.start.toFixed(2)}s-${c.end.toFixed(2)}s | ${c.duration.toFixed(1)} 秒\n${c.text}`
    )
    .join('\n\n');

  return `你是幫繁中創作者挑短影音片段的編輯。這支影片全長 ${duration.toFixed(1)} 秒。

下面是系統已經切好的候選片段（起訖都已對齊完整語句，你不需要也不可以自己算時間）。
請挑出**最適合當短影音**的一個，並給標題與評分。

判斷標準：
- 開頭幾秒就要有 hook，能讓人停下來
- 語意完整，不需要看前文也懂
- 有記憶點：金句、衝突、笑點、情緒高點、意外資訊
- 分享意願高

輸出：
- selectedCandidateId：只能填下面清單出現過的 id
- title：Threads 風格短標題，15 字內，口語、有梗、不要震驚體
- reason：一句話說明為什麼選它
- scores：hook / completeness / emotion / shareability 各給 1-10
- hashtags：3-5 個，不含 #

候選片段：
${list}`;
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json<ApiError>(
      { error: '請先登入', code: 'unauthenticated' },
      { status: 401 }
    );
  }

  const ip = getClientIp(request);
  if (!checkRateLimit(`hl:ip:${ip}`).allowed) {
    return NextResponse.json<ApiError>(
      { error: '太頻繁了，稍後再試', code: 'rate_limited' },
      { status: 429 }
    );
  }
  if (!checkRateLimit(`hl:user:${user.id}`, 30).allowed) {
    return NextResponse.json<ApiError>(
      { error: '太頻繁了，稍後再試', code: 'rate_limited' },
      { status: 429 }
    );
  }

  let body: ClientPayload;
  try {
    body = (await request.json()) as ClientPayload;
  } catch {
    return NextResponse.json<ApiError>(
      { error: '請求格式錯誤', code: 'bad_request' },
      { status: 400 }
    );
  }
  if (
    !body ||
    typeof body.duration !== 'number' ||
    !Array.isArray(body.cues) ||
    body.cues.length === 0
  ) {
    return NextResponse.json<ApiError>(
      { error: '缺少字幕資料', code: 'no_cues' },
      { status: 400 }
    );
  }
  if (body.cues.length > MAX_CUES) {
    return NextResponse.json<ApiError>(
      { error: '字幕過多', code: 'too_many_cues' },
      { status: 400 }
    );
  }

  // 不信任 client:清洗一次
  const cues: SubtitleCue[] = body.cues
    .filter(
      (c) =>
        typeof c?.start === 'number' &&
        typeof c?.end === 'number' &&
        typeof c?.text === 'string' &&
        c.end > c.start
    )
    .map((c) => ({
      start: Math.max(0, c.start),
      end: Math.min(body.duration, c.end),
      text: c.text.slice(0, MAX_CUE_CHARS),
      words: [],
      timing: 'exact' as const,
    }))
    .sort((a, b) => a.start - b.start);

  if (cues.length === 0) {
    return NextResponse.json<ApiError>(
      { error: '字幕無效', code: 'invalid_cues' },
      { status: 400 }
    );
  }

  // ---- 候選片段:deterministic,與 AI 無關 ----
  const candidates = buildCandidates(cues, DEFAULT_CANDIDATE_CONFIG);
  if (candidates.length === 0) {
    return NextResponse.json<ApiError>(
      { error: '影片太短，做不出候選片段', code: 'no_candidates' },
      { status: 422 }
    );
  }

  const fallback = pickDefaultCandidate(candidates)!;

  const key = process.env.GEMINI_API_KEY;
  const model = GEMINI_MODEL;
  if (!key) {
    log.error('missing_gemini_key');
    // 沒 key 不擋流程:回 deterministic fallback
    return NextResponse.json<HighlightResponse>({
      highlight: {
        start: fallback.start,
        end: fallback.end,
        reason: fallback.reasonText ?? '已為你挑選一段完整片段',
      },
      title: '',
      hashtags: [],
      candidateId: fallback.id,
      candidates,
      ai: { ranking: { status: 'fallback', reason: 'missing_key' } },
    });
  }

  const url = geminiEndpoint(model, key);
  const geminiBody = {
    contents: [
      { role: 'user', parts: [{ text: buildPrompt(candidates, body.duration) }] },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RANKING_SCHEMA,
      temperature: 0.4,
    },
  };

  const MAX_ATTEMPTS = 3;
  let geminiJson: {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  } = {};
  let ok = false;
  let lastStatus = 0;
  let lastSnippet = '';
  let networkFailed = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });
      if (resp.ok) {
        geminiJson = await resp.json();
        ok = true;
        break;
      }
      lastStatus = resp.status;
      lastSnippet = (await resp.text().catch(() => '')).slice(0, 300);
      // 400/404/429-quota:重試沒有意義
      const reason = classifyGeminiError(resp.status, lastSnippet);
      const retryable =
        reason === 'rate_limit' || reason === 'provider_error' || reason === 'timeout';
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      log.warn('gemini_retry', { attempt, status: resp.status, reason });
      await new Promise((r) => setTimeout(r, attempt * 1500));
    } catch (err) {
      networkFailed = true;
      lastSnippet = (err as Error).message ?? 'network_error';
      if (attempt === MAX_ATTEMPTS) break;
      log.warn('gemini_retry_network', { attempt });
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }

  if (!ok) {
    const reason = networkFailed
      ? 'network_error'
      : classifyGeminiError(lastStatus, lastSnippet);
    log.warn('gemini_ranking_unavailable', {
      status: lastStatus,
      reason,
      snippet: lastSnippet.slice(0, 200),
    });
    // AI 排序失敗不代表做不出短片:用 deterministic 預設候選繼續
    return NextResponse.json<HighlightResponse>({
      highlight: {
        start: fallback.start,
        end: fallback.end,
        reason: fallback.reasonText ?? '已為你挑選一段完整片段',
      },
      title: '',
      hashtags: [],
      candidateId: fallback.id,
      candidates,
      ai: { ranking: { status: 'fallback', reason } },
    });
  }

  const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  let parsed: {
    selectedCandidateId?: unknown;
    title?: unknown;
    reason?: unknown;
    scores?: unknown;
    hashtags?: unknown;
  };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    log.warn('gemini_parse_fail', { snippet: rawText.slice(0, 200) });
    parsed = {};
  }

  // 只接受清單裡真實存在的 id;其他一律退回 deterministic 選擇
  const chosen =
    (typeof parsed.selectedCandidateId === 'string'
      ? candidates.find((c) => c.id === parsed.selectedCandidateId)
      : undefined) ?? fallback;

  const rawScores = (parsed.scores ?? {}) as Partial<Record<keyof HighlightScores, unknown>>;
  const clampScore = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.max(1, Math.min(10, Math.round(v)))
      : 5;
  const scores: HighlightScores = {
    hook: clampScore(rawScores.hook),
    completeness: clampScore(rawScores.completeness),
    emotion: clampScore(rawScores.emotion),
    shareability: clampScore(rawScores.shareability),
  };

  const response: HighlightResponse = {
    // 時間只來自候選,絕不採用 Gemini 回的任何數字
    highlight: {
      start: chosen.start,
      end: chosen.end,
      reason:
        typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : '完整且有記憶點的片段',
    },
    title: typeof parsed.title === 'string' ? parsed.title.slice(0, 40) : '',
    hashtags: Array.isArray(parsed.hashtags)
      ? parsed.hashtags
          .filter((t): t is string => typeof t === 'string')
          .slice(0, 8)
          .map((t) => t.replace(/^#/, '').slice(0, 20))
      : [],
    scores,
    candidateId: chosen.id,
    candidates,
    ai: { ranking: { status: 'success' } },
  };

  log.info('highlight_ok', {
    u: log.userHash(user.id),
    cues: cues.length,
    candidates: candidates.length,
    chosen: chosen.id,
    ai_chose: chosen.id === parsed.selectedCandidateId,
    dur: chosen.duration.toFixed(2),
  });

  return NextResponse.json(response);
}

export async function GET() {
  return NextResponse.json<ApiError>({ error: 'method_not_allowed' }, { status: 405 });
}
