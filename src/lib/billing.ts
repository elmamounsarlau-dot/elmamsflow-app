import 'server-only';
import { supabaseAdmin } from './supabase/admin';

export type Currency = 'USD' | 'EUR' | 'GBP';
export const CURRENCIES: Currency[] = ['USD', 'EUR', 'GBP'];

export type RateCard = {
  org_id: string;
  currency: Currency;
  pick_pack_order: number;
  pick_pack_extra_unit: number;
  packaging_order: number;
  shipping_base: number;
  shipping_per_kg: number;
  ddp_order: number;
  receiving_carton: number;
  receiving_unit: number;
  storage_unit_month: number;
  monthly_minimum: number;
  payment_terms_days: number;
};

/** The price list fields, in the order shown, with what each one means. */
export const RATE_FIELDS: { key: keyof RateCard; label: string; unit: string; group: string; step: string }[] = [
  { key: 'pick_pack_order', label: 'Pick & pack', unit: 'per order', group: 'Fulfillment', step: '0.01' },
  { key: 'pick_pack_extra_unit', label: 'Extra item', unit: 'per extra item in an order', group: 'Fulfillment', step: '0.01' },
  { key: 'packaging_order', label: 'Packaging', unit: 'per order (box or mailer)', group: 'Fulfillment', step: '0.01' },
  { key: 'shipping_base', label: 'Shipping', unit: 'per parcel', group: 'Shipping', step: '0.01' },
  { key: 'shipping_per_kg', label: 'Shipping weight', unit: 'per kg', group: 'Shipping', step: '0.01' },
  { key: 'ddp_order', label: 'DDP customs handling', unit: 'per DDP order', group: 'Shipping', step: '0.01' },
  { key: 'receiving_carton', label: 'Receiving', unit: 'per carton', group: 'Receiving & storage', step: '0.01' },
  { key: 'receiving_unit', label: 'Counting in', unit: 'per unit', group: 'Receiving & storage', step: '0.001' },
  { key: 'storage_unit_month', label: 'Storage', unit: 'per unit per month', group: 'Receiving & storage', step: '0.001' },
  { key: 'monthly_minimum', label: 'Monthly minimum', unit: 'per month', group: 'Terms', step: '0.01' },
];

export const CATEGORY: Record<string, string> = {
  fulfillment: 'Fulfillment',
  packaging: 'Packaging materials',
  shipping: 'Transportation',
  customs: 'Customs & DDP',
  receiving: 'Receiving',
  storage: 'Storage',
  other: 'Other',
};

export type Line = { category: string; description: string; qty: number; unit_price: number; amount: number };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function money(n: number, c: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD' }).format(Number(n) || 0);
}

export async function getRateCard(orgId: string): Promise<RateCard | null> {
  const { data } = await supabaseAdmin().from('rate_cards').select('*').eq('org_id', orgId).maybeSingle();
  if (!data) return null;
  const out = { ...data } as Record<string, unknown>;
  for (const f of RATE_FIELDS) out[f.key] = Number(out[f.key]) || 0;
  out.payment_terms_days = Number(out.payment_terms_days) || 14;
  return out as RateCard;
}

const ON_HAND = new Set(['inbound', 'order', 'adjust', 'count']);

/** Billable weight: each parcel is charged by its weight rounded UP to the next full kilogram
 *  (a 300 g parcel is 1 kg, 1.2 kg is 2 kg). Parcels with no weight at all are counted separately. */
export function billableKg(parcelGrams: number[]) {
  let kg = 0;
  let unknown = 0;
  for (const g of parcelGrams) {
    if (!(g > 0)) { unknown++; continue; }
    kg += Math.ceil(g / 1000);
  }
  return { kg, unknown, actualKg: Math.round(parcelGrams.reduce((a, g) => a + Math.max(0, g || 0), 0)) / 1000 };
}

