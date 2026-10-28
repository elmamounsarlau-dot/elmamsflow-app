import { ORDER_STATUS } from './format';

/** Problem groups for held orders (set by the database from the hold reason). */
export const HOLD_KIND: Record<string, [string, string, string]> = {
  // key: [tab label, badge label, what to do]
  products: ['Products', 'Unknown product', 'A product from the store isn’t in Elmamsflow yet'],
  customs: ['Customs', 'Customs info', 'A product is missing its HS code or customs value'],
  address: ['Address', 'Address issue', 'The shipping address is incomplete'],
  stock: ['Stock', 'Out of stock', 'Not enough sellable stock'],
  manual: ['Manual hold', 'Manual hold', 'Held on purpose, until someone releases it'],
};

export const SEARCH_FIELDS: [string, string][] = [
  ['order', 'Order ID'],
  ['customer', 'Customer'],
  ['email', 'Email'],
  ['tracking', 'Tracking'],
];

export const CHANNELS: Record<string, string> = { manual: 'Manual', csv: 'CSV import', shopify: 'Shopify', woocommerce: 'WooCommerce' };
export const PER_PAGE = [10, 25, 50, 100];

export type OrderFilters = {
  s: string; t: string; field: string; q: string; src: string; country: string; from: string; to: string; c: string; svc: string; per: number; p: number;
  /** Only orders waiting longer than this many hours (24 or 48), counted from when they arrived. */
  older: string;
  /** Shipped on this day (China time, the warehouse day). */
  shipped: string;
};

/** Midnight of a warehouse day (China time, UTC+8, no daylight saving), as an ISO time. */
export const chinaDayStart = (day: string, plusDays = 0) => new Date(Date.parse(`${day}T00:00:00+08:00`) + plusDays * 864e5).toISOString();

const clean = (v: string) => v.replace(/[,()*%\\]/g, ' ').trim().slice(0, 80);

export function parseFilters(sp: Record<string, string | undefined>, backOffice: boolean): OrderFilters {
  const per = PER_PAGE.includes(Number(sp.per)) ? Number(sp.per) : 25;
  return {
    s: sp.s && ORDER_STATUS[sp.s] ? sp.s : '',
    t: sp.t && (sp.t === 'attention' || HOLD_KIND[sp.t]) ? sp.t : '',
    field: SEARCH_FIELDS.some(([k]) => k === sp.field) ? sp.field! : 'order',
    q: clean(sp.q ?? ''),
    src: sp.src && CHANNELS[sp.src] ? sp.src : '',
    country: /^[A-Za-z]{2}$/.test(sp.country ?? '') ? sp.country!.toUpperCase() : '',
    from: /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? '') ? sp.from! : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? '') ? sp.to! : '',
    c: backOffice && (/^[0-9a-f-]{36}$/.test(sp.c ?? '') || sp.c === 'all') ? sp.c! : '',
    svc: sp.svc === 'ddp' || sp.svc === 'express' ? sp.svc : '',
    per,
    p: Math.max(1, parseInt(sp.p ?? '1', 10) || 1),
    older: sp.older === '24' || sp.older === '48' ? sp.older : '',
    shipped: /^\d{4}-\d{2}-\d{2}$/.test(sp.shipped ?? '') ? sp.shipped! : '',
  };
}

/** Narrow a Supabase orders query by everything except the status / problem tab. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyScope<Q extends { eq: any; or: any; ilike: any; gte: any; lt: any; in: any }>(q: Q, f: OrderFilters, orgId: string | null): Q {
  let x = q;
  if (orgId) x = x.eq('org_id', orgId);
  else if (f.c && f.c !== 'all') x = x.eq('org_id', f.c);
  if (f.src) x = x.eq('source', f.src);
  if (f.country) x = x.eq('country', f.country);
  if (f.svc) x = x.eq('service', f.svc);
  // Dates are warehouse days (China time), like every date shown in the app.
  if (f.from) x = x.gte('created_at', chinaDayStart(f.from));
  if (f.to) x = x.lt('created_at', chinaDayStart(f.to, 1));
  if (f.shipped) x = x.in('status', ['shipped', 'delivered']).gte('shipped_at', chinaDayStart(f.shipped)).lt('shipped_at', chinaDayStart(f.shipped, 1));
  if (f.older) x = x.lt('created_at', new Date(Date.now() - Number(f.older) * 3600e3).toISOString());
  if (f.q) {
    const like = `%${f.q}%`;
    if (f.field === 'order') x = x.or(`number.ilike.${like},store_ref.ilike.${like}`);
    else if (f.field === 'customer') x = x.ilike('customer', like);
    else if (f.field === 'email') x = x.ilike('email', like);
    else x = x.ilike('tracking', like);
  }
  return x;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyTab<Q extends { eq: any }>(q: Q, f: OrderFilters): Q {
  let x = q;
  if (f.t === 'attention') x = x.eq('status', 'on_hold');
  else if (f.t) x = x.eq('status', 'on_hold').eq('hold_kind', f.t);
  if (f.s) x = x.eq('status', f.s);
  return x;
}

export function ordersHref(f: OrderFilters, patch: Partial<Record<keyof OrderFilters, string | number>> = {}) {
  const m = { ...f, ...patch } as Record<string, string | number>;
  const u = new URLSearchParams();
  for (const k of ['t', 's', 'field', 'q', 'src', 'country', 'from', 'to', 'shipped', 'c', 'svc', 'older', 'per', 'p']) {
    const v = m[k];
    if (v === '' || v === undefined) continue;
    if (k === 'field' && (v === 'order' || !m.q)) continue;
    if (k === 'per' && Number(v) === 25) continue;
    if (k === 'p' && Number(v) === 1) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return `/orders${s ? `?${s}` : ''}`;
}

/** Link to the order inside the client's store admin. */
export function storeAdminUrl(kind: string | null, storeUrl: string | null, externalId: string | null) {
  if (!kind || !storeUrl || !externalId) return null;
  if (kind === 'shopify') return `https://admin.shopify.com/store/${storeUrl.replace(/\.myshopify\.com$/, '')}/orders/${externalId.split('/').pop()}`;
  if (kind === 'woocommerce') return `${storeUrl}/wp-admin/post.php?post=${encodeURIComponent(externalId)}&action=edit`;
  return null;
}

export function flag(cc: string) {
  if (!/^[A-Z]{2}$/.test(cc) || cc === 'XX') return '';
  return String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
