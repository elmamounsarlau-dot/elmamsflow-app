// Builds real Supabase session cookies for a local test user (local stack only).
import { createServerClient } from '@supabase/ssr';
import { readFileSync } from 'node:fs';
import { session } from '../supabase/local/gateway-sign.mjs';

const users = JSON.parse(readFileSync(new URL('../supabase/local/users.json', import.meta.url), 'utf8'));

export async function cookiesFor(email, baseUrl) {
  const u = users.find((x) => x.email === email);
  if (!u) throw new Error(`no local test user ${email}`);
  const jar = new Map();
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)) },
  });
  const s = session(u);
  const { error } = await sb.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw error;
  const host = new URL(baseUrl).hostname;
  return [...jar].map(([name, value]) => ({ name, value, domain: host, path: '/', httpOnly: false, secure: false, sameSite: 'Lax' }));
}