/** Everything a client is charged for between `start` (included) and `end` (excluded), from what really happened. */
export async function computeCharges(orgId: string, rates: RateCard, start: Date, end: Date) {
  const admin = supabaseAdmin();
  const s = start.toISOString();
  const e = end.toISOString();
  // Supabase returns at most 1,000 rows per request, so read in pages.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = async (make: () => any) => {
    const out: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await make().range(from, from + 999);
      // Never bill from partial data: a failed read stops the invoice instead of silently under-charging.
      if (error) throw new Error(`Could not read the data for this invoice: ${error.message}`);
      if (!data?.length) break;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  };
  const [orders, inbounds, moves] = await Promise.all([
    all(() => admin.from('orders').select('id, weight_g, service, order_items(qty, products(weight_g))').eq('org_id', orgId).gte('shipped_at', s).lt('shipped_at', e).order('shipped_at')),
    all(() => admin.from('inbounds').select('id, cartons, inbound_items(received)').eq('org_id', orgId).eq('status', 'received').gte('received_at', s).lt('received_at', e).order('received_at')),
    all(() => admin.from('stock_moves').select('qty, type, created_at').eq('org_id', orgId).lt('created_at', e).order('created_at').order('id')),
  ]);

  type O = { weight_g: number; service: string; order_items: { qty: number; products: { weight_g: number } | null }[] };
  const os = orders as O[];
  const nOrders = os.length;
  const units = os.reduce((a, o) => a + o.order_items.reduce((b, i) => b + i.qty, 0), 0);
  const extra = Math.max(0, units - nOrders);
  // Parcel weight: what the warehouse weighed, otherwise the products' weights.
  const parcels = os.map((o) => o.weight_g || o.order_items.reduce((b, i) => b + i.qty * (i.products?.weight_g ?? 0), 0));
  const w = billableKg(parcels);
  const kg = w.kg;
  const ddp = os.filter((o) => o.service === 'ddp').length;

  type I = { cartons: number; inbound_items: { received: number }[] };
  const ins = inbounds as I[];
  const cartons = ins.reduce((a, b) => a + (b.cartons || 0), 0);
  const unitsIn = ins.reduce((a, b) => a + b.inbound_items.reduce((x, i) => x + i.received, 0), 0);

  // Storage: units on hand at the end of each day, summed (unit-days), charged as a 30-day month.
  const ms = (moves as { qty: number; type: string; created_at: string }[]).filter((m) => ON_HAND.has(m.type));
  let bal = 0;
  let i = 0;
  while (i < ms.length && ms[i].created_at < s) bal += ms[i++].qty;
  let unitDays = 0;
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 864e5));
  for (let d = 1; d <= days; d++) {
    const dayEnd = new Date(start.getTime() + d * 864e5).toISOString();
    while (i < ms.length && ms[i].created_at < dayEnd) bal += ms[i++].qty;
    unitDays += Math.max(0, bal);
  }
  const unitMonths = r3(unitDays / 30);

  const lines: Line[] = [];
  const add = (category: string, description: string, qty: number, unit: number) => {
    if (!qty || !unit) return;
    lines.push({ category, description, qty: r3(qty), unit_price: unit, amount: r2(qty * unit) });
  };
  add('fulfillment', `Pick & pack · ${nOrders} order${nOrders === 1 ? '' : 's'}`, nOrders, rates.pick_pack_order);
  add('fulfillment', `Extra items picked · ${extra} unit${extra === 1 ? '' : 's'}`, extra, rates.pick_pack_extra_unit);
  add('packaging', `Packaging · ${nOrders} parcel${nOrders === 1 ? '' : 's'}`, nOrders, rates.packaging_order);
  add('shipping', `Shipping · ${nOrders} parcel${nOrders === 1 ? '' : 's'}`, nOrders, rates.shipping_base);
  add('shipping', `Shipping weight · ${kg.toLocaleString('en')} kg billed (each parcel rounded up to the full kg; ${w.actualKg.toLocaleString('en')} kg actual)${w.unknown ? ` · ${w.unknown} parcel${w.unknown === 1 ? '' : 's'} without a weight not included` : ''}`, kg, rates.shipping_per_kg);
  add('customs', `DDP customs handling · ${ddp} order${ddp === 1 ? '' : 's'}`, ddp, rates.ddp_order);
  add('receiving', `Receiving · ${cartons} carton${cartons === 1 ? '' : 's'} on ${ins.length} inbound${ins.length === 1 ? '' : 's'}`, cartons, rates.receiving_carton);
  add('receiving', `Counting in · ${unitsIn.toLocaleString('en')} units`, unitsIn, rates.receiving_unit);
  add('storage', `Storage · avg ${Math.round(unitDays / days).toLocaleString('en')} units over ${days} day${days === 1 ? '' : 's'}`, unitMonths, rates.storage_unit_month);
  const subtotal = r2(lines.reduce((a, l) => a + l.amount, 0));
  if (rates.monthly_minimum > subtotal && days >= 28) add('other', 'Monthly minimum top-up', 1, r2(rates.monthly_minimum - subtotal));
  const total = r2(lines.reduce((a, l) => a + l.amount, 0));
  return { lines, total, stats: { orders: nOrders, units, kg, kgActual: w.actualKg, noWeight: w.unknown, ddp, cartons, unitsIn, avgStored: Math.round(unitDays / days) } };
}

