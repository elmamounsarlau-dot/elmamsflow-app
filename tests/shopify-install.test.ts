/* eslint-disable @typescript-eslint/no-explicit-any -- the fake Shopify below takes loosely-typed requests */
// One-link Shopify connection, against the LOCAL test stack and a fake Shopify (npm run test:stack). Never production.
//   install link → /api/shopify/install (signed by Shopify) → Shopify asks the owner → /api/shopify/callback → store connected
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '../src/lib/supabase/admin';
import { seal } from '../src/lib/integrations/crypto';
import { SHOPIFY_SCOPES } from '../src/lib/integrations/shopify';
import { queryHmacOk } from '../src/lib/integrations/shopify-install';
import { GET as install } from '../src/app/api/shopify/install/route';
import { GET as callback } from '../src/app/api/shopify/callback/route';

if (!/^http:\/\/127\.0\.0\.1/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')) throw new Error('local stack only');
const db = () => supabaseAdmin();
const ATLAS = '11111111-1111-1111-1111-111111111111';
const SHOP = 'atlas-link.myshopify.com';
const SECRET = 'app-client-secret';
const calls: string[] = [];
let tokenAsked: any = null;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  if (u.hostname !== SHOP) return realFetch(url as string, init);
  const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/admin/oauth/access_token') {
    tokenAsked = JSON.parse(String(init?.body));
    if (tokenAsked.code !== 'good-code' || tokenAsked.client_secret !== SECRET) return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 });
    return ok({ access_token: 'shpat_from_install', scope: SHOPIFY_SCOPES.join(',') });
  }
  const { query } = JSON.parse(String(init?.body ?? '{}')) as { query: string };
  assert.equal((init?.headers as any)['X-Shopify-Access-Token'], 'shpat_from_install');
  if (/shop \{ name \}/.test(query)) { calls.push('shop'); return ok({ data: { shop: { name: 'Atlas Link Store' } } }); }
  if (/webhookSubscriptionCreate/.test(query)) { calls.push('webhook'); return ok({ data: { webhookSubscriptionCreate: { userErrors: [] } } }); }
  if (/productVariants/.test(query)) { calls.push('products'); return ok({ data: { productVariants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }); }
  throw new Error(`fake Shopify: no handler for ${query.slice(0, 60)}`);
}) as typeof fetch;

/** The query string as Shopify signs it. */
function signed(params: Record<string, string>, secret = SECRET) {
  const q = new URLSearchParams({ ...params, timestamp: String(Math.floor(Date.now() / 1000)) });
  const msg = [...q.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  q.set('hmac', createHmac('sha256', secret).update(msg).digest('hex'));
  return q;
}
const req = (path: string, q: URLSearchParams, cookie?: string) => new NextRequest(`https://app.elmamsflow.com${path}?${q}`, { headers: cookie ? { cookie } : {} });

before(async () => {
  await db().from('integrations').delete().eq('store_url', SHOP);
  await db().from('shopify_installs').delete().eq('shop', SHOP);
  const { error } = await db().from('shopify_installs').insert({ org_id: ATLAS, shop: SHOP, client_id: 'app-client-id', secret_enc: seal(SECRET), install_link: 'https://admin.shopify.com/oauth/install?client_id=x' });
  assert.ifError(error);
});

test('signature check: Shopify’s signed query passes, a changed one fails', () => {
  const q = signed({ shop: SHOP });
  assert.ok(queryHmacOk(SECRET, q));
  q.set('shop', 'other.myshopify.com');
  assert.ok(!queryHmacOk(SECRET, q));
  assert.ok(!queryHmacOk('wrong', signed({ shop: SHOP })));
});

test('unknown store or forged request: refused, nothing connected', async () => {
  assert.equal((await install(req('/api/shopify/install', signed({ shop: 'stranger.myshopify.com' })))).status, 404);
  assert.equal((await install(req('/api/shopify/install', signed({ shop: SHOP }, 'not-the-secret')))).status, 401);
});

test('install → permission → callback: the store connects by itself, with webhooks and products', async () => {
  const r1 = await install(req('/api/shopify/install', signed({ shop: SHOP, host: 'abc' })));
  assert.equal(r1.status, 307);
  const to = new URL(r1.headers.get('location')!);
  assert.equal(to.hostname, SHOP);
  assert.equal(to.pathname, '/admin/oauth/authorize');
  assert.equal(to.searchParams.get('client_id'), 'app-client-id');
  assert.equal(to.searchParams.get('scope'), SHOPIFY_SCOPES.join(','));
  assert.match(to.searchParams.get('redirect_uri')!, /\/api\/shopify\/callback$/);
  const cookie = /elm_shopify_state=([^;]+)/.exec(r1.headers.get('set-cookie') ?? '')![1];
  const state = to.searchParams.get('state')!;

  // A different browser (no cookie) or a wrong state is refused.
  assert.equal((await callback(req('/api/shopify/callback', signed({ shop: SHOP, code: 'good-code', state })))).status, 400);
  assert.equal((await callback(req('/api/shopify/callback', signed({ shop: SHOP, code: 'good-code', state: 'nope' }), `elm_shopify_state=${cookie}`))).status, 400);

  const r2 = await callback(req('/api/shopify/callback', signed({ shop: SHOP, code: 'good-code', state }), `elm_shopify_state=${cookie}`));
  const html = await r2.text();
  assert.equal(r2.status, 200, html);
  assert.match(html, /Atlas Link Store is connected/);
  assert.equal(tokenAsked.client_id, 'app-client-id');

  const { data: i } = await db().from('integrations').select('id, org_id, role, status, name, settings').eq('store_url', SHOP).single();
  assert.equal(i!.org_id, ATLAS);
  assert.equal(i!.role, 'store');
  assert.equal(i!.status, 'active');
  assert.deepEqual(i!.settings, { auto_import: true, push_tracking: true });
  const { data: x } = await db().from('shopify_installs').select('status, integration_id').eq('shop', SHOP).single();
  assert.equal(x!.status, 'installed');
  assert.equal(x!.integration_id, i!.id);
  assert.ok(calls.includes('webhook') && calls.includes('products'), calls.join(','));

  // Opening the app again later just says it's connected.
  const r3 = await install(req('/api/shopify/install', signed({ shop: SHOP })));
  assert.equal(r3.status, 200);
  assert.match(await r3.text(), /Your store is connected/);
});
