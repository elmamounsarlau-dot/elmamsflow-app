import 'server-only';
import { cache } from 'react';
import { supabaseAdmin } from './supabase/admin';
import { allRows } from './data';
import { computeCharges, DUTIES_LINE, getRateCard, invoiceTz, monthBounds, ymOf, type Line } from './billing';
import { dayKey } from './orders-overview';
import { financeSettings, toReport, type FinanceSettings } from './fx';

/**
 * Finance: what the business earns (invoices), spends (expenses + what each order cost us) and keeps.
 * Everything is in the reporting currency (Finance → Settings). Only people with billing.manage reach these
 * functions; they read with full rights because clients' costs are never readable by clients.
 */

export const EXPENSE_CATS = ['carrier', 'duties', 'rent', 'salaries', 'packaging', 'software', 'other'] as const;
export type ExpenseCat = (typeof EXPENSE_CATS)[number];
export const CAT_LABEL: Record<ExpenseCat, string> = {
  carrier: 'Carriers & postage', duties: 'Duties & taxes (DDP)', rent: 'Warehouse rent', salaries: 'Team salaries', packaging: 'Packaging', software: 'Software', other: 'Other',
};
export const CAT_SHORT: Record<ExpenseCat, string> = {
  carrier: 'Carrier', duties: 'Duties (DDP)', rent: 'Rent', salaries: 'Salaries', packaging: 'Packaging', software: 'Software', other: 'Other',
};

/** Revenue groups, for the profit & loss. */
export const REV_GROUPS = [
  ['fulfil', 'Fulfilment & packaging'],
  ['shipping', 'Shipping'],
  ['customs', 'Customs handling (DDP)'],
  ['duties', 'DDP duties billed back'],
  ['stock', 'Receiving & storage'],
  ['other', 'Other'],
] as const;
export type RevGroup = (typeof REV_GROUPS)[number][0];
const groupOf = (l: { category: string; description: string }): RevGroup =>
  l.description.startsWith(DUTIES_LINE) ? 'duties'
    : l.category === 'fulfillment' || l.category === 'packaging' ? 'fulfil'
      : l.category === 'shipping' ? 'shipping'
        : l.category === 'customs' ? 'customs'
          : l.category === 'receiving' || l.category === 'storage' ? 'stock' : 'other';

