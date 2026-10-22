import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Scheduled jobs are allowed only with the shared secret Vercel sends as `Authorization: Bearer <CRON_SECRET>`.
 * Fails closed: no secret configured (or a short one) → every call is refused. Headers such as User-Agent are never trusted.
 */
export function cronAllowed(authorization: string | null, secret = process.env.CRON_SECRET): { ok: boolean; reason: 'ok' | 'not_configured' | 'denied' } {
  if (!secret || secret.length < 16) return { ok: false, reason: 'not_configured' };
  const given = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  // Compare fixed-length digests so neither the length nor the content of the secret leaks through timing.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b) && given.length > 0 ? { ok: true, reason: 'ok' } : { ok: false, reason: 'denied' };
}
