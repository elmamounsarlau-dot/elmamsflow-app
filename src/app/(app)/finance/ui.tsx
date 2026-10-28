import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireCtx, type Ctx } from '@/lib/session';

/** Finance pages: the owner, managers and finance, in the back office. */
export async function requireFinance(): Promise<Ctx> {
  const ctx = await requireCtx();
  if (!ctx.staffRole || !ctx.backOffice || !ctx.can('billing.manage')) redirect('/?err=' + encodeURIComponent('Finance is only for the owner, managers and finance.'));
  return ctx;
}

/** Whole amounts for tiles (the same rounding everywhere the figure appears). */
export const fm = (n: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
/** Exact amounts for lists. */
export const fm2 = (n: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD' }).format(Number(n) || 0);

const TABS: [string, string][] = [['/finance', 'Overview'], ['/finance/expenses', 'Expenses & profit'], ['/finance/import', 'Import bank statement'], ['/finance/settings', 'Settings']];

export function FinanceNav({ on, m }: { on: string; m?: string }) {
  return (
    <nav className="fn-tabs" aria-label="Finance">
      {TABS.map(([href, label]) => (
        <Link key={href} href={m && (href === '/finance' || href === '/finance/expenses') ? `${href}?m=${m}` : href} className={on === href ? 'is-on' : ''} aria-current={on === href ? 'page' : undefined}>{label}</Link>
      ))}
      <Link href="/invoices">Invoices</Link>
    </nav>
  );
}

/** ‹ Month › — never past the month in progress. */
export function MonthPick({ base, label, prev, next }: { base: string; label: string; prev: string; next: string | null }) {
  return (
    <div className="fn-month" role="group" aria-label="Month">
      <Link href={`${base}?m=${prev}`} aria-label="Previous month" className="fn-month-btn">‹</Link>
      <span>{label}</span>
      {next ? <Link href={`${base}?m=${next}`} aria-label="Next month" className="fn-month-btn">›</Link> : <span className="fn-month-btn is-off" aria-hidden="true">›</span>}
    </div>
  );
}

export function Warnings({ items }: { items: ReactNode[] }) {
  const list = items.filter(Boolean);
  if (!list.length) return null;
  return (
    <section className="ep-note ep-note--warn fn-warn" role="status">
      {list.map((x, i) => <p key={i}>{x}</p>)}
    </section>
  );
}

export const CAT_TONE: Record<string, string> = { carrier: 'blue', duties: 'orange', rent: 'violet', salaries: 'teal', packaging: 'grey', software: 'grey', other: 'grey' };