export const ymOk = (v: string | undefined | null) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(v ?? '') ? v! : null);
export const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const monthLabel = (ym: string, short = false) =>
  new Intl.DateTimeFormat('en-GB', short ? { month: 'short', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-01T12:00:00Z`));
const r2 = (n: number) => Math.round(n * 100) / 100;
const todayChina = () => dayKey(new Date());

export const currentYm = cache(async () => ymOf(new Date(), await invoiceTz()));

// ---------------------------------------------------------------------
// Repeating expenses: written into the month on their day, once.
// ---------------------------------------------------------------------
export const materializeRecurring = cache(async () => {
  const admin = supabaseAdmin();
  const { data: recs } = await admin.from('recurring_expenses').select('*').eq('active', true);
  const today = todayChina();
  const now = today.slice(0, 7);
  for (const r of recs ?? []) {
    let m = r.generated_until ? addMonths(String(r.generated_until).slice(0, 7), 1) : String(r.start_month).slice(0, 7);
    let last: string | null = null;
    for (let guard = 0; m <= now && guard < 36; guard++, m = addMonths(m, 1)) {
      const day = `${m}-${String(r.day_of_month).padStart(2, '0')}`;
      if (day > today) break;
      const { error } = await admin.from('expenses').insert({
        spent_on: day, category: r.category, payee: r.payee, amount: r.amount, currency: r.currency, org_id: r.org_id, note: r.note,
        source: 'recurring', recurring_id: r.id, recurring_month: `${m}-01`, created_by: r.created_by,
      });
      if (error && error.code !== '23505') break; // 23505: another page load wrote it a moment ago
      last = m;
    }
    if (last) await admin.from('recurring_expenses').update({ generated_until: `${last}-01` }).eq('id', r.id);
  }
});

// ---------------------------------------------------------------------
// Revenue: the month's invoices; for the month in progress, what is billable so far.
// ---------------------------------------------------------------------
export type RevenueRow = {
  org_id: string; name: string; currency: string; total: number; report: number | null;
  source: 'invoice' | 'so_far'; status: string | null; invoiceId: string | null; number: string | null;
  groups: Partial<Record<RevGroup, number>>; error: string | null;
};

export const revenueMonth = cache(async (ym: string) => {
  const admin = supabaseAdmin();
  const [fin, tz, cur] = await Promise.all([financeSettings(), invoiceTz(), currentYm()]);
  const { start, end, label } = monthBounds(ym, tz);
  const current = ym === cur;
  const future = ym > cur;
  const elapsed = current ? Math.max(1 / 24, (Date.now() - start.getTime()) / 864e5) : (end.getTime() - start.getTime()) / 864e5;
  const days = (end.getTime() - start.getTime()) / 864e5;

  const [{ data: clients }, { data: cards }, { data: invs }] = await Promise.all([
    admin.from('organizations').select('id, name').eq('kind', 'client'),
    admin.from('rate_cards').select('org_id'),
    admin.from('invoices').select('id, number, org_id, status, currency, total, invoice_lines(category, description, amount)').eq('period_start', `${ym}-01`).neq('status', 'void'),
  ]);
  const names = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]));
  const byOrg = new Map((invs ?? []).map((i) => [i.org_id as string, i]));
  const rows: RevenueRow[] = [];
  const missing: string[] = []; // clients with a price list but no invoice for a finished month

  for (const i of invs ?? []) {
    const groups: Partial<Record<RevGroup, number>> = {};
    for (const l of (i.invoice_lines ?? []) as { category: string; description: string; amount: number }[]) groups[groupOf(l)] = r2((groups[groupOf(l)] ?? 0) + Number(l.amount));
    rows.push({ org_id: i.org_id, name: names.get(i.org_id) ?? 'Client', currency: i.currency, total: Number(i.total), report: toReport(Number(i.total), i.currency, fin), source: 'invoice', status: i.status, invoiceId: i.id, number: i.number, groups, error: null });
  }
  if (!future) {
    const open = (cards ?? []).filter((c) => !byOrg.has(c.org_id) && names.has(c.org_id));
    if (current) {
      const computed = await Promise.all(open.map(async (c) => {
        const rates = await getRateCard(c.org_id);
        if (!rates) return null;
        try {
          const r = await computeCharges(c.org_id, rates, start, new Date());
          const groups: Partial<Record<RevGroup, number>> = {};
          for (const l of r.lines as Line[]) groups[groupOf(l)] = r2((groups[groupOf(l)] ?? 0) + l.amount);
          return { org_id: c.org_id, name: names.get(c.org_id)!, currency: rates.currency, total: r.total, report: toReport(r.total, rates.currency, fin), source: 'so_far', status: null, invoiceId: null, number: null, groups, error: null } as RevenueRow;
        } catch (e) {
          return { org_id: c.org_id, name: names.get(c.org_id)!, currency: rates.currency, total: 0, report: 0, source: 'so_far', status: null, invoiceId: null, number: null, groups: {}, error: (e as Error).message } as RevenueRow;
        }
      }));
      rows.push(...computed.filter((x): x is RevenueRow => !!x));
    } else {
      missing.push(...open.map((c) => names.get(c.org_id)!).filter(Boolean));
    }
  }
  rows.sort((a, b) => (b.report ?? 0) - (a.report ?? 0));

  const noRate = [...new Set(rows.filter((r) => r.report === null).map((r) => r.currency))];
  const total = r2(rows.reduce((a, r) => a + (r.report ?? 0), 0));
  const groups: Record<RevGroup, number> = { fulfil: 0, shipping: 0, customs: 0, duties: 0, stock: 0, other: 0 };
  for (const r of rows) for (const [g, v] of Object.entries(r.groups)) {
    const x = toReport(v!, r.currency, fin);
    if (x !== null) groups[g as RevGroup] = r2(groups[g as RevGroup] + x);
  }
  return {
    ym, label, start, end, current, future, day: Math.ceil(elapsed), days: Math.round(days), share: Math.min(1, elapsed / days),
    rows, total, forecast: current ? r2((total / elapsed) * days) : total, groups, noRate, missing,
    errors: rows.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`), currency: fin.report_currency,
  };
});

// ---------------------------------------------------------------------
// Expenses: what was typed in, plus what each shipped order cost us (labels and duties).
// ---------------------------------------------------------------------
export type ExpenseRow = {
  id: string; spent_on: string; category: ExpenseCat; payee: string; amount: number; currency: string; report: number | null;
  org_id: string | null; note: string | null; receipt_path: string | null; source: string; recurring_id: string | null; created_at: string;
};
export type AutoRow = { day: string; category: 'carrier' | 'duties'; payee: string; orders: number; report: number; org_id: string | null };

