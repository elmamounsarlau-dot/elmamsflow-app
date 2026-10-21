'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { itemsFromForm } from '@/lib/data';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';

export async function createOrder(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx?.can('orders.create')) redirect(withMsg('/orders', 'You don’t have access to that.', 'err'));
  const orgId = ctx.org?.id ?? str(fd, 'org_id');
  const items = itemsFromForm(fd);
  const country = str(fd, 'country').toUpperCase().slice(0, 2);
  if (!orgId || !items.length || !str(fd, 'customer') || !str(fd, 'address') || !country) redirect(withMsg('/orders/new', 'Add the customer, the address with country, and at least one product.', 'err'));
  const sb = await supabaseServer();
  const { data: prods } = await sb.from('products').select('id, org_id, hs_code, customs_value').in('id', items.map((i) => i.product_id));
  if (!prods || prods.length !== items.length || prods.some((p) => p.org_id !== orgId)) redirect(withMsg('/orders/new', 'Those products don’t belong to this client.', 'err'));
  const missing = prods.some((p) => !p.hs_code || !Number(p.customs_value));
  const { data: order, error } = await sb.from('orders').insert({
    org_id: orgId, store_ref: str(fd, 'store_ref') || null, customer: str(fd, 'customer'), email: str(fd, 'email') || null, phone: str(fd, 'phone') || null,
    address: str(fd, 'address'), city: str(fd, 'city') || null, zip: str(fd, 'zip') || null, country, service: str(fd, 'service') === 'ddp' ? 'ddp' : 'express',
    status: missing ? 'on_hold' : 'new', hold_reason: missing ? 'A product is missing its HS code or customs value' : null, created_by: ctx.userId,
  }).select('id, number').single();
  if (error || !order) redirect(withMsg('/orders/new', error?.message ?? 'Could not create the order.', 'err'));
  await sb.from('order_items').insert(items.map((i) => ({ ...i, order_id: order.id })));
  await logActivity(sb, ctx.userId, orgId, 'order_created', `#${order.number} · ${str(fd, 'customer')}, ${country}`);
  redirect(withMsg(`/orders/${order.id}`, missing ? `#${order.number} created and put on hold: add the HS code and customs value to its products.` : `#${order.number} created.`, missing ? 'warn' : 'ok'));
}

export async function updateOrder(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id');
  if (!ctx?.can('orders.hold')) redirect(withMsg(`/orders/${id}`, 'You don’t have access to that.', 'err'));
  const sb = await supabaseServer();
  const weight = parseInt(str(fd, 'weight_g'), 10);
  const { error } = await sb.rpc('set_order_status', {
    p_order: id, p_status: str(fd, 'status'), p_carrier: str(fd, 'carrier') || null, p_tracking: str(fd, 'tracking') || null,
    p_weight: Number.isFinite(weight) ? weight : null, p_hold_reason: str(fd, 'hold_reason') || null,
  });
  redirect(withMsg(`/orders/${id}`, error ? error.message : 'Order saved.', error ? 'err' : 'ok'));
}

export async function cancelOrder(fd: FormData) {
  const id = str(fd, 'id');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('cancel_order', { p_order: id });
  redirect(withMsg(`/orders/${id}`, error ? error.message : 'Order cancelled.', error ? 'err' : 'ok'));
}
