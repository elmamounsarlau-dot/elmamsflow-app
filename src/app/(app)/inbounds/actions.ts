'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { itemsFromForm } from '@/lib/data';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';

export async function createInbound(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx?.can('inbounds.create')) redirect(withMsg('/inbounds', 'You don’t have access to that.', 'err'));
  const orgId = ctx.org?.id ?? str(fd, 'org_id');
  const items = itemsFromForm(fd);
  if (!orgId || !items.length) redirect(withMsg('/inbounds/new', 'Choose the client and add at least one product with a quantity.', 'err'));
  const sb = await supabaseServer();
  const { data: prods } = await sb.from('products').select('id, org_id').in('id', items.map((i) => i.product_id));
  if (!prods || prods.length !== items.length || prods.some((p) => p.org_id !== orgId)) redirect(withMsg('/inbounds/new', 'Those products don’t belong to this client.', 'err'));
  const eta = str(fd, 'eta');
  const { data: ib, error } = await sb.from('inbounds').insert({
    org_id: orgId, cartons: parseInt(str(fd, 'cartons'), 10) || 0, eta: /^\d{4}-\d{2}-\d{2}$/.test(eta) ? eta : null,
    supplier: str(fd, 'supplier') || null, notes: str(fd, 'notes') || null, created_by: ctx.userId,
  }).select('id, ref').single();
  if (error || !ib) redirect(withMsg('/inbounds/new', error?.message ?? 'Could not save.', 'err'));
  await sb.from('inbound_items').insert(items.map((i) => ({ inbound_id: ib.id, product_id: i.product_id, expected: i.qty })));
  await logActivity(sb, ctx.userId, orgId, 'inbound_created', `${ib.ref} · ${items.reduce((a, b) => a + b.qty, 0)} units`);
  redirect(withMsg(`/inbounds/${ib.id}`, `Inbound ${ib.ref} announced. Write this reference on every carton.`));
}

/** One form for the warehouse: move the inbound to any step. "Counted" saves the counts; "Available" adds the units to stock. */
export async function updateInbound(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id');
  if (!ctx?.can('inbounds.receive')) redirect(withMsg(`/inbounds/${id}`, 'You don’t have access to that.', 'err'));
  const status = str(fd, 'status');
  const counts: Record<string, number> = {};
  for (const [k, v] of fd.entries()) if (k.startsWith('rcv_')) counts[k.slice(4)] = Math.max(0, parseInt(String(v), 10) || 0);
  const sb = await supabaseServer();
  if (status === 'received') {
    const { error } = await sb.rpc('receive_inbound', { p_inbound: id, p_counts: counts });
    redirect(withMsg(`/inbounds/${id}`, error ? error.message : 'Done. The units are available in stock now.', error ? 'err' : 'ok'));
  }
  if (status === 'counted') {
    const { error } = await sb.rpc('count_inbound', { p_inbound: id, p_counts: counts });
    redirect(withMsg(`/inbounds/${id}`, error ? (/count_inbound/.test(error.message) ? 'Run the “Counted” database update first.' : error.message) : 'Count saved. Check it, then choose “Available” to add the units to stock.', error ? 'err' : 'ok'));
  }
  if (!['announced', 'in_transit', 'receiving'].includes(status)) redirect(`/inbounds/${id}`);
  const { data, error } = await sb.from('inbounds').update({ status }).eq('id', id).neq('status', 'received').select('org_id, ref').single();
  if (data) await logActivity(sb, ctx.userId, data.org_id, 'inbound_status', `${data.ref} → ${status}`);
  redirect(withMsg(`/inbounds/${id}`, error ? error.message : 'Inbound updated.', error ? 'err' : 'ok'));
}