type CostRow = { order_id: string; org_id: string; label_cost: number | null; duties_paid: number | null; currency: string; orders: { shipped_at: string; carrier: string | null } };

async function orderCosts(start: Date, end: Date) {
  const admin = supabaseAdmin();
  return allRows<CostRow>(() => admin.from('order_costs').select('order_id, org_id, label_cost, duties_paid, currency, orders!inner(shipped_at, carrier, status)')
    .in('orders.status', ['shipped', 'delivered']).gte('orders.shipped_at', start.toISOString()).lt('orders.shipped_at', end.toISOString()).order('order_id'));
}

export const expensesMonth = cache(async (ym: string) => {
  const admin = supabaseAdmin();
  await materializeRecurring();
  const [fin, tz] = await Promise.all([financeSettings(), invoiceTz()]);
  const { start, end } = monthBounds(ym, tz);
  const [list, costs] = await Promise.all([
    allRows<Omit<ExpenseRow, 'report'>>(() => admin.from('expenses').select('id, spent_on, category, payee, amount, currency, org_id, note, receipt_path, source, recurring_id, created_at')
      .gte('spent_on', `${ym}-01`).lt('spent_on', `${addMonths(ym, 1)}-01`).order('spent_on', { ascending: false }).order('created_at', { ascending: false })),
    orderCosts(start, end),
  ]);
  const rows: ExpenseRow[] = list.map((e) => ({ ...e, amount: Number(e.amount), report: toReport(Number(e.amount), e.currency, fin) }));
  const cats: Record<ExpenseCat, number> = { carrier: 0, duties: 0, rent: 0, salaries: 0, packaging: 0, software: 0, other: 0 };
  const direct = new Map<string, number>();
  const noRate = new Set<string>();
  let overhead = 0;
  for (const e of rows) {
    if (e.report === null) { noRate.add(e.currency); continue; }
    cats[e.category] = r2(cats[e.category] + e.report);
    if (e.org_id) direct.set(e.org_id, (direct.get(e.org_id) ?? 0) + e.report);
    else overhead += e.report;
  }
  // Costs typed by the team when shipping, grouped per day (and per carrier / client) for the list.
  const auto = new Map<string, AutoRow>();
  let labels = 0, duties = 0, labelOrders = 0, dutyOrders = 0;
  for (const c of costs) {
    const day = dayKey(c.orders.shipped_at);
    for (const [cat, v] of [['carrier', c.label_cost], ['duties', c.duties_paid]] as const) {
      if (!v || Number(v) <= 0) continue;
      const x = toReport(Number(v), c.currency, fin);
      if (x === null) { noRate.add(c.currency); continue; }
      cats[cat] = r2(cats[cat] + x);
      direct.set(c.org_id, (direct.get(c.org_id) ?? 0) + x);
      if (cat === 'carrier') { labels += x; labelOrders++; } else { duties += x; dutyOrders++; }
      const payee = cat === 'carrier' ? (c.orders.carrier || 'Shipping labels') : 'Customs (DDP duties)';
      const key = `${day}|${cat}|${cat === 'carrier' ? payee : c.org_id}`;
      const a = auto.get(key) ?? { day, category: cat, payee, orders: 0, report: 0, org_id: cat === 'duties' ? c.org_id : null };
      a.orders++; a.report = r2(a.report + x);
      auto.set(key, a);
    }
  }
  const total = r2(Object.values(cats).reduce((a, b) => a + b, 0));
  return {
    rows, auto: [...auto.values()].sort((a, b) => b.day.localeCompare(a.day)), cats, total, direct, overhead: r2(overhead),
    labels: r2(labels), duties: r2(duties), labelOrders, dutyOrders, noRate: [...noRate], currency: fin.report_currency,
  };
});

/** Orders shipped in the month, per client (for cost per order and sharing overheads). */
export const shippedMonth = cache(async (ym: string) => {
  const admin = supabaseAdmin();
  const { start, end } = monthBounds(ym, await invoiceTz());
  const rows = await allRows<{ org_id: string }>(() => admin.from('orders').select('org_id').in('status', ['shipped', 'delivered']).gte('shipped_at', start.toISOString()).lt('shipped_at', end.toISOString()).order('id'));
  const by = new Map<string, number>();
  for (const o of rows) by.set(o.org_id, (by.get(o.org_id) ?? 0) + 1);
  return { total: rows.length, by };
});

