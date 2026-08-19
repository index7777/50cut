import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * Server-only admin client. Uses service role key — bypasses RLS.
 * ONLY use for:
 *   - Calling security-definer RPC (consume_usage)
 *   - Anything the user cannot do for themselves
 *
 * NEVER import from a Client Component. NEVER expose to browser.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('Missing Supabase admin credentials');
  }

  return createSupabaseClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
