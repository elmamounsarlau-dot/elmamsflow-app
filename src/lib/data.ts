import 'server-only';
import { supabaseServer } from './supabase/server';
import type { Ctx } from './session';

export type ProductRow = {
  id: string; org_id: string; sku: string; name: string; barcode: string | null; weight_g: number; hs_code: string | null;
  customs_value: number; low_stock: number; on_hand: number; reserved: number; incoming: number; quarantined: number;
  last_movement_at: string | null; in_transfer?: number; unallocated?: number;
};

/** Sellable now: on hand − quarantined − reserved for open orders. */
export const available = (p: Pick<ProductRow, 'on_hand' | 'quarantined' | 'reserved'>) => Math.max(0, p.on_hand - p.quarantined - p.reserved);

/**
 * Every matching row, read 1,000 at a time. The database API returns at most 1,000 rows per request,
 * so a plain query silently stops there — wrong totals once a client has more products or orders than that.
 * `make` must build the query with a stable order.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function allRows<T>(make: () => any, cap = 100_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function getProducts(ctx: Ctx) {
  const sb = await supabaseServer();
  return allRows<ProductRow>(() => {
    let q = sb.from('product_stock').select('*').order('name').order('id');
    if (ctx.org) q = q.eq('org_id', ctx.org.id);
    return q;
  });
}

export async function getClients() {
  const sb = await supabaseServer();
  return allRows<{ id: string; name: string; code: string | null; status: string; country: string | null; created_at: string }>(() =>
    sb.from('organizations').select('id, name, code, status, country, created_at').eq('kind', 'client').order('created_at', { ascending: false }).order('id'));
}

export async function orgNames(): Promise<Record<string, string>> {
  const list = await getClients();
  return Object.fromEntries(list.map((c) => [c.id, c.name]));
}

export function productOptions(products: ProductRow[], names?: Record<string, string>) {
  return products.map((p) => ({
    id: p.id,
    org: p.org_id,
    label: `${names ? names[p.org_id] + ' — ' : ''}${p.sku} · ${p.name} (${available(p)} available)`,
  }));
}

export function itemsFromForm(fd: FormData) {
  const ids = fd.getAll('item_product').map(String);
  const qtys = fd.getAll('item_qty').map((v) => parseInt(String(v), 10) || 0);
  const map = new Map<string, number>();
  ids.forEach((id, i) => {
    if (id && qtys[i] > 0) map.set(id, (map.get(id) ?? 0) + qtys[i]);
  });
  return [...map.entries()].map(([product_id, qty]) => ({ product_id, qty }));
}
