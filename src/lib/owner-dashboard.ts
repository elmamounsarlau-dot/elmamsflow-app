import 'server-only';
import { supabaseServer } from './supabase/server';
import { supabaseAdmin } from './supabase/admin';
import { allRows, available, getProducts } from './data';
import { runway, salesByProduct } from './insights';
import { computeCharges, getRateCard, invoiceTz, monthBounds, ymOf } from './billing';
import { ordersOverview } from './orders-overview';
import { getWarehouses } from './warehouses';
import { CARRIER_PROBLEM } from './format';
import { isOwner, seesBusiness, seesMoney, type Ctx } from './session';

const today = () => new Date().toISOString().slice(0, 10);

/** Everything the back office needs on one screen. Each part is only read when the person's role may see it. */
export async function ownerDashboard(ctx: Ctx) {
  const sb = await supabaseServer();
  const admin = supabaseAdmin();
  const money = seesMoney(ctx) && ctx.can('invoices.view');
  const business = seesBusiness(ctx);
  const stock = ctx.can('stock.adjust') || ctx.can('inbounds.receive') || ctx.can('products.edit') || business;
  const owner = isOwner(ctx);
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const t = today();

  const [ov, shippedNoTrack, trackProblems, quarantineOpen, inbounds, transfers, tickets, stores, links, activity, delivered, products, sales30, whs, whStock, invoices] = await Promise.all([
    ordersOverview(14),
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'shipped').is('tracking', null),
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'shipped').or(`tracking_status.in.(${CARRIER_PROBLEM.join(',')}),tracking_error.not.is.null`),
    stock ? sb.from('quarantine_requests').select('id', { count: 'exact', head: true }).eq('status', 'requested') : Promise.resolve({ count: 0 }),
    stock ? sb.from('inbounds').select('id, status, eta, org_id').neq('status', 'received').limit(1000) : Promise.resolve({ data: [] as { id: string; status: string; eta: string | null; org_id: string }[] }),
    stock ? sb.from('transfers').select('id', { count: 'exact', head: true }).eq('status', 'in_transit') : Promise.resolve({ count: 0 }),
    ctx.can('support.reply') ? sb.from('tickets').select('id, subject, org_id, status, category, updated_at').neq('status', 'closed').order('updated_at', { ascending: false }).limit(200) : Promise.resolve({ data: [] as { id: string; subject: string; org_id: string; status: string; category: string; updated_at: string }[] }),
    ctx.can('integrations.manage') ? admin.from('integrations').select('id, org_id, name, store_url, status, last_error, last_sync_at').neq('status', 'disconnected') : Promise.resolve({ data: [] as { id: string; org_id: string; name: string | null; store_url: string; status: string; last_error: string | null; last_sync_at: string | null }[] }),
    owner || ctx.staffRole === 'manager' ? sb.from('access_links').select('user_id', { count: 'exact', head: true }) : Promise.resolve({ count: 0 }),
    owner ? sb.from('activity_log').select('id, action, detail, org_id, created_at').order('created_at', { ascending: false }).limit(7) : Promise.resolve({ data: [] as { id: number; action: string; detail: string | null; org_id: string | null; created_at: string }[] }),
    allRows<{ shipped_at: string; delivered_at: string; country: string }>(() => sb.from('orders').select('shipped_at, delivered_at, country').eq('status', 'delivered').gte('delivered_at', since30).not('shipped_at', 'is', null).order('id')),
    stock ? getProducts(ctx) : Promise.resolve([]),
    stock ? salesByProduct(ctx, 30) : Promise.resolve(new Map<string, number>()),
    getWarehouses(),
    stock ? allRows<{ warehouse_id: string; on_hand: number; quarantined: number; reserved: number }>(() => sb.from('warehouse_stock').select('warehouse_id, on_hand, quarantined, reserved').order('warehouse_id').order('product_id')) : Promise.resolve([]),
    money ? allRows<{ id: string; number: string; org_id: string; status: string; total: number; currency: string; due_date: string | null; paid_at: string | null; period_start: string }>(() =>
      sb.from('invoices').select('id, number, org_id, status, total, currency, due_date, paid_at, period_start').neq('status', 'void').order('period_start', { ascending: false }).order('id')) : Promise.resolve([]),
  ]);

  // ---------- Orders right now ----------
  const holds: Record<string, number> = {};
  for (const b of ov.brands) for (const [k, n] of Object.entries(b.holds)) holds[k] = (holds[k] ?? 0) + n;
  const oldest = await sb.from('orders').select('created_at').eq('status', 'new').order('created_at').limit(1).maybeSingle();
  const oldestNewH = oldest.data ? Math.floor((Date.now() - Date.parse(oldest.data.created_at)) / 3600e3) : null;

  // ---------- Delivery (last 30 days) ----------
  const trips = delivered.map((o) => (Date.parse(o.delivered_at) - Date.parse(o.shipped_at)) / 864e5);
  const avgTrip = trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : null;
  const onTime = trips.length ? Math.round((trips.filter((d) => d <= 9).length / trips.length) * 100) : null;
  const markets = new Map<string, number>();
  for (const o of delivered) markets.set(o.country, (markets.get(o.country) ?? 0) + 1);

  // ---------- Stock ----------
  const items = products.filter((p) => p.kind !== 'bundle');
  const reorder = items.filter((p) => { const h = runway(p, sales30.get(p.id) ?? 0).health; return h === 'critical' || h === 'out'; });
  const stockSum = {
    sellable: items.reduce((a, p) => a + available(p), 0),
    onHand: items.reduce((a, p) => a + p.on_hand, 0),
    incoming: items.reduce((a, p) => a + p.incoming, 0),
    quarantined: items.reduce((a, p) => a + p.quarantined, 0),
    reorder: reorder.length,
    reorderBrands: new Set(reorder.map((p) => p.org_id)).size,
    noCustoms: items.filter((p) => !p.hs_code || !Number(p.customs_value)).length,
    skus: items.length,
  };
  const reorderByBrand = new Map<string, number>();
  for (const p of reorder) reorderByBrand.set(p.org_id, (reorderByBrand.get(p.org_id) ?? 0) + 1);
  const sellableByBrand = new Map<string, number>();
  for (const p of items) sellableByBrand.set(p.org_id, (sellableByBrand.get(p.org_id) ?? 0) + available(p));

  // ---------- Warehouses ----------
  const openByWh = new Map<string, number>();
  const { data: openOrders } = await sb.from('orders').select('warehouse_id').in('status', ['new', 'packed']).not('warehouse_id', 'is', null).limit(10000);
  for (const o of openOrders ?? []) openByWh.set(o.warehouse_id, (openByWh.get(o.warehouse_id) ?? 0) + 1);
  const ib = (inbounds.data ?? []) as { id: string; status: string; eta: string | null; org_id: string }[];
  const warehouses = whs.filter((w) => w.kind === 'physical' && w.active).map((w) => {
    const rows = whStock.filter((r) => r.warehouse_id === w.id);
    return {
      ...w,
      onHand: rows.reduce((a, r) => a + r.on_hand, 0),
      sellable: rows.reduce((a, r) => a + Math.max(0, r.on_hand - r.quarantined - r.reserved), 0),
      quarantined: rows.reduce((a, r) => a + r.quarantined, 0),
      toShip: openByWh.get(w.id) ?? 0,
    };
  });

  // ---------- Money ----------
  let mtd: { org_id: string; total: number; currency: string }[] = [];
  if (money) {
    const tz = await invoiceTz();
    const { start } = monthBounds(ymOf(new Date(), tz), tz);
    const { data: cards } = await admin.from('rate_cards').select('org_id');
    mtd = (await Promise.all((cards ?? []).map(async (c) => {
      const rates = await getRateCard(c.org_id);
      if (!rates) return null;
      const r = await computeCharges(c.org_id, rates, start, new Date()).catch(() => null);
      return r ? { org_id: c.org_id, total: r.total, currency: rates.currency } : null;
    }))).filter((x): x is { org_id: string; total: number; currency: string } => !!x);
  }
  const sumBy = (rows: { total: number; currency: string }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.currency, (m.get(r.currency) ?? 0) + Number(r.total));
    return [...m.entries()].map(([currency, total]) => ({ currency, total })).sort((a, b) => b.total - a.total);
  };
  const open = invoices.filter((i) => i.status === 'open');
  const overdue = open.filter((i) => i.due_date && i.due_date < t);
  const drafts = invoices.filter((i) => i.status === 'draft');
  const paid30 = invoices.filter((i) => i.status === 'paid' && i.paid_at && i.paid_at >= since30);
  const owedByBrand = new Map<string, number>();
  for (const i of open) owedByBrand.set(i.org_id, (owedByBrand.get(i.org_id) ?? 0) + Number(i.total));
  const mtdByBrand = new Map(mtd.map((m) => [m.org_id, m]));

  const tk = (tickets.data ?? []) as { id: string; subject: string; org_id: string; status: string; category: string; updated_at: string }[];
  const storeRows = (stores.data ?? []) as { id: string; org_id: string; name: string | null; store_url: string; status: string; last_error: string | null; last_sync_at: string | null }[];

  return {
    flags: { money, business, stock, owner, support: ctx.can('support.reply'), stores: ctx.can('integrations.manage') },
    ov, holds, oldestNewH,
    noTracking: shippedNoTrack.count ?? 0, trackProblems: trackProblems.count ?? 0,
    delivery: { avgTrip, onTime, delivered: trips.length, markets: [...markets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6) },
    stock: stockSum, reorderByBrand, sellableByBrand,
    quarantineOpen: quarantineOpen.count ?? 0,
    inbounds: { open: ib.length, late: ib.filter((b) => b.eta && b.eta < t && ['announced', 'in_transit'].includes(b.status)).length, arriving: ib.filter((b) => b.status === 'in_transit').length, receiving: ib.filter((b) => ['receiving', 'counted'].includes(b.status)).length },
    transfers: transfers.count ?? 0, warehouses,
    tickets: { waiting: tk.filter((x) => x.status === 'open'), damaged: tk.filter((x) => x.category === 'damaged').length, all: tk.length },
    stores: { total: storeRows.length, errors: storeRows.filter((s) => s.last_error) },
    links: links.count ?? 0, activity: activity.data ?? [],
    money: {
      mtd: sumBy(mtd), outstanding: sumBy(open), overdue: sumBy(overdue), paid30: sumBy(paid30),
      drafts: drafts.length, overdueN: overdue.length, openN: open.length,
      toSend: [...overdue, ...drafts].slice(0, 5),
    },
    owedByBrand, mtdByBrand,
  };
}
