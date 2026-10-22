import { shippingOnly } from '@/lib/session';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { orgNames } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { CATEGORY, computeCharges, getRateCard, INVOICE_STATUS, invoiceTz, isOverdue, lastMonth, money, monthBounds, ymOf } from '@/lib/billing';
import { Arrow, Badge, Empty } from '@/components/ui';
import { Submit } from '@/components/client';
import { createAllInvoices } from './actions';

export const metadata = { title: 'Invoices' };

type Inv = { id: string; number: string; org_id: string; period_start: string; period_end: string; currency: string; status: string; total: number; issued_at: string | null; due_date: string | null; paid_at: string | null; paid_method: string | null };

export default async function Invoices({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  if (shippingOnly(ctx)) redirect('/shipping');
  if (!ctx.can('invoices.view')) redirect('/?err=' + encodeURIComponent('You don’t have access to invoices.'));
  const sp = await searchParams;
  const sb = await supabaseServer();
  const staff = ctx.backOffice;
  const manage = !!ctx.staffRole && ctx.can('billing.manage');
  let q = sb.from('invoices').select('id, number, org_id, period_start, period_end, currency, status, total, issued_at, due_date, paid_at, paid_method').neq('status', 'void').order('period_start', { ascending: false }).order('number', { ascending: false }).limit(1000);
  if (ctx.org) q = q.eq('org_id', ctx.org.id).neq('status', 'draft');
  const [{ data }, names] = await Promise.all([q, staff ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  const all = (data ?? []) as Inv[];
  const st = (i: Inv) => (isOverdue(i) ? 'overdue' : i.status);

  // Totals per currency (clients usually have one).
  const sum = (rows: Inv[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.currency, (m.get(r.currency) ?? 0) + Number(r.total));
    return m.size ? [...m.entries()].map(([c, n]) => money(n, c)).join(' · ') : money(0, ctx.org ? '' : 'USD');
  };
  const open = all.filter((i) => i.status === 'open');
  const overdue = open.filter(isOverdue);
  const since90 = Date.now() - 90 * 864e5;
  const paid90 = all.filter((i) => i.status === 'paid' && i.paid_at && Date.parse(i.paid_at) >= since90);
  const drafts = all.filter((i) => i.status === 'draft');

  // This month so far (clients, and staff viewing as a client).
  let running: Awaited<ReturnType<typeof computeCharges>> | null = null;
  let runCur = 'USD';
  const tz = await invoiceTz();
  const ym = ymOf(new Date(), tz);
  if (ctx.org) {
    const rates = await getRateCard(ctx.org.id);
    if (rates) {
      const { start } = monthBounds(ym, tz);
      running = await computeCharges(ctx.org.id, rates, start, new Date());
      runCur = rates.currency;
    }
  }

  const TABS: [string, string, Inv[]][] = [
    ['all', 'All', all],
    ...(staff ? [['draft', 'Drafts', drafts] as [string, string, Inv[]]] : []),
    ['open', 'Open', open.filter((i) => !isOverdue(i))],
    ['overdue', 'Overdue', overdue],
    ['paid', 'Paid', all.filter((i) => i.status === 'paid')],
  ];
  const tab = TABS.find(([k]) => k === sp.t) ?? TABS[0];
  const term = (sp.q ?? '').trim().toLowerCase();
  const list = tab[2].filter((i) => !term || `${i.number} ${names[i.org_id] ?? ''}`.toLowerCase().includes(term));
  const href = (t: string) => `/invoices?${new URLSearchParams({ ...(t !== 'all' ? { t } : {}), ...(term ? { q: term } : {}) })}`;
  const period = (i: Inv) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${i.period_start}T00:00:00Z`));

  return (
    <>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">Invoices</p>
          <h1>Invoices</h1>
          <p>{staff ? 'Billing for every client: monthly invoices built from what really happened in the warehouse.' : `Fulfillment, shipping, receiving and storage for ${ctx.org?.name}. One invoice a month.`}</p>
        </div>
        <div className="ep-actions">
          {manage && staff && <Link className="ep-btn ep-btn--ghost" href="/settings/billing">Billing details</Link>}
          {manage && staff && (
            <form action={createAllInvoices} className="ep-inline">
              <input type="hidden" name="month" value={lastMonth(tz)} />
              <Submit confirm={`Create draft invoices for ${monthBounds(lastMonth(tz)).label} for every client with a price list?`}>Create {monthBounds(lastMonth(tz)).label} invoices <Arrow /></Submit>
            </form>
          )}
        </div>
      </div>

      <div className="ep-sum">
        <Link href={href('open')} className="ep-sum-card">
          <small>Outstanding</small>
          <b className="ep-sum-money">{sum(open)}</b>
          <span>{open.length} invoice{open.length === 1 ? '' : 's'} to be paid</span>
        </Link>
        <Link href={href('overdue')} className={`ep-sum-card${overdue.length ? ' is-alert' : ''}`}>
          <small>Overdue</small>
          <b className="ep-sum-money">{sum(overdue)}</b>
          <span>{overdue.length ? `${overdue.length} past the due date` : 'Nothing overdue'}</span>
        </Link>
        <Link href={href('paid')} className="ep-sum-card">
          <small>Paid · last 90 days</small>
          <b className={`ep-sum-money${paid90.length ? ' ep-good' : ''}`}>{sum(paid90)}</b>
          <span>Bank transfer or card</span>
        </Link>
        {staff ? (
          <Link href={href('draft')} className={`ep-sum-card${drafts.length ? ' is-warn' : ''}`}>
            <small>Drafts to review</small>
            <b>{drafts.length}</b>
            <span>{drafts.length ? 'Check and issue them' : 'Nothing waiting'}</span>
          </Link>
        ) : (
          <div className="ep-sum-card">
            <small>This month so far</small>
            <b className="ep-sum-money">{running ? money(running.total, runCur) : '—'}</b>
            <span>{running ? 'Invoiced on the 1st of next month' : 'Your price list is being set up'}</span>
          </div>
        )}
      </div>

      {running && running.lines.length > 0 && (
        <section className="ep-card">
          <div className="ep-card-head"><h2>Running bill · {monthBounds(ym).label}</h2><span className="ep-muted ep-small">Updates live as orders ship and stock arrives</span></div>
          <div className="ep-running">
            {Object.entries(running.lines.reduce<Record<string, number>>((a, l) => ({ ...a, [l.category]: (a[l.category] ?? 0) + l.amount }), {})).map(([c, n]) => (
              <div key={c}><small>{CATEGORY[c]}</small><b>{money(n, runCur)}</b></div>
            ))}
          </div>
        </section>
      )}

      <section className="ep-card ep-card--flush">
        <form className="ep-toolbar" action="/invoices">
          {tab[0] !== 'all' && <input type="hidden" name="t" value={tab[0]} />}
          <div className="ep-search">
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            <input name="q" defaultValue={term} placeholder={staff ? 'Search invoice or client' : 'Search invoices'} />
          </div>
        </form>
        <div className="ep-tabbar">
          {TABS.map(([k, l, rows]) => <Link key={k} href={href(k)} className={tab[0] === k ? 'is-on' : ''}>{l}<em>{rows.length}</em></Link>)}
        </div>
        {list.length === 0 ? (
          <Empty title={all.length ? 'Nothing here' : 'No invoices yet'} text={all.length ? 'Try another tab.' : staff ? 'Set a price list on each client, then create the month’s invoices.' : 'Your first invoice arrives at the start of next month.'} />
        ) : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Invoice</th>{staff && <th>Client</th>}<th>Period</th><th>Issued</th><th>Due</th><th className="ep-right">Amount</th><th>Status</th><th className="ep-right">Actions</th></tr></thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id} data-href={`/invoices/${i.id}`}>
                    <td><b className="ep-mono">{i.number}</b></td>
                    {staff && <td><small className="ep-client">{names[i.org_id]}</small></td>}
                    <td>{period(i)}</td>
                    <td><small>{i.issued_at ? fmtDate(i.issued_at) : '—'}</small></td>
                    <td><small className={isOverdue(i) ? 'ep-late' : ''}>{i.status === 'paid' ? `Paid ${fmtDate(i.paid_at)}` : i.due_date ? fmtDate(i.due_date) : '—'}</small></td>
                    <td className="ep-right"><b>{money(i.total, i.currency)}</b></td>
                    <td><Badge map={INVOICE_STATUS} value={st(i)} /></td>
                    <td className="ep-right">
                      <div className="ep-row-actions">
                        <a className="ep-icon-btn" href={`/print/invoice/${i.id}`} target="_blank" rel="noreferrer" title="Download PDF" aria-label="Download PDF">
                          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3v10M6 9l4 4 4-4M4 16h12" /></svg>
                        </a>
                        {i.status === 'open' && !staff && <Link className="ep-btn ep-btn--sm" href={`/invoices/${i.id}#pay`}>Pay</Link>}
                        {i.status === 'draft' && <Link className="ep-btn ep-btn--sm ep-btn--ghost" href={`/invoices/${i.id}`}>Review</Link>}
                        {i.status === 'paid' && <span className="ep-paid">✓ Paid</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="ep-table-foot"><span>{list.length} invoice{list.length === 1 ? '' : 's'}</span></div>
      </section>
    </>
  );
}
