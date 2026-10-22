// Test-token helpers for the local stack (HS256 with the local-only secret).
import { createHmac } from 'node:crypto';
const SECRET = process.env.LOCAL_JWT_SECRET ?? 'local-only-jwt-secret-0123456789-abcdef';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function sign(claims) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
export function verify(token) {
  const [h, b, s] = (token ?? '').split('.');
  if (!h || !b || !s) return null;
  if (createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url') !== s) return null;
  const c = JSON.parse(Buffer.from(b, 'base64url').toString());
  return c.exp && c.exp * 1000 < Date.now() ? null : c;
}
export const userJson = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: u.signedIn ? '2026-10-01T00:00:00Z' : null, app_metadata: { provider: 'email' }, user_metadata: { full_name: u.name }, created_at: '2026-01-01T00:00:00Z' });
export function session(u) {
  const now = Math.floor(Date.now() / 1000);
  const access_token = sign({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 7 * 86400, session_id: u.id, amr: [{ method: 'password', timestamp: now }] });
  return { access_token, refresh_token: u.id, token_type: 'bearer', expires_in: 7 * 86400, expires_at: now + 7 * 86400, user: userJson(u) };
}
