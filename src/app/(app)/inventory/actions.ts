'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { IMAGES, removeFile, saveFile } from '@/lib/files';
import { itemsFromForm } from '@/lib/data';

export async function addProduct(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx?.can('products.edit')) redirect(withMsg('/inventory', 'You don’t have access to that.', 'err'));
  const orgId = ctx.org?.id ?? str(fd, 'org_id');
  const sku = str(fd, 'sku').toUpperCase().replace(/[^A-Z0-9\-_.]/g, '');
  const name = str(fd, 'name');
  if (!orgId || !sku || !name) redirect(withMsg('/inventory/new', 'Choose the client and add a SKU and a name.', 'err'));
  const sb = await supabaseServer();
  const { data: made, error } = await sb.from('products').insert({
    org_id: orgId, sku, name, barcode: str(fd, 'barcode') || null, weight_g: parseInt(str(fd, 'weight_g'), 10) || 0,
    hs_code: str(fd, 'hs_code').replace(/[^0-9.]/g, '') || null, customs_value: parseFloat(str(fd, 'customs_value')) || 0,
    low_stock: Math.max(0, parseInt(str(fd, 'low_stock'), 10) || 0), kind: str(fd, 'kind') === 'bundle' ? 'bundle' : 'item',
  }).select('id').single();
  if (error) redirect(withMsg('/inventory/new', error.code === '23505' ? `This client already has SKU ${sku}.` : error.message, 'err'));
  await logActivity(sb, ctx.userId, orgId, 'product_added', `${sku} · ${name}`);
  if (made && str(fd, 'kind') === 'bundle') redirect(withMsg(`/inventory/${made.id}#kit`, `Kit ${sku} created. Now choose the products inside it.`));
  if (made) {
    const photo = fd.get('photo');
    if (photo instanceof File && photo.size) {
      try {
        const { path } = await saveFile('products', `${orgId}/${made.id}`, photo, { types: IMAGES, maxMb: 5, what: 'photo' });
        await supabaseAdmin().from('products').update({ photo_path: path }).eq('id', made.id);
      } catch (e) {
        redirect(withMsg(`/inventory/${made.id}`, `Product ${sku} added, but the photo wasn’t: ${(e as Error).message}`, 'warn'));
      }
    }
  }
  redirect(withMsg('/inventory', `Product ${sku} added.`));
}

const back = (fd: FormData) => (str(fd, 'back').startsWith('/inventory') ? str(fd, 'back') : '/inventory');
const wh = (fd: FormData) => (/^[0-9a-f-]{36}$/.test(str(fd, 'warehouse_id')) ? str(fd, 'warehouse_id') : null);

export async function adjustStock(fd: FormData) {
  const sb = await supabaseServer();
  const { error } = await sb.rpc('adjust_stock', { p_product: str(fd, 'product'), p_qty: parseInt(str(fd, 'qty'), 10) || 0, p_reason: str(fd, 'reason') || 'Adjustment', p_warehouse: wh(fd) });
  redirect(withMsg(back(fd), error ? error.message : 'Stock updated.', error ? 'err' : 'ok'));
}

export async function quarantineStock(fd: FormData) {
  const sb = await supabaseServer();
  const { error } = await sb.rpc('quarantine_stock', { p_product: str(fd, 'product'), p_qty: parseInt(str(fd, 'qty'), 10) || 0, p_reason: str(fd, 'reason'), p_warehouse: wh(fd) });
  redirect(withMsg(back(fd), error ? error.message : 'Units moved to quarantine. They are no longer available to sell.', error ? 'err' : 'ok'));
}

export async function releaseStock(fd: FormData) {
  const sb = await supabaseServer();
  const writeOff = str(fd, 'mode') === 'writeoff';
  const { error } = await sb.rpc('release_stock', { p_product: str(fd, 'product'), p_qty: parseInt(str(fd, 'qty'), 10) || 0, p_reason: str(fd, 'reason'), p_write_off: writeOff, p_warehouse: wh(fd) });
  redirect(withMsg(back(fd), error ? error.message : writeOff ? 'Written off and removed from stock.' : 'Released back to available stock.', error ? 'err' : 'ok'));
}

/** Edit a product's details (not its SKU or stock). Clients with "Add and edit products" can do this for their own products. */
export async function updateProduct(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'product');
  const to = `/inventory/${id}`;
  if (!ctx?.can('products.edit')) redirect(withMsg(to, 'You don’t have access to that.', 'err'));
  const name = str(fd, 'name');
  if (!name) redirect(withMsg(`${to}#edit`, 'The product needs a name.', 'err'));
  const hs = str(fd, 'hs_code').replace(/[^0-9.]/g, '');
  if (hs && hs.replace(/\./g, '').length < 6) redirect(withMsg(`${to}#edit`, 'An HS code has at least 6 digits, e.g. 6307.90.', 'err'));
  const sb = await supabaseServer();
  const { data, error } = await sb.from('products').update({
    name, barcode: str(fd, 'barcode') || null, weight_g: Math.max(0, parseInt(str(fd, 'weight_g'), 10) || 0),
    hs_code: hs || null, customs_value: Math.max(0, parseFloat(str(fd, 'customs_value')) || 0),
    low_stock: Math.max(0, parseInt(str(fd, 'low_stock'), 10) || 0),
  }).eq('id', id).select('org_id, sku').maybeSingle();
  if (error || !data) redirect(withMsg(`${to}#edit`, error?.message ?? 'You can’t edit this product.', 'err'));
  await logActivity(sb, ctx.userId, data.org_id, 'product_updated', `${data.sku} · ${name}`);
  redirect(withMsg(to, `${data.sku} saved.`));
}

