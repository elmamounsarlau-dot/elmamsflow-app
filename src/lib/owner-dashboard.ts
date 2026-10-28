import 'server-only';
import { supabaseServer } from './supabase/server';
import { supabaseAdmin } from './supabase/admin';
import { allRows, available, getProducts, getProductsWithKits } from './data';
import { runway, salesByProduct } from './insights';
import { computeCharges, getRateCard, invoiceTz, monthBounds, ymOf } from './billing';
import { dayKey, ordersOverview } from './orders-overview';
import { getWarehouses } from './warehouses';
import { ACTIVITY_LABELS } from './log';
import { CARRIER_PROBLEM, countryName } from './format';
import { getNotices } from './notifications';
import { isOwner, seesBusiness, seesMoney, type Ctx } from './session';

const H = 3600e3;
const today = () => new Date().toISOString().slice(0, 10);

export type Speed = { rate: number | null; days: { label: string; rate: number | null; n: number }[]; ages: [number, number, number, number]; waiting: number; oldestH: number | null };
export type Pipe = { toPack: number; hold: number; packed: number; road: number };
export type FeedItem = { tone: 'ok' | 'blue' | 'warn' | 'err' | 'violet'; who: string; text: string; at: string };
export type Money = { total: number; currency: string }[];

/** Orders shipped within 24 h over the last 7 days, and the orders waiting to be packed, by age. */
async function shippingSpeed(orgId: string | null): Promise<Speed> {
  const sb = await supabaseServer();
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [shipped, waiting] = await Promise.all([
    allRows<{ created_at: string; shipped_at: string }>(() => {
      let q = sb.from('orders').select('created_at, shipped_at').in('status', ['shipped', 'delivered']).gte('shipped_at', since).order('id');
      if (orgId) q = q.eq('org_id', orgId);
      return q;
    }),
    allRows<{ created_at: string }>(() => {
      let q = sb.from('orders').select('created_at').eq('status', 'new').order('id');
      if (orgId) q = q.eq('org_id', orgId);
      return q;
    }),
  ]);
  const fast = (o: { created_at: string; shipped_at: string }) => Date.parse(o.shipped_at) - Date.parse(o.created_at) <= 24 * H;
  const keys = Array.from({ length: 7 }, (_, i) => dayKey(new Date(Date.now() - (6 - i) * 864e5)));
  const days = keys.map((k) => {
    const list = shipped.filter((o) => dayKey(o.shipped_at) === k);
    return { label: new Date(`${k}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short' }), n: list.length, rate: list.length ? Math.round((list.filter(fast).length / list.length) * 100) : null };
  });
  const now = Date.now();
  const ages: [number, number, number, number] = [0, 0, 0, 0];
  let oldest = 0;
  for (const o of waiting) {
    const h = (now - Date.parse(o.created_at)) / H;
    oldest = Math.max(oldest, h);
    ages[h < 6 ? 0 : h < 24 ? 1 : h < 48 ? 2 : 3]++;
  }
  return { rate: shipped.length ? Math.round((shipped.filter(fast).length / shipped.length) * 100) : null, days, ages, waiting: waiting.length, oldestH: waiting.length ? Math.floor(oldest) : null };
}

const sumBy = (rows: { total: number; currency: string }[]): Money => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.currency, (m.get(r.currency) ?? 0) + Number(r.total));
  return [...m.entries()].map(([currency, total]) => ({ currency, total })).sort((a, b) => b.total - a.total);
};

/** Month so far, the forecast for the whole month, and where we are in it (invoice month and clock). */
async function monthProgress() {
  const tz = await invoiceTz();
  const { start, end, label } = monthBounds(ymOf(new Date(), tz), tz);
  const elapsed = Math.max(1 / 24, (Date.now() - start.getTime()) / 864e5);
  const days = (end.getTime() - start.getTime()) / 864e5;
  return { start, label, elapsed, days, share: Math.min(1, elapsed / days), forecast: (n: number) => (n / elapsed) * days };
}

// ======================================================================
// Owner / team
// ======================================================================
export async function ownerDashboard(ctx: Ctx) {
  const sb = await supabaseServer();
  const admin = supabaseAdmin();
  const money = seesMoney(ctx) && ctx.can('invoices.view');
  const business = seesBusiness(ctx);
  const owner = isOwner(ctx);
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const t = today();

  const [ov, speed, noTrack, problems, qOpen, inbounds, tickets, stores, links, delivered, products, sales30, whs, whStock, invoices, openWh] = await Promise.all([
    ordersOverview(14),
    shippingSpeed(null),
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'shipped').is('tracking', null),
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'shipped').or(`tracking_status.in.(${CARRIER_PROBLEM.join(',')}),tracking_error.not.is.null`),
    ctx.can('stock.adjust') ? sb.from('quarantine_requests').select('id', { count: 'exact', head: true }).eq('status', 'requested') : Promise.resolve({ count: 0 }),
    sb.from('inbounds').select('id, status, eta').neq('status', 'received').limit(2000),
    ctx.can('support.reply') ? sb.from('tickets').select('id, status, category').neq('status', 'closed').limit(1000) : Promise.resolve({ data: [] as { id: string; status: string; category: string }[] }),
    ctx.can('integrations.manage') ? admin.from('integrations').select('id, last_error').neq('status', 'disconnected') : Promise.resolve({ data: [] as { id: string; last_error: string | null }[] }),
    owner || ctx.staffRole === 'manager' ? sb.from('access_links').select('user_id', { count: 'exact', head: true }) : Promise.resolve({ count: 0 }),
    allRows<{ shipped_at: string; delivered_at: string }>(() => sb.from('orders').select('shipped_at, delivered_at').eq('status', 'delivered').gte('delivered_at', since30).not('shipped_at', 'is', null).order('id')),
    getProducts(ctx),
    salesByProduct(ctx, 30),
    getWarehouses(),
    allRows<{ warehouse_id: string; on_hand: number; quarantined: number; reserved: number }>(() => sb.from('warehouse_stock').select('warehouse_id, on_hand, quarantined, reserved').order('warehouse_id').order('product_id')),
    money ? allRows<{ id: string; number: string; org_id: string; status: string; total: number; currency: string; due_date: string | null; paid_at: string | null }>(() =>
      sb.from('invoices').select('id, number, org_id, status, total, currency, due_date, paid_at').neq('status', 'void').order('id')) : Promise.resolve([]),
    allRows<{ warehouse_id: string | null }>(() => sb.from('orders').select('warehouse_id').in('status', ['new', 'packed']).order('id')),
  ]);
  const names = Object.fromEntries(ov.clients.map((c) => [c.id, c.name]));

  // Today
  const trips = delivered.map((o) => (Date.parse(o.delivered_at) - Date.parse(o.shipped_at)) / 864e5);
  const avgTrip = trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : null;
  const onTime = trips.length ? Math.round((trips.filter((d) => d <= 9).length / trips.length) * 100) : null;
  const pipe: Pipe = { toPack: ov.pipe.new, hold: ov.pipe.on_hold, packed: ov.pipe.packed, road: ov.pipe.shipped };
  const holds: Record<string, number> = {};
  for (const b of ov.brands) for (const [k, n] of Object.entries(b.holds)) holds[k] = (holds[k] ?? 0) + n;

  // Stock, per brand
  const items = products.filter((p) => p.kind !== 'bundle');
  const brandStock = new Map<string, { sellable: number; daily: number; reorder: number }>();
  for (const p of items) {
    const s = brandStock.get(p.org_id) ?? { sellable: 0, daily: 0, reorder: 0 };
    const r = runway(p, sales30.get(p.id) ?? 0);
    s.sellable += available(p);
    s.daily += r.daily;
    if (r.health === 'critical' || r.health === 'out') s.reorder++;
    brandStock.set(p.org_id, s);
  }

  // Warehouses
  const toShipWh = new Map<string, number>();
  for (const o of openWh) if (o.warehouse_id) toShipWh.set(o.warehouse_id, (toShipWh.get(o.warehouse_id) ?? 0) + 1);
  const physical = whs.filter((w) => w.kind === 'physical' && w.active);
  const warehouses = physical.map((w) => {
    const rows = whStock.filter((r) => r.warehouse_id === w.id);
    return { id: w.id, name: w.name, onHand: rows.reduce((a, r) => a + r.on_hand, 0), toShip: toShipWh.get(w.id) ?? 0 };
  });
  const whMax = Math.max(1, ...warehouses.map((w) => w.onHand));

  // Money
  const month = await monthProgress();
  let mtd: { org_id: string; total: number; currency: string }[] = [];
  if (money) {
    const { data: cards } = await admin.from('rate_cards').select('org_id');
    mtd = (await Promise.all((cards ?? []).map(async (c) => {
      const rates = await getRateCard(c.org_id);
      if (!rates) return null;
      const r = await computeCharges(c.org_id, rates, month.start, new Date()).catch(() => null);
      return r ? { org_id: c.org_id, total: r.total, currency: rates.currency } : null;
    }))).filter((x): x is { org_id: string; total: number; currency: string } => !!x);
  }
  const open = invoices.filter((i) => i.status === 'open');
  const overdue = open.filter((i) => i.due_date && i.due_date < t);
  const drafts = invoices.filter((i) => i.status === 'draft');
  const owes = new Map<string, { total: number; overdue: boolean }>();
  for (const i of open) { const o = owes.get(i.org_id) ?? { total: 0, overdue: false }; o.total += Number(i.total); o.overdue ||= !!(i.due_date && i.due_date < t); owes.set(i.org_id, o); }
  const mtdBy = new Map(mtd.map((m) => [m.org_id, m]));

  // Brands
  const brands = ov.brands.filter((b) => b.week || b.toShip || b.onHold || b.inTransit || brandStock.get(b.id)?.sellable).map((b) => {
    const st = brandStock.get(b.id);
    const daysLeft = st && st.daily > 0 ? st.sellable / st.daily : null;
    const change = b.prevWeek ? Math.round(((b.week - b.prevWeek) / b.prevWeek) * 100) : null;
    const owe = owes.get(b.id);
    const tone = (owe?.overdue || (daysLeft !== null && daysLeft < 21) || (st?.reorder ?? 0) > 0) ? 'err' : b.onHold ? 'warn' : 'ok';
    return { id: b.id, name: b.name, today: b.today, week: b.week, change, spark: b.spark.slice(-7), toPack: b.toShip, hold: b.onHold, daysLeft, reorder: st?.reorder ?? 0, month: mtdBy.get(b.id) ?? null, owes: owe ?? null, tone };
  }).slice(0, 8);

  // Needs action, only what this person can act on
  const ib = (inbounds.data ?? []) as { id: string; status: string; eta: string | null }[];
  const lateIn = ib.filter((b) => b.eta && b.eta < t && ['announced', 'in_transit'].includes(b.status)).length;
  const toConfirm = ib.filter((b) => b.status === 'counted').length;
  const tk = (tickets.data ?? []) as { id: string; status: string; category: string }[];
  const waitingTk = tk.filter((x) => x.status === 'open');
  const damaged = waitingTk.filter((x) => x.category === 'damaged').length;
  const storeErr = ((stores.data ?? []) as { last_error: string | null }[]).filter((s) => s.last_error).length;
  const holdText = Object.entries(holds).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${k === 'manual' ? 'manual' : k} ${n}`).join(' · ');
  const work = ctx.can('orders.warehouse') || ctx.can('orders.hold');
  const actions = [
    work && { n: pipe.toPack, tone: 'blue', label: `Orders to pack${speed.oldestH !== null ? ` · oldest ${speed.oldestH} h` : ''}`, href: '/orders?c=all&s=new' },
    ctx.can('orders.hold') && { n: pipe.hold, tone: 'warn', label: `On hold${holdText ? ` · ${holdText}` : ''}`, href: '/orders?c=all&t=attention' },
    ctx.can('orders.warehouse') && { n: noTrack.count ?? 0, tone: 'err', label: 'Shipped without tracking', href: '/tracking?t=problem' },
    work && { n: problems.count ?? 0, tone: 'err', label: 'Carrier problems', href: '/tracking?t=problem' },
    ctx.can('stock.adjust') && { n: qOpen.count ?? 0, tone: 'violet', label: 'Quarantine decisions to carry out', href: '/inventory/decisions' },
    (ctx.can('inbounds.receive') || business) && { n: lateIn + toConfirm, tone: 'warn', label: `Inbounds late${toConfirm ? ` · ${toConfirm} counted, to confirm` : ''}`, href: lateIn ? '/inbounds?t=late' : '/inbounds?t=active' },
    ctx.can('support.reply') && { n: waitingTk.length, tone: 'blue', label: `Tickets waiting${damaged ? ` · ${damaged} damaged goods` : ''}`, href: '/support' },
    ctx.can('integrations.manage') && { n: storeErr, tone: 'err', label: 'Store connection errors', href: '/integrations' },
    ctx.can('billing.manage') && { n: drafts.length + overdue.length, tone: 'warn', label: `Invoices to issue${overdue.length ? ` · ${overdue.length} overdue to chase` : ''}`, href: drafts.length ? '/invoices?t=draft' : '/invoices?t=overdue' },
    (owner || ctx.staffRole === 'manager') && { n: links.count ?? 0, tone: 'blue', label: 'People waiting to sign in', href: '/clients' },
  ].filter((x): x is { n: number; tone: string; label: string; href: string } => !!x);

  // Live feed
  let feed: FeedItem[] = [];
  if (owner) {
    const { data } = await sb.from('activity_log').select('action, detail, org_id, created_at').order('created_at', { ascending: false }).limit(12);
    const tone = (a: string): FeedItem['tone'] => /deliver|paid|received|released/.test(a) ? 'ok' : /held|late|void|error|written/.test(a) ? 'warn' : /ticket|quarantine/.test(a) ? 'violet' : 'blue';
    feed = (data ?? []).map((a) => ({ tone: tone(a.action), who: a.org_id ? names[a.org_id] ?? '' : 'Team', text: `${ACTIVITY_LABELS[a.action] ?? a.action}${a.detail ? ` · ${a.detail}` : ''}`, at: a.created_at }));
  } else {
    feed = await orderFeed(null, names);
  }

  return {
    flags: { money, business, owner, billing: ctx.can('billing.manage'), clients: ctx.can('clients.manage') },
    month: { label: month.label, share: month.share, day: Math.ceil(month.elapsed), days: Math.round(month.days) },
    ov, speed, pipe, avgTrip, onTime, problems: problems.count ?? 0,
    sellable: items.reduce((a, p) => a + available(p), 0),
    warehouses, whMax, brands, actions, feed,
    money: {
      mtd: sumBy(mtd), forecast: sumBy(mtd.map((m) => ({ ...m, total: month.forecast(m.total) }))),
      outstanding: sumBy(open), overdue: sumBy(overdue), paid30: sumBy(invoices.filter((i) => i.status === 'paid' && i.paid_at && i.paid_at >= since30)),
      overdueList: overdue.slice(0, 2).map((i) => ({ id: i.id, number: i.number, who: names[i.org_id] ?? '', total: Number(i.total), currency: i.currency, days: Math.floor((Date.now() - Date.parse(`${i.due_date}T00:00:00Z`)) / 864e5) })),
      drafts: { n: drafts.length, total: sumBy(drafts) },
    },
    openTickets: waitingTk.length,
  };
}

/** Latest parcels shipped and delivered, as a feed (for people who don't see the activity log). */
async function orderFeed(orgId: string | null, names: Record<string, string>): Promise<FeedItem[]> {
  const sb = await supabaseServer();
  let q = sb.from('orders').select('number, org_id, status, city, country, shipped_at, delivered_at, carrier, hold_reason, created_at').in('status', ['shipped', 'delivered', 'on_hold']).order('created_at', { ascending: false }).limit(40);
  if (orgId) q = q.eq('org_id', orgId);
  const { data } = await q;
  const out: FeedItem[] = [];
  for (const o of data ?? []) {
    const where = [o.city, countryName(o.country)].filter(Boolean).join(', ');
    if (o.status === 'delivered' && o.delivered_at) out.push({ tone: 'ok', who: orgId ? '' : names[o.org_id] ?? '', text: `#${o.number} delivered${where ? ` in ${where}` : ''}`, at: o.delivered_at });
    else if (o.status === 'shipped' && o.shipped_at) out.push({ tone: 'blue', who: orgId ? '' : names[o.org_id] ?? '', text: `#${o.number} shipped${o.carrier ? ` · ${o.carrier}` : ''}${where ? ` to ${where}` : ''}`, at: o.shipped_at });
    else if (o.status === 'on_hold') out.push({ tone: 'warn', who: orgId ? '' : names[o.org_id] ?? '', text: `#${o.number} on hold${o.hold_reason ? `: ${o.hold_reason}` : ''}`, at: o.created_at });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
}

// ======================================================================
// A brand (Compact overview)
// ======================================================================
export async function clientDashboard(ctx: Ctx) {
  const org = ctx.org!;
  const sb = await supabaseServer();
  const billing = ctx.can('invoices.view');
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const since14 = new Date(Date.now() - 14 * 864e5).toISOString();
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const t = today();

  const [recent, open, speed, { products }, sales30, sold7, sold14, notices, inbounds, invoices, shipped7, problems, rates] = await Promise.all([
    allRows<{ status: string; created_at: string; shipped_at: string | null; delivered_at: string | null }>(() => sb.from('orders').select('status, created_at, shipped_at, delivered_at').eq('org_id', org.id)
      .or(`created_at.gte.${since14},shipped_at.gte.${since30},delivered_at.gte.${since30}`).order('id')),
    allRows<{ status: string }>(() => sb.from('orders').select('status').eq('org_id', org.id).in('status', ['new', 'on_hold', 'packed', 'shipped']).order('id')),
    shippingSpeed(org.id),
    getProductsWithKits(ctx),
    salesByProduct(ctx, 30),
    salesByProduct(ctx, 7),
    salesByProduct(ctx, 7, new Date(Date.now() - 7 * 864e5)),
    getNotices(ctx),
    sb.from('inbounds').select('id, ref, status, eta, inbound_items(expected)').eq('org_id', org.id).neq('status', 'received').order('eta', { ascending: true, nullsFirst: false }).limit(3),
    billing ? sb.from('invoices').select('id, number, status, total, currency, due_date, period_start, paid_at').eq('org_id', org.id).in('status', ['open', 'paid']).order('period_start', { ascending: false }).limit(3) : Promise.resolve({ data: [] as { id: string; number: string; status: string; total: number; currency: string; due_date: string | null; period_start: string; paid_at: string | null }[] }),
    allRows<{ country: string; order_items: { product_id: string; qty: number }[] }>(() => sb.from('orders').select('country, order_items(product_id, qty)').eq('org_id', org.id).in('status', ['shipped', 'delivered']).gte('shipped_at', since7).order('id')),
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('org_id', org.id).eq('status', 'shipped').or(`tracking_status.in.(${[...CARRIER_PROBLEM, 'AvailableForPickup'].join(',')}),tracking_error.not.is.null`),
    billing ? getRateCard(org.id) : Promise.resolve(null),
  ]);

  // Numbers
  const keys = Array.from({ length: 14 }, (_, i) => dayKey(new Date(Date.now() - (13 - i) * 864e5)));
  const inBy = new Map(keys.map((k) => [k, 0])), outBy = new Map(keys.map((k) => [k, 0]));
  let week = 0, prevWeek = 0;
  for (const o of recent) {
    const c = dayKey(o.created_at);
    if (o.status !== 'cancelled' && inBy.has(c)) { inBy.set(c, inBy.get(c)! + 1); if (keys.indexOf(c) >= 7) week++; else prevWeek++; }
    if (o.shipped_at && ['shipped', 'delivered'].includes(o.status)) { const s = dayKey(o.shipped_at); if (outBy.has(s)) outBy.set(s, outBy.get(s)! + 1); }
  }
  const todayKey = keys[13];
  const trips = recent.filter((o) => o.status === 'delivered' && o.delivered_at && o.shipped_at && o.delivered_at >= since30).map((o) => (Date.parse(o.delivered_at!) - Date.parse(o.shipped_at!)) / 864e5);
  const pipe: Pipe = { toPack: 0, hold: 0, packed: 0, road: 0 };
  for (const o of open) { if (o.status === 'new') pipe.toPack++; else if (o.status === 'on_hold') pipe.hold++; else if (o.status === 'packed') pipe.packed++; else pipe.road++; }

  // Stock
  const items = products.filter((p) => p.kind !== 'bundle');
  const sellable = items.reduce((a, p) => a + available(p), 0);
  const daily = items.reduce((a, p) => a + (sales30.get(p.id) ?? 0), 0) / 30;
  const low = items.map((p) => ({ p, r: runway(p, sales30.get(p.id) ?? 0) }))
    .filter((x) => ['out', 'critical', 'warning'].includes(x.r.health) && x.r.daily > 0).sort((a, b) => (a.r.days ?? 0) - (b.r.days ?? 0)).slice(0, 3);

  // Best sellers, 7 days
  const topCountry = new Map<string, Map<string, number>>();
  for (const o of shipped7) for (const i of o.order_items) {
    const m = topCountry.get(i.product_id) ?? new Map<string, number>();
    m.set(o.country, (m.get(o.country) ?? 0) + i.qty);
    topCountry.set(i.product_id, m);
  }
  const best = items.map((p) => ({ p, n: sold7.get(p.id) ?? 0, prev: sold14.get(p.id) ?? 0, r: runway(p, sales30.get(p.id) ?? 0) }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5)
    .map((x) => ({ ...x, change: x.prev ? Math.round(((x.n - x.prev) / x.prev) * 100) : null, market: [...(topCountry.get(x.p.id) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null }));

  // Billing
  let bill: { total: number; perOrder: number | null; forecast: number; currency: string } | null = null;
  const month = await monthProgress();
  if (rates) {
    const r = await computeCharges(org.id, rates, month.start, new Date()).catch(() => null);
    if (r) {
      const perOrder = r.stats.orders ? r.lines.filter((l) => ['fulfillment', 'packaging', 'shipping', 'customs'].includes(l.category)).reduce((a, l) => a + l.amount, 0) / r.stats.orders : null;
      bill = { total: r.total, perOrder, forecast: month.forecast(r.total), currency: rates.currency };
    }
  }

  return {
    org, month: { label: month.label, share: month.share },
    today: { in: inBy.get(todayKey) ?? 0, out: outBy.get(todayKey) ?? 0, week, change: prevWeek ? Math.round(((week - prevWeek) / prevWeek) * 100) : null },
    spark: { in: keys.map((k) => inBy.get(k)!), out: keys.map((k) => outBy.get(k)!) },
    pipe, speed, problems: problems.count ?? 0,
    avgTrip: trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : null,
    sellable, daysLeft: daily > 0 ? sellable / daily : null,
    low, inbounds: (inbounds.data ?? []).map((b) => ({ ...b, units: (b.inbound_items as { expected: number }[]).reduce((a, i) => a + i.expected, 0), late: !!b.eta && b.eta < t && ['announced', 'in_transit'].includes(b.status) })),
    notices, best, bill, invoices: invoices.data ?? [],
    feed: await orderFeed(org.id, {}),
  };
}
