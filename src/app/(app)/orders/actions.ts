'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { itemsFromForm } from '@/lib/data';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';
import { pushTracking } from '@/lib/integrations/service';
import { refreshOrders, registerOrders, syncTracking, trackKey, trackShippedOrder } from '@/lib/track17';
import { saveLabel } from '@/lib/labels';
import { MONEY_CURRENCIES } from '@/lib/fx';
import { editShipTo } from '@/lib/integrations/core';

export async function createOrder(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx?.can('orders.create')) redirect(withMsg('/orders', 'You don’t have access to that.', 'err'));
  const orgId = ctx.org?.id ?? str(fd, 'org_id');
  const items = itemsFromForm(fd);
  const country = str(fd, 'country').toUpperCase().slice(0, 2);
  if (!orgId || !items.length || !str(fd, 'customer') || !str(fd, 'address') || !country) redirect(withMsg('/orders/new', 'Add the customer, the address with country, and at least one product.', 'err'));
  const sb = await supabaseServer();
  const { data: prods } = await sb.from('products').select('id, org_id, hs_code, customs_value, kind').in('id', items.map((i) => i.product_id));
  if (!prods || prods.length !== items.length || prods.some((p) => p.org_id !== orgId)) redirect(withMsg('/orders/new', 'Those products don’t belong to this client.', 'err'));
  // A kit ships its products, so their customs info counts (the kit itself has none).
  const kits = prods.filter((p) => p.kind === 'bundle').map((p) => p.id);
  const parts = kits.length ? ((await sb.from('bundle_items').select('component:products!bundle_items_component_id_fkey(hs_code, customs_value)').in('bundle_id', kits)).data ?? []) : [];
  const noCustoms = (p: { hs_code: string | null; customs_value: number } | null) => !p?.hs_code || !Number(p?.customs_value);
  const missing = prods.some((p) => p.kind !== 'bundle' && noCustoms(p)) || parts.some((x) => noCustoms(x.component as unknown as { hs_code: string | null; customs_value: number } | null));
  const { data: order, error } = await sb.from('orders').insert({
    org_id: orgId, store_ref: str(fd, 'store_ref') || null, customer: str(fd, 'customer'), email: str(fd, 'email') || null, phone: str(fd, 'phone') || null,
    address: str(fd, 'address'), city: str(fd, 'city') || null, zip: str(fd, 'zip') || null, country, service: 'ddp',
    status: missing ? 'on_hold' : 'new', hold_reason: missing ? 'A product is missing its HS code or customs value' : null, created_by: ctx.userId,
  }).select('id, number').single();
  if (error || !order) redirect(withMsg('/orders/new', error?.message ?? 'Could not create the order.', 'err'));
  const { error: itemsErr } = await sb.from('order_items').insert(items.map((i) => ({ ...i, order_id: order.id })));
  if (itemsErr) {
    // Never leave an order without its products.
    await supabaseAdmin().from('orders').delete().eq('id', order.id);
    redirect(withMsg('/orders/new', `The order wasn’t saved: ${itemsErr.message}`, 'err'));
  }
  await logActivity(sb, ctx.userId, orgId, 'order_created', `#${order.number} · ${str(fd, 'customer')}, ${country}`);
  redirect(withMsg(`/orders/${order.id}`, missing ? `#${order.number} created and put on hold: add the HS code and customs value to its products.` : `#${order.number} created.`, missing ? 'warn' : 'ok'));
}

