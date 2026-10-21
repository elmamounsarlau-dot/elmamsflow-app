import 'server-only';
import { supabaseServer } from './supabase/server';
import { available, type ProductRow } from './data';
import type { Ctx } from './session';

/** Units shipped per product over the last `days` days (from stock leaving with orders). */
export async function salesByProduct(ctx: Ctx, days: number, until?: Date) {
  const sb = await supabaseServer();
  const end = until ?? new Date();
  const since = new Date(end.getTime() - days * 864e5).toISOString();
  let q = sb.from('stock_moves').select('product_id, qty').eq('type', 'order').gte('created_at', since).lt('created_at', end.toISOString()).limit(20000);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data } = await q;
  const m = new Map<string, number>();
  for (const r of (data ?? []) as { product_id: string; qty: number }[]) m.set(r.product_id, (m.get(r.product_id) ?? 0) + Math.abs(r.qty));
  return m;
}

export type Health = 'out' | 'critical' | 'warning' | 'healthy' | 'idle' | 'new';

export const HEALTH: Record<Health, [string, string]> = {
  out: ['Out of stock', 'err'],
  critical: ['Reorder now', 'err'],
  warning: ['Running low', 'warn'],
  healthy: ['Healthy', 'ok'],
  idle: ['Not selling', 'mute'],
  new: ['No stock yet', 'mute'],
};

/** Days of stock left at the 30-day selling pace, and what to do about it.
 *  Restock from China takes 2–5 weeks, so under 21 days is critical and under 45 is low. */
export function runway(p: ProductRow, sold30: number) {
  const av = available(p);
  const daily = sold30 / 30;
  const days = daily > 0 ? av / daily : null;
  let health: Health;
  if (av <= 0 && (sold30 > 0 || p.on_hand > 0)) health = 'out';
  else if (av <= 0) health = 'new';
  else if (daily === 0) health = av <= p.low_stock ? 'warning' : 'idle';
  else if ((days ?? 0) < 21 || av <= p.low_stock) health = 'critical';
  else if ((days ?? 0) < 45) health = 'warning';
  else health = 'healthy';
  // Cover 60 days of sales, counting what is already on its way.
  const reorder = daily > 0 ? Math.max(0, Math.ceil(daily * 60 - av - p.incoming)) : Math.max(0, p.low_stock * 2 - av - p.incoming);
  return { available: av, daily, days, health, reorder, sold30 };
}

export const RANGES = { today: 1, '7d': 7, '30d': 30, '90d': 90 } as const;
export type Range = keyof typeof RANGES;
export const rangeOf = (v: string | undefined): Range => (v && v in RANGES ? (v as Range) : '30d');
export const RANGE_LABEL: Record<Range, string> = { today: 'Today', '7d': '7D', '30d': '30D', '90d': '90D' };

export function fmtDays(d: number | null) {
  if (d === null) return '—';
  if (d >= 365) return '1y+';
  return `${Math.floor(d)}d`;
}
