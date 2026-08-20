/**
 * Gemini 校字 —— 只回「文字 patch」,不重建 transcript,不碰時間軸。
 *
 * 契約:
 *   輸入  { texts: string[] }        // 每個 cue 的文字
 *   輸出  { corrections: [{ index, from, to }] }
 *
 * 呼叫端只會用 corrections 去替換文字;cue 與底層 word 的 start/end
 * 完全不經過這支 API,所以 AI 不可能改到時間。
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { log } from '@/lib/logger';
import type { ApiError, ProofreadCorrection, ProofreadResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_LINES = 500;
const MAX_LINE_CHARS = 300;

type ClientPayload = {
  texts: string[];
};

const PROOFREAD_SCHEMA = {
  type: 'object',
  properties: {
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '第幾行(從 0 開始)' },
          from: { type: 'string', description: '該行中要被取代的錯字片段,必須逐字出現在原文' },
          to: { type: 'string', description: '正確的文字' },
        },
        required: ['index', 'from', 'to'],
      },
    },
  },
  required: ['corrections'],
};

function buildPrompt(texts: string[]): string {
  const lines = texts.map((t, i) => `[${i}] ${t}`).join('\n');
  return `以下是一支繁中短影片的字幕逐行文字(由語音辨識產生)，可能有同音錯字或辨識錯誤。

你的任務：找出明顯錯誤的**字詞片段**，回傳最小替換 patch。

嚴格規則：
- 只回「需要修正」的片段，不要整句重寫
- from 必須是該行中**逐字存在**的片段，否則會被丟棄
- from 要盡量短，只涵蓋錯的那幾個字
- 只修同音錯字、明顯聽錯的詞；不要改語氣、不要潤飾、不要「文謅謅化」
- 標點原樣保留，不要增加也不要移除
- 人名、專有名詞不確定就不要動
- 使用台灣繁中用語
- 沒有需要修正的地方就回空陣列

字幕：
${lines}`;
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
  if (!checkRateLimit(`pr:ip:${ip}`).allowed) {
    return NextResponse.json<ApiError>(
      { error: '太頻繁了，稍後再試', code: 'rate_limited' },
      { status: 429 }
    );
  }
  if (!checkRateLimit(`pr:user:${user.id}`, 30).allowed) {
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
  if (!body || !Array.isArray(body.texts) || body.texts.length === 0) {
    return NextResponse.json<ApiError>(
      { error: '缺少字幕', code: 'no_texts' },
      { status: 400 }
    );
  }
  if (body.texts.length > MAX_LINES) {
    return NextResponse.json<ApiError>(
      { error: '字幕過多', code: 'too_many_lines' },
      { status: 400 }
    );
  }

  const texts = body.texts.map((t) =>
    typeof t === 'string' ? t.slice(0, MAX_LINE_CHARS) : ''
  );

  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  if (!key) {
    log.error('missing_gemini_key_proofread');
    // 沒設定 key 不擋流程:回空 patch
    return NextResponse.json<ProofreadResponse>({ corrections: [] });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  let geminiJson: {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(texts) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: PROOFREAD_SCHEMA,
          temperature: 0.2,
        },
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const quota = resp.status === 429 && /quota|billing/i.test(errText);
      log.warn('proofread_failed', {
        status: resp.status,
        quota,
        snippet: errText.slice(0, 200),
      });
      // 校字是加分項,失敗不擋流程
      return NextResponse.json<ProofreadResponse>({ corrections: [] });
    }
    geminiJson = await resp.json();
  } catch (err) {
    log.warn('proofread_network_error', { msg: (err as Error).message });
    return NextResponse.json<ProofreadResponse>({ corrections: [] });
  }

  const raw = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  let parsed: { corrections?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('proofread_parse_fail', { snippet: raw.slice(0, 200) });
    return NextResponse.json<ProofreadResponse>({ corrections: [] });
  }

  // 驗證每個 patch:index 合法、from 必須逐字存在於該行、to 不得過長
  const corrections: ProofreadCorrection[] = [];
  let rejected = 0;
  for (const item of Array.isArray(parsed.corrections) ? parsed.corrections : []) {
    const c = item as { index?: unknown; from?: unknown; to?: unknown };
    if (
      typeof c.index !== 'number' ||
      !Number.isInteger(c.index) ||
      c.index < 0 ||
      c.index >= texts.length ||
      typeof c.from !== 'string' ||
      typeof c.to !== 'string' ||
      c.from.length === 0 ||
      c.from.length > 60 ||
      c.to.length > 60 ||
      c.from === c.to ||
      !texts[c.index].includes(c.from)
    ) {
      rejected++;
      continue;
    }
    corrections.push({ index: c.index, from: c.from, to: c.to });
  }

  log.info('proofread_ok', {
    u: log.userHash(user.id),
    lines: texts.length,
    corrections: corrections.length,
    rejected,
  });

  return NextResponse.json<ProofreadResponse>({ corrections });
}

export async function GET() {
  return NextResponse.json<ApiError>({ error: 'method_not_allowed' }, { status: 405 });
}
