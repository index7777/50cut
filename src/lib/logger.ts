/**
 * Logger wrapper — never logs raw email, tokens, or API keys.
 * Use short-hash for identifying users in logs.
 */
import { createHash } from 'crypto';

function hashId(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

const SENSITIVE_KEYS = ['email', 'password', 'token', 'apiKey', 'api_key', 'authorization'];

function redact(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) {
      out[k] = typeof v === 'string' ? `[redacted:${hashId(v)}]` : '[redacted]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

export const log = {
  info: (msg: string, ctx?: object) => console.log(JSON.stringify({ level: 'info', msg, ctx: redact(ctx) })),
  warn: (msg: string, ctx?: object) => console.warn(JSON.stringify({ level: 'warn', msg, ctx: redact(ctx) })),
  error: (msg: string, ctx?: object) => console.error(JSON.stringify({ level: 'error', msg, ctx: redact(ctx) })),
  userHash: hashId,
};