export async function updateOrder(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id');
  if (!ctx?.can('orders.hold') && !ctx?.can('orders.warehouse')) redirect(withMsg(`/orders/${id}`, 'You don’t have access to that.', 'err'));
  const sb = await supabaseServer();
  const { data: cur } = await sb.from('orders').select('id, number, org_id, status, tracking, label_path').eq('id', id).maybeSingle();
  if (!cur) redirect(withMsg('/orders', 'Order not found.', 'err'));
  const next = str(fd, 'status');
  const label = fd.get('label');
  const file = label instanceof File && label.size > 0 ? label : null;
  // Handing a parcel to the carrier needs its tracking number and the label (photo or PDF): that's the proof clients see.
  if (['shipped', 'delivered'].includes(next) && !['shipped', 'delivered'].includes(cur.status)) {
    if (!str(fd, 'tracking') && !cur.tracking) redirect(withMsg(`/orders/${id}#ship`, 'Add the tracking number to mark it in transit.', 'warn'));
    if (!file && !cur.label_path) redirect(withMsg(`/orders/${id}#ship`, 'Add the label photo (or PDF) to mark it in transit.', 'warn'));
  }
  if (file && ctx.can('orders.warehouse')) {
    try {
      await saveLabel(cur, file, ctx.userId);
    } catch (e) {
      redirect(withMsg(`/orders/${id}#ship`, (e as Error).message, 'err'));
    }
  }
  const weight = parseInt(str(fd, 'weight_g'), 10);
  // Warehouse first (only allowed before packing), then the status change checks stock at that warehouse.
  const wh = str(fd, 'warehouse_id');
  if (/^[0-9a-f-]{36}$/.test(wh) && wh !== str(fd, 'current_warehouse_id')) {
    const { error: we } = await sb.rpc('assign_order_warehouse', { p_orders: [id], p_warehouse: wh });
    if (we) redirect(withMsg(`/orders/${id}`, we.message, 'err'));
  }
  const { error } = await sb.rpc('set_order_status', {
    p_order: id, p_status: str(fd, 'status'), p_carrier: str(fd, 'carrier') || null, p_tracking: str(fd, 'tracking') || null,
    p_weight: Number.isFinite(weight) ? weight : null, p_hold_reason: str(fd, 'hold_reason') || null,
  });
  if (error) redirect(withMsg(`/orders/${id}`, error.message, 'err'));
  // What the label and the duties cost us (Finance). Kept apart from the order: clients can never read it.
  if (fd.get('costs') && ctx.staffRole && !ctx.viewingAs && ctx.can('orders.warehouse')) {
    const costErr = await saveOrderCosts(cur, fd, ctx.userId);
    if (costErr) redirect(withMsg(`/orders/${id}#ship`, `Order saved, but the costs weren’t: ${costErr}`, 'warn'));
  }
  // Shipped with a tracking number: tell the client's store (Shopify / WooCommerce).
  const shipped = ['shipped', 'delivered'].includes(str(fd, 'status'));
  const pushed = shipped ? await pushTracking(id).catch((e) => (e as Error).message) : null;
  // Start live tracking with 17TRACK (a failure here is retried by the daily sync).
  if (shipped) await trackShippedOrder(id).catch(() => null);
  redirect(withMsg(`/orders/${id}`, pushed === 'ok' ? 'Order saved. Tracking sent to the client’s store.' : pushed ? `Order saved, but tracking couldn’t be sent to the store: ${pushed}` : 'Order saved.', pushed && pushed !== 'ok' ? 'warn' : 'ok'));
}

async function saveOrderCosts(order: { id: string; number: string; org_id: string }, fd: FormData, by: string): Promise<string | null> {
  const read = (k: string) => {
    const v = str(fd, k);
    if (!v) return null;
    const n = Math.round(parseFloat(v.replace(',', '.')) * 100) / 100;
    return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : NaN;
  };
  const label = read('label_cost');
  const duties = fd.has('duties_paid') ? read('duties_paid') : undefined;
  if (Number.isNaN(label) || Number.isNaN(duties)) return 'write the costs as amounts (0 or more).';
  const currency = str(fd, 'cost_currency');
  if (!(MONEY_CURRENCIES as readonly string[]).includes(currency)) return 'choose the currency.';
  const admin = supabaseAdmin();
  const { data: old } = await admin.from('order_costs').select('label_cost, duties_paid, currency').eq('order_id', order.id).maybeSingle();
  const next = { label_cost: label, duties_paid: duties === undefined ? old?.duties_paid ?? null : duties };
  if (next.label_cost === null && next.duties_paid === null) {
    if (old) await admin.from('order_costs').delete().eq('order_id', order.id);
    return null;
  }
  if (old && Number(old.label_cost ?? -1) === Number(next.label_cost ?? -1) && Number(old.duties_paid ?? -1) === Number(next.duties_paid ?? -1) && old.currency === currency) return null;
  const { error } = await admin.from('order_costs').upsert({ order_id: order.id, org_id: order.org_id, ...next, currency, recorded_by: by, recorded_at: new Date().toISOString() }, { onConflict: 'order_id' });
  if (error) return error.message;
  // No client on the log line: clients can read their own activity, never our costs.
  await logActivity(admin, by, null, 'order_costs', `#${order.number} · ` + [next.label_cost !== null && `label ${next.label_cost}`, next.duties_paid !== null && `duties ${next.duties_paid}`].filter(Boolean).join(' · ') + ` ${currency}`);
  return null;
}

