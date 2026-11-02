import 'server-only';
import { cache } from 'react';
import { supabaseAdmin } from './supabase/admin';
import { financeSettings, toReport, type FinanceSettings } from './fx';
import { stagesOf, totals, type Line } from './b2b';

// Every caller checks first that the person is the owner, a manager or finance (billing.manage, back office).

export type B2BSettings = { stages: string[]; next_order: number; next_devis: number; next_facture: number; next_invoice: number; intl_template: 'a' | 'b'; bank: Record<string, string>; email: string | null };
export const b2bSettings = cache(async (): Promise<B2BSettings> => {
  const { data } = await supabaseAdmin().from('b2b_settings').select('stages, next_order, next_devis, next_facture, next_invoice, intl_template, bank, email').eq('id', 1).maybeSingle();
  return {
    stages: stagesOf(data?.stages),
    next_order: data?.next_order ?? 1, next_devis: data?.next_devis ?? 1, next_facture: data?.next_facture ?? 1, next_invoice: data?.next_invoice ?? 1,
    intl_template: (data?.intl_template === 'b' ? 'b' : 'a'),
    bank: (data?.bank ?? {}) as Record<string, string>,
    email: data?.email ?? null,
  };
});

export type B2BClient = { id: string; name: string; country: string; ice: string | null; vat_number: string | null; address: string | null; contact: string | null; email: string | null; phone: string | null; currency: string; notes: string | null; archived: boolean };
export const b2bClients = cache(async (all = false): Promise<B2BClient[]> => {
  let q = supabaseAdmin().from('b2b_clients').select('id, name, country, ice, vat_number, address, contact, email, phone, currency, notes, archived').order('name');
  if (!all) q = q.eq('archived', false);
  return ((await q).data ?? []) as B2BClient[];
});

export type B2BOrder = {
  id: string; number: string; client_id: string; title: string; stage: string; cancelled: boolean; currency: string; tva_rate: number; discount: number;
  incoterm: string | null; transport: string | null; origin: string | null; destination: string | null; client_ref: string | null; container: string | null;
  carrier: string | null; tracking: string | null; etd: string | null; eta: string | null; notes: string | null; created_at: string; updated_at: string;
};
const ORDER_COLS = 'id, number, client_id, title, stage, cancelled, currency, tva_rate, discount, incoterm, transport, origin, destination, client_ref, container, carrier, tracking, etd, eta, notes, created_at, updated_at';

export type LineRow = Line & { id: string; position: number };
export type CostRow = { id: string; order_id: string; category: string; payee: string; amount: number; currency: string; paid_on: string; note: string | null };
export type PayRow = { id: string; order_id: string; amount: number; currency: string; paid_on: string; method: string; note: string | null };
export type DocRow = { id: string; order_id: string; kind: 'devis' | 'facture' | 'invoice'; template: 'ma' | 'a' | 'b'; number: string; issued_on: string; due_on: string | null; currency: string; total: number; status: string; data: DocData };

export type DocData = {
  client: { name: string; country: string; ice: string | null; vat_number: string | null; address: string | null };
  order: { number: string; title: string; client_ref: string | null; incoterm: string | null; transport: string | null; origin: string | null; destination: string | null; container: string | null; carrier: string | null; etd: string | null; eta: string | null };
  lines: { kind: string; description: string; hs_code: string | null; qty: number | null; unit: string | null; unit_price: number | null; price_currency: string | null; pct: number | null; amount: number }[];
  ht: number; tva_rate: number; tva: number; discount: number; ttc: number;
  paid: number; balance: number; payments: { paid_on: string; amount: number; method: string }[];
  bank: string | null; email: string | null;
};

