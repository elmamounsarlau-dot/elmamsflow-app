import 'server-only';
import { open } from './crypto';
import type { ExtOrder, ExtProduct, Integration } from './core';

export type WooSecrets = { ck: string; cs: string; webhook_secret: string };

export function normalizeWooUrl(input: string) {
  let s = input.trim().replace(/\/+$/, '').replace(/\/wp-admin.*$/, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return null; // keys must never travel unencrypted
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call<T = any>(base: string, s: Pick<WooSecrets, 'ck' | 'cs'>, path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const u = new URL(`${base}/wp-json/wc/v3${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) u.searchParams.set(k, v);
  const auth = Buffer.from(`${s.ck}:${s.cs}`).toString('base64');
  const go = (withQuery: boolean) => {
    const url = new URL(u);
    if (withQuery) { url.searchParams.set('consumer_key', s.ck); url.searchParams.set('consumer_secret', s.cs); }
    return fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...(withQuery ? {} : { Authorization: `Basic ${auth}` }) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    });
  };
  // Some hosts drop the Authorization header; WooCommerce also accepts the keys as parameters over HTTPS.
  let res = await go(false);
  if (res.status === 401) res = await go(true);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const j = json as { message?: string; code?: string } | null;
    if (res.status === 404 && !j?.code) throw new Error('WooCommerce REST API not found at this address. Check the store URL and that permalinks are enabled.');
    if (res.status === 401 || j?.code === 'woocommerce_rest_cannot_view') throw new Error('WooCommerce refused the keys. Create them with “Read/Write” permission.');
    throw new Error(`WooCommerce: ${j?.message ?? text.slice(0, 160) ?? `HTTP ${res.status}`}`);
  }
  if (json === null) throw new Error('WooCommerce sent an unexpected answer (not JSON). Is a security plugin blocking the REST API?');
  return json as T;
}

export const wooCall = <T>(i: Integration, path: string, init?: Parameters<typeof call>[3]) => call<T>(i.store_url, open<WooSecrets>(i.secret_enc), path, init);

export async function wooConnect(base: string, s: Pick<WooSecrets, 'ck' | 'cs'>) {
  await call(base, s, '/orders', { query: { per_page: '1' } });
  let name = new URL(base).hostname;
  try {
    const r = await fetch(`${base}/wp-json`, { cache: 'no-store' });
    const j = (await r.json()) as { name?: string };
    if (j.name) name = j.name;
  } catch { /* keep hostname */ }
  return { name };
}

export async function wooRegisterWebhooks(i: Integration, url: string) {
  const s = open<WooSecrets>(i.secret_enc);
  const errors: string[] = [];
  const existing = await wooCall<{ id: number; delivery_url: string; topic: string }[]>(i, '/webhooks', { query: { per_page: '100' } }).catch(() => []);
  for (const topic of ['order.created', 'order.updated']) {
    if (existing.some((w) => w.delivery_url === url && w.topic === topic)) continue;
    try {
      await wooCall(i, '/webhooks', { method: 'POST', body: { name: `Elmamsflow ${topic}`, topic, delivery_url: url, secret: s.webhook_secret, status: 'active' } });
    } catch (e) {
      errors.push(`${topic}: ${(e as Error).message}`);
    }
  }
  return errors;
}

type WooOrder = {
  id: number; number: string; status: string;
  billing: { first_name: string; last_name: string; email: string; phone: string; company: string };
  shipping: { first_name: string; last_name: string; company: string; address_1: string; address_2: string; city: string; postcode: string; country: string; phone?: string };
  line_items: { sku: string; name: string; quantity: number }[];
};

export function wooToExt(o: WooOrder): ExtOrder {
  const sh = o.shipping;
  const hasShip = !!(sh?.address_1 || sh?.city);
  const a = hasShip ? sh : { ...o.billing, address_1: '', address_2: '', city: '', postcode: '', country: '' };
  return {
    external_id: String(o.id),
    ref: `#${o.number}`,
    customer: [a.first_name, a.last_name].filter(Boolean).join(' ') || [o.billing.first_name, o.billing.last_name].filter(Boolean).join(' ') || 'Customer',
    email: o.billing.email || null,
    phone: (hasShip && sh.phone) || o.billing.phone || null,
    address: hasShip ? [sh.company, sh.address_1, sh.address_2].filter(Boolean).join(', ') : '',
    city: hasShip ? sh.city || null : null,
    zip: hasShip ? sh.postcode || null : null,
    country: hasShip ? sh.country : '',
    lines: o.line_items.map((l) => ({ sku: l.sku ?? '', name: l.name, qty: l.quantity })),
    shippable: o.status === 'processing',
    cancelled: ['cancelled', 'refunded', 'failed'].includes(o.status),
  };
}

export async function wooOpenOrders(i: Integration, since: Date) {
  const out: ExtOrder[] = [];
  for (let page = 1; page <= 5; page++) {
    const list = await wooCall<WooOrder[]>(i, '/orders', { query: { status: 'processing', after: since.toISOString(), per_page: '50', page: String(page), orderby: 'date', order: 'asc' } });
    out.push(...list.map(wooToExt));
    if (list.length < 50) break;
  }
  return out;
}

/** Complete the order in WooCommerce and add the tracking number as a note the customer receives. */
export async function wooFulfil(i: Integration, id: string, carrier: string | null, tracking: string) {
  await wooCall(i, `/orders/${encodeURIComponent(id)}/notes`, { method: 'POST', body: { note: `Your order has shipped${carrier ? ` with ${carrier}` : ''}. Tracking number: ${tracking} — follow it at https://t.17track.net/en#nums=${encodeURIComponent(tracking)}`, customer_note: true } });
  await wooCall(i, `/orders/${encodeURIComponent(id)}`, { method: 'PUT', body: { status: 'completed' } });
}

const TO_G: Record<string, number> = { g: 1, kg: 1000, lbs: 453.592, oz: 28.3495 };

export async function wooProducts(i: Integration) {
  let unit = 'kg';
  try {
    const u = await wooCall<{ value: string }>(i, '/settings/products/woocommerce_weight_unit');
    unit = u.value || 'kg';
  } catch { /* default kg */ }
  const g = (w: string) => Math.round((parseFloat(w) || 0) * (TO_G[unit] ?? 1000));
  const out: ExtProduct[] = [];
  type P = { id: number; name: string; sku: string; type: string; weight: string; global_unique_id?: string };
  for (let page = 1; page <= 10; page++) {
    const list = await wooCall<P[]>(i, '/products', { query: { per_page: '100', page: String(page), status: 'publish' } });
    for (const p of list) {
      if (p.type === 'variable') {
        const vars = await wooCall<(P & { attributes: { option: string }[] })[]>(i, `/products/${p.id}/variations`, { query: { per_page: '100' } }).catch(() => []);
        for (const v of vars) if (v.sku) out.push({ sku: v.sku, name: `${p.name} · ${v.attributes.map((a) => a.option).join(' / ')}`, barcode: v.global_unique_id || null, weight_g: g(v.weight || p.weight) });
      } else if (p.sku) {
        out.push({ sku: p.sku, name: p.name, barcode: p.global_unique_id || null, weight_g: g(p.weight) });
      }
    }
    if (list.length < 100) break;
  }
  return out;
}