/** First day of a month (UTC) and the first day of the next one. */
export function monthBounds(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start, end, label: new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(start) };
}

export const ymOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
export const lastMonth = () => ymOf(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)));

/** Create the draft invoice for one client and month (or return the one that already exists). */
export async function draftInvoice(orgId: string, ym: string, by: string | null) {
  const admin = supabaseAdmin();
  const { start, end } = monthBounds(ym);
  const periodStart = start.toISOString().slice(0, 10);
  const { data: existing } = await admin.from('invoices').select('id, status').eq('org_id', orgId).eq('period_start', periodStart).neq('status', 'void').maybeSingle();
  if (existing) return { id: existing.id as string, created: false };
  const rates = await getRateCard(orgId);
  if (!rates) return { error: 'This client has no price list yet.' };
  let charges: Awaited<ReturnType<typeof computeCharges>>;
  try {
    charges = await computeCharges(orgId, rates, start, end);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const { lines, total } = charges;
  const { data: inv, error } = await admin.from('invoices').insert({
    org_id: orgId, period_start: periodStart, period_end: new Date(end.getTime() - 864e5).toISOString().slice(0, 10),
    currency: rates.currency, status: 'draft', total, created_by: by,
  }).select('id').single();
  if (error || !inv) return { error: error?.message ?? 'Could not create the invoice.' };
  if (lines.length) {
    const { error: le } = await admin.from('invoice_lines').insert(lines.map((l, i) => ({ ...l, invoice_id: inv.id, position: i })));
    if (le) {
      await admin.from('invoices').delete().eq('id', inv.id);
      return { error: `Could not save the invoice lines: ${le.message}` };
    }
  }
  return { id: inv.id as string, created: true };
}

/** Recalculate a draft's total from its lines. */
export async function retotal(invoiceId: string) {
  const admin = supabaseAdmin();
  const { data } = await admin.from('invoice_lines').select('amount').eq('invoice_id', invoiceId);
  const total = r2((data ?? []).reduce((a, l) => a + Number(l.amount), 0));
  await admin.from('invoices').update({ total }).eq('id', invoiceId);
  return total;
}

export const isOverdue = (i: { status: string; due_date: string | null }) => i.status === 'open' && !!i.due_date && i.due_date < new Date().toISOString().slice(0, 10);

export const INVOICE_STATUS: Record<string, [string, string]> = {
  draft: ['Draft', 'mute'],
  open: ['Open', 'go'],
  overdue: ['Overdue', 'err'],
  paid: ['Paid', 'ok'],
  void: ['Void', 'mute'],
};

export const stripeReady = () => !!process.env.STRIPE_SECRET_KEY;