/** Money summary of one order, in its own currency and in the reporting currency. */
export type Money = { ht: number; ttc: number; paid: number; billed: number; balance: number; costs: number | null; profit: number | null; margin: number | null; noRate: string[] };
export function moneyOf(o: B2BOrder, lines: Line[], costs: CostRow[], pays: PayRow[], docs: DocRow[], fin: FinanceSettings): Money {
  const t = totals(lines, Number(o.tva_rate), Number(o.discount));
  const noRate = new Set<string>();
  const paid = Math.round(pays.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100;
  const billed = Math.round(docs.filter((d) => d.kind !== 'devis' && d.status === 'issued').reduce((s, d) => s + Number(d.total), 0) * 100) / 100;
  // Profit (reporting currency): what we sell, before TVA, minus what it cost us.
  const saleR = toReport(t.ht - t.discount, o.currency, fin);
  if (saleR === null) noRate.add(o.currency);
  let costsR: number | null = 0;
  for (const c of costs) {
    const v = toReport(Number(c.amount), c.currency, fin);
    if (v === null) { noRate.add(c.currency); costsR = null; } else if (costsR !== null) costsR += v;
  }
  const profit = saleR !== null && costsR !== null ? Math.round((saleR - costsR) * 100) / 100 : null;
  return {
    ht: t.ht, ttc: t.ttc, paid, billed, balance: Math.round(((billed || t.ttc) - paid) * 100) / 100,
    costs: costsR === null ? null : Math.round(costsR * 100) / 100,
    profit, margin: profit !== null && saleR ? Math.round((profit / saleR) * 100) : null, noRate: [...noRate],
  };
}

const byOrder = <T extends { order_id: string }>(rows: T[]) => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.order_id, [...(m.get(r.order_id) ?? []), r]);
  return m;
};

export type ListRow = B2BOrder & { client: string; country: string; money: Money; lastDoc: string | null };
/** Every order with its client and money (B2B volumes are small: dozens to a few hundred). */
export const b2bOrders = cache(async (): Promise<ListRow[]> => {
  const sb = supabaseAdmin();
  const [{ data: orders }, { data: lines }, { data: costs }, { data: pays }, { data: docs }, clients, fin] = await Promise.all([
    sb.from('b2b_orders').select(ORDER_COLS).order('created_at', { ascending: false }).limit(2000),
    sb.from('b2b_lines').select('id, order_id, position, kind, description, hs_code, qty, unit, unit_price, price_currency, rate, pct').order('position'),
    sb.from('b2b_costs').select('id, order_id, category, payee, amount, currency, paid_on, note'),
    sb.from('b2b_payments').select('id, order_id, amount, currency, paid_on, method, note'),
    sb.from('b2b_docs').select('id, order_id, kind, template, number, issued_on, due_on, currency, total, status').order('created_at'),
    b2bClients(true),
    financeSettings(),
  ]);
  const L = byOrder((lines ?? []) as (LineRow & { order_id: string })[]), C = byOrder((costs ?? []) as CostRow[]), P = byOrder((pays ?? []) as PayRow[]), D = byOrder((docs ?? []) as DocRow[]);
  const cl = new Map(clients.map((c) => [c.id, c]));
  return ((orders ?? []) as B2BOrder[]).map((o) => {
    const ds = D.get(o.id) ?? [];
    const last = [...ds].reverse().find((d) => d.status === 'issued');
    return {
      ...o, client: cl.get(o.client_id)?.name ?? '—', country: cl.get(o.client_id)?.country ?? '',
      money: moneyOf(o, (L.get(o.id) ?? []).map(numLine), C.get(o.id) ?? [], P.get(o.id) ?? [], ds, fin),
      lastDoc: last ? `${last.kind === 'devis' ? 'Devis' : last.kind === 'facture' ? 'Facture' : 'Invoice'} ${last.number}` : null,
    };
  });
});

export const numLine = <T extends Line>(l: T): T => ({ ...l, qty: l.qty === null ? null : Number(l.qty), unit_price: l.unit_price === null ? null : Number(l.unit_price), rate: Number(l.rate), pct: l.pct === null ? null : Number(l.pct) });

