import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '../supabase/admin';
import { siteUrl } from '../format';
import { logActivity } from '../log';
import { open, seal } from './crypto';
import { KIND_LABEL, logEvent, type Integration } from './core';
import { SHOPIFY_SCOPES, gql } from './shopify';
import { importProducts, registerWebhooks } from './service';

/**
 * One-link Shopify connection. Elmamsflow makes a custom-distribution app for the client's store in its own
 * Dev Dashboard and sends the client Shopify's install link. The client clicks Install; Shopify sends them to
 * /api/shopify/install, we ask for the permissions (OAuth) and /api/shopify/callback saves the store's token.
 */

export type ShopifyInstall = {
  id: string; org_id: string; shop: string; client_id: string; secret_enc: string; install_link: string | null;
  status: 'waiting' | 'installed' | 'cancelled'; integration_id: string | null; last_error: string | null; created_by: string | null;
  created_at: string; installed_at: string | null;
};

export const installAppUrl = () => `${siteUrl()}/api/shopify/install`;
export const installCallbackUrl = () => `${siteUrl()}/api/shopify/callback`;

/** Shopify signs the query string it sends us (hex HMAC-SHA256 of the sorted parameters, without `hmac`). */
export function queryHmacOk(secret: string, params: URLSearchParams) {
  const given = params.get('hmac');
  if (!given || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const msg = [...params.entries()].filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const want = createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
  return timingSafeEqual(Buffer.from(want), Buffer.from(given.toLowerCase()));
}

/** Shopify's timestamp is recent (stops an old signed link from being replayed). */
export const freshTimestamp = (t: string | null) => !!t && /^\d+$/.test(t) && Math.abs(Date.now() / 1000 - Number(t)) < 24 * 3600;

/** The install set up for this store (waiting first, else the one already done). */
export async function findInstall(shop: string) {
  const { data } = await supabaseAdmin().from('shopify_installs').select('*').eq('shop', shop).neq('status', 'cancelled')
    .order('status', { ascending: false }) // 'waiting' sorts before 'installed' descending
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return (data as ShopifyInstall | null) ?? null;
}

export const secretOf = (x: ShopifyInstall) => open<string>(x.secret_enc);

export function authorizeUrl(x: ShopifyInstall, state: string) {
  const q = new URLSearchParams({ client_id: x.client_id, scope: SHOPIFY_SCOPES.join(','), redirect_uri: installCallbackUrl(), state });
  return `https://${x.shop}/admin/oauth/authorize?${q}`;
}

async function exchange(x: ShopifyInstall, code: string) {
  const res = await fetch(`https://${x.shop}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: x.client_id, client_secret: secretOf(x), code }), cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`Shopify didn’t give access: ${json.error_description || json.error || `HTTP ${res.status}`}`);
  return { token: json.access_token, scope: json.scope ?? '' };
}

/** The client approved: save the store, switch on order updates, bring its products in. */
export async function completeInstall(x: ShopifyInstall, code: string) {
  const admin = supabaseAdmin();
  try {
    const { token, scope } = await exchange(x, code);
    const name = (await gql<{ shop: { name: string } }>(x.shop, token, '{ shop { name } }')).shop.name;
    const { data: row, error } = await admin.from('integrations').upsert({
      org_id: x.org_id, kind: 'shopify', role: 'store', store_url: x.shop, name, status: 'active',
      secret_enc: seal({ mode: 'token', token, api_secret: secretOf(x) }), token_enc: null, token_expires_at: null,
      settings: { auto_import: true, push_tracking: true }, last_error: null, created_by: x.created_by,
    }, { onConflict: 'org_id,kind,store_url' }).select('*').single();
    if (error || !row) throw new Error(error?.message ?? 'The store could not be saved.');
    const i = row as Integration;
    await admin.from('shopify_installs').update({ status: 'installed', installed_at: new Date().toISOString(), integration_id: i.id, last_error: null }).eq('id', x.id);
    await logEvent(i, 'connected', `${KIND_LABEL.shopify} store connected by install link: ${name}`);
    if (x.created_by) await logActivity(admin, x.created_by, x.org_id, 'store_connected', `${KIND_LABEL.shopify} · ${name} (install link)`);
    const missing = SHOPIFY_SCOPES.filter((s) => !scope.split(',').map((v) => v.trim()).includes(s));
    if (scope && missing.length) await logEvent(i, 'error', `Shopify didn’t grant: ${missing.join(', ')} — add them to the app's scopes and release a new version.`);
    await registerWebhooks(i).catch(async (e) => { await logEvent(i, 'error', (e as Error).message); });
    await importProducts(i).catch(async (e) => { await logEvent(i, 'error', `Products not imported: ${(e as Error).message}`); });
    return { ok: true as const, name };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await admin.from('shopify_installs').update({ last_error: msg }).eq('id', x.id);
    return { ok: false as const, error: msg };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A small branded page for the store owner (they are not signed in to Elmamsflow). */
export function installPage(title: string, text: string, ok: boolean, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Elmamsflow</title><meta name="robots" content="noindex">
<style>:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--ink:#0f172a;--mute:#475569;--acc:${ok ? '#16a34a' : '#dc2626'}}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#121a2f;--ink:#e5e7eb;--mute:#a3acc2}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
main{background:var(--card);max-width:28rem;width:100%;border-radius:16px;padding:2rem;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.dot{width:44px;height:44px;border-radius:50%;background:var(--acc);display:grid;place-items:center;color:#fff;font-size:22px;margin-bottom:1rem}
h1{font-size:1.35rem;margin:0 0 .5rem}p{color:var(--mute);margin:0 0 1.2rem}a{display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:.65rem 1.1rem;border-radius:10px;font-weight:600}
small{display:block;margin-top:1.4rem;color:var(--mute)}</style></head>
<body><main><div class="dot" aria-hidden="true">${ok ? '✓' : '!'}</div><h1>${esc(title)}</h1><p>${esc(text)}</p>
<a href="https://app.elmamsflow.com">Open Elmamsflow</a><small>Elmamsflow · fulfilment by EL MAMOUN SHIPPING &amp; TRADING</small></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } });
}
