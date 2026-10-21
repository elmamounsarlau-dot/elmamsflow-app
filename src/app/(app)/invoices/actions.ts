'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { logActivity } from '@/lib/log';
import { siteUrl, str, withMsg } from '@/lib/format';
import { CURRENCIES, draftInvoice, getRateCard, lastMonth, money, RATE_FIELDS, retotal, stripeReady } from '@/lib/billing';

async function billing(back: string) {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  if (!ctx.staffRole || !ctx.can('billing.manage')) redirect(withMsg(back, 'Only Elmamsflow billing can do that.', 'err'));
  return ctx;
}

async function invoiceFor(id: string) {
  const { data } = await supabaseAdmin().from('invoices').select('*').eq('id', id).maybeSingle();
  return data;
}

const ymOk = (v: string) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : lastMonth());

// ---------- Price list ----------

export async function saveRateCard(fd: FormData) {
  const org = str(fd, 'org');
  const back = `/clients/${org}#prices`;
  const ctx = await billing(back);
  const row: Record<string, unknown> = { org_id: org, updated_by: ctx.userId, updated_at: new Date().toISOString() };
  const cur = str(fd, 'currency');
  row.currency = CURRENCIES.includes(cur as never) ? cur : 'USD';
  for (const f of RATE_FIELDS) row[f.key] = Math.max(0, parseFloat(str(fd, f.key)) || 0);
  row.payment_terms_days = Math.min(90, Math.max(0, parseInt(str(fd, 'payment_terms_days'), 10) || 14));
  const { error } = await supabaseAdmin().from('rate_cards').upsert(row, { onConflict: 'org_id' });
  await logActivity(supabaseAdmin(), ctx.userId, org, 'prices_saved', `${row.currency}`);
  redirect(withMsg(back, error ? error.message : 'Price list saved. New charges use it straight away.', error ? 'err' : 'ok'));
}

// ---------- Creating and editing invoices ----------

export async function createInvoice(fd: FormData) {
  const org = str(fd, 'org');
  const ym = ymOk(str(fd, 'month'));
  const ctx = await billing('/invoices');
  const r = await draftInvoice(org, ym, ctx.userId);
  if ('error' in r) redirect(withMsg(org ? `/clients/${org}#prices` : '/invoices', r.error!, 'err'));
  if (r.created) await logActivity(supabaseAdmin(), ctx.userId, org, 'invoice_drafted', ym);
  redirect(withMsg(`/invoices/${r.id}`, r.created ? 'Draft ready. Check the lines, then issue it.' : 'This month already has an invoice.'));
}

export async function createAllInvoices(fd: FormData) {
  const ym = ymOk(str(fd, 'month'));
  const ctx = await billing('/invoices');
  const admin = supabaseAdmin();
  const { data: cards } = await admin.from('rate_cards').select('org_id, organizations!inner(status, kind)').eq('organizations.kind', 'client');
  let made = 0;
  for (const c of (cards ?? []) as unknown as { org_id: string }[]) {
    const r = await draftInvoice(c.org_id, ym, ctx.userId);
    if ('created' in r && r.created) made++;
  }
  await logActivity(admin, ctx.userId, null, 'invoice_drafted', `${made} drafts for ${ym}`);
  redirect(withMsg('/invoices?t=draft', made ? `${made} draft invoice${made === 1 ? '' : 's'} created. Review and issue them.` : 'Every client with a price list already has an invoice for that month.'));
}

export async function recalcDraft(fd: FormData) {
  const id = str(fd, 'id');
  const ctx = await billing(`/invoices/${id}`);
  const inv = await invoiceFor(id);
  if (!inv || inv.status !== 'draft') redirect(withMsg(`/invoices/${id}`, 'Only drafts can be recalculated.', 'err'));
  const admin = supabaseAdmin();
  await admin.from('invoices').update({ status: 'void', notes: 'Replaced by a recalculated draft' }).eq('id', id);
  const r = await draftInvoice(inv.org_id, inv.period_start.slice(0, 7), ctx.userId);
  if ('error' in r) {
    await admin.from('invoices').update({ status: 'draft', notes: inv.notes }).eq('id', id);
    redirect(withMsg(`/invoices/${id}`, r.error!, 'err'));
  }
  await admin.from('invoices').delete().eq('id', id);
  redirect(withMsg(`/invoices/${r.id}`, 'Recalculated from the latest orders, inbounds and stock.'));
}