export async function b2bOrderFile(id: string) {
  const sb = supabaseAdmin();
  const { data: o } = await sb.from('b2b_orders').select(ORDER_COLS).eq('id', id).maybeSingle();
  if (!o) return null;
  const [{ data: client }, { data: lines }, { data: costs }, { data: pays }, { data: docs }, { data: events }] = await Promise.all([
    sb.from('b2b_clients').select('id, name, country, ice, vat_number, address, contact, email, phone, currency, notes, archived').eq('id', o.client_id).maybeSingle(),
    sb.from('b2b_lines').select('id, order_id, position, kind, description, hs_code, qty, unit, unit_price, price_currency, rate, pct').eq('order_id', id).order('position'),
    sb.from('b2b_costs').select('id, order_id, category, payee, amount, currency, paid_on, note').eq('order_id', id).order('paid_on'),
    sb.from('b2b_payments').select('id, order_id, amount, currency, paid_on, method, note').eq('order_id', id).order('paid_on'),
    sb.from('b2b_docs').select('id, order_id, kind, template, number, issued_on, due_on, currency, total, status, data').eq('order_id', id).order('created_at'),
    sb.from('b2b_events').select('id, text, stage, at').eq('order_id', id).order('at', { ascending: false }).limit(50),
  ]);
  return {
    order: o as B2BOrder, client: client as B2BClient | null, lines: ((lines ?? []) as LineRow[]).map(numLine),
    costs: (costs ?? []) as CostRow[], pays: (pays ?? []) as PayRow[], docs: (docs ?? []) as DocRow[],
    events: (events ?? []) as { id: string; text: string; stage: string | null; at: string }[],
  };
}

/** B2B money for one month, in the reporting currency (for Finance). */
export const b2bMonth = cache(async (ym: string) => {
  const sb = supabaseAdmin();
  const fin = await financeSettings();
  const start = `${ym}-01`;
  const [y, m] = ym.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const [{ data: docs }, { data: costs }, list, st] = await Promise.all([
    sb.from('b2b_docs').select('id, order_id, kind, number, issued_on, currency, total, status, data').neq('kind', 'devis').eq('status', 'issued').gte('issued_on', start).lt('issued_on', end),
    sb.from('b2b_costs').select('id, order_id, category, payee, amount, currency, paid_on, note').gte('paid_on', start).lt('paid_on', end),
    b2bOrders(),
    b2bSettings(),
  ]);
  const noRate = new Set<string>();
  const rep = (v: number, c: string) => { const r = toReport(v, c, fin); if (r === null) noRate.add(c); return r ?? 0; };
  let revenue = 0;
  for (const d of (docs ?? []) as DocRow[]) revenue += rep(Number(d.data?.ht ?? d.total) - Number(d.data?.discount ?? 0), d.currency);
  const cats: Record<string, number> = {};
  let spent = 0;
  for (const c of (costs ?? []) as CostRow[]) { const v = rep(Number(c.amount), c.currency); spent += v; cats[c.category] = (cats[c.category] ?? 0) + v; }
  let owed = 0;
  for (const o of list) if (!o.cancelled && o.money.billed > 0 && o.money.billed - o.money.paid > 0.5) owed += rep(o.money.billed - o.money.paid, o.currency);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const done = st.stages[st.stages.length - 1];
  const open = list.filter((o) => !o.cancelled && o.stage !== done);
  const byId = new Map(list.map((o) => [o.id, o]));
  const docRows = ((docs ?? []) as DocRow[]).map((d) => ({
    id: d.id, order_id: d.order_id, number: d.number, kind: d.kind, issued_on: d.issued_on, client: byId.get(d.order_id)?.client ?? d.data?.client?.name ?? '—',
    total: Number(d.total), currency: d.currency, report: toReport(Number(d.data?.ht ?? d.total) - Number(d.data?.discount ?? 0), d.currency, fin),
  })).sort((a, b) => b.issued_on.localeCompare(a.issued_on));
  const costRows = ((costs ?? []) as CostRow[]).map((c) => ({ ...c, amount: Number(c.amount), order: byId.get(c.order_id)?.number ?? '', report: toReport(Number(c.amount), c.currency, fin) })).sort((a, b) => b.paid_on.localeCompare(a.paid_on));
  return {
    docs: docRows, costRows,
    currency: fin.report_currency, revenue: r2(revenue), costs: r2(spent), cats, profit: r2(revenue - spent),
    margin: revenue ? Math.round(((revenue - spent) / revenue) * 100) : null, owed: r2(owed),
    invoices: (docs ?? []).length, open: open.length, noRate: [...noRate],
  };
});
