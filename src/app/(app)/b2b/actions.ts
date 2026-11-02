'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';
import { convert, financeSettings, MONEY_CURRENCIES } from '@/lib/fx';
import { B2B_KINDS, docNumber, INCOTERMS, totals } from '@/lib/b2b';
import { b2bOrderFile, b2bSettings, type DocData } from '@/lib/b2b-data';

// B2B is for the owner, managers and finance (billing.manage), in the back office only.
// Activity entries carry no client (clients can read their own activity, never B2B money).
async function b2b(back: string) {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  if (!ctx.staffRole || !ctx.backOffice || !ctx.can('billing.manage')) redirect(withMsg(back, 'Only the owner, managers and finance can change B2B orders.', 'err'));
  return ctx;
}

const CUR = MONEY_CURRENCIES as readonly string[];
const dateOk = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
const num = (v: string) => {
  if (!v) return null;
  const n = parseFloat(v.replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const txt = (fd: FormData, k: string, max = 200) => str(fd, k).slice(0, max) || null;
const today = () => new Date().toISOString().slice(0, 10);
const orderPath = (id: string) => `/b2b/${id}`;
const uuid = (v: string) => (/^[0-9a-f-]{36}$/i.test(v) ? v : '');

function done(path: string, msg: string): never {
  revalidatePath('/b2b', 'layout');
  revalidatePath('/finance');
  redirect(withMsg(path, msg));
}

async function event(orderId: string, text: string, by: string, stage: string | null = null) {
  await supabaseAdmin().from('b2b_events').insert({ order_id: orderId, text: text.slice(0, 300), stage, by_user: by });
  await supabaseAdmin().from('b2b_orders').update({ updated_at: new Date().toISOString() }).eq('id', orderId);
}

// ---------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------
function clientFields(fd: FormData, back: string) {
  const name = str(fd, 'name').slice(0, 160);
  const country = str(fd, 'country').toUpperCase();
  const currency = str(fd, 'currency') || (country === 'MA' ? 'MAD' : 'USD');
  if (!name) redirect(withMsg(back, 'Write the client’s company name.', 'err'));
  if (!/^[A-Z]{2}$/.test(country)) redirect(withMsg(back, 'Choose the client’s country.', 'err'));
  if (!CUR.includes(currency)) redirect(withMsg(back, 'Choose the currency.', 'err'));
  return {
    name, country, currency, ice: txt(fd, 'ice', 40), vat_number: txt(fd, 'vat', 40), address: txt(fd, 'address', 400), contact: txt(fd, 'contact', 120),
    email: txt(fd, 'email', 160), phone: txt(fd, 'phone', 60), notes: txt(fd, 'notes', 600),
  };
}

export async function saveClient(fd: FormData) {
  const id = uuid(str(fd, 'id'));
  const back = id ? `/b2b/clients?edit=${id}` : '/b2b/clients';
  const ctx = await b2b(back);
  const f = clientFields(fd, back);
  const admin = supabaseAdmin();
  const { error } = id ? await admin.from('b2b_clients').update(f).eq('id', id) : await admin.from('b2b_clients').insert({ ...f, created_by: ctx.userId });
  if (error) redirect(withMsg(back, error.message, 'err'));
  await logActivity(admin, ctx.userId, null, id ? 'b2b_client_saved' : 'b2b_client_added', f.name);
  done('/b2b/clients', id ? `${f.name} saved.` : `${f.name} added.`);
}

export async function archiveClient(fd: FormData) {
  const id = uuid(str(fd, 'id'));
  const ctx = await b2b('/b2b/clients');
  const on = str(fd, 'archive') === '1';
  await supabaseAdmin().from('b2b_clients').update({ archived: on }).eq('id', id);
  await logActivity(supabaseAdmin(), ctx.userId, null, 'b2b_client_saved', on ? 'archived' : 'restored');
  done('/b2b/clients', on ? 'Client archived.' : 'Client restored.');
}

// ---------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------
export async function createOrder(fd: FormData) {
  const back = '/b2b/new';
  const ctx = await b2b(back);
  const admin = supabaseAdmin();
  const title = str(fd, 'title').slice(0, 160);
  if (!title) redirect(withMsg(back, 'Write what the order is (e.g. “Porcelain tiles 60×60”).', 'err'));
  let clientId = uuid(str(fd, 'client'));
  let currency = str(fd, 'currency');
  if (!clientId) {
    // A new client typed on the spot
    const f = clientFields(fd, back);
    const { data, error } = await admin.from('b2b_clients').insert({ ...f, created_by: ctx.userId }).select('id, currency').single();
    if (error) redirect(withMsg(back, error.message, 'err'));
    clientId = data.id;
    currency ||= data.currency;
  } else {
    const { data } = await admin.from('b2b_clients').select('id, currency').eq('id', clientId).maybeSingle();
    if (!data) redirect(withMsg(back, 'Choose the client.', 'err'));
    currency ||= data.currency;
  }
  if (!CUR.includes(currency)) redirect(withMsg(back, 'Choose the currency.', 'err'));
  const st = await b2bSettings();
  const { data: n, error: nErr } = await admin.rpc('b2b_take_number', { p_kind: 'order' });
  if (nErr || typeof n !== 'number') redirect(withMsg(back, nErr?.message ?? 'Couldn’t number the order.', 'err'));
  const number = docNumber('order', n, today());
  const { data: o, error } = await admin.from('b2b_orders').insert({
    number, client_id: clientId, title, stage: st.stages[0], currency, tva_rate: 0,
    incoterm: INCOTERMS.includes(str(fd, 'incoterm') as (typeof INCOTERMS)[number]) ? str(fd, 'incoterm') : null,
    transport: ['sea', 'air', 'rail', 'road', 'express'].includes(str(fd, 'transport')) ? str(fd, 'transport') : null,
    origin: txt(fd, 'origin', 120), destination: txt(fd, 'destination', 120), client_ref: txt(fd, 'client_ref', 80), notes: txt(fd, 'notes', 1000),
    created_by: ctx.userId,
  }).select('id').single();
  if (error) redirect(withMsg(back, error.message, 'err'));
  await event(o.id, `Order created at “${st.stages[0]}”`, ctx.userId, st.stages[0]);
  await logActivity(admin, ctx.userId, null, 'b2b_order_created', number);
  done(`${orderPath(o.id)}#lines`, `${number} created. Add what you sell on it below.`);
}

export async function saveOrder(fd: FormData) {
  const id = uuid(str(fd, 'id'));
  const back = orderPath(id);
  const ctx = await b2b(back);
  const title = str(fd, 'title').slice(0, 160);
  const currency = str(fd, 'currency');
  const tva = num(str(fd, 'tva_rate')) ?? 0;
  const discount = num(str(fd, 'discount')) ?? 0;
  if (!title) redirect(withMsg(back, 'Write what the order is.', 'err'));
  if (!CUR.includes(currency)) redirect(withMsg(back, 'Choose the currency.', 'err'));
  if (tva < 0 || tva > 100) redirect(withMsg(back, 'TVA is a percentage between 0 and 100.', 'err'));
  if (discount < 0) redirect(withMsg(back, 'The discount can’t be negative.', 'err'));
  const etd = dateOk(str(fd, 'etd')), eta = dateOk(str(fd, 'eta'));
  const transport = str(fd, 'transport');
  const { error } = await supabaseAdmin().from('b2b_orders').update({
    title, currency, tva_rate: tva, discount,
    incoterm: txt(fd, 'incoterm', 20), transport: ['sea', 'air', 'rail', 'road', 'express'].includes(transport) ? transport : null,
    origin: txt(fd, 'origin', 120), destination: txt(fd, 'destination', 120), client_ref: txt(fd, 'client_ref', 80),
    container: txt(fd, 'container', 80), carrier: txt(fd, 'carrier', 80), tracking: txt(fd, 'tracking', 300), etd, eta, notes: txt(fd, 'notes', 1000),
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) redirect(withMsg(back, error.message, 'err'));
  await logActivity(supabaseAdmin(), ctx.userId, null, 'b2b_order_saved', title);
  done(back, 'Order details saved.');
}

export async function setStage(fd: FormData) {
  const id = uuid(str(fd, 'id'));
  const back = orderPath(id);
  const ctx = await b2b(back);
  const admin = supabaseAdmin();
  const { data: o } = await admin.from('b2b_orders').select('number, stage, cancelled').eq('id', id).maybeSingle();
  if (!o) redirect(withMsg('/b2b', 'That order no longer exists.', 'err'));
  if (fd.get('cancel')) {
    const on = str(fd, 'cancel') === '1';
    await admin.from('b2b_orders').update({ cancelled: on }).eq('id', id);
    await event(id, on ? 'Order cancelled' : 'Order reopened', ctx.userId);
    await logActivity(admin, ctx.userId, null, 'b2b_stage', `${o.number} · ${on ? 'cancelled' : 'reopened'}`);
    done(back, on ? 'Order cancelled.' : 'Order reopened.');
  }
  const stage = str(fd, 'stage');
  const st = await b2bSettings();
  if (!st.stages.includes(stage)) redirect(withMsg(back, 'Choose one of your stages.', 'err'));
  if (stage === o.stage) done(back, `Already at “${stage}”.`);
  await admin.from('b2b_orders').update({ stage, cancelled: false }).eq('id', id);
  const note = str(fd, 'note').slice(0, 200);
  await event(id, `${o.stage} → ${stage}${note ? ` · ${note}` : ''}`, ctx.userId, stage);
  await logActivity(admin, ctx.userId, null, 'b2b_stage', `${o.number} · ${stage}`);
  done(back, `Moved to “${stage}”.`);
}

export async function addNote(fd: FormData) {
  const id = uuid(str(fd, 'id'));
  const back = `${orderPath(id)}#story`;
  const ctx = await b2b(back);
  const text = str(fd, 'text').slice(0, 300);
  if (!text) redirect(withMsg(back, 'Write the note first.', 'err'));
  await event(id, text, ctx.userId);
  done(back, 'Note added.');
}

// ---------------------------------------------------------------------
// Lines (what we sell)
// ---------------------------------------------------------------------
export async function saveLine(fd: FormData) {
  const orderId = uuid(str(fd, 'order'));
  const lineId = uuid(str(fd, 'line'));
  const back = `${orderPath(orderId)}#lines`;
  const ctx = await b2b(back);
  const admin = supabaseAdmin();
  const { data: o } = await admin.from('b2b_orders').select('currency').eq('id', orderId).maybeSingle();
  if (!o) redirect(withMsg('/b2b', 'That order no longer exists.', 'err'));
  const kind = str(fd, 'kind');
  const description = str(fd, 'description').slice(0, 200);
  if (!(B2B_KINDS as readonly string[]).includes(kind)) redirect(withMsg(back, 'Choose what the line is.', 'err'));
  if (!description) redirect(withMsg(back, 'Write the description.', 'err'));
  const priceAs = str(fd, 'price_as'); // a currency code, or '%'
  const qty = num(str(fd, 'qty'));
  if (qty !== null && !(qty > 0)) redirect(withMsg(back, 'The quantity must be more than 0 (or leave it empty for a flat amount).', 'err'));
  let row: Record<string, unknown>;
  if (priceAs === '%') {
    const pct = num(str(fd, 'price'));
    if (pct === null || pct < 0 || pct > 1000) redirect(withMsg(back, 'Write the percentage (e.g. 20 for 20%).', 'err'));
    row = { pct, unit_price: null, price_currency: null, rate: 1, qty: null };
  } else {
    if (!CUR.includes(priceAs)) redirect(withMsg(back, 'Choose the currency of the price.', 'err'));
    const price = num(str(fd, 'price'));
    if (price === null || price < 0) redirect(withMsg(back, 'Write the unit price.', 'err'));
    let rate = num(str(fd, 'rate'));
    if (priceAs === o.currency) rate = 1;
    if (rate === null) rate = convert(1, priceAs, o.currency, await financeSettings());
    if (rate === null || !(rate > 0)) redirect(withMsg(back, `No exchange rate from ${priceAs} to ${o.currency}: type the rate on the line, or add it in Finance settings.`, 'err'));
    row = { pct: null, unit_price: price, price_currency: priceAs, rate: Math.round(rate * 1e6) / 1e6, qty };
  }
  const fields = { ...row, kind, description, hs_code: txt(fd, 'hs_code', 20), unit: txt(fd, 'unit', 20) };
  if (lineId) {
    const { error } = await admin.from('b2b_lines').update(fields).eq('id', lineId).eq('order_id', orderId);
    if (error) redirect(withMsg(back, error.message, 'err'));
  } else {
    const { data: last } = await admin.from('b2b_lines').select('position').eq('order_id', orderId).order('position', { ascending: false }).limit(1).maybeSingle();
    const { error } = await admin.from('b2b_lines').insert({ ...fields, order_id: orderId, position: (last?.position ?? 0) + 1 });
    if (error) redirect(withMsg(back, error.message, 'err'));
  }
  await admin.from('b2b_orders').update({ updated_at: new Date().toISOString() }).eq('id', orderId);
  await logActivity(admin, ctx.userId, null, 'b2b_order_saved', description);
  done(back, lineId ? 'Line saved.' : 'Line added.');
}

export async function deleteLine(fd: FormData) {
  const orderId = uuid(str(fd, 'order'));
  const back = `${orderPath(orderId)}#lines`;
  await b2b(back);
  await supabaseAdmin().from('b2b_lines').delete().eq('id', uuid(str(fd, 'line'))).eq('order_id', orderId);
  done(back, 'Line removed.');
}

export async function moveLine(fd: FormData) {
  const orderId = uuid(str(fd, 'order'));
  const back = `${orderPath(orderId)}#lines`;
  await b2b(back);
  const admin = supabaseAdmin();
  const { data } = await admin.from('b2b_lines').select('id, position').eq('order_id', orderId).order('position');
  const list = data ?? [];
  const i = list.findIndex((l) => l.id === str(fd, 'line'));
  const j = i + (str(fd, 'dir') === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) done(back, 'Order unchanged.');
  [list[i], list[j]] = [list[j], list[i]];
  await Promise.all(list.map((l, k) => admin.from('b2b_lines').update({ position: k + 1 }).eq('id', l.id)));
  done(back, 'Line moved.');
}

// ---------------------------------------------------------------------
// Costs and payments
// ---------------------------------------------------------------------
export async function addCost(fd: FormData) {
  const orderId = uuid(str(fd, 'order'));
  const back = `${orderPath(orderId)}#money`;
  const ctx = await b2b(back);
  const category = str(fd, 'category');
  const amount = num(str(fd, 'amount'));
  const currency = str(fd, 'currency');
  const paid_on = dateOk(str(fd, 'date'));
  const payee = str(fd, 'payee').slice(0, 120);
  if (!(B2B_KINDS as readonly string[]).includes(category)) redirect(withMsg(back, 'Choose what the cost is for.', 'err'));
  if (!payee) redirect(withMsg(back, 'Write who was paid (factory, forwarder…).', 'err'));
  if (!(amount && amount > 0)) redirect(withMsg(back, 'Write the amount paid.', 'err'));
  if (!CUR.includes(currency)) redirect(withMsg(back, 'Choose the currency.', 'err'));
  if (!paid_on) redirect(withMsg(back, 'Choose the date it was paid.', 'err'));
  const { error } = await supabaseAdmin().from('b2b_costs').insert({ order_id: orderId, category, payee, amount: Math.round(amount * 100) / 100, currency, paid_on, note: txt(fd, 'note', 300), created_by: ctx.userId });
  if (error) redirect(withMsg(back, error.message, 'err'));
  await event(orderId, `Cost: ${payee} ${amount.toLocaleString('en')} ${currency}`, ctx.userId);
  await logActivity(supabaseAdmin(), ctx.userId, null, 'b2b_cost', payee);
  done(back, 'Cost added.');
}

export async function deleteCost(fd: FormData) {
  const orderId = uuid(str(fd, 'order'));
  const back = `${orderPath(orderId)}#money`;
  await b2b(back);
  await supabaseAdmin().from('b2b_costs').delete().eq('id', uuid(str(fd, 'cost'))).eq('order_id', orderId);
  done(back, 'Cost removed.');
}

export async function addPayment(fd: FormData) {
  const orderId = uuid(str(fd, 'order'));
  const back = `${orderPath(orderId)}#money`;
  const ctx = await b2b(back);
  const { data: o } = await supabaseAdmin().from('b2b_orders').select('currency').eq('id', orderId).maybeSingle();
  if (!o) redirect(withMsg('/b2b', 'That order no longer exists.', 'err'));
  const amount = num(str(fd, 'amount'));
  const paid_on = dateOk(str(fd, 'date'));
  const method = ['bank', 'cash', 'cheque', 'other'].includes(str(fd, 'method')) ? str(fd, 'method') : 'bank';
  if (!(amount && amount > 0)) redirect(withMsg(back, 'Write the amount received.', 'err'));
  if (!paid_on) redirect(withMsg(back, 'Choose the date it was received.', 'err'));
  const { error } = await supabaseAdmin().from('b2b_payments').insert({ order_id: orderId, amount: Math.round(amount * 100) / 100, currency: o.currency, paid_on, method, note: txt(fd, 'note', 300), created_by: ctx.userId });
  if (error) redirect(withMsg(back, error.message, 'err'));
  await event(orderId, `Payment received: ${amount.toLocaleString('en')} ${o.currency} (${method})`, ctx.userId);
  await logActivity(supabaseAdmin(), ctx.userId, null, 'b2b_payment', `${amount} ${o.currency}`);
  done(back, 'Payment recorded.');
}

export async function deletePayment(fd: FormData) {
  const orderId = uuid(str(fd, 'order'));
  const back = `${orderPath(orderId)}#money`;
  await b2b(back);
  await supabaseAdmin().from('b2b_payments').delete().eq('id', uuid(str(fd, 'payment'))).eq('order_id', orderId);
  done(back, 'Payment removed.');
}

// ---------------------------------------------------------------------
// Documents: devis, facture (Morocco), invoice (abroad). Frozen when issued.
// ---------------------------------------------------------------------
export async function issueDoc(fd: FormData) {
  const orderId = uuid(str(fd, 'order'));
  const back = `${orderPath(orderId)}#docs`;
  const ctx = await b2b(back);
  const file = await b2bOrderFile(orderId);
  if (!file || !file.client) redirect(withMsg('/b2b', 'That order no longer exists.', 'err'));
  const { order: o, client, lines, pays } = file;
  if (!lines.length) redirect(withMsg(back, 'Add at least one line before making a document.', 'err'));
  const st = await b2bSettings();
  const morocco = client.country === 'MA';
  const want = str(fd, 'kind'); // 'devis' | 'final'
  const kind: 'devis' | 'facture' | 'invoice' = want === 'devis' ? 'devis' : morocco ? 'facture' : 'invoice';
  const tplIn = str(fd, 'template');
  const template: 'ma' | 'a' | 'b' = morocco ? 'ma' : tplIn === 'a' || tplIn === 'b' ? tplIn : st.intl_template;
  const issued_on = dateOk(str(fd, 'date')) ?? today();
  const due = num(str(fd, 'due_days'));
  const due_on = due && due > 0 ? new Date(Date.parse(`${issued_on}T00:00:00Z`) + due * 864e5).toISOString().slice(0, 10) : null;
  const t = totals(lines, Number(o.tva_rate), Number(o.discount));
  if (!(t.ttc > 0)) redirect(withMsg(back, 'The total is 0: check the lines.', 'err'));
  const paid = Math.round(pays.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100;
  const data: DocData = {
    client: { name: client.name, country: client.country, ice: client.ice, vat_number: client.vat_number, address: client.address },
    order: { number: o.number, title: o.title, client_ref: o.client_ref, incoterm: o.incoterm, transport: o.transport, origin: o.origin, destination: o.destination, container: o.container, carrier: o.carrier, etd: o.etd, eta: o.eta },
    lines: lines.map((l, i) => ({ kind: l.kind, description: l.description, hs_code: l.hs_code ?? null, qty: l.qty, unit: l.unit ?? null, unit_price: l.unit_price, price_currency: l.price_currency ?? null, pct: l.pct, amount: t.amounts[i] })),
    ht: t.ht, tva_rate: Number(o.tva_rate), tva: t.tva, discount: t.discount, ttc: t.ttc,
    paid: kind === 'devis' ? 0 : paid, balance: kind === 'devis' ? t.ttc : Math.round((t.ttc - paid) * 100) / 100,
    payments: kind === 'devis' ? [] : pays.map((p) => ({ paid_on: p.paid_on, amount: Number(p.amount), method: p.method })),
    bank: st.bank[o.currency] ?? null, email: st.email,
  };
  const admin = supabaseAdmin();
  const counter = kind === 'devis' && !morocco ? 'devis' : kind;
  const { data: n, error: nErr } = await admin.rpc('b2b_take_number', { p_kind: counter });
  if (nErr || typeof n !== 'number') redirect(withMsg(back, nErr?.message ?? 'Couldn’t number the document.', 'err'));
  const number = docNumber(kind, n, issued_on, !morocco);
  const { data: doc, error } = await admin.from('b2b_docs').insert({ order_id: orderId, kind, template, number, issued_on, due_on, currency: o.currency, total: t.ttc, data, created_by: ctx.userId }).select('id').single();
  if (error) redirect(withMsg(back, error.message, 'err'));
  const label = kind === 'devis' ? (morocco ? 'Devis' : 'Quotation') : kind === 'facture' ? 'Facture' : 'Invoice';
  await event(orderId, `${label} ${number} issued`, ctx.userId);
  await logActivity(admin, ctx.userId, null, 'b2b_doc', `${label} ${number}`);
  revalidatePath('/b2b', 'layout');
  redirect(withMsg(`/print/b2b/${doc.id}`, `${label} ${number} is ready. Print it or save it as a PDF.`));
}

export async function voidDoc(fd: FormData) {
  const orderId = uuid(str(fd, 'order'));
  const back = `${orderPath(orderId)}#docs`;
  const ctx = await b2b(back);
  const { data: d } = await supabaseAdmin().from('b2b_docs').update({ status: 'void' }).eq('id', uuid(str(fd, 'doc'))).eq('order_id', orderId).select('number').maybeSingle();
  if (d) await event(orderId, `${d.number} cancelled`, ctx.userId);
  done(back, 'Document cancelled. Its number stays used.');
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
export async function saveB2BSettings(fd: FormData) {
  const back = '/b2b/settings';
  const ctx = await b2b(back);
  const stages = Array.from(new Set(str(fd, 'stages').split('\n').map((s) => s.trim().slice(0, 40)).filter(Boolean)));
  if (!stages.length) redirect(withMsg(back, 'Keep at least one stage.', 'err'));
  if (stages.length > 20) redirect(withMsg(back, 'Up to 20 stages.', 'err'));
  const nums: Record<string, number> = {};
  for (const k of ['next_order', 'next_devis', 'next_facture', 'next_invoice']) {
    const v = Math.floor(num(str(fd, k)) ?? 0);
    if (!(v > 0)) redirect(withMsg(back, 'Next numbers must be 1 or more.', 'err'));
    nums[k] = v;
  }
  const bank: Record<string, string> = {};
  for (const c of MONEY_CURRENCIES) { const v = str(fd, `bank_${c}`).slice(0, 400); if (v) bank[c] = v; }
  const admin = supabaseAdmin();
  const { error } = await admin.from('b2b_settings').update({
    stages, ...nums, intl_template: str(fd, 'intl_template') === 'b' ? 'b' : 'a', bank, email: txt(fd, 'email', 160),
    updated_at: new Date().toISOString(), updated_by: ctx.userId,
  }).eq('id', 1);
  if (error) redirect(withMsg(back, error.message, 'err'));
  // Orders at a stage that no longer exists keep it until moved; nothing is lost.
  await logActivity(admin, ctx.userId, null, 'b2b_settings', `${stages.length} stages`);
  done(back, 'B2B settings saved.');
}