export async function addLine(fd: FormData) {
  const id = str(fd, 'id');
  await billing(`/invoices/${id}`);
  const inv = await invoiceFor(id);
  if (!inv || inv.status !== 'draft') redirect(withMsg(`/invoices/${id}`, 'Lines can only be changed on drafts.', 'err'));
  const qty = parseFloat(str(fd, 'qty')) || 1;
  const unit = parseFloat(str(fd, 'unit_price')) || 0;
  const description = str(fd, 'description').slice(0, 200);
  if (!description || !unit) redirect(withMsg(`/invoices/${id}`, 'Add a description and a price.', 'err'));
  const cat = ['fulfillment', 'packaging', 'shipping', 'customs', 'receiving', 'storage', 'other'].includes(str(fd, 'category')) ? str(fd, 'category') : 'other';
  await supabaseAdmin().from('invoice_lines').insert({ invoice_id: id, category: cat, description, qty, unit_price: unit, amount: Math.round(qty * unit * 100) / 100, position: 999 });
  await retotal(id);
  redirect(withMsg(`/invoices/${id}`, 'Line added.'));
}

export async function removeLine(fd: FormData) {
  const id = str(fd, 'id');
  await billing(`/invoices/${id}`);
  const inv = await invoiceFor(id);
  if (!inv || inv.status !== 'draft') redirect(withMsg(`/invoices/${id}`, 'Lines can only be changed on drafts.', 'err'));
  await supabaseAdmin().from('invoice_lines').delete().eq('id', str(fd, 'line')).eq('invoice_id', id);
  await retotal(id);
  redirect(withMsg(`/invoices/${id}`, 'Line removed.'));
}

export async function issueInvoice(fd: FormData) {
  const id = str(fd, 'id');
  const ctx = await billing(`/invoices/${id}`);
  const inv = await invoiceFor(id);
  if (!inv || inv.status !== 'draft') redirect(withMsg(`/invoices/${id}`, 'Only drafts can be issued.', 'err'));
  if (Number(inv.total) <= 0) redirect(withMsg(`/invoices/${id}`, 'This invoice is empty. Add a line or delete the draft.', 'err'));
  const rates = await getRateCard(inv.org_id);
  const due = new Date(Date.now() + (rates?.payment_terms_days ?? 14) * 864e5).toISOString().slice(0, 10);
  await supabaseAdmin().from('invoices').update({ status: 'open', issued_at: new Date().toISOString(), due_date: due, notes: str(fd, 'notes') || inv.notes }).eq('id', id);
  await logActivity(supabaseAdmin(), ctx.userId, inv.org_id, 'invoice_issued', `${inv.number} · ${money(inv.total, inv.currency)}`);
  redirect(withMsg(`/invoices/${id}`, `${inv.number} issued. The client sees it now, due ${due}.`));
}

export async function deleteDraft(fd: FormData) {
  const id = str(fd, 'id');
  await billing(`/invoices/${id}`);
  const inv = await invoiceFor(id);
  if (!inv || inv.status !== 'draft') redirect(withMsg(`/invoices/${id}`, 'Only drafts can be deleted. Void an issued invoice instead.', 'err'));
  await supabaseAdmin().from('invoices').delete().eq('id', id);
  redirect(withMsg('/invoices', `Draft ${inv.number} deleted.`));
}

