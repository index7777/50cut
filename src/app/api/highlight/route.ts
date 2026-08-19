import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { log } from '@/lib/logger';
import type {
  ApiError,
  HighlightResponse,
  TranscriptSegment,
} from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_SEGMENTS = 500;
const MIN_HL = 25;   // 亮點最短 25 秒
const MAX_HL = 65;   // 亮點最長 65 秒

type ClientPayload = {
  duration: number;
  segments: TranscriptSegment[];
};

const HIGHLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    highlight: {
      type: 'object',
      properties: {
        start: { type: 'number', description: '亮點起始秒數' },
        end: { type: 'number', description: '亮點結束秒數' },
        reason: { type: 'string', description: '為什麼選這段(一句話)' },
      },
      required: ['start', 'end', 'reason'],
    },
    title: {
      type: 'string',
      description: '適合 Threads 的短標題,15 字內',
    },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: '3–5 個繁中或英文 hashtag,不含 # 符號',
    },
  },
  required: ['highlight', 'title', 'hashtags'],
};

function buildPrompt(payload: ClientPayload): string {
  const lines = payload.segments
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join('\n');

  // 短影片直接整支當亮點
  const isShort = payload.duration < MIN_HL;
  const lengthRule = isShort
    ? `- 影片太短(${payload.duration.toFixed(1)} 秒),直接把整支影片當亮點:start=0, end=${payload.duration.toFixed(1)}`
    : `- 長度 ${MIN_HL}-${MAX_HL} 秒之間
- 有起頭、有結論,能獨立看懂
- 有記憶點:金句、衝突、笑點、情緒高點、意外資訊
- 避免半句被切斷,start/end 對齊字幕邊界
- 若整支影片都很平,選最完整的一段觀點`;

  return `你是一個幫繁中創作者剪短影音的助手。以下是一支長度 ${payload.duration.toFixed(1)} 秒的影片逐字稿(帶時間戳)。

請從中挑出**一段最適合當短影音的亮點**,規則:
${lengthRule}

輸出:
- highlight: 起始/結束秒數 + 選段理由
- title: Threads 風格短標題,15 字內,口語、有梗、能吸引點擊,不要「震驚體」
- hashtags: 3-5 個,繁中或英文皆可,不含 # 符號

逐字稿:
${lines}`;
}

export async function POST(request: NextRequest) {
  // Auth
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

  // Rate limit
  const ip = getClientIp(request);
  if (!checkRateLimit(`hl:ip:${ip}`).allowed) {
    return NextResponse.json<ApiError>(
      { error: '太頻繁了,稍後再試', code: 'rate_limited' },
      { status: 429 }
    );
  }
  if (!checkRateLimit(`hl:user:${user.id}`, 30).allowed) {
    return NextResponse.json<ApiError>(
      { error: '太頻繁了,稍後再試', code: 'rate_limited' },
      { status: 429 }
    );
  }

  // Body
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
    !Array.isArray(body.segments) ||
    body.segments.length === 0
  ) {
    return NextResponse.json<ApiError>(
      { error: '缺少字幕資料', code: 'no_segments' },
      { status: 400 }
    );
  }
  if (body.segments.length > MAX_SEGMENTS) {
    return NextResponse.json<ApiError>(
      { error: '字幕過多', code: 'too_many_segments' },
      { status: 400 }
    );
  }

  // Sanitize segments(不信任來源,即使前端剛送)
  const segments: TranscriptSegment[] = body.segments
    .filter(
      (s) =>
        typeof s?.start === 'number' &&
        typeof s?.end === 'number' &&
        typeof s?.text === 'string' &&
        s.end > s.start
    )
    .map((s) => ({
      start: Math.max(0, s.start),
      end: Math.min(body.duration, s.end),
      text: s.text.slice(0, 300), // 每句上限 300 字防 prompt 攻擊
    }));

  if (segments.length === 0) {
    return NextResponse.json<ApiError>(
      { error: '字幕無效', code: 'invalid_segments' },
      { status: 400 }
    );
  }

  // Call Gemini
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  if (!key) {
    log.error('missing_gemini_key');
    return NextResponse.json<ApiError>(
      { error: '伺服器未設定', code: 'server_misconfig' },
      { status: 500 }
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const geminiBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: buildPrompt({ duration: body.duration, segments }) }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: HIGHLIGHT_SCHEMA,
      temperature: 0.4,
    },
  };

  let geminiJson: {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      log.error('gemini_failed', {
        status: resp.status,
        snippet: errText.slice(0, 200),
      });
      return NextResponse.json<ApiError>(
        { error: '選段失敗,再試一次', code: 'gemini_error' },
        { status: 502 }
      );
    }
    geminiJson = await resp.json();
  } catch (err) {
    log.error('gemini_network_error', { msg: (err as Error).message });
    return NextResponse.json<ApiError>(
      { error: '網路錯誤,再試一次', code: 'network_error' },
      { status: 502 }
    );
  }

  // Parse
  const text =
    geminiJson.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  let parsed: HighlightResponse;
  try {
    parsed = JSON.parse(text) as HighlightResponse;
  } catch {
    log.warn('gemini_parse_fail', { snippet: text.slice(0, 200) });
    return NextResponse.json<ApiError>(
      { error: '選段回傳格式錯誤', code: 'parse_error' },
      { status: 502 }
    );
  }

  // Guard rails + clamp(Gemini 有時會回略超出的 end)
  const hl = parsed.highlight;
  if (!hl || typeof hl.start !== 'number' || typeof hl.end !== 'number') {
    log.warn('highlight_shape_bad', { snippet: text.slice(0, 200) });
    return NextResponse.json<ApiError>(
      { error: '選段結果無效', code: 'invalid_highlight' },
      { status: 502 }
    );
  }
  // Clamp
  hl.start = Math.max(0, hl.start);
  hl.end = Math.min(body.duration, hl.end);
  if (hl.end <= hl.start) {
    log.warn('highlight_range_bad', {
      start: hl.start,
      end: hl.end,
      duration: body.duration,
    });
    return NextResponse.json<ApiError>(
      { error: '選段結果無效', code: 'invalid_range' },
      { status: 502 }
    );
  }
  const dur = hl.end - hl.start;
  const minAllowed = body.duration < MIN_HL ? 1 : 10;
  if (dur < minAllowed || dur > 90) {
    log.warn('highlight_length_bad', { dur, duration: body.duration });
    return NextResponse.json<ApiError>(
      { error: '選段長度不合理', code: 'invalid_length' },
      { status: 502 }
    );
  }

  const clean: HighlightResponse = {
    highlight: {
      start: hl.start,
      end: hl.end,
      reason: String(hl.reason ?? '').slice(0, 100),
    },
    title: String(parsed.title ?? '').slice(0, 40),
    hashtags: Array.isArray(parsed.hashtags)
      ? parsed.hashtags
          .filter((t) => typeof t === 'string')
          .slice(0, 8)
          .map((t) => t.replace(/^#/, '').slice(0, 20))
      : [],
  };

  log.info('highlight_ok', {
    u: log.userHash(user.id),
    dur: (clean.highlight.end - clean.highlight.start).toFixed(1),
  });

  return NextResponse.json(clean);
}

export async function GET() {
  return NextResponse.json<ApiError>({ error: 'method_not_allowed' }, { status: 405 });
}
