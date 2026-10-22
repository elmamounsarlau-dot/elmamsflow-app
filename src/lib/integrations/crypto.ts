import 'server-only';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Store credentials are encrypted (AES-256-GCM) before they reach the database.
 *  The key comes from INTEGRATIONS_KEY if set, otherwise it is derived from the server-only service key. */
function key() {
  const base = process.env.INTEGRATIONS_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) throw new Error('No encryption key available');
  return createHash('sha256').update(`elmamsflow-integrations:${base}`).digest();
}

export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function open<T>(sealed: string): T {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8')) as T;
}

/** Constant-time check of a base64 HMAC-SHA256 signature over the raw request body. */
export function hmacOk(secret: string, body: string, signature: string | null) {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const randomSecret = () => randomBytes(24).toString('base64url');
