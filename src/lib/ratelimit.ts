/**
 * Simple in-memory rate limiter for API routes.
 * Good enough for MVP. Upgrade to Upstash Redis when running behind multiple regions.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

// 每小時清理過期 bucket,避免記憶體洩漏
if (typeof globalThis !== 'undefined' && !(globalThis as any).__ratelimit_gc) {
  (globalThis as any).__ratelimit_gc = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }, 60 * 60 * 1000);
}

export function checkRateLimit(
  key: string,
  limit = Number(process.env.RATE_LIMIT_PER_IP_PER_HOUR ?? 20),
  windowMs = 60 * 60 * 1000
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }

  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
}

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}
