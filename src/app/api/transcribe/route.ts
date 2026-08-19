import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, getClientIp } from '@/lib/ratelimit';
import { log } from '@/lib/logger';
import { isUnlimitedEmail } from '@/lib/auth-helpers';
import type { TranscribeResponse, ApiError } from '@/lib/types';

// Whisper 需要 Node 環境(FormData + fetch to OpenAI)
export const runtime = 'nodejs';
export const maxDuration = 60;   // Vercel 限制

// 音訊上限:5 分鐘 16kHz mono 32kbps ≈ 1.2 MB。給到 5 MB 保險。
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
      { error: '太頻繁了,稍後再試', code: 'rate_limited' },
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

  const audio = form.get('audio');
  if (!(audio instanceof File) && !(audio instanceof Blob)) {
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
      return NextResponse.json<ApiError>({ error: '系統忙線,請重試', code: 'usage_error' }, { status: 500 });
    }
    const row = Array.isArray(usage) ? usage[0] : usage;
    if (!row?.allowed) {
      return NextResponse.json<ApiError>(
        { error: '今日免費額度已用完,明天再試', code: 'daily_limit' },
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
  // 要逐字時間戳,server 端再切成句子
  whisperForm.append('timestamp_granularities[]', 'segment');
  whisperForm.append('timestamp_granularities[]', 'word');
  whisperForm.append(
    'prompt',
    '以下是繁體中文對話,請以台灣用語標點,常見詞:視頻→影片、質量→品質。'
  );

  let whisperJson: {
    language?: string;
    duration?: number;
    text?: string;
    segments?: { start: number; end: number; text: string }[];
    words?: { start: number; end: number; word: string }[];
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
        { error: '辨識失敗,再試一次', code: 'whisper_error' },
        { status: 502 }
      );
    }
    whisperJson = await resp.json();
  } catch (err) {
    log.error('whisper_network_error', { msg: (err as Error).message });
    return NextResponse.json<ApiError>(
      { error: '網路錯誤,再試一次', code: 'network_error' },
      { status: 502 }
    );
  }

  // 6. 用逐字時間戳依標點切成句子
  //    Whisper 對長句常回一大段,我們自己依中英標點切,方便 Gemini 挑亮點對齊
  const rawSegments = (whisperJson.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));
  const words = (whisperJson.words ?? []).filter(
    (w) => typeof w.start === 'number' && typeof w.end === 'number'
  );

  const segments = splitBySentence(rawSegments, words);

  const payload: TranscribeResponse = {
    language: whisperJson.language ?? 'zh',
    duration: whisperJson.duration ?? 0,
    segments,
    full_text: whisperJson.text?.trim() ?? '',
  };

  log.info('transcribe_ok', {
    u: log.userHash(user.id),
    raw_segments: rawSegments.length,
    words: words.length,
    final_segments: segments.length,
    duration: payload.duration,
    full_text_len: payload.full_text.length,
  });

  return NextResponse.json(payload);
}

// 拒絕其他方法
export async function GET() {
  return NextResponse.json<ApiError>({ error: 'method_not_allowed' }, { status: 405 });
}

// ============================================================
// Helpers
// ============================================================

const SENTENCE_END = /[。!?!?…]|\.(\s|$)/;

/**
 * 把 Whisper 回傳的大段落依標點+逐字時間戳切成短句。
 * 若沒有逐字時間戳,fallback 用字元比例分配時間。
 */
function splitBySentence(
  rawSegments: { start: number; end: number; text: string }[],
  words: { start: number; end: number; word: string }[]
): { start: number; end: number; text: string }[] {
  const results: { start: number; end: number; text: string }[] = [];

  // 有逐字時間戳:重建整段文字→依標點切→每句 char range 對應到 word 找起訖
  if (words.length > 0) {
    // 預先算每個 word 在 joinedText 的 char 位置
    const wordPos: { start: number; end: number; wStart: number; wEnd: number }[] = [];
    let pos = 0;
    for (const w of words) {
      const len = w.word.length;
      wordPos.push({ start: w.start, end: w.end, wStart: pos, wEnd: pos + len });
      pos += len;
    }
    const joinedText = words.map((w) => w.word).join('');
    const sentences = splitTextIntoSentences(joinedText);

    let sentCharStart = 0;
    for (const sent of sentences) {
      const sentCharEnd = sentCharStart + sent.length;
      let firstWord = -1;
      let lastWord = -1;
      for (let i = 0; i < wordPos.length; i++) {
        // 有交集就算命中
        if (wordPos[i].wEnd > sentCharStart && wordPos[i].wStart < sentCharEnd) {
          if (firstWord === -1) firstWord = i;
          lastWord = i;
        } else if (wordPos[i].wStart >= sentCharEnd) {
          break;
        }
      }
      if (firstWord !== -1 && lastWord !== -1) {
        results.push({
          start: wordPos[firstWord].start,
          end: wordPos[lastWord].end,
          text: sent.trim(),
        });
      }
      sentCharStart = sentCharEnd;
    }

    if (results.length > 0) return mergeShort(results);
  }

  // Fallback:沒逐字時間戳 → 每個 segment 依標點切,時間按字元比例分配
  for (const seg of rawSegments) {
    const parts = splitTextIntoSentences(seg.text);
    if (parts.length <= 1) {
      results.push(seg);
      continue;
    }
    const totalLen = parts.reduce((a, p) => a + p.length, 0) || 1;
    const dur = seg.end - seg.start;
    let cursor = seg.start;
    for (const p of parts) {
      const partDur = (p.length / totalLen) * dur;
      results.push({
        start: cursor,
        end: cursor + partDur,
        text: p.trim(),
      });
      cursor += partDur;
    }
  }

  return mergeShort(results);
}

function splitTextIntoSentences(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if (SENTENCE_END.test(text[i])) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf);
  return out.filter((s) => s.trim().length > 0);
}

// 合併過短的句子(<3 字)避免時間戳雜訊
function mergeShort(segs: { start: number; end: number; text: string }[]) {
  const out: typeof segs = [];
  for (const s of segs) {
    if (s.text.length < 3 && out.length > 0) {
      const prev = out[out.length - 1];
      prev.end = s.end;
      prev.text = (prev.text + s.text).trim();
    } else {
      out.push({ ...s });
    }
  }
  return out;
}
