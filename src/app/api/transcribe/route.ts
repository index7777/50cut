import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { log } from '@/lib/logger';
import { isUnlimitedEmail } from '@/lib/auth-helpers';
import type {
  TranscribeResponse,
  ApiError,
  TranscriptWord,
  TimingSource,
} from '@/lib/types';

// Whisper 需要 Node 環境(FormData + fetch to OpenAI)
export const runtime = 'nodejs';
export const maxDuration = 60;   // Vercel 限制

// 音訊上限：5 分鐘 16kHz mono 32kbps ≈ 1.2 MB。給到 5 MB 保險。
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

export async function POST(request: NextRequest) {
  // 1. Auth
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json<ApiError>({ error: '請先登入', code: 'unauthenticated' }, { status: 401 });
  }

  // 2. Rate limit(IP + userId 各一個 bucket)
  const ip = getClientIp(request);
  const ipCheck = checkRateLimit(`ip:${ip}`);
  const userCheck = checkRateLimit(`user:${user.id}`, 30); // 每小時 30 次

  if (!ipCheck.allowed || !userCheck.allowed) {
    log.warn('rate_limited', { u: log.userHash(user.id) });
    return NextResponse.json<ApiError>(
      { error: '太頻繁了，稍後再試', code: 'rate_limited' },
      { status: 429 }
    );
  }

  // 3. 收音訊
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json<ApiError>({ error: '請求格式錯誤', code: 'bad_request' }, { status: 400 });
  }

  const audio = form.get('audio') as File | Blob | null;
  if (!audio || typeof (audio as Blob).size !== 'number') {
    return NextResponse.json<ApiError>({ error: '缺少音訊', code: 'no_audio' }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json<ApiError>({ error: '音訊過大', code: 'audio_too_large' }, { status: 400 });
  }
  if (audio.size < 1024) {
    return NextResponse.json<ApiError>({ error: '音訊過小或空白', code: 'audio_too_small' }, { status: 400 });
  }

  // 4. 扣用量(無限白名單使用者跳過)
  if (!isUnlimitedEmail(user.email)) {
    const admin = createAdminClient();
    const { data: usage, error: usageErr } = await admin.rpc('consume_usage', {
      p_user_id: user.id,
    });

    if (usageErr) {
      log.error('consume_usage_failed', { u: log.userHash(user.id), err: usageErr.message });
      return NextResponse.json<ApiError>({ error: '系統忙線，請重試', code: 'usage_error' }, { status: 500 });
    }
    const row = Array.isArray(usage) ? usage[0] : usage;
    if (!row?.allowed) {
      return NextResponse.json<ApiError>(
        { error: '今日免費額度已用完，明天再試', code: 'daily_limit' },
        { status: 402 }
      );
    }
  } else {
    log.info('unlimited_user', { u: log.userHash(user.id) });
  }

  // 5. 呼叫 Whisper API(Groq,OpenAI 相容)
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    log.error('missing_groq_key');
    return NextResponse.json<ApiError>({ error: '伺服器未設定', code: 'server_misconfig' }, { status: 500 });
  }

  const whisperForm = new FormData();
  const audioFile =
    audio instanceof File
      ? audio
      : new File([audio], 'audio.mp3', { type: 'audio/mpeg' });
  whisperForm.append('file', audioFile);
  whisperForm.append('model', 'whisper-large-v3-turbo');
  whisperForm.append('response_format', 'verbose_json');
  whisperForm.append('language', 'zh');
  // 要最細粒度的時間戳。segment 只當 fallback,實際字幕由 subtitleSegmenter
  // 依 word timestamp 切分(見 src/lib/subtitle-segmenter.ts)
  whisperForm.append('timestamp_granularities[]', 'segment');
  whisperForm.append('timestamp_granularities[]', 'word');
  whisperForm.append('temperature', '0');
  whisperForm.append(
    'prompt',
    '以下是繁體中文對話，請以台灣用語標點。常見詞：視頻→影片、質量→品質。請完整轉錄所有聽到的內容，包含短句、語助詞、口頭禪。'
  );

  let whisperJson: {
    language?: string;
    duration?: number;
    text?: string;
    segments?: { start: number; end: number; text: string }[];
    words?: { start?: number; end?: number; word?: string; text?: string }[];
  };
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: whisperForm,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      log.error('whisper_failed', { status: resp.status, snippet: errText.slice(0, 200) });
      return NextResponse.json<ApiError>(
        { error: '辨識失敗，再試一次', code: 'whisper_error' },
        { status: 502 }
      );
    }
    whisperJson = await resp.json();
  } catch (err) {
    log.error('whisper_network_error', { msg: (err as Error).message });
    return NextResponse.json<ApiError>(
      { error: '網路錯誤，再試一次', code: 'network_error' },
      { status: 502 }
    );
  }

  // 6. 回傳「最細粒度」的時間戳。
  //    這裡不做任何斷句 —— 字幕切分交給 deterministic 的 subtitleSegmenter,
  //    這樣 AI 與 API 都不可能左右字幕邊界。
  const segments = (whisperJson.segments ?? [])
    .filter((s) => typeof s.start === 'number' && typeof s.end === 'number')
    .map((s) => ({
      start: s.start,
      end: s.end,
      text: (s.text ?? '').trim(),
    }))
    .filter((s) => s.text.length > 0);

  // Groq/OpenAI 的 word 物件欄位名可能是 word 或 text,兩者都接受。
  const words: TranscriptWord[] = (whisperJson.words ?? [])
    .map((w) => {
      const raw = w as { start?: number; end?: number; word?: string; text?: string };
      return {
        text: (raw.word ?? raw.text ?? '').trim(),
        start: raw.start ?? Number.NaN,
        end: raw.end ?? Number.NaN,
      };
    })
    .filter(
      (w) =>
        Number.isFinite(w.start) &&
        Number.isFinite(w.end) &&
        w.end >= w.start &&
        w.text.length > 0
    )
    .sort((a, b) => a.start - b.start);

  const timingSource: TimingSource = words.length > 0 ? 'exact' : 'estimated';

  const payload: TranscribeResponse = {
    language: whisperJson.language ?? 'zh',
    duration: whisperJson.duration ?? 0,
    words,
    segments,
    timingSource,
    full_text: (whisperJson.text ?? '').trim(),
  };

  log.info('transcribe_ok', {
    u: log.userHash(user.id),
    words: words.length,
    segments: segments.length,
    timing_source: timingSource,
    duration: payload.duration,
    full_text_len: payload.full_text.length,
  });

  return NextResponse.json(payload);
}

// 拒絕其他方法
export async function GET() {
  return NextResponse.json<ApiError>({ error: 'method_not_allowed' }, { status: 405 });
}
