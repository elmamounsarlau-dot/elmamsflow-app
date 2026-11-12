'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';
import { adjustWallet, decideTopup, requestTopup } from '@/lib/wallet';
import { afterOrderChange } from '@/lib/integrations/flow';

const num = (v: string) => { const n = Math.round(parseFloat(v.replace(',', '.')) * 100) / 100; return Number.isFinite(n) ? n : NaN; };

/** The client announces a top-up: it gets the payment details and its own reference. */
export async function startTopup(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx?.org || !ctx.can('invoices.view')) redirect(withMsg('/invoices', 'You don’t have access to that.', 'err'));
  const amount = num(str(fd, 'amount'));
  const r = await requestTopup(ctx.org!.id, amount, str(fd, 'method'), str(fd, 'note') || null, ctx.userId);
  if ('error' in r) redirect(withMsg('/invoices/topup', r.error!, 'err'));
  redirect(`/invoices/topup/${r.id}`);
}

async function staff(back: string) {
  const ctx = await getCtx();
  if (!ctx?.staffRole || !ctx.can('billing.manage') || ctx.viewingAs) redirect(withMsg(back, 'Only Elmamsflow billing can do that.', 'err'));
  return ctx;
}

/** We saw the money arrive (amount can be corrected for bank fees), or it never came. */
export async function decideTopupAction(fd: FormData) {
  const back = str(fd, 'back').startsWith('/') ? str(fd, 'back') : '/invoices';
  const ctx = await staff(back);
  const ok = str(fd, 'decision') === 'confirm';
  const amount = str(fd, 'amount') ? num(str(fd, 'amount')) : undefined;
  if (ok && amount !== undefined && !(amount > 0)) redirect(withMsg(back, 'Write the amount that arrived.', 'err'));
  const r = await decideTopup(str(fd, 'id'), ok, ctx.userId, amount);
  if ('error' in r) redirect(withMsg(back, r.error!, 'err'));
  if (r.released?.length) await afterOrderChange(r.released);
  redirect(withMsg(back, ok ? `Top-up confirmed.${r.released?.length ? ` ${r.released.length} waiting order${r.released.length === 1 ? '' : 's'} released to the warehouse.` : ''}` : 'Top-up marked as not received.'));
}

export async function adjustWalletAction(fd: FormData) {
  const org = str(fd, 'org');
  const back = `/clients/${org}#partner`;
  const ctx = await staff(back);
  const amount = num(str(fd, 'amount'));
  if (!Number.isFinite(amount) || amount === 0) redirect(withMsg(back, 'Write an amount (− to take from the balance).', 'err'));
  const r = await adjustWallet(org, amount, str(fd, 'note'), ctx.userId);
  if ('error' in r) redirect(withMsg(back, r.error!, 'err'));
  if (r.released?.length) await afterOrderChange(r.released);
  redirect(withMsg(back, 'Balance adjusted.'));
}

/** Client code (SKU prefix at the partner), how the client pays, and the cancel/refund default. */
export async function savePartnerSettings(fd: FormData) {
  const org = str(fd, 'org');
  const back = `/clients/${org}#partner`;
  const ctx = await staff(back);
  const admin = supabaseAdmin();
  const code = str(fd, 'client_code').toUpperCase();
  if (code && !/^[A-Z][A-Z0-9]{1,5}$/.test(code)) redirect(withMsg(back, 'The client code is 2 to 6 letters or digits, starting with a letter (e.g. TOF).', 'err'));
  const { data: cur } = await admin.from('organizations').select('client_code').eq('id', org).maybeSingle();
  if (cur?.client_code && code !== cur.client_code) {
    const { count } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('org_id', org).not('bridge_id', 'is', null).in('status', ['new', 'packed', 'on_hold']);
    if (count) redirect(withMsg(back, `${count} order${count === 1 ? ' is' : 's are'} still at the warehouse under ${cur.client_code}. Change the code once they have shipped.`, 'err'));
  }
  const credit = num(str(fd, 'credit_limit') || '0');
  const low = num(str(fd, 'low_balance') || '0');
  if (!(credit >= 0) || !(low >= 0)) redirect(withMsg(back, 'Credit and warning amounts are 0 or more.', 'err'));
  const { error } = await admin.from('organizations').update({
    client_code: code || null, billing_mode: str(fd, 'billing_mode') === 'prepaid' ? 'prepaid' : 'invoice',
    credit_limit: credit, low_balance: low, cancel_refund: str(fd, 'cancel_refund') === 'yes',
  }).eq('id', org);
  if (error) redirect(withMsg(back, /client_code/.test(error.message) ? 'Another client already uses this code.' : error.message, 'err'));
  // A new code means new SKUs at the partner: products are sent again under the new code.
  if (code !== (cur?.client_code ?? '')) await admin.from('products').update({ bridge_ref: null, bridge_sku: null, bridge_synced_at: null }).eq('org_id', org);
  await logActivity(admin, ctx.userId, org, 'client_billing', `${code ? `code ${code} · ` : ''}${str(fd, 'billing_mode') === 'prepaid' ? 'prepaid balance' : 'monthly invoice'}`);
  redirect(withMsg(back, 'Saved.'));
}

/** Where clients send top-ups (shown on their top-up page). One method per block: first line the name, then the details. */
export async function saveTopupSettings(fd: FormData) {
  const ctx = await staff('/settings/billing');
  const blocks = str(fd, 'methods').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const methods = blocks.map((b) => { const [label, ...rest] = b.split('\n'); return { label: label.replace(/:$/, '').trim().slice(0, 80), details: rest.join('\n').trim().slice(0, 1000) }; }).filter((m) => m.label && m.details).slice(0, 8);
  const min = num(str(fd, 'min_topup') || '0');
  if (!(min >= 0)) redirect(withMsg('/settings/billing#topup', 'The minimum is 0 or more.', 'err'));
  const { error } = await supabaseAdmin().from('wallet_settings').upsert({ id: 1, methods, min_topup: min, note: str(fd, 'note').slice(0, 500) || null, updated_at: new Date().toISOString(), updated_by: ctx.userId }, { onConflict: 'id' });
  await logActivity(supabaseAdmin(), ctx.userId, null, 'billing_settings', 'top-up details');
  redirect(withMsg('/settings/billing#topup', error ? error.message : `Saved: ${methods.length} way${methods.length === 1 ? '' : 's'} to top up.`, error ? 'err' : 'ok'));
}
