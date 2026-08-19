import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { log } from '@/lib/logger';

/**
 * OAuth / Magic Link 回調點
 * Supabase 會導向這裡,帶 code parameter → 換 session cookie
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/app';

  if (!code) {
    log.warn('auth_callback_no_code');
    return NextResponse.redirect(new URL('/login?error=no_code', url.origin));
  }

  const supabase = createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    log.warn('auth_callback_error', { code: 'redacted' });
    return NextResponse.redirect(new URL('/login?error=exchange_failed', url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
