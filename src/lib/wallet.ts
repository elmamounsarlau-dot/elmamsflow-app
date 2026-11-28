import 'server-only';
import { supabaseAdmin } from './supabase/admin';
import { getRateCard, type RateCard } from './billing';
import { priceShipped, SHIP_SEL, shipQuoter, type ShipOrder, type ShipQuote } from './order-shipping';

/**
 * Prepaid balance. A prepaid client tops up first; every shipped order is paid from the balance at the client's
 * own prices. Storage, receiving, duties and the monthly minimum are taken when that month's invoice is issued
 * (the invoice minus what its orders already paid). When the balance can't cover a new order, the order waits
 * ("on hold — top up") and is never sent to the warehouse; a confirmed top-up releases it by itself.
 */

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type TopupMethod = { label: string; details: string };
export type WalletSettings = { methods: TopupMethod[]; min_topup: number; note: string | null };

export async function walletSettings(): Promise<WalletSettings> {
  const { data } = await supabaseAdmin().from('wallet_settings').select('methods, min_topup, note').eq('id', 1).maybeSingle();
  const methods = Array.isArray(data?.methods) ? (data!.methods as TopupMethod[]).filter((m) => m?.label && m?.details) : [];
  return { methods, min_topup: Number(data?.min_topup ?? 100), note: data?.note ?? null };
}

type OrgPay = { id: string; name: string; client_code: string | null; billing_mode: string; credit_limit: number; low_balance: number };
async function orgPay(orgId: string): Promise<OrgPay | null> {
  const { data } = await supabaseAdmin().from('organizations').select('id, name, client_code, billing_mode, credit_limit, low_balance').eq('id', orgId).maybeSingle();
  return data ? { ...data, credit_limit: Number(data.credit_limit) || 0, low_balance: Number(data.low_balance) || 0 } as OrgPay : null;
}

export async function balanceOf(orgId: string) {
  const admin = supabaseAdmin();
  const [{ data: rows }, rates, org] = await Promise.all([
    admin.from('wallet_entries').select('amount, status, kind').eq('org_id', orgId).in('status', ['confirmed', 'pending']),
    getRateCard(orgId),
    orgPay(orgId),
  ]);
  const balance = r2((rows ?? []).filter((r) => r.status === 'confirmed').reduce((a, r) => a + Number(r.amount), 0));
  const pending = r2((rows ?? []).filter((r) => r.status === 'pending').reduce((a, r) => a + Number(r.amount), 0));
  return {
    balance, pending, currency: rates?.currency ?? 'USD', prepaid: org?.billing_mode === 'prepaid',
    creditLimit: org?.credit_limit ?? 0, lowBalance: org?.low_balance ?? 0, hasRates: !!rates,
  };
}

type OrderForCharge = ShipOrder & { id: string; number: string; org_id: string; service: string };

/** What one order costs the client at its price list (fulfilment, packaging, shipping on its line to the gram, DDP
 *  handling). `ship` is the order's shipping price from shipQuoter (null = no price: shipping not included). */
export function orderCharge(o: OrderForCharge, rates: RateCard, ship: ShipQuote | null) {
  const units = o.order_items.reduce((a, i) => a + i.qty, 0);
  const parts = [
    { label: 'Pick & pack', amount: rates.pick_pack_order },
    { label: `Extra items (${Math.max(0, units - 1)})`, amount: Math.max(0, units - 1) * rates.pick_pack_extra_unit },
    { label: 'Packaging', amount: rates.packaging_order },
    { label: ship ? `Shipping · ${ship.line} (${ship.kg} kg)` : 'Shipping', amount: ship?.price ?? 0 },
    { label: 'DDP customs handling', amount: o.service === 'ddp' ? rates.ddp_order : 0 },
  ].map((p) => ({ ...p, amount: r2(p.amount) })).filter((p) => p.amount > 0);
  return { amount: r2(parts.reduce((a, p) => a + p.amount, 0)), parts, kg: ship?.kg ?? 0, units };
}

const ORDER_SEL = `id, number, org_id, service, status, ${SHIP_SEL}`;

/** A charge calculator for one client: prices each order's shipping the same way as the invoice.
 *  strict (the real charge when an order ships): a missing exchange rate stops it (retried later). Not strict (the
 *  balance check before an order goes to the warehouse): it must never fail open, so a missing rate falls back to
 *  the flat rate as an estimate instead of throwing. */
async function charger(orgId: string, rates: RateCard, strict = false) {
  const { quote } = await shipQuoter(orgId, rates.currency, { strict });
  return async (o: OrderForCharge) => orderCharge(o, rates, await quote(o, rates));
}

