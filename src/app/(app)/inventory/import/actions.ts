'use server';

import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { logActivity } from '@/lib/log';

type Result = { ok: boolean; message: string };

export async function applyStockCount(payload: string): Promise<Result> {
  const ctx = await getCtx();
  if (!ctx?.can('stock.adjust')) return { ok: false, message: 'You don’t have access to that.' };
  let data: { rows: { product_id: string; counted: number; note?: string }[]; file: string; hash: string; confirmedOn: string; confirmedBy: string };
  try {
    data = JSON.parse(payload);
  } catch {
    return { ok: false, message: 'Invalid data.' };
  }
  if (!Array.isArray(data.rows) || data.rows.length === 0 || data.rows.length > 5000) return { ok: false, message: 'Nothing to import.' };
  if (data.rows.some((r) => !/^[0-9a-f-]{36}$/.test(r.product_id) || !Number.isInteger(r.counted) || r.counted < 0)) return { ok: false, message: 'Some rows are invalid. Check the preview.' };
  const sb = await supabaseServer();
  const { data: res, error } = await sb.rpc('apply_stock_count', {
    p_rows: data.rows, p_file: String(data.file).slice(0, 200), p_hash: String(data.hash).slice(0, 128),
    p_confirmed_on: /^\d{4}-\d{2}-\d{2}$/.test(data.confirmedOn) ? data.confirmedOn : null, p_confirmed_by: String(data.confirmedBy ?? '').slice(0, 120) || null,
  });
  if (error) return { ok: false, message: error.message };
  const r = res as { changed: number; unchanged: number };
  return { ok: true, message: `Count imported: ${r.changed} SKU${r.changed === 1 ? '' : 's'} corrected, ${r.unchanged} already matched.` };
}

export async function importProducts(payload: string): Promise<Result> {
  const ctx = await getCtx();
  if (!ctx?.can('products.edit')) return { ok: false, message: 'You don’t have access to that.' };
  let data: { orgId: string; rows: { sku: string; name: string; barcode?: string; weight_g?: number; hs_code?: string; customs_value?: number; low_stock?: number }[]; file: string; hash: string };
  try {
    data = JSON.parse(payload);
  } catch {
    return { ok: false, message: 'Invalid data.' };
  }
  const orgId = ctx.org?.id ?? data.orgId;
  if (!orgId) return { ok: false, message: 'Choose the client first.' };
  const rows = (data.rows ?? [])
    .map((r) => ({
      org_id: orgId,
      sku: String(r.sku ?? '').toUpperCase().replace(/[^A-Z0-9\-_.]/g, ''),
      name: String(r.name ?? '').trim().slice(0, 190),
      barcode: r.barcode ? String(r.barcode).slice(0, 64) : null,
      weight_g: Math.max(0, Math.round(Number(r.weight_g) || 0)),
      hs_code: r.hs_code ? String(r.hs_code).replace(/[^0-9.]/g, '') || null : null,
      customs_value: Math.max(0, Number(r.customs_value) || 0),
      low_stock: Math.max(0, Math.round(Number(r.low_stock ?? 10) || 0)),
    }))
    .filter((r) => r.sku && r.name);
  if (!rows.length || rows.length > 5000) return { ok: false, message: 'No valid rows to import.' };
  const sb = await supabaseServer();
  const { data: existing } = await sb.from('products').select('sku').eq('org_id', orgId).in('sku', rows.map((r) => r.sku));
  const have = new Set((existing ?? []).map((e) => e.sku));
  const fresh = rows.filter((r, i) => !have.has(r.sku) && rows.findIndex((x) => x.sku === r.sku) === i);
  if (fresh.length) {
    // All new products in one statement: either every one is added or none is.
    const { error } = await sb.from('products').insert(fresh);
    if (error) return { ok: false, message: error.code === '23505' ? 'Two SKUs in the file (or one already here) differ only by upper/lower case. Fix them and try again.' : error.message };
  }
  // Remember the file afterwards, so a failed attempt can simply be retried.
  await sb.rpc('record_import', { p_kind: 'products', p_org: orgId, p_file: String(data.file).slice(0, 200), p_hash: String(data.hash).slice(0, 128), p_rows: rows.length, p_summary: { added: fresh.length, skipped: rows.length - fresh.length } });
  await logActivity(sb, ctx.userId, orgId, 'products_imported', `${fresh.length} added from ${data.file}`);
  return { ok: true, message: `${fresh.length} product${fresh.length === 1 ? '' : 's'} added. ${rows.length - fresh.length} skipped (SKU already exists).` };
}
