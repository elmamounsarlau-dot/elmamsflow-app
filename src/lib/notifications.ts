import 'server-only';
import { cache } from 'react';
import { supabaseServer } from './supabase/server';
import { allRows, getProducts } from './data';
import { runway, salesByProduct } from './insights';
import { CARRIER_STATUS } from './format';
import type { Ctx } from './session';

/**
 * Everything a client has to act on (or should know about), in one list.
 * Computed live from the data on every page load — nothing to mark as read; an item disappears when it is fixed.
 */
export type Notice = {
  key: string;
  level: 'action' | 'warn' | 'info';   // action = blocks shipping or money owed; warn = needs a look; info = good to know
  kind: 'order' | 'product' | 'invoice' | 'tracking' | 'support' | 'stock' | 'inbound' | 'store';
  title: string;
  detail: string;
  href: string;
  cta: string;
  at?: string | null;
};

const LEVEL_ORDER = { action: 0, warn: 1, info: 2 } as const;

export const getNotices = cache(async (ctx: Ctx): Promise<Notice[]> => {
  if (!ctx.org) return [];
  const org = ctx.org.id;
  const sb = await supabaseServer();
  const today = new Date().toISOString().slice(0, 10);
  const can = ctx.can;

  const [held, products, sales30, invoices, trackIssues, answered, inbounds, stores] = await Promise.all([
    allRows<{ id: string; number: string; hold_reason: string | null; created_at: string; customer: string }>(() =>
      sb.from('orders').select('id, number, hold_reason, created_at, customer').eq('org_id', org).eq('status', 'on_hold').order('created_at').order('id')),
    getProducts(ctx),
    salesByProduct(ctx, 30),
    can('invoices.view')
      ? sb.from('invoices').select('id, number, total, currency, due_date, issued_at').eq('org_id', org).eq('status', 'open').order('due_date', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [] as { id: string; number: string; total: number; currency: string; due_date: string | null; issued_at: string | null }[] }),
    sb.from('orders').select('id, number, tracking, tracking_status, tracking_last_event, tracking_error, tracking_last_event_at, shipped_at')
      .eq('org_id', org).eq('status', 'shipped')
      .or('tracking_status.in.(DeliveryFailure,Exception,Expired,AvailableForPickup),tracking_error.not.is.null,tracking.is.null')
      .order('shipped_at', { ascending: false }).limit(50),
    sb.from('tickets').select('id, subject, updated_at').eq('org_id', org).eq('status', 'answered').order('updated_at', { ascending: false }).limit(20),
    sb.from('inbounds').select('id, ref, status, eta').eq('org_id', org).in('status', ['announced', 'in_transit']).lt('eta', today).limit(20),
    can('integrations.manage')
      ? sb.from('integrations').select('id, name, store_url, last_error, status').eq('org_id', org).eq('status', 'active').not('last_error', 'is', null)
      : Promise.resolve({ data: [] as { id: string; name: string | null; store_url: string; last_error: string | null; status: string }[] }),
  ]);

  const out: Notice[] = [];

  for (const o of held) {
    const r = o.hold_reason || 'On hold';
    const isProduct = /not in elmamsflow|product/i.test(r);
    const isCustoms = /hs code|customs/i.test(r);
    const isAddress = /address/i.test(r);
    out.push({
      key: `hold:${o.id}`, level: 'action', kind: 'order', at: o.created_at,
      title: `Order #${o.number} is on hold`,
      detail: r,
      href: isCustoms ? '/inventory?f=customs' : `/orders/${o.id}`,
      cta: isCustoms ? 'Add customs info' : isProduct ? 'Fix products' : isAddress ? 'Fix the address' : 'Open order',
    });
  }

  const noCustoms = products.filter((p) => !p.hs_code || !Number(p.customs_value));
  if (noCustoms.length) {
    out.push({
      key: 'customs', level: 'action', kind: 'product',
      title: `${noCustoms.length} product${noCustoms.length === 1 ? '' : 's'} missing customs info`,
      detail: `Orders with ${noCustoms.length === 1 ? 'this product' : 'these products'} can’t ship until the HS code and declared value are filled in: ${noCustoms.slice(0, 3).map((p) => p.sku).join(', ')}${noCustoms.length > 3 ? '…' : ''}`,
      href: '/inventory?f=customs', cta: 'Fill them in',
    });
  }

  for (const i of invoices.data ?? []) {
    const overdue = !!i.due_date && i.due_date < today;
    out.push({
      key: `inv:${i.id}`, level: overdue ? 'action' : 'warn', kind: 'invoice', at: i.issued_at,
      title: overdue ? `Invoice ${i.number} is overdue` : `Invoice ${i.number} is waiting for payment`,
      detail: `${Number(i.total).toLocaleString('en', { style: 'currency', currency: i.currency })}${i.due_date ? ` · due ${new Date(i.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}`,
      href: `/invoices/${i.id}`, cta: 'View and pay',
    });
  }

  for (const o of trackIssues.data ?? []) {
    if (!o.tracking) continue; // shipped without a number is the warehouse's to fix, not the client's
    const label = o.tracking_status ? CARRIER_STATUS[o.tracking_status]?.[0] ?? o.tracking_status : 'Not tracked';
    const pickup = o.tracking_status === 'AvailableForPickup';
    out.push({
      key: `trk:${o.id}`, level: pickup ? 'info' : 'warn', kind: 'tracking', at: o.tracking_last_event_at ?? o.shipped_at,
      title: pickup ? `Parcel #${o.number} is waiting at a pickup point` : `Parcel #${o.number}: ${label.toLowerCase()}`,
      detail: o.tracking_last_event || o.tracking_error || 'The carrier reports a problem with this parcel.',
      href: `/orders/${o.id}#carrier`, cta: pickup ? 'Tell your customer' : 'See tracking',
    });
  }

  for (const t of answered.data ?? []) {
    out.push({ key: `tk:${t.id}`, level: 'info', kind: 'support', at: t.updated_at, title: 'Our team replied', detail: t.subject, href: `/support/${t.id}`, cta: 'Read reply' });
  }

  const low = products
    .map((p) => ({ p, r: runway(p, sales30.get(p.id) ?? 0) }))
    .filter((x) => x.r.health === 'out' || x.r.health === 'critical');
  for (const { p, r } of low.slice(0, 10)) {
    out.push({
      key: `stock:${p.id}`, level: r.health === 'out' ? 'action' : 'warn', kind: 'stock',
      title: r.health === 'out' ? `${p.sku} is out of stock` : `${p.sku} runs out soon`,
      detail: `${p.name}${r.reorder ? ` · we suggest sending ${r.reorder.toLocaleString('en')} units` : ''}`,
      href: can('inbounds.create') ? '/inbounds/new' : `/inventory/${p.id}`, cta: can('inbounds.create') ? 'Send stock' : 'View product',
    });
  }

  for (const b of inbounds.data ?? []) {
    out.push({ key: `in:${b.id}`, level: 'warn', kind: 'inbound', title: `Inbound ${b.ref} is late`, detail: `Expected ${b.eta ? new Date(b.eta).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}. Update the ETA or tracking so we can plan receiving.`, href: `/inbounds/${b.id}`, cta: 'Update inbound' });
  }

  for (const s of stores.data ?? []) {
    out.push({ key: `store:${s.id}`, level: 'action', kind: 'store', title: `Store connection needs attention: ${s.name ?? s.store_url}`, detail: s.last_error ?? '', href: `/integrations/${s.id}`, cta: 'Check store' });
  }

  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (b.at ?? '').localeCompare(a.at ?? ''));
});
