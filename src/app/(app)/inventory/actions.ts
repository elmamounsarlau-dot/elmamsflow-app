'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';

export async function addProduct(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx?.can('products.edit')) redirect(withMsg('/inventory', 'You don’t have access to that.', 'err'));
  const orgId = ctx.org?.id ?? str(fd, 'org_id');
  const sku = str(fd, 'sku').toUpperCase().replace(/[^A-Z0-9\-_.]/g, '');
  const name = str(fd, 'name');
  if (!orgId || !sku || !name) redirect(withMsg('/inventory?new=1', 'Choose the client and add a SKU and a name.', 'err'));
  const sb = await supabaseServer();
  const { error } = await sb.from('products').insert({
    org_id: orgId, sku, name, barcode: str(fd, 'barcode') || null, weight_g: parseInt(str(fd, 'weight_g'), 10) || 0,
    hs_code: str(fd, 'hs_code').replace(/[^0-9.]/g, '') || null, customs_value: parseFloat(str(fd, 'customs_value')) || 0,
    low_stock: Math.max(0, parseInt(str(fd, 'low_stock'), 10) || 0),
  });
  if (error) redirect(withMsg('/inventory?new=1', error.code === '23505' ? `This client already has SKU ${sku}.` : error.message, 'err'));
  await logActivity(sb, ctx.userId, orgId, 'product_added', `${sku} · ${name}`);
  redirect(withMsg('/inventory', `Product ${sku} added.`));
}

export async function adjustStock(fd: FormData) {
  const sb = await supabaseServer();
  const { error } = await sb.rpc('adjust_stock', { p_product: str(fd, 'product'), p_qty: parseInt(str(fd, 'qty'), 10) || 0, p_reason: str(fd, 'reason') || 'Adjustment' });
  redirect(withMsg('/inventory', error ? error.message : 'Stock updated.', error ? 'err' : 'ok'));
}

export async function quarantineStock(fd: FormData) {
  const sb = await supabaseServer();
  const { error } = await sb.rpc('quarantine_stock', { p_product: str(fd, 'product'), p_qty: parseInt(str(fd, 'qty'), 10) || 0, p_reason: str(fd, 'reason') });
  redirect(withMsg('/inventory', error ? error.message : 'Units moved to quarantine. They are no longer available to sell.', error ? 'err' : 'ok'));
}

export async function releaseStock(fd: FormData) {
  const sb = await supabaseServer();
  const writeOff = str(fd, 'mode') === 'writeoff';
  const { error } = await sb.rpc('release_stock', { p_product: str(fd, 'product'), p_qty: parseInt(str(fd, 'qty'), 10) || 0, p_reason: str(fd, 'reason'), p_write_off: writeOff });
  redirect(withMsg('/inventory', error ? error.message : writeOff ? 'Written off and removed from stock.' : 'Released back to available stock.', error ? 'err' : 'ok'));
}
