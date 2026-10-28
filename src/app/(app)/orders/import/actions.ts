'use server';

import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logActivity } from '@/lib/log';
import { groupOrders, parseCsv } from '@/lib/csv';

type Result = { ok: boolean; message: string; created?: number; held?: number; skipped?: number };

/**
 * Create orders from a CSV file. Everything is checked again here (the browser preview is only a preview):
 * products must belong to the client, every order needs a customer, address and country. All orders are
 * created together, or none are. Order numbers already imported for this client are skipped, never duplicated.
 */
export async function importOrdersCsv(payload: string): Promise<Result> {
  const ctx = await getCtx();
  if (!ctx?.can('orders.create')) return { ok: false, message: 'You don’t have access to that.' };
  let data: { orgId?: string; text: string; file: string };
  try {
    data = JSON.parse(payload);
  } catch {
    return { ok: false, message: 'Invalid data.' };
  }
  const orgId = ctx.org?.id ?? String(data.orgId ?? '');
  if (!/^[0-9a-f-]{36}$/.test(orgId)) return { ok: false, message: 'Choose the client first.' };
  if (typeof data.text !== 'string' || data.text.length > 5_000_000) return { ok: false, message: 'The file is too large (5 MB max).' };

  const sb = await supabaseServer();
  const { data: prods } = await sb.from('products').select('id, sku, hs_code, customs_value, kind').eq('org_id', orgId).limit(20000);
  const bySku = new Map((prods ?? []).map((p) => [p.sku.toUpperCase(), p]));
  const orders = groupOrders(parseCsv(data.text).rows, new Set(bySku.keys()));
  if (!orders.length) return { ok: false, message: 'No orders found in the file.' };
  if (orders.length > 2000) return { ok: false, message: 'At most 2,000 orders per file. Split it into smaller files.' };
  const bad = orders.filter((o) => o.errors.length);
  if (bad.length) return { ok: false, message: `${bad.length} order${bad.length === 1 ? ' has' : 's have'} errors (e.g. ${bad[0].ref || 'line ' + bad[0].lineNos[0]}: ${bad[0].errors[0]}). Fix the file and upload it again.` };

  // Same order number already imported for this client → skipped (safe to upload the same file twice).
  const refs = orders.map((o) => o.ref);
  const { data: have } = await supabaseAdmin().from('orders').select('store_ref').eq('org_id', orgId).eq('source', 'csv').in('store_ref', refs);
  const existing = new Set((have ?? []).map((x) => x.store_ref));
  const fresh = orders.filter((o) => !existing.has(o.ref));
  if (!fresh.length) return { ok: true, message: `All ${orders.length} orders were already imported. Nothing changed.`, created: 0, skipped: orders.length };

  const rows = fresh.map((o) => {
    const noCustoms = o.lines.some((l) => { const p = bySku.get(l.sku)! as { hs_code: string | null; customs_value: number; kind?: string }; return p.kind !== 'bundle' && (!p.hs_code || !Number(p.customs_value)); });
    return {
      org_id: orgId, store_ref: o.ref, source: 'csv', customer: o.customer, email: o.email || null, phone: o.phone || null,
      address: o.address, city: o.city || null, zip: o.zip || null, country: o.country, service: o.service,
      status: noCustoms ? 'on_hold' : 'new', hold_reason: noCustoms ? 'A product is missing its HS code or customs value' : null, created_by: ctx.userId,
    };
  });
  const { data: created, error } = await sb.from('orders').insert(rows).select('id, store_ref, status');
  if (error || !created) return { ok: false, message: error?.message ?? 'The orders couldn’t be created.' };
  const idOf = new Map(created.map((c) => [c.store_ref, c.id]));
  const items = fresh.flatMap((o) => o.lines.map((l) => ({ order_id: idOf.get(o.ref)!, product_id: bySku.get(l.sku)!.id, qty: l.qty })));
  const { error: itemsErr } = await sb.from('order_items').insert(items);
  if (itemsErr) {
    // All or nothing: never leave orders without their products.
    await supabaseAdmin().from('orders').delete().in('id', created.map((c) => c.id));
    return { ok: false, message: `Nothing was imported: ${itemsErr.message}` };
  }
  const held = created.filter((c) => c.status === 'on_hold').length;
  await logActivity(sb, ctx.userId, orgId, 'orders_imported', `${created.length} order${created.length === 1 ? '' : 's'} from ${String(data.file).slice(0, 80)}${held ? ` · ${held} on hold` : ''}`);
  return {
    ok: true, created: created.length, held, skipped: orders.length - fresh.length,
    message: `${created.length} order${created.length === 1 ? '' : 's'} imported${held ? `, ${held} on hold (products missing customs info)` : ''}${existing.size ? `, ${orders.length - fresh.length} already imported before and skipped` : ''}.`,
  };
}