/** A prepaid client's order has shipped: take it from the balance (once). */
export async function chargeShipped(orderId: string) {
  const admin = supabaseAdmin();
  // Lock the shipping price on the order first (every client, prepaid or not), so the invoice uses the same one.
  await priceShipped(orderId, getRateCard).catch(() => null);
  const { data: o } = await admin.from('orders').select(ORDER_SEL).eq('id', orderId).maybeSingle();
  if (!o || !['shipped', 'delivered'].includes(o.status)) return null;
  const org = await orgPay(o.org_id);
  if (org?.billing_mode !== 'prepaid') return null;
  const rates = await getRateCard(o.org_id);
  if (!rates) return null;
  const c = await (await charger(o.org_id, rates, true))(o as unknown as OrderForCharge);
  if (c.amount <= 0) return null;
  const { error } = await admin.from('wallet_entries').insert({
    org_id: o.org_id, kind: 'charge', amount: -c.amount, currency: rates.currency, order_id: o.id,
    note: `Order #${o.number}`, detail: { parts: c.parts, kg: c.kg, units: c.units },
  });
  if (error && error.code !== '23505') throw new Error(error.message);
  return error ? 'already' : 'charged';
}

/** What this client can still spend on new orders: balance + credit − what its waiting orders will cost. */
async function headroom(orgId: string, exceptOrder?: string) {
  const admin = supabaseAdmin();
  const rates = await getRateCard(orgId);
  if (!rates) return { left: Infinity, rates: null, charge: null };
  const { balance, creditLimit } = await balanceOf(orgId);
  const { data: waiting } = await admin.from('orders').select(ORDER_SEL).eq('org_id', orgId).in('status', ['new', 'packed']);
  const charge = await charger(orgId, rates);
  const costs = await Promise.all((waiting ?? []).filter((w) => w.id !== exceptOrder).map((w) => charge(w as unknown as OrderForCharge)));
  const reserved = costs.reduce((a, c) => a + c.amount, 0);
  return { left: r2(balance + creditLimit - reserved), rates, charge };
}

export const BALANCE_HOLD = 'Balance: top up your balance so this order can ship';

/** A new order of a prepaid client: if the balance can't cover it, it waits (and isn't sent to the warehouse). */
export async function holdIfNoBalance(orderId: string) {
  const admin = supabaseAdmin();
  const { data: o } = await admin.from('orders').select(ORDER_SEL).eq('id', orderId).maybeSingle();
  if (!o || o.status !== 'new') return false;
  const org = await orgPay(o.org_id);
  if (org?.billing_mode !== 'prepaid') return false;
  const { left, rates, charge } = await headroom(o.org_id, o.id);
  if (!rates || !charge) return false;
  const need = (await charge(o as unknown as OrderForCharge)).amount;
  if (left - need >= 0) return false;
  await admin.from('orders').update({ status: 'on_hold', hold_reason: BALANCE_HOLD }).eq('id', o.id).eq('status', 'new');
  await admin.from('activity_log').insert({ org_id: o.org_id, action: 'order_held', detail: `#${o.number} · waiting for a top-up (balance too low)` });
  return true;
}

/** After a top-up: release waiting orders, oldest first, as far as the balance goes. Returns their ids. */
export async function releaseBalanceHolds(orgId: string) {
  const admin = supabaseAdmin();
  const { data: held } = await admin.from('orders').select(ORDER_SEL).eq('org_id', orgId).eq('status', 'on_hold').eq('hold_kind', 'balance').order('created_at');
  if (!held?.length) return [] as string[];
  const room = await headroom(orgId);
  const charge = room.charge;
  let left = room.left;
  if (!room.rates || !charge) return [];
  const out: string[] = [];
  for (const o of held) {
    const need = (await charge(o as unknown as OrderForCharge)).amount;
    if (left - need < 0) break;
    const { data: done } = await admin.from('orders').update({ status: 'new', hold_reason: null }).eq('id', o.id).eq('status', 'on_hold').select('id').maybeSingle();
    if (done) { out.push(o.id); left = r2(left - need); }
  }
  if (out.length) await admin.from('activity_log').insert({ org_id: orgId, action: 'order_released', detail: `${out.length} order${out.length === 1 ? '' : 's'} released after a top-up` });
  return out;
}

