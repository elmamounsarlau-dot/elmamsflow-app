import 'server-only';
import { cache } from 'react';
import { supabaseAdmin } from './supabase/admin';

export const MONEY_CURRENCIES = ['USD', 'EUR', 'GBP', 'CNY', 'MAD'] as const;
export type MoneyCurrency = (typeof MONEY_CURRENCIES)[number];

export type FinanceSettings = { report_currency: MoneyCurrency; fx: Record<string, number>; cost_currency: MoneyCurrency; bill_duties: boolean };

/** How money is reported (read with full rights: callers check permissions themselves). */
export const financeSettings = cache(async (): Promise<FinanceSettings> => {
  const { data } = await supabaseAdmin().from('finance_settings').select('report_currency, fx, cost_currency, bill_duties').eq('id', 1).maybeSingle();
  const fx: Record<string, number> = {};
  for (const [k, v] of Object.entries((data?.fx ?? {}) as Record<string, unknown>)) if (Number(v) > 0) fx[k] = Number(v);
  return {
    report_currency: (data?.report_currency ?? 'USD') as MoneyCurrency,
    fx,
    cost_currency: (data?.cost_currency ?? 'CNY') as MoneyCurrency,
    bill_duties: data?.bill_duties ?? true,
  };
});

/** Value of 1 unit of `cur` in the reporting currency, or null when no rate is set. */
export const rateOf = (cur: string, s: FinanceSettings) => (cur === s.report_currency ? 1 : s.fx[cur] ?? null);

/** Amount in the reporting currency (null when the rate is missing). */
export function toReport(amount: number, cur: string, s: FinanceSettings) {
  const r = rateOf(cur, s);
  return r === null ? null : Math.round(amount * r * 100) / 100;
}

/** Amount from one currency to another, through the reporting currency (null when a rate is missing). */
export function convert(amount: number, from: string, to: string, s: FinanceSettings) {
  if (from === to) return amount;
  const a = rateOf(from, s), b = rateOf(to, s);
  return a === null || b === null ? null : Math.round(((amount * a) / b) * 100) / 100;
}
