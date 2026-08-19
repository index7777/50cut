/**
 * Server-only helpers for user status checks.
 * DO NOT import from client components.
 */

export function isUnlimitedEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const raw = process.env.UNLIMITED_EMAILS ?? '';
  if (!raw) return false;
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}
