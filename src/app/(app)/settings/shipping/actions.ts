'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';
import { isService, isShipType, parseSheet, SERVICES, SHIP_TYPES } from '@/lib/shipping-rates';

const BACK = '/settings/shipping';

async function staff() {
  const ctx = await getCtx();
  if (!ctx?.staffRole || ctx.viewingAs || !ctx.can('billing.manage')) redirect(withMsg('/settings', 'You don’t have access to shipping prices.', 'err'));
  return ctx!;
}

/** Paste the partner's sheet for one option + product type. Replaces the previous one (kept in history). */
export async function saveShippingSheet(fd: FormData) {
  const ctx = await staff();
  const service = str(fd, 'service'), type = str(fd, 'product_type');
  if (!isService(service) || !isShipType(type)) redirect(withMsg(`${BACK}#paste`, 'Choose the option and the product type.', 'err'));
  const text = String(fd.get('sheet') ?? '');
  if (text.length > 2_000_000) redirect(withMsg(`${BACK}#paste`, 'That paste is too large — copy one tab at a time.', 'err'));
  const p = parseSheet(text);
  if (!p.rows.length) redirect(withMsg(`${BACK}#paste`, 'No prices found. Copy the whole tab (Cmd + A, Cmd + C) including the header row with “Country/Region” and “Weight”.', 'err'));
  const dated = str(fd, 'dated') || p.dated;
  const { error } = await supabaseAdmin().rpc('shipping_sheet_replace', {
    p_service: service, p_type: type, p_source: str(fd, 'source').slice(0, 120), p_dated: dated, p_user: ctx.userId, p_rows: p.rows,
  });
  if (error) redirect(withMsg(`${BACK}#paste`, /shipping_sheet_replace|shipping_/.test(error.message) ? 'Run the latest database update (0022) first.' : error.message, 'err'));
  const countries = new Set(p.rows.map((r) => r.country)).size;
  await logActivity(supabaseAdmin(), ctx.userId, null, 'shipping_prices', `${SERVICES[service as keyof typeof SERVICES]} · ${SHIP_TYPES[type as keyof typeof SHIP_TYPES]} · ${countries} countries${dated ? ` · dated ${dated}` : ''}`);
  revalidatePath('/rates');
  const warn = p.unknown.length ? ` Not recognised (left out): ${p.unknown.slice(0, 8).join(', ')}${p.unknown.length > 8 ? '…' : ''}.` : '';
  redirect(withMsg(BACK, `Saved: ${countries} countries, ${p.rows.length} price rows${dated ? `, dated ${dated}` : ''}. Clients see the new prices now.${warn}`, warn ? 'warn' : 'ok'));
}

export async function saveShippingDefaults(fd: FormData) {
  const ctx = await staff();
  const n = (k: string) => Number(str(fd, k).replace(',', '.'));
  const row = { margin_pct: n('margin_pct'), margin_fixed: n('margin_fixed'), packaging_g: Math.round(n('packaging_g')), volume_factor: Math.round(n('volume_factor')), remind_days: Math.round(n('remind_days')) };
  if (Object.values(row).some((v) => !Number.isFinite(v) || v < 0)) redirect(withMsg(`${BACK}#defaults`, 'Use numbers only.', 'err'));
  const { error } = await supabaseAdmin().from('shipping_settings').update({ ...row, updated_by: ctx.userId, updated_at: new Date().toISOString() }).eq('id', true);
  if (error) redirect(withMsg(`${BACK}#defaults`, error.message, 'err'));
  await logActivity(supabaseAdmin(), ctx.userId, null, 'shipping_prices', `Defaults: +${row.margin_pct}% +$${row.margin_fixed}, packaging ${row.packaging_g} g, ÷${row.volume_factor}`);
  revalidatePath('/rates');
  redirect(withMsg(BACK, 'Saved.'));
}

/** A client's own margin (empty fields = the default). */
export async function saveClientShippingMargin(fd: FormData) {
  const ctx = await staff();
  const org = str(fd, 'org');
  const back = `/clients/${org}#partner`;
  const v = (k: string) => { const s = str(fd, k).replace(',', '.'); return s === '' ? null : Number(s); };
  const pct = v('shipping_margin_pct'), fixed = v('shipping_margin_fixed');
  if ((pct != null && !(pct >= 0 && pct <= 500)) || (fixed != null && !(fixed >= 0 && fixed <= 1000))) redirect(withMsg(back, 'Margin: use numbers (0–500 %, 0–1000 $).', 'err'));
  const { error } = await supabaseAdmin().from('organizations').update({ shipping_margin_pct: pct, shipping_margin_fixed: fixed }).eq('id', org).eq('kind', 'client');
  if (error) redirect(withMsg(back, error.message, 'err'));
  await logActivity(supabaseAdmin(), ctx.userId, org, 'shipping_prices', pct == null && fixed == null ? 'Shipping margin: default' : `Shipping margin: ${pct ?? 'default'} % + $${fixed ?? 'default'}`);
  redirect(withMsg(back, 'Shipping margin saved.'));
}
