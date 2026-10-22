import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { orgNames } from '@/lib/data';
import { ORDER_STATUS } from '@/lib/format';
import { applyScope, applyTab, CHANNELS, HOLD_KIND, parseFilters } from '@/lib/orders-query';

import { csvCell as cell } from '@/lib/format';

/** Orders as a CSV file: the ticked ones, or everything matching the page's tab, search and filters. */
export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx || (!ctx.staffRole && !ctx.clientRole)) return NextResponse.redirect(new URL('/login', req.url));
  const sp = req.nextUrl.searchParams;
  const f = parseFilters(Object.fromEntries(sp.entries()), ctx.backOffice);
  const ids = sp.getAll('ids').filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 500);
  const sb = await supabaseServer();
  const names = ctx.backOffice ? await orgNames() : ({} as Record<string, string>);
  const cols = 'number, store_ref, source, status, hold_kind, hold_reason, org_id, customer, email, phone, address, city, zip, country, service, carrier, tracking, weight_g, created_at, shipped_at, delivered_at, order_items(qty, products(sku))';
  type R = Record<string, string | number | null> & { order_items: { qty: number; products: { sku: string } | null }[] };
  const rows: R[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    let q = sb.from('orders').select(cols).order('created_at', { ascending: false }).range(from, from + 999);
    if (ctx.org) q = q.eq('org_id', ctx.org.id);
    q = ids.length ? q.in('id', ids) : applyTab(applyScope(q, f, ctx.org?.id ?? null), f);
    const { data } = await q;
    rows.push(...((data ?? []) as unknown as R[]));
    if (!data || data.length < 1000) break;
  }
  const head = ['order', 'store_ref', 'channel', 'status', 'hold_type', 'hold_reason', ...(ctx.backOffice ? ['client'] : []), 'customer', 'email', 'phone', 'address', 'city', 'zip', 'country', 'service', 'carrier', 'tracking', 'weight_g', 'items', 'units', 'created', 'shipped', 'delivered'];
  const lines = rows.map((o) => [
    o.number, o.store_ref, CHANNELS[String(o.source ?? 'manual')] ?? o.source, ORDER_STATUS[String(o.status)]?.[0] ?? o.status,
    o.hold_kind ? HOLD_KIND[String(o.hold_kind)]?.[1] : '', o.hold_reason, ...(ctx.backOffice ? [names[String(o.org_id)]] : []),
    o.customer, o.email, o.phone, o.address, o.city, o.zip, o.country, o.service === 'ddp' ? 'DDP' : 'Express', o.carrier, o.tracking, o.weight_g,
    o.order_items.map((i) => `${i.products?.sku ?? '?'} x${i.qty}`).join(' | '), o.order_items.reduce((a, i) => a + i.qty, 0),
    String(o.created_at ?? '').slice(0, 16).replace('T', ' '), String(o.shipped_at ?? '').slice(0, 10), String(o.delivered_at ?? '').slice(0, 10),
  ].map(cell).join(','));
  const csv = '﻿' + [head.join(','), ...lines].join('\n');
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="orders-${date}.csv"` } });
}
