import 'server-only';
import { supabaseServer } from './supabase/server';
import { allRows } from './data';
import { computeCharges, getRateCard, invoiceTz, monthBounds, ymOf } from './billing';
import { dayKey } from './orders-overview';
import type { Ctx } from './session';

type O = { id: string; created_at: string; status: string; country: string; shipped_at: string | null; delivered_at: string | null; hold_kind: string | null; held_at: string | null };
type S = { id: string; country: string; shipped_at: string; delivered_at: string | null; order_items: { qty: number; product_id: string }[] };
type M = { qty: number; type: string };

/** Everything that happened for one brand in one month (invoice month, so it matches the invoice). */
export async function monthReport(ctx: Ctx, ym: string) {
  const orgId = ctx.org!.id;
  const tz = await invoiceTz();
  const { start, end, label } = monthBounds(ym, tz);
  const now = new Date();
  const until = end < now ? end : now;
  const s = start.toISOString(), e = end.toISOString();
  const sb = await supabaseServer();
  const prev = monthBounds(ymOf(new Date(start.getTime() - 864e5), tz), tz);

  const [created, shipped, moves, tickets, prevShipped, products] = await Promise.all([
    allRows<O>(() => sb.from('orders').select('id, created_at, status, country, shipped_at, delivered_at, hold_kind, held_at').eq('org_id', orgId).gte('created_at', s).lt('created_at', e).order('created_at').order('id')),
    allRows<S>(() => sb.from('orders').select('id, country, shipped_at, delivered_at, order_items(qty, product_id)').eq('org_id', orgId).in('status', ['shipped', 'delivered']).gte('shipped_at', s).lt('shipped_at', e).order('shipped_at').order('id')),
    allRows<M>(() => sb.from('stock_moves').select('qty, type').eq('org_id', orgId).gte('created_at', s).lt('created_at', e).order('id')),
    sb.from('tickets').select('id', { count: 'exact', head: true }).eq('org_id', orgId).gte('created_at', s).lt('created_at', e),
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('org_id', orgId).in('status', ['shipped', 'delivered']).gte('shipped_at', prev.start.toISOString()).lt('shipped_at', prev.end.toISOString()),
    allRows<{ id: string; sku: string; name: string; photo_path: string | null }>(() => sb.from('products').select('id, sku, name, photo_path').eq('org_id', orgId).order('id')),
  ]);

  // Day by day (China time, the warehouse day).
  const days: string[] = [];
  for (let t = start.getTime() + 12 * 3600e3; t < end.getTime(); t += 864e5) days.push(dayKey(new Date(t)));
  const rec = new Map(days.map((d) => [d, 0]));
  const out = new Map(days.map((d) => [d, 0]));
  for (const o of created) if (o.status !== 'cancelled') rec.set(dayKey(o.created_at), (rec.get(dayKey(o.created_at)) ?? 0) + 1);
  for (const o of shipped) out.set(dayKey(o.shipped_at), (out.get(dayKey(o.shipped_at)) ?? 0) + 1);
  const lastDay = dayKey(until);
  const series = days.filter((d) => d <= lastDay).map((d) => ({ label: String(Number(d.slice(8))), received: rec.get(d) ?? 0, shipped: out.get(d) ?? 0 }));

  // Delivery speed for parcels shipped this month that have arrived.
  const trips = shipped.filter((o) => o.delivered_at).map((o) => (Date.parse(o.delivered_at!) - Date.parse(o.shipped_at)) / 864e5);
  const avgTrip = trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : null;
  const fast = trips.length ? trips.filter((d) => d <= 9).length / trips.length : null;
  const speed = [['Under 5 days', 0, 5], ['5–7 days', 5, 7], ['7–10 days', 7, 10], ['10+ days', 10, 1e9]].map(([l, a, b]) => ({ label: l as string, n: trips.filter((d) => d >= (a as number) && d < (b as number)).length }));

  // Where parcels went, and what sold.
  const byCountry = new Map<string, number>();
  for (const o of shipped) byCountry.set(o.country, (byCountry.get(o.country) ?? 0) + 1);
  const countries = [...byCountry.entries()].sort((a, b) => b[1] - a[1]);
  const byProduct = new Map<string, number>();
  for (const o of shipped) for (const i of o.order_items) byProduct.set(i.product_id, (byProduct.get(i.product_id) ?? 0) + i.qty);
  const pmap = new Map(products.map((p) => [p.id, p]));
  const top = [...byProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n]) => ({ p: pmap.get(id), id, n }));
  const units = [...byProduct.values()].reduce((a, b) => a + b, 0);

  // Holds raised this month, by type.
  const holds = new Map<string, number>();
  for (const o of created) if (o.held_at || o.status === 'on_hold') { const k = o.hold_kind ?? 'manual'; holds.set(k, (holds.get(k) ?? 0) + 1); }

  // Stock in and out.
  const stockIn = moves.filter((m) => m.type === 'inbound').reduce((a, m) => a + m.qty, 0);
  const stockOut = -moves.filter((m) => m.type === 'order').reduce((a, m) => a + m.qty, 0);
  const corrections = moves.filter((m) => ['adjust', 'count'].includes(m.type)).reduce((a, m) => a + m.qty, 0);

  // What it cost (same calculation as the invoice).
  let costs: Awaited<ReturnType<typeof computeCharges>> | null = null;
  let currency = 'USD';
  if (ctx.can('invoices.view')) {
    const rates = await getRateCard(orgId);
    if (rates) { costs = await computeCharges(orgId, rates, start, until).catch(() => null); currency = rates.currency; }
  }
  const { data: invoice } = ctx.can('invoices.view')
    ? await sb.from('invoices').select('id, number, status, total, currency').eq('org_id', orgId).eq('period_start', `${ym}-01`).neq('status', 'void').neq('status', 'draft').maybeSingle()
    : { data: null };

  return {
    ym, label, start, end, partial: until < end, series,
    received: created.filter((o) => o.status !== 'cancelled').length, cancelled: created.filter((o) => o.status === 'cancelled').length,
    shipped: shipped.length, prevShipped: prevShipped.count ?? 0, delivered: trips.length, avgTrip, fast, speed, units,
    countries, top, holds: [...holds.entries()].sort((a, b) => b[1] - a[1]), heldCount: [...holds.values()].reduce((a, b) => a + b, 0),
    stockIn, stockOut, corrections, tickets: tickets.count ?? 0, costs, currency, invoice,
  };
}

/** The last 12 invoice months, newest first. */
export function recentMonths(tz: 'UTC' | 'Asia/Shanghai', n = 12) {
  const out: string[] = [];
  let d = new Date();
  for (let i = 0; i < n; i++) {
    const ym = ymOf(d, tz);
    out.push(ym);
    const [y, m] = ym.split('-').map(Number);
    d = new Date(Date.UTC(y, m - 2, 15));
  }
  return out;
}
