import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx, type Ctx } from '@/lib/session';

/** B2B pages: the owner, managers and finance, in the back office. */
export async function requireB2B(): Promise<Ctx> {
  const ctx = await requireCtx();
  if (!ctx.staffRole || !ctx.backOffice || !ctx.can('billing.manage')) redirect('/?err=' + encodeURIComponent('B2B is only for the owner, managers and finance.'));
  return ctx;
}

/** Exact amount with its currency (MAD prints as "DH"). */
export const money = (n: number, c: string, whole = false) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD', currencyDisplay: c === 'MAD' ? 'code' : 'symbol', maximumFractionDigits: whole ? 0 : 2, minimumFractionDigits: whole ? 0 : 2 }).format(whole ? Math.round(Number(n) || 0) : Number(n) || 0);

const TABS: [string, string][] = [['/b2b', 'Orders'], ['/b2b/clients', 'Clients'], ['/b2b/settings', 'Stages, numbers & bank']];

export function B2BNav({ on }: { on: string }) {
  return (
    <nav className="fn-tabs" aria-label="B2B">
      {TABS.map(([href, label]) => <Link key={href} href={href} className={on === href ? 'is-on' : ''} aria-current={on === href ? 'page' : undefined}>{label}</Link>)}
      <Link href="/finance?scope=b2b">B2B in Finance</Link>
    </nav>
  );
}

/** A flag from a 2-letter country code. */
export const flag = (cc: string) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');

/** Tone of a stage on the pipeline: first = grey, last = green, in between = blue / orange. */
export function stageTone(stage: string, stages: string[], cancelled = false) {
  if (cancelled) return 'mute';
  const i = stages.indexOf(stage);
  if (i < 0) return 'mute';
  if (i === stages.length - 1) return 'ok';
  if (i === 0) return 'warn';
  return i >= stages.length / 2 ? 'pk' : 'go';
}
