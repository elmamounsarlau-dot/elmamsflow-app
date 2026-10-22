'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';

async function owner() {
  const ctx = await getCtx();
  if (ctx?.staffRole !== 'owner' || ctx.viewingAs) redirect(withMsg('/warehouses', 'Only the owner can change warehouses.', 'err'));
  return ctx;
}

export async function addWarehouse(fd: FormData) {
  const ctx = await owner();
  const code = str(fd, 'code').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const name = str(fd, 'name').slice(0, 80);
  if (!/^[A-Z0-9]{2,10}$/.test(code) || !name) redirect(withMsg('/warehouses', 'Give the warehouse a name and a 2–10 letter code.', 'err'));
  if (code === 'UNALLOC') redirect(withMsg('/warehouses', 'That code is reserved.', 'err'));
  const admin = supabaseAdmin();
  const { error } = await admin.from('warehouses').insert({ code, name, city: str(fd, 'city').slice(0, 80) || null, province: str(fd, 'province').slice(0, 80) || null, kind: 'physical' });
  if (error) redirect(withMsg('/warehouses', error.code === '23505' ? `A warehouse with code ${code} already exists.` : error.message, 'err'));
  await logActivity(admin, ctx.userId, null, 'warehouse_added', `${name} (${code})`);
  revalidatePath('/', 'layout');
  redirect(withMsg('/warehouses', `${name} added. It can now receive inbounds and ship orders.`));
}

export async function toggleWarehouse(fd: FormData) {
  const ctx = await owner();
  const id = str(fd, 'id');
  const admin = supabaseAdmin();
  const { data: w } = await admin.from('warehouses').select('id, name, kind, active').eq('id', id).maybeSingle();
  if (!w || w.kind !== 'physical') redirect(withMsg('/warehouses', 'Warehouse not found.', 'err'));
  if (w.active) {
    // A warehouse that still holds stock or has work in progress can't be closed.
    const [{ data: stock }, { count: openOrders }, { count: openInbounds }, { count: openTransfers }] = await Promise.all([
      admin.from('warehouse_stock').select('on_hand').eq('warehouse_id', id).neq('on_hand', 0).limit(1),
      admin.from('orders').select('id', { count: 'exact', head: true }).eq('warehouse_id', id).in('status', ['new', 'on_hold', 'packed']),
      admin.from('inbounds').select('id', { count: 'exact', head: true }).eq('warehouse_id', id).neq('status', 'received').neq('status', 'cancelled'),
      admin.from('transfers').select('id', { count: 'exact', head: true }).or(`from_warehouse_id.eq.${id},to_warehouse_id.eq.${id}`).in('status', ['requested', 'in_transit']),
    ]);
    const why = [stock?.length ? 'it still holds stock' : '', openOrders ? `${openOrders} open order${openOrders === 1 ? '' : 's'}` : '', openInbounds ? `${openInbounds} inbound${openInbounds === 1 ? '' : 's'} on the way` : '', openTransfers ? `${openTransfers} open transfer${openTransfers === 1 ? '' : 's'}` : ''].filter(Boolean);
    if (why.length) redirect(withMsg('/warehouses', `${w.name} can’t be closed yet: ${why.join(', ')}.`, 'warn'));
  }
  await admin.from('warehouses').update({ active: !w.active }).eq('id', id);
  await logActivity(admin, ctx.userId, null, w.active ? 'warehouse_closed' : 'warehouse_reopened', w.name);
  revalidatePath('/', 'layout');
  redirect(withMsg('/warehouses', w.active ? `${w.name} closed. Its history stays.` : `${w.name} reopened.`));
}
