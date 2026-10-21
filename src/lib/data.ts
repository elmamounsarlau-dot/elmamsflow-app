import 'server-only';
import { supabaseServer } from './supabase/server';
import type { Ctx } from './session';

export type ProductRow = {
  id: string; org_id: string; sku: string; name: string; barcode: string | null; weight_g: number; hs_code: string | null;
  customs_value: number; low_stock: number; on_hand: number; reserved: number; incoming: number;
};

export async function getProducts(ctx: Ctx) {
  const sb = await supabaseServer();
  let q = sb.from('product_stock').select('*').order('name');
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data } = await q;
  return (data ?? []) as ProductRow[];
}

export async function getClients() {
  const sb = await supabaseServer();
  const { data } = await sb.from('organizations').select('id, name, code, status, country, created_at').eq('kind', 'client').order('created_at', { ascending: false });
  return data ?? [];
}

export async function orgNames(): Promise<Record<string, string>> {
  const list = await getClients();
  return Object.fromEntries(list.map((c) => [c.id, c.name]));
}

export function productOptions(products: ProductRow[], names?: Record<string, string>) {
  return products.map((p) => ({
    id: p.id,
    org: p.org_id,
    label: `${names ? names[p.org_id] + ' — ' : ''}${p.sku} · ${p.name} (${Math.max(0, p.on_hand - p.reserved)} available)`,
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