/** Owner only: a stock correction backed by evidence (approver, reason and proof are stored with the movement). */
export async function reconcileStock(fd: FormData) {
  const ctx = await getCtx();
  const b = back(fd);
  if (ctx?.staffRole !== 'owner') redirect(withMsg(b, 'Only the owner can approve a reconciliation.', 'err'));
  const sb = await supabaseServer();
  const { error } = await sb.rpc('reconcile_stock', {
    p_product: str(fd, 'product'), p_qty: parseInt(str(fd, 'qty'), 10) || 0,
    p_reason: str(fd, 'reason').slice(0, 300), p_evidence: str(fd, 'evidence').slice(0, 500), p_ref: str(fd, 'ref').slice(0, 60) || null, p_warehouse: wh(fd),
  });
  redirect(withMsg(b, error ? error.message : 'Reconciliation recorded with your approval and the evidence.', error ? 'err' : 'ok'));
}

/** The brand decides what happens to quarantined units; the warehouse then carries it out. */
export async function requestQuarantine(fd: FormData) {
  const b = back(fd);
  const sb = await supabaseServer();
  const { error } = await sb.rpc('request_quarantine_decision', {
    p_product: str(fd, 'product'), p_warehouse: wh(fd), p_qty: parseInt(str(fd, 'qty'), 10) || 0,
    p_decision: str(fd, 'decision'), p_note: str(fd, 'note').slice(0, 500) || null,
  });
  redirect(withMsg(b, error ? error.message : 'Decision sent to the warehouse. You’ll see it here once it’s done.', error ? 'err' : 'ok'));
}

export async function decideQuarantine(fd: FormData) {
  const to = str(fd, 'back').startsWith('/inventory') ? str(fd, 'back') : '/inventory/decisions';
  const apply = str(fd, 'act') === 'apply';
  const sb = await supabaseServer();
  const { error } = await sb.rpc('decide_quarantine', { p_request: str(fd, 'request'), p_apply: apply, p_note: str(fd, 'note').slice(0, 300) || null });
  redirect(withMsg(to, error ? error.message : apply ? 'Done. Stock updated and the brand can see it.' : 'Declined. The brand sees your note.', error ? 'err' : 'ok'));
}

/** Product photo: add, replace or remove. */
export async function saveProductPhoto(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'product');
  const to = `/inventory/${id}`;
  if (!ctx?.can('products.edit')) redirect(withMsg(to, 'You don’t have access to that.', 'err'));
  const sb = await supabaseServer();
  const { data: p } = await sb.from('products').select('id, org_id, sku, photo_path').eq('id', id).maybeSingle();
  if (!p) redirect(withMsg('/inventory', 'Product not found.', 'err'));
  const admin = supabaseAdmin();
  let path: string | null = null;
  const file = fd.get('photo');
  if (str(fd, 'remove') !== '1') {
    if (!(file instanceof File) || !file.size) redirect(withMsg(to, 'Choose a photo first.', 'warn'));
    try {
      path = (await saveFile('products', `${p.org_id}/${p.id}`, file as File, { types: IMAGES, maxMb: 5, what: 'photo' })).path;
    } catch (e) {
      redirect(withMsg(to, (e as Error).message, 'err'));
    }
  }
  // RLS already confirmed this person may edit the product; the column is written by the server.
  const { error } = await admin.from('products').update({ photo_path: path }).eq('id', p.id);
  if (error) redirect(withMsg(to, error.message, 'err'));
  await removeFile('products', p.photo_path);
  await logActivity(sb, ctx.userId, p.org_id, 'product_photo', p.sku);
  redirect(withMsg(to, path ? 'Photo saved.' : 'Photo removed.'));
}

/** A kit: which single products it contains, and how many of each. */
export async function saveBundle(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'product');
  const to = `/inventory/${id}`;
  if (!ctx?.can('products.edit')) redirect(withMsg(to, 'You don’t have access to that.', 'err'));
  const items = itemsFromForm(fd).filter((i) => i.product_id !== id);
  if (!items.length) redirect(withMsg(`${to}#kit`, 'Add at least one product to the kit.', 'err'));
  const sb = await supabaseServer();
  const { data: p } = await sb.from('products').select('id, org_id, sku, kind').eq('id', id).maybeSingle();
  if (!p || p.kind !== 'bundle') redirect(withMsg(to, 'This product is not a kit.', 'err'));
  const { error: d } = await sb.from('bundle_items').delete().eq('bundle_id', id);
  if (d) redirect(withMsg(`${to}#kit`, d.message, 'err'));
  const { error } = await sb.from('bundle_items').insert(items.map((i) => ({ bundle_id: id, component_id: i.product_id, qty: Math.min(1000, i.qty) })));
  if (error) redirect(withMsg(`${to}#kit`, error.message, 'err'));
  await logActivity(sb, ctx.userId, p.org_id, 'bundle_saved', `${p.sku} · ${items.length} product${items.length === 1 ? '' : 's'}`);
  redirect(withMsg(to, 'Kit saved. Orders for it now ship these products.'));
}
