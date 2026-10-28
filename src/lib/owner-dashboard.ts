import 'server-only';
import { supabaseServer } from './supabase/server';
import { supabaseAdmin } from './supabase/admin';
import { allRows, getProducts, getProductsWithKits } from './data';
import { runway, salesByProduct } from './insights';
import { computeCharges, getRateCard, invoiceTz, lastMonth, monthBounds, ymOf } from './billing';
import { dayKey, ordersOverview } from './orders-overview';
import { chinaDayStart } from './orders-query';
import { getWarehouses } from './warehouses';
import { ACTIVITY_LABELS } from './log';
import { CARRIER_PROBLEM, countryName } from './format';
import { getNotices } from './notifications';
import { currentYm, moneyStatus, revenueMonth } from './finance';
import { financeSettings, toReport } from './fx';
import { isOwner, type Ctx } from './session';

/**
 * The Overview. Every figure here is computed the same way as on the page it links to,
 * so a number on the Overview is the number you find when you click it.
 */

const H = 3600e3;
const utcToday = () => new Date().toISOString().slice(0, 10);

export type Speed = { rate: number | null; days: { label: string; rate: number | null; n: number }[]; ages: [number, number, number, number]; waiting: number; oldestH: number | null };
export type Pipe = { toPack: number; hold: number; packed: number; road: number };
export type FeedItem = { tone: 'ok' | 'blue' | 'warn' | 'err' | 'violet'; who: string; text: string; at: string };
export type Action = { n: number; tone: string; label: string; href: string; key: string };

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
    return { label: new Date(`${k}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }), n: list.length, rate: list.length ? Math.round((list.filter(fast).length / list.length) * 100) : null };
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

/** Door to door, the same figure as on the Tracking page: delivered in the last 30 days. */
function doorToDoor(rows: { shipped_at: string | null; delivered_at: string | null }[]) {
  const trips = rows.filter((o) => o.shipped_at && o.delivered_at).map((o) => (Date.parse(o.delivered_at!) - Date.parse(o.shipped_at!)) / 864e5);
  return {
    avg: trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : null,
    onTime: trips.length ? Math.round((trips.filter((d) => d <= 9).length / trips.length) * 100) : null,
    n: trips.length,
  };
}

/** "Tracking → Problems": in transit with a carrier problem, a tracking error, or no tracking number. */
const problemFilter = `tracking_status.in.(${CARRIER_PROBLEM.join(',')}),tracking_error.not.is.null,tracking.is.null`;

// ======================================================================
// Owner / team
// ======================================================================
export async function ownerDashboard(ctx: Ctx) {
  const sb = await supabaseServer();
  const admin = supabaseAdmin();
  const money = !!ctx.staffRole && ctx.can('billing.manage');
  const owner = isOwner(ctx);
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const today = dayKey(new Date());
  const t = utcToday();

  const [ov, speed, problems, ordersToday, qOpen, inbounds, tickets, stores, links, delivered, products, sales30, whs, whStock, openWh] = await Promise.all([
    ordersOverview(14),
    shippingSpeed(null),
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'shipped').or(problemFilter),
    sb.from('orders').select('id', { count: 'exact', head: true }).gte('created_at', chinaDayStart(today)).lt('created_at', chinaDayStart(today, 1)),
    ctx.can('stock.adjust') ? sb.from('quarantine_requests').select('id', { count: 'exact', head: true }).eq('status', 'requested') : Promise.resolve({ count: 0 }),
    sb.from('inbounds').select('id, status, eta').neq('status', 'received').limit(2000),
    ctx.can('support.reply') ? sb.from('tickets').select('id, status, category').eq('status', 'open').limit(1000) : Promise.resolve({ data: [] as { id: string; status: string; category: string }[] }),
    ctx.can('integrations.manage') ? admin.from('integrations').select('id, last_error').neq('status', 'disconnected') : Promise.resolve({ data: [] as { id: string; last_error: string | null }[] }),
    owner || ctx.staffRole === 'manager' ? sb.from('access_links').select('*').order('created_at', { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
    allRows<{ shipped_at: string | null; delivered_at: string | null }>(() => sb.from('orders').select('shipped_at, delivered_at').eq('status', 'delivered').gte('delivered_at', since30).not('shipped_at', 'is', null).order('id')),
    getProducts(ctx),
    salesByProduct(ctx, 30),
    getWarehouses(),
    allRows<{ warehouse_id: string; on_hand: number }>(() => sb.from('warehouse_stock').select('warehouse_id, on_hand').order('warehouse_id').order('product_id')),
    allRows<{ warehouse_id: string | null }>(() => sb.from('orders').select('warehouse_id').in('status', ['new', 'on_hold', 'packed']).order('id')),
  ]);
  const names = Object.fromEntries(ov.clients.map((c) => [c.id, c.name]));
  const trip = doorToDoor(delivered);
  const pipe: Pipe = { toPack: ov.pipe.new, hold: ov.pipe.on_hold, packed: ov.pipe.packed, road: ov.pipe.shipped };
  const holds: Record<string, number> = {};
  for (const b of ov.brands) for (const [k, n] of Object.entries(b.holds)) holds[k] = (holds[k] ?? 0) + n;
  const in14 = ov.series.reduce((a, d) => a + d.received, 0), out14 = ov.series.reduce((a, d) => a + d.shipped, 0);
  const week = ov.series.slice(-7).reduce((a, d) => a + d.received, 0), prevWeek = ov.series.slice(0, 7).reduce((a, d) => a + d.received, 0);

  // Stock, per brand (the Inventory page's figures: kits are left out)
  const items = products.filter((p) => p.kind !== 'bundle');
  const brandStock = new Map<string, { sellable: number; daily: number; reorder: number }>();
  for (const p of items) {
    const s = brandStock.get(p.org_id) ?? { sellable: 0, daily: 0, reorder: 0 };
    const r = runway(p, sales30.get(p.id) ?? 0);
    s.sellable += r.available;
    s.daily += r.daily;
    if (r.health === 'critical' || r.health === 'out') s.reorder++;
    brandStock.set(p.org_id, s);
  }

  // Warehouses (the Warehouses page: on hand, and open orders = to pack, on hold, packed)
  const openBy = new Map<string, number>();
  for (const o of openWh) if (o.warehouse_id) openBy.set(o.warehouse_id, (openBy.get(o.warehouse_id) ?? 0) + 1);
  const warehouses = whs.filter((w) => w.kind === 'physical' && w.active).map((w) => ({
    id: w.id, name: w.name, onHand: whStock.filter((r) => r.warehouse_id === w.id).reduce((a, r) => a + r.on_hand, 0), open: openBy.get(w.id) ?? 0,
  }));
  const whMax = Math.max(1, ...warehouses.map((w) => w.onHand));

  // Money: exactly the Finance page's figures (reporting currency)
  const tz = await invoiceTz();
  const [rev, ms] = money ? await Promise.all([currentYm().then(revenueMonth), moneyStatus()]) : [null, null];
  const owes = new Map<string, { total: number; overdue: boolean }>();
  if (ms) {
    const [{ data: openInv }, fin] = await Promise.all([admin.from('invoices').select('org_id, total, currency, due_date').eq('status', 'open'), financeSettings()]);
    for (const i of openInv ?? []) {
      const o = owes.get(i.org_id) ?? { total: 0, overdue: false };
      o.total += toReport(Number(i.total), i.currency, fin) ?? 0;
      o.overdue ||= !!(i.due_date && i.due_date < t);
      owes.set(i.org_id, o);
    }
  }
  const revBy = new Map((rev?.rows ?? []).map((r) => [r.org_id, r.report ?? 0]));

  // Brands
  const brands = ov.brands.filter((b) => b.week || b.toShip || b.onHold || b.inTransit || brandStock.get(b.id)?.sellable).map((b) => {
    const st = brandStock.get(b.id);
    const daysLeft = st && st.daily > 0 ? st.sellable / st.daily : null;
    const change = b.prevWeek ? Math.round(((b.week - b.prevWeek) / b.prevWeek) * 100) : null;
    const owe = owes.get(b.id) ?? null;
    const tone = owe?.overdue || (daysLeft !== null && daysLeft < 21) || (st?.reorder ?? 0) > 0 ? 'err' : b.onHold ? 'warn' : 'ok';
    return { id: b.id, name: b.name, today: b.today, week: b.week, change, spark: b.spark.slice(-7), toPack: b.toShip, hold: b.onHold, daysLeft, reorder: st?.reorder ?? 0, month: revBy.get(b.id) ?? null, owes: owe, tone };
  }).slice(0, 8);

  // Needs action: only what this person can act on, each linked to the list with the same count
  const ib = (inbounds.data ?? []) as { id: string; status: string; eta: string | null }[];
  const lateIn = ib.filter((b) => b.eta && b.eta < t).length; // Inbounds → Overdue
  const tk = (tickets.data ?? []) as { id: string; status: string; category: string }[];
  const damaged = tk.filter((x) => x.category === 'damaged').length;
  const storeErr = ((stores.data ?? []) as { last_error: string | null }[]).filter((s) => s.last_error).length;
  const holdText = Object.entries(holds).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${k} ${n}`).join(' · ');
  const late24 = speed.ages[2] + speed.ages[3];
  const work = ctx.can('orders.warehouse') || ctx.can('orders.hold');
  const pending = (links.data ?? []) as unknown[];
  const actions = ([
    work && { key: 'pack', n: pipe.toPack, tone: 'blue', label: `Orders to pack${speed.oldestH !== null ? ` · oldest ${speed.oldestH} h` : ''}`, href: '/orders?c=all&s=new' },
    work && { key: 'late', n: late24, tone: 'err', label: 'Waiting over 24 h', href: '/orders?c=all&s=new&older=24' },
    ctx.can('orders.hold') && { key: 'hold', n: pipe.hold, tone: 'warn', label: `On hold${holdText ? ` · ${holdText}` : ''}`, href: '/orders?c=all&s=on_hold' },
    work && { key: 'track', n: problems.count ?? 0, tone: 'err', label: 'Tracking problems · no tracking or carrier issue', href: '/tracking?t=problem' },
    ctx.can('stock.adjust') && { key: 'quarantine', n: qOpen.count ?? 0, tone: 'violet', label: 'Quarantine decisions to carry out', href: '/inventory/decisions' },
    (ctx.can('inbounds.receive') || ctx.can('clients.view')) && { key: 'inbounds', n: lateIn, tone: 'warn', label: 'Inbounds past their expected date', href: '/inbounds?t=late' },
    ctx.can('support.reply') && { key: 'tickets', n: tk.length, tone: 'blue', label: `Tickets waiting for our reply${damaged ? ` · ${damaged} damaged goods` : ''}`, href: '/support?s=open' },
    ctx.can('integrations.manage') && { key: 'stores', n: storeErr, tone: 'err', label: 'Store connection errors', href: '/integrations' },
    money && { key: 'drafts', n: ms!.drafts.n, tone: 'warn', label: 'Invoice drafts to review & issue', href: '/invoices?t=draft' },
    money && { key: 'overdue', n: ms!.overdue.n, tone: 'err', label: 'Invoices overdue to chase', href: '/invoices?t=overdue' },
    (owner || ctx.staffRole === 'manager') && { key: 'links', n: pending.length, tone: 'blue', label: 'People who haven’t signed in yet', href: '#pending' },
  ] as (Action | false)[]).filter((x): x is Action => !!x);

  // Live feed
  let feed: FeedItem[] = [];
  if (owner) {
    const { data } = await sb.from('activity_log').select('action, detail, org_id, created_at').order('created_at', { ascending: false }).limit(12);
    const tone = (a: string): FeedItem['tone'] => /deliver|paid|received|released/.test(a) ? 'ok' : /held|late|void|error|written|deleted|cancel/.test(a) ? 'warn' : /ticket|quarantine/.test(a) ? 'violet' : 'blue';
    feed = (data ?? []).map((a) => ({ tone: tone(a.action), who: a.org_id ? names[a.org_id] ?? '' : 'Team', text: `${ACTIVITY_LABELS[a.action] ?? a.action}${a.detail ? ` · ${a.detail}` : ''}`, at: a.created_at }));
  } else {
    feed = await orderFeed(null, names);
  }

  return {
    flags: { money, owner, clients: ctx.can('clients.manage') },
    today, toInvoice: { ym: lastMonth(tz), label: monthBounds(lastMonth(tz)).label },
    kpi: {
      ordersToday: ordersToday.count ?? 0, shippedToday: ov.today.shipped, road: pipe.road, problems: problems.count ?? 0,
      in14, out14, week, change: prevWeek ? Math.round(((week - prevWeek) / prevWeek) * 100) : null,
      spark: { in: ov.series.map((d) => d.received), out: ov.series.map((d) => d.shipped) },
    },
    trip, speed, pipe, warehouses, whMax, brands, actions, feed, pending, names,
    sellable: [...brandStock.values()].reduce((a, b) => a + b.sellable, 0), reorder: [...brandStock.values()].reduce((a, b) => a + b.reorder, 0),
    tickets: ctx.can('support.reply') ? tk.length : null, lateIn,
    money: rev && ms ? {
      currency: rev.currency, label: rev.label, day: rev.day, days: rev.days, share: rev.share,
      mtd: rev.total, forecast: rev.forecast, owed: ms.open, overdue: ms.overdue, paid30: ms.paid30, drafts: ms.drafts,
      late: ms.next.filter((n) => n.tone === 'err').slice(0, 2), noRate: [...new Set([...rev.noRate, ...ms.noRate])],
    } : null,
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
// A brand: the Quick view
// ======================================================================
export async function clientDashboard(ctx: Ctx) {
  const org = ctx.org!;
  const sb = await supabaseServer();
  const billing = ctx.can('invoices.view');
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const since14 = new Date(Date.now() - 14 * 864e5).toISOString();
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const today = dayKey(new Date());
  const t = utcToday();

  const [recent, open, speed, { products }, sales30, sold7, sold14, notices, inbounds, invoices, shipped7, problems, delivered, ordersToday, rates] = await Promise.all([
    allRows<{ status: string; created_at: string; shipped_at: string | null }>(() => sb.from('orders').select('status, created_at, shipped_at').eq('org_id', org.id)
      .or(`created_at.gte.${since14},shipped_at.gte.${since14}`).order('id')),
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
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('org_id', org.id).eq('status', 'shipped').or(problemFilter),
    allRows<{ shipped_at: string | null; delivered_at: string | null }>(() => sb.from('orders').select('shipped_at, delivered_at').eq('org_id', org.id).eq('status', 'delivered').gte('delivered_at', since30).not('shipped_at', 'is', null).order('id')),
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('org_id', org.id).gte('created_at', chinaDayStart(today)).lt('created_at', chinaDayStart(today, 1)),
    billing ? getRateCard(org.id) : Promise.resolve(null),
  ]);

  // Orders in and out, day by day (China days, like the Orders list)
  const keys = Array.from({ length: 14 }, (_, i) => dayKey(new Date(Date.now() - (13 - i) * 864e5)));
  const inBy = new Map(keys.map((k) => [k, 0])), outBy = new Map(keys.map((k) => [k, 0]));
  for (const o of recent) {
    const c = dayKey(o.created_at);
    if (inBy.has(c)) inBy.set(c, inBy.get(c)! + 1);
    if (o.shipped_at && ['shipped', 'delivered'].includes(o.status)) { const s = dayKey(o.shipped_at); if (outBy.has(s)) outBy.set(s, outBy.get(s)! + 1); }
  }
  const week = keys.slice(7).reduce((a, k) => a + inBy.get(k)!, 0), prevWeek = keys.slice(0, 7).reduce((a, k) => a + inBy.get(k)!, 0);
  const pipe: Pipe = { toPack: 0, hold: 0, packed: 0, road: 0 };
  for (const o of open) { if (o.status === 'new') pipe.toPack++; else if (o.status === 'on_hold') pipe.hold++; else if (o.status === 'packed') pipe.packed++; else pipe.road++; }

  // Stock (the Inventory page's figures: kits left out)
  const items = products.filter((p) => p.kind !== 'bundle');
  const rw = items.map((p) => ({ p, r: runway(p, sales30.get(p.id) ?? 0) }));
  const sellable = rw.reduce((a, x) => a + x.r.available, 0);
  const daily = items.reduce((a, p) => a + (sales30.get(p.id) ?? 0), 0) / 30;
  const reorder = rw.filter((x) => x.r.health === 'critical' || x.r.health === 'out').length;
  const low = rw.filter((x) => ['out', 'critical', 'warning'].includes(x.r.health) && x.r.daily > 0).sort((a, b) => (a.r.days ?? 0) - (b.r.days ?? 0)).slice(0, 3);

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

  // Running bill: the Invoices page's "This month so far"
  let bill: { total: number; perOrder: number | null; forecast: number; currency: string; label: string; share: number } | null = null;
  if (rates) {
    const tz = await invoiceTz();
    const { start, end, label } = monthBounds(ymOf(new Date(), tz), tz);
    const elapsed = Math.max(1 / 24, (Date.now() - start.getTime()) / 864e5), days = (end.getTime() - start.getTime()) / 864e5;
    const r = await computeCharges(org.id, rates, start, new Date()).catch(() => null);
    if (r) {
      const perOrder = r.stats.orders ? r.lines.filter((l) => ['fulfillment', 'packaging', 'shipping', 'customs'].includes(l.category)).reduce((a, l) => a + l.amount, 0) / r.stats.orders : null;
      bill = { total: r.total, perOrder, forecast: (r.total / elapsed) * days, currency: rates.currency, label, share: Math.min(1, elapsed / days) };
    }
  }

  return {
    org, today,
    kpi: { ordersToday: ordersToday.count ?? 0, shippedToday: outBy.get(keys[13]) ?? 0, week, change: prevWeek ? Math.round(((week - prevWeek) / prevWeek) * 100) : null },
    spark: { in: keys.map((k) => inBy.get(k)!), out: keys.map((k) => outBy.get(k)!) },
    pipe, speed, problems: problems.count ?? 0, trip: doorToDoor(delivered),
    sellable, reorder, daysLeft: daily > 0 ? sellable / daily : null,
    low, inbounds: (inbounds.data ?? []).map((b) => ({ ...b, units: (b.inbound_items as { expected: number }[]).reduce((a, i) => a + i.expected, 0), late: !!b.eta && b.eta < t })),
    notices, best, bill, invoices: invoices.data ?? [],
    feed: await orderFeed(org.id, {}),
  };
}
