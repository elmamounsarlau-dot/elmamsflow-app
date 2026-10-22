import 'server-only';
import { supabaseAdmin } from '../supabase/admin';
import { open, seal } from './crypto';

export type Kind = 'shopify' | 'woocommerce';

export type Integration = {
  id: string;
  org_id: string;
  kind: Kind;
  store_url: string;
  name: string | null;
  status: 'active' | 'paused' | 'error';
  secret_enc: string;
  token_enc: string | null;
  token_expires_at: string | null;
  settings: { auto_import?: boolean; push_tracking?: boolean };
  last_sync_at: string | null;
  last_error: string | null;
  orders_imported: number;
  created_at: string;
};

/** An order as it comes from any store, before it becomes an Elmamsflow order. */
export type ExtOrder = {
  external_id: string;
  ref: string;
  customer: string;
  email: string | null;
  phone: string | null;
  address: string;
  city: string | null;
  zip: string | null;
  country: string;
  lines: { sku: string; qty: number; name: string }[];
  /** Paid and waiting to be shipped. */
  shippable: boolean;
  cancelled: boolean;
};

export type ExtProduct = { sku: string; name: string; barcode: string | null; weight_g: number };

export const STORE_STATUS: Record<string, [string, string]> = { active: ['Connected', 'ok'], paused: ['Paused', 'mute'], error: ['Needs attention', 'err'] };

export const KIND_LABEL: Record<Kind, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce' };

export async function loadIntegration(id: string) {
  const { data } = await supabaseAdmin().from('integrations').select('*').eq('id', id).maybeSingle();
  return (data as Integration) ?? null;
}

export const secretsOf = <T>(i: Integration) => open<T>(i.secret_enc);

export async function saveToken(i: Integration, token: string, expiresInSec: number) {
  const exp = new Date(Date.now() + expiresInSec * 1000).toISOString();
  await supabaseAdmin().from('integrations').update({ token_enc: seal(token), token_expires_at: exp }).eq('id', i.id);
  i.token_enc = seal(token);
  i.token_expires_at = exp;
}

export async function logEvent(i: Pick<Integration, 'id' | 'org_id'>, kind: string, detail: string) {
  await supabaseAdmin().from('integration_events').insert({ integration_id: i.id, org_id: i.org_id, kind, detail: detail.slice(0, 500) });
}

export async function markError(i: Integration, message: string) {
  await supabaseAdmin().from('integrations').update({ last_error: message.slice(0, 500) }).eq('id', i.id);
  await logEvent(i, 'error', message);
}

const norm = (s: string) => s.trim().toUpperCase();

type Prod = { id: string; sku: string; hs_code: string | null; customs_value: number };

/** Match store lines to this client's products by SKU. */
function match(lines: ExtOrder['lines'], products: Prod[]) {
  const bySku = new Map(products.map((p) => [norm(p.sku), p]));
  const items = new Map<string, number>();
  const unmatched: string[] = [];
  for (const l of lines) {
    if (l.qty <= 0) continue;
    const p = l.sku ? bySku.get(norm(l.sku)) : undefined;
    if (p) items.set(p.id, (items.get(p.id) ?? 0) + l.qty);
    else unmatched.push(l.sku || `“${l.name}” (no SKU)`);
  }
  const used = products.filter((p) => items.has(p.id));
  const noCustoms = used.some((p) => !p.hs_code || !Number(p.customs_value));
  return { items: [...items.entries()].map(([product_id, qty]) => ({ product_id, qty })), unmatched, noCustoms };
}

function holdReason(unmatched: string[], noCustoms: boolean, noAddress: boolean) {
  if (noAddress) return 'The shipping address is incomplete in the store';
  if (unmatched.length) return `Not in Elmamsflow yet: ${unmatched.slice(0, 6).join(', ')}${unmatched.length > 6 ? '…' : ''}. Add these products, then press “Match products again”`;
  if (noCustoms) return 'A product is missing its HS code or customs value';
  return null;
}