/** The client says it sent money. Waits for us to see it arrive. */
export async function requestTopup(orgId: string, amount: number, method: string, note: string | null, by: string) {
  const org = await orgPay(orgId);
  const rates = await getRateCard(orgId);
  if (!org || !rates) return { error: 'Your price list isn’t set up yet. Please contact us.' };
  const s = await walletSettings();
  if (!(amount >= s.min_topup) || amount > 1_000_000) return { error: `The minimum top-up is ${s.min_topup} ${rates.currency}.` };
  if (!s.methods.some((m) => m.label === method)) return { error: 'Choose how you sent the money.' };
  const code = org.client_code ?? 'EMF';
  const ref = `${code}-TOP-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const { data, error } = await supabaseAdmin().from('wallet_entries').insert({
    org_id: orgId, kind: 'topup', amount: r2(amount), currency: rates.currency, status: 'pending', method, ref, note: note?.slice(0, 300) || null, created_by: by,
  }).select('id, ref').single();
  if (error || !data) return { error: error?.message ?? 'Could not save it.' };
  await supabaseAdmin().from('activity_log').insert({ org_id: orgId, user_id: by, action: 'topup_requested', detail: `${data.ref} · ${r2(amount)} ${rates.currency} by ${method}` });
  return { ok: true, ref: data.ref as string, id: data.id as string };
}

/** We saw the money arrive (or not). A confirmed top-up releases orders that were waiting. */
export async function decideTopup(entryId: string, ok: boolean, by: string, amount?: number) {
  const admin = supabaseAdmin();
  const { data: e } = await admin.from('wallet_entries').select('id, org_id, amount, currency, ref, status').eq('id', entryId).eq('kind', 'topup').maybeSingle();
  if (!e || e.status !== 'pending') return { error: 'This top-up was already handled.' };
  const patch: Record<string, unknown> = { status: ok ? 'confirmed' : 'rejected', confirmed_by: by, confirmed_at: new Date().toISOString() };
  // The amount that really arrived (bank fees can make it a bit less than announced).
  if (ok && amount && amount > 0 && amount !== Number(e.amount)) patch.amount = r2(amount);
  const { error } = await admin.from('wallet_entries').update(patch).eq('id', e.id).eq('status', 'pending');
  if (error) return { error: error.message };
  await admin.from('activity_log').insert({ org_id: e.org_id, user_id: by, action: ok ? 'topup_confirmed' : 'topup_rejected', detail: `${e.ref} · ${patch.amount ?? e.amount} ${e.currency}` });
  const released = ok ? await releaseBalanceHolds(e.org_id) : [];
  return { ok: true, released };
}

/** A correction by us: + adds to the balance, − takes from it. */
export async function adjustWallet(orgId: string, amount: number, note: string, by: string) {
  const rates = await getRateCard(orgId);
  if (!rates) return { error: 'This client has no price list yet.' };
  if (!amount || !note.trim()) return { error: 'Write an amount and a reason.' };
  const { error } = await supabaseAdmin().from('wallet_entries').insert({ org_id: orgId, kind: 'adjust', amount: r2(amount), currency: rates.currency, note: note.slice(0, 300), created_by: by });
  if (error) return { error: error.message };
  await supabaseAdmin().from('activity_log').insert({ org_id: orgId, user_id: by, action: 'wallet_adjusted', detail: `${amount > 0 ? '+' : ''}${r2(amount)} ${rates.currency} · ${note.slice(0, 120)}` });
  const released = amount > 0 ? await releaseBalanceHolds(orgId) : [];
  return { ok: true, released };
}

/**
 * A prepaid client's monthly invoice was issued: take the part its orders didn't already pay (storage, receiving,
 * duties, monthly minimum) from the balance, and mark the invoice paid.
 */
export async function payInvoiceFromWallet(invoiceId: string, by: string | null) {
  const admin = supabaseAdmin();
  const { data: inv } = await admin.from('invoices').select('id, number, org_id, total, currency, status, period_start, period_end').eq('id', invoiceId).maybeSingle();
  if (!inv || inv.status !== 'open') return null;
  const org = await orgPay(inv.org_id);
  if (org?.billing_mode !== 'prepaid') return null;
  const { data: charged } = await admin.from('wallet_entries').select('amount, orders!inner(shipped_at)').eq('org_id', inv.org_id).eq('kind', 'charge')
    .gte('orders.shipped_at', `${inv.period_start}T00:00:00Z`).lte('orders.shipped_at', `${inv.period_end}T23:59:59Z`);
  const already = r2(-(charged ?? []).reduce((a, c) => a + Number(c.amount), 0));
  const rest = r2(Number(inv.total) - already);
  if (rest > 0) {
    const { error } = await admin.from('wallet_entries').insert({ org_id: inv.org_id, kind: 'invoice', amount: -rest, currency: inv.currency, invoice_id: inv.id, note: `Invoice ${inv.number} (storage, receiving and other monthly charges)`, created_by: by });
    if (error && error.code !== '23505') throw new Error(error.message);
  }
  await admin.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString(), paid_method: 'other', paid_ref: 'Prepaid balance' }).eq('id', inv.id).eq('status', 'open');
  return { rest, already };
}

export const WALLET_KIND: Record<string, string> = { topup: 'Top-up', charge: 'Order', invoice: 'Monthly charges', adjust: 'Adjustment', refund: 'Refund' };