// ---------------------------------------------------------------------
// The month in one place: revenue − expenses, by client and per order.
// ---------------------------------------------------------------------
export const monthFinance = cache(async (ym: string) => {
  const [rev, exp, ship, fin] = await Promise.all([revenueMonth(ym), expensesMonth(ym), shippedMonth(ym), financeSettings()]);
  const profit = r2(rev.total - exp.total);
  const n = ship.total;
  // Each client: their revenue − the costs of their own orders − a share of rent, team and other costs (by orders shipped).
  const ids = new Set([...rev.rows.map((r) => r.org_id), ...exp.direct.keys(), ...ship.by.keys()]);
  const names = new Map(rev.rows.map((r) => [r.org_id, r.name]));
  if ([...ids].some((id) => !names.has(id))) {
    const { data } = await supabaseAdmin().from('organizations').select('id, name').in('id', [...ids]);
    for (const o of data ?? []) names.set(o.id, o.name);
  }
  const revBy = new Map(rev.rows.map((r) => [r.org_id, r.report ?? 0]));
  const shareOf = (id: string) => (n ? (ship.by.get(id) ?? 0) / n : rev.total ? (revBy.get(id) ?? 0) / rev.total : 0);
  const clients = [...ids].map((id) => {
    const revenue = revBy.get(id) ?? 0;
    const costs = r2((exp.direct.get(id) ?? 0) + exp.overhead * shareOf(id));
    return { id, name: names.get(id) ?? 'Client', revenue, costs, profit: r2(revenue - costs), margin: revenue ? Math.round(((revenue - costs) / revenue) * 100) : null, orders: ship.by.get(id) ?? 0 };
  }).filter((c) => c.revenue || c.costs).sort((a, b) => b.revenue - a.revenue);
  // Costs not tied to a client and not shared (no orders and no revenue this month).
  const unshared = r2(exp.total - clients.reduce((a, c) => a + c.costs, 0));

  const per = n ? {
    earn: r2(rev.total / n), cost: r2(exp.total / n), keep: r2(profit / n),
    carrier: r2(exp.cats.carrier / n), duties: r2(exp.cats.duties / n),
    other: r2((exp.cats.packaging + exp.cats.software + exp.cats.other) / n), team: r2((exp.cats.rent + exp.cats.salaries) / n),
  } : null;

  return {
    ym, rev, exp, ship, profit, margin: rev.total ? Math.round((profit / rev.total) * 100) : null, clients, unshared, per,
    duties: { paid: exp.cats.duties, billed: rev.groups.duties, on: fin.bill_duties },
    noRate: [...new Set([...rev.noRate, ...exp.noRate])], currency: fin.report_currency,
  };
});

// ---------------------------------------------------------------------
// Getting paid: open, overdue, by age, paid lately.
// ---------------------------------------------------------------------
export type Inv = { id: string; number: string; org_id: string; status: string; total: number; currency: string; due_date: string | null; issued_at: string | null; paid_at: string | null; paid_method: string | null; period_start: string };