/** Create (or cancel) the Elmamsflow order for one store order. Safe to call twice for the same order. */
export async function importOrder(i: Integration, o: ExtOrder): Promise<'imported' | 'exists' | 'cancelled' | 'skipped'> {
  const admin = supabaseAdmin();
  const { data: existing } = await admin.from('orders').select('id, number, status').eq('integration_id', i.id).eq('external_id', o.external_id).maybeSingle();

  if (o.cancelled) {
    if (existing && ['new', 'on_hold'].includes(existing.status)) {
      await admin.from('orders').update({ status: 'cancelled' }).eq('id', existing.id);
      await admin.from('activity_log').insert({ org_id: i.org_id, action: 'order_cancelled', detail: `#${existing.number} · cancelled in ${o.ref ? `the store (${o.ref})` : 'the store'}` });
      await logEvent(i, 'cancelled', `${o.ref} cancelled in the store → #${existing.number} cancelled`);
      return 'cancelled';
    }
    return 'skipped';
  }
  if (existing) return 'exists';
  if (!o.shippable) return 'skipped';

  const { data: prods } = await admin.from('products').select('id, sku, hs_code, customs_value').eq('org_id', i.org_id);
  const m = match(o.lines, (prods ?? []) as Prod[]);
  if (!m.items.length && !m.unmatched.length) return 'skipped'; // nothing to ship (digital items only)
  const noAddress = !o.address || !o.country;
  const reason = holdReason(m.unmatched, m.noCustoms, noAddress);

  const { data: order, error } = await admin.from('orders').insert({
    org_id: i.org_id, store_ref: o.ref || null, customer: o.customer || 'Customer', email: o.email, phone: o.phone,
    address: o.address || '—', city: o.city, zip: o.zip, country: (o.country || 'XX').toUpperCase().slice(0, 2), service: 'express',
    status: reason ? 'on_hold' : 'new', hold_reason: reason,
    source: i.kind, integration_id: i.id, external_id: o.external_id, external_lines: o.lines,
  }).select('id, number').single();
  if (error || !order) {
    if (error?.code === '23505') return 'exists';
    throw new Error(error?.message ?? 'Could not create the order');
  }
  if (m.items.length) await admin.from('order_items').insert(m.items.map((it) => ({ ...it, order_id: order.id })));
  await admin.from('integrations').update({ orders_imported: (i.orders_imported ?? 0) + 1, last_error: null }).eq('id', i.id);
  i.orders_imported = (i.orders_imported ?? 0) + 1;
  await admin.from('activity_log').insert({ org_id: i.org_id, action: 'order_created', detail: `#${order.number} · ${o.ref} from ${KIND_LABEL[i.kind]}` });
  await logEvent(i, 'imported', `${o.ref} → #${order.number}${reason ? ' (on hold)' : ''}`);
  return 'imported';
}

/** After the client adds missing products: match the store lines again and release the hold if everything fits. */
export async function rematchOrder(orderId: string) {
  const admin = supabaseAdmin();
  const { data: o } = await admin.from('orders').select('id, org_id, status, external_lines, address, country').eq('id', orderId).maybeSingle();
  if (!o || !o.external_lines || !['new', 'on_hold'].includes(o.status)) return { ok: false, message: 'This order can’t be matched again.' };
  const { data: prods } = await admin.from('products').select('id, sku, hs_code, customs_value').eq('org_id', o.org_id);
  const m = match(o.external_lines as ExtOrder['lines'], (prods ?? []) as Prod[]);
  await admin.from('order_items').delete().eq('order_id', o.id);
  if (m.items.length) await admin.from('order_items').insert(m.items.map((it) => ({ ...it, order_id: o.id })));
  const reason = holdReason(m.unmatched, m.noCustoms, !o.address || o.address === '—' || o.country === 'XX');
  await admin.from('orders').update({ status: reason ? 'on_hold' : 'new', hold_reason: reason }).eq('id', o.id);
  return { ok: !reason, message: reason ? `Still on hold: ${reason}` : 'All products matched. The order is ready for the warehouse.' };
}

export function tracking17(number: string) {
  return `https://t.17track.net/en#nums=${encodeURIComponent(number)}`;
}