export async function cancelOrder(fd: FormData) {
  const id = str(fd, 'id');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('cancel_order', { p_order: id });
  redirect(withMsg(`/orders/${id}`, error ? error.message : 'Order cancelled.', error ? 'err' : 'ok'));
}

/** Row and bulk actions from the Orders list: hold, release, cancel. */
export async function ordersListAction(fd: FormData) {
  const raw = str(fd, 'back');
  const back = raw.startsWith('/orders') ? raw : '/orders';
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  const [act, one] = str(fd, 'act').split(':');
  const ids = (one ? [one] : fd.getAll('ids').map(String)).filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 500);
  if (!ids.length) redirect(withMsg(back, 'Select at least one order.', 'warn'));
  const sb = await supabaseServer();
  const n = ids.length;
  const s = (k: number) => `${k} order${k === 1 ? '' : 's'}`;
  if (act === 'hold' || act === 'release') {
    const { data, error } = await sb.rpc('hold_orders', { p_orders: ids, p_hold: act === 'hold', p_reason: str(fd, 'reason') || null });
    if (error) redirect(withMsg(back, error.message, 'err'));
    const done = Number(data ?? 0);
    const verb = act === 'hold' ? 'put on hold' : 'released';
    const why = act === 'hold' ? 'only new orders the warehouse hasn’t started can be held' : 'held for a product, customs or address problem — fix that and they release by themselves';
    redirect(withMsg(back, done === n ? `${s(done)} ${verb}.` : `${s(done)} ${verb}; ${n - done} skipped (${why}).`, done === n ? 'ok' : 'warn'));
  }
  if (act === 'assign') {
    const w = str(fd, 'warehouse');
    if (!/^[0-9a-f-]{36}$/.test(w)) redirect(withMsg(back, 'Choose the warehouse first.', 'warn'));
    const { data, error } = await sb.rpc('assign_order_warehouse', { p_orders: ids, p_warehouse: w });
    if (error) redirect(withMsg(back, error.message, 'err'));
    const done = Number(data ?? 0);
    redirect(withMsg(back, done === n ? `${s(done)} will ship from the new warehouse.` : `${s(done)} changed; ${n - done} skipped (already packed or shipped, or already there).`, done === n ? 'ok' : 'warn'));
  }
  if (act === 'cancel') {
    let done = 0;
    for (const id of ids) {
      const { error } = await sb.rpc('cancel_order', { p_order: id });
      if (!error) done++;
    }
    redirect(withMsg(back, done === n ? `${s(done)} cancelled.` : `${s(done)} cancelled; ${n - done} couldn’t be (already packed or shipped).`, done === n ? 'ok' : 'warn'));
  }
  redirect(back);
}

/** Owner only: undo a shipment that never physically left (e.g. a test). Needs a reason and evidence; fully logged. */
export async function reverseShipment(fd: FormData) {
  const id = str(fd, 'id');
  const ctx = await getCtx();
  if (ctx?.staffRole !== 'owner') redirect(withMsg(`/orders/${id}`, 'Only the owner can reverse a shipment.', 'err'));
  if (str(fd, 'confirm') !== 'REVERSE') redirect(withMsg(`/orders/${id}#correction`, 'Type REVERSE to confirm.', 'err'));
  const sb = await supabaseServer();
  const { error } = await sb.rpc('reverse_shipment', { p_order: id, p_reason: str(fd, 'reason').slice(0, 300), p_evidence: str(fd, 'evidence').slice(0, 500) });
  redirect(withMsg(`/orders/${id}`, error ? error.message : 'Shipment reversed. The units are back in stock and the order is cancelled. Both steps are in the history.', error ? 'err' : 'ok'));
}