export const moneyStatus = cache(async () => {
  const admin = supabaseAdmin();
  const fin = await financeSettings();
  const [invs, { data: orgs }] = await Promise.all([
    allRows<Inv>(() => admin.from('invoices').select('id, number, org_id, status, total, currency, due_date, issued_at, paid_at, paid_method, period_start').neq('status', 'void').order('id')),
    admin.from('organizations').select('id, name').eq('kind', 'client'),
  ]);
  const names = Object.fromEntries((orgs ?? []).map((o) => [o.id, o.name])) as Record<string, string>;
  const t = new Date().toISOString().slice(0, 10); // the same "today" as the Invoices page
  const noRate = new Set<string>();
  const rep = (i: Inv) => { const v = toReport(Number(i.total), i.currency, fin); if (v === null) noRate.add(i.currency); return v ?? 0; };
  const sum = (l: Inv[]) => r2(l.reduce((a, i) => a + rep(i), 0));
  const lateDays = (i: Inv) => (i.due_date && i.due_date < t ? Math.round((Date.parse(t) - Date.parse(i.due_date)) / 864e5) : 0);

  const open = invs.filter((i) => i.status === 'open');
  const overdue = open.filter((i) => lateDays(i) > 0);
  const drafts = invs.filter((i) => i.status === 'draft');
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const since90 = new Date(Date.now() - 90 * 864e5).toISOString();
  const paid30 = invs.filter((i) => i.status === 'paid' && i.paid_at && i.paid_at >= since30);
  const paid90 = invs.filter((i) => i.status === 'paid' && i.paid_at && i.issued_at && i.paid_at >= since90);
  const aging = [
    { label: 'Not due yet', total: sum(open.filter((i) => lateDays(i) === 0)), tone: 'ok' },
    { label: '1–30 days late', total: sum(open.filter((i) => lateDays(i) >= 1 && lateDays(i) <= 30)), tone: 'warn' },
    { label: '31–60 days late', total: sum(open.filter((i) => lateDays(i) > 30 && lateDays(i) <= 60)), tone: 'err' },
    { label: 'Over 60 days', total: sum(open.filter((i) => lateDays(i) > 60)), tone: 'err' },
  ];
  const methods: Record<string, number> = {};
  for (const i of paid30) methods[i.paid_method ?? 'other'] = (methods[i.paid_method ?? 'other'] ?? 0) + 1;
  const avgDays = paid90.length ? Math.round(paid90.reduce((a, i) => a + (Date.parse(i.paid_at!) - Date.parse(i.issued_at!)) / 864e5, 0) / paid90.length) : null;

  // What to do next, most urgent first.
  const next = [
    ...overdue.sort((a, b) => lateDays(b) - lateDays(a)).map((i) => ({ ...i, who: names[i.org_id] ?? '', tone: 'err', state: `${lateDays(i)} day${lateDays(i) === 1 ? '' : 's'} late`, step: 'Chase payment' })),
    ...drafts.map((i) => ({ ...i, who: names[i.org_id] ?? '', tone: 'mute', state: 'Draft', step: 'Review & issue' })),
    ...open.filter((i) => lateDays(i) === 0).sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '')).map((i) => ({ ...i, who: names[i.org_id] ?? '', tone: 'go', state: i.due_date ? `Due ${new Date(`${i.due_date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : 'Open', step: 'Mark as paid' })),
  ];

  return {
    open: { n: open.length, total: sum(open) }, overdue: { n: overdue.length, total: sum(overdue) },
    drafts: { n: drafts.length, total: sum(drafts) }, paid30: { n: paid30.length, total: sum(paid30), methods },
    aging, avgDays, next, noRate: [...noRate], currency: fin.report_currency, names,
  };
});

// ---------------------------------------------------------------------
// Twelve months: revenue (invoices; the month in progress so far) and expenses.
// ---------------------------------------------------------------------
export const history = cache(async (ym: string) => {
  const admin = supabaseAdmin();
  await materializeRecurring();
  const [fin, tz, cur] = await Promise.all([financeSettings(), invoiceTz(), currentYm()]);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(ym, i - 11));
  const first = months[0];
  const { start } = monthBounds(first, tz);
  const { end } = monthBounds(ym, tz);
  const [invs, exps, costs] = await Promise.all([
    allRows<{ total: number; currency: string; period_start: string }>(() => admin.from('invoices').select('total, currency, period_start').neq('status', 'void').gte('period_start', `${first}-01`).lte('period_start', `${ym}-01`).order('id')),
    allRows<{ amount: number; currency: string; spent_on: string }>(() => admin.from('expenses').select('amount, currency, spent_on').gte('spent_on', `${first}-01`).lt('spent_on', `${addMonths(ym, 1)}-01`).order('id')),
    orderCosts(start, end),
  ]);
  const rev = new Map(months.map((m) => [m, 0])), exp = new Map(months.map((m) => [m, 0]));
  for (const i of invs) { const m = i.period_start.slice(0, 7); const v = toReport(Number(i.total), i.currency, fin); if (v !== null && rev.has(m)) rev.set(m, rev.get(m)! + v); }
  for (const e of exps) { const m = e.spent_on.slice(0, 7); const v = toReport(Number(e.amount), e.currency, fin); if (v !== null && exp.has(m)) exp.set(m, exp.get(m)! + v); }
  for (const c of costs) {
    const m = ymOf(new Date(c.orders.shipped_at), tz);
    const v = toReport(Number(c.label_cost ?? 0) + Number(c.duties_paid ?? 0), c.currency, fin);
    if (v !== null && exp.has(m)) exp.set(m, exp.get(m)! + v);
  }
  // The month in progress (and any month shown live) uses the same figures as the month view.
  const [live, liveExp] = await Promise.all([revenueMonth(ym), expensesMonth(ym)]);
  rev.set(ym, live.total);
  exp.set(ym, liveExp.total);
  return months.map((m) => ({ ym: m, label: monthLabel(m, true), revenue: r2(rev.get(m)!), expenses: r2(exp.get(m)!), current: m === cur }));
});

export type FinanceSettingsT = FinanceSettings;