export async function markPaid(fd: FormData) {
  const id = str(fd, 'id');
  const ctx = await billing(`/invoices/${id}`);
  const inv = await invoiceFor(id);
  if (!inv || inv.status !== 'open') redirect(withMsg(`/invoices/${id}`, 'Only open invoices can be marked as paid.', 'err'));
  const method = ['bank', 'card', 'other'].includes(str(fd, 'method')) ? str(fd, 'method') : 'bank';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str(fd, 'date')) ? new Date(`${str(fd, 'date')}T12:00:00Z`).toISOString() : new Date().toISOString();
  await supabaseAdmin().from('invoices').update({ status: 'paid', paid_at: date, paid_method: method, paid_ref: str(fd, 'ref').slice(0, 120) || null }).eq('id', id);
  await logActivity(supabaseAdmin(), ctx.userId, inv.org_id, 'invoice_paid', `${inv.number} · ${money(inv.total, inv.currency)} · ${method}`);
  redirect(withMsg(`/invoices/${id}`, `${inv.number} marked as paid.`));
}

export async function voidInvoice(fd: FormData) {
  const id = str(fd, 'id');
  const ctx = await billing(`/invoices/${id}`);
  const inv = await invoiceFor(id);
  if (!inv || inv.status !== 'open') redirect(withMsg(`/invoices/${id}`, 'Only open invoices can be voided.', 'err'));
  await supabaseAdmin().from('invoices').update({ status: 'void', notes: str(fd, 'reason') || 'Voided' }).eq('id', id);
  await logActivity(supabaseAdmin(), ctx.userId, inv.org_id, 'invoice_void', inv.number);
  redirect(withMsg(`/invoices/${id}`, `${inv.number} voided. You can create a new invoice for that month.`));
}

// ---------- Paying by card (Stripe Checkout) ----------

export async function payByCard(fd: FormData) {
  const id = str(fd, 'id');
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  // Read through the person's own access: they only reach invoices they're allowed to see.
  const sb = await supabaseServer();
  const { data: inv } = await sb.from('invoices').select('id, number, total, currency, status, org_id').eq('id', id).maybeSingle();
  if (!inv || inv.status !== 'open') redirect(withMsg(`/invoices/${id}`, 'This invoice can’t be paid online.', 'err'));
  if (!ctx.can('invoices.view')) redirect(withMsg(`/invoices/${id}`, 'You don’t have access to that.', 'err'));
  if (!stripeReady()) redirect(withMsg(`/invoices/${id}`, 'Card payments aren’t switched on yet. Please pay by bank transfer.', 'warn'));
  const body = new URLSearchParams({
    mode: 'payment',
    success_url: `${siteUrl()}/invoices/${inv.id}?paid=1`,
    cancel_url: `${siteUrl()}/invoices/${inv.id}`,
    client_reference_id: inv.id,
    customer_email: ctx.email,
    'metadata[invoice_id]': inv.id,
    'payment_intent_data[metadata][invoice_id]': inv.id,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': String(inv.currency).toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(Math.round(Number(inv.total) * 100)),
    'line_items[0][price_data][product_data][name]': `Elmamsflow invoice ${inv.number}`,
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as { url?: string; error?: { message: string } };
  if (!res.ok || !json.url) redirect(withMsg(`/invoices/${inv.id}`, json.error?.message ?? 'Card payment could not start. Please try again.', 'err'));
  redirect(json.url);
}

// ---------- Your billing details ----------

export async function saveBillingSettings(fd: FormData) {
  const ctx = await billing('/settings/billing');
  const row: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
  for (const k of ['company', 'address', 'tax_id', 'email', 'bank_usd', 'bank_eur', 'bank_gbp', 'footer']) row[k] = str(fd, k).slice(0, 1000) || null;
  const { error } = await supabaseAdmin().from('billing_settings').upsert(row, { onConflict: 'id' });
  await logActivity(supabaseAdmin(), ctx.userId, null, 'billing_settings', '');
  redirect(withMsg('/settings/billing', error ? error.message : 'Billing details saved.', error ? 'err' : 'ok'));
}