/** Staff: fetch the latest carrier data for one order now (registers it first if 17TRACK doesn't know it yet). */
export async function refreshTracking(fd: FormData) {
  const id = str(fd, 'id');
  const ctx = await getCtx();
  if (!ctx?.staffRole) redirect(withMsg(`/orders/${id}`, 'You don’t have access to that.', 'err'));
  if (!trackKey()) redirect(withMsg(`/orders/${id}`, '17TRACK isn’t connected yet. Add TRACK17_API_KEY in Vercel.', 'warn'));
  const { data: o } = await supabaseAdmin().from('orders').select('id, tracking, status, tracking_registered_at').eq('id', id).maybeSingle();
  if (!o?.tracking || !['shipped', 'delivered'].includes(o.status)) redirect(withMsg(`/orders/${id}`, 'Add a tracking number and mark it shipped first.', 'warn'));
  let msg = '';
  try {
    if (!o.tracking_registered_at) {
      const r = await registerOrders([{ id: o.id, tracking: o.tracking }]);
      msg = r.accepted ? 'Sent to 17TRACK. The first carrier update usually arrives within minutes to a few hours.' : 'Not accepted by 17TRACK. Check the tracking number.';
    } else {
      const r = await refreshOrders([{ id: o.id, tracking: o.tracking }]);
      msg = r.delivered ? 'Carrier confirms delivery: order marked Delivered.' : 'Tracking refreshed.';
    }
  } catch (e) {
    redirect(withMsg(`/orders/${id}`, (e as Error).message, 'err'));
  }
  redirect(withMsg(`/orders/${id}`, msg));
}

/** Staff: run the tracking sync now (same as the daily job). */
export async function syncTrackingNow() {
  const ctx = await getCtx();
  if (!ctx?.staffRole) redirect(withMsg('/tracking', 'You don’t have access to that.', 'err'));
  let msg = '';
  try {
    const r = await syncTracking();
    msg = !r.configured ? '17TRACK isn’t connected yet. Add TRACK17_API_KEY in Vercel.' : `Sync done: ${r.registered} parcel${r.registered === 1 ? '' : 's'} sent to 17TRACK, ${r.refreshed} refreshed, ${r.delivered} newly delivered${r.rejected ? `, ${r.rejected} not accepted (check the numbers)` : ''}.`;
  } catch (e) {
    redirect(withMsg('/tracking', (e as Error).message, 'err'));
  }
  redirect(withMsg('/tracking', msg));
}

/** Fix the customer's name, address, phone or email before the warehouse packs the order. */
export async function editOrderShipTo(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id');
  const to = `/orders/${id}`;
  if (!ctx || !(ctx.can('orders.create') || (ctx.staffRole && ctx.can('orders.hold')))) redirect(withMsg(to, 'You don’t have access to that.', 'err'));
  // Row Level Security decides who sees the order; the edit itself runs on the server after that check.
  const sb = await supabaseServer();
  let q = sb.from('orders').select('id, org_id').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: o } = await q.maybeSingle();
  if (!o) redirect(withMsg('/orders', 'Order not found.', 'err'));
  const email = str(fd, 'email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect(withMsg(`${to}#edit`, 'The email doesn’t look right.', 'err'));
  const country = str(fd, 'country').toUpperCase().slice(0, 2);
  if (!str(fd, 'customer') || !str(fd, 'address') || !/^[A-Z]{2}$/.test(country)) redirect(withMsg(`${to}#edit`, 'The customer name, street address and country are needed.', 'err'));
  const res = await editShipTo(o.id, o.org_id, {
    customer: str(fd, 'customer').slice(0, 120), email: email.slice(0, 160) || null, phone: str(fd, 'phone').slice(0, 40) || null,
    address: [str(fd, 'address'), str(fd, 'address2')].filter(Boolean).join(', ').slice(0, 240), city: str(fd, 'city').slice(0, 80) || null,
    zip: str(fd, 'zip').slice(0, 20) || null, country,
  }, ctx.userId);
  if ('error' in res && res.error) redirect(withMsg(to, res.error, 'err'));
  redirect(withMsg(to, ('message' in res && res.message) || 'Saved.', 'held' in res && res.held ? 'warn' : 'ok'));
}
