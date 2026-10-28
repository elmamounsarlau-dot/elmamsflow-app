import Link from 'next/link';
import { addMonths, CAT_LABEL, currentYm, EXPENSE_CATS, history, monthFinance, monthLabel, moneyStatus, ymOk } from '@/lib/finance';
import { invoiceTz, lastMonth, monthBounds } from '@/lib/billing';
import { Submit } from '@/components/client';
import { Arrow } from '@/components/ui';
import { createAllInvoices } from '../invoices/actions';
import { CAT_TONE, FinanceNav, fm, fm2, MonthPick, requireFinance, Warnings } from './ui';

export const metadata = { title: 'Finance' };

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

export default async function Finance({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireFinance();
  const sp = await searchParams;
  const cur = await currentYm();
  const ym = ymOk(sp.m) && sp.m! <= cur ? sp.m! : cur;
  const [f, ms, hist, tz] = await Promise.all([monthFinance(ym), moneyStatus(), history(ym), invoiceTz()]);
  const c = f.currency;
  const { rev, exp } = f;
  const prev = hist[hist.length - 2];
  const change = prev?.revenue ? Math.round(((rev.forecast - prev.revenue) / prev.revenue) * 100) : null;
  const toInvoice = lastMonth(tz);

  // 12 months of revenue (bars) and revenue vs expenses (lines)
  const maxRev = Math.max(1, ...hist.map((h) => Math.max(h.revenue, h.current ? rev.forecast : 0)));
  const maxBoth = Math.max(1, ...hist.flatMap((h) => [h.revenue, h.expenses]));
  const line = (key: 'revenue' | 'expenses') => hist.map((h, i) => `${i ? 'L' : 'M'}${((i * 380) / 11).toFixed(1)} ${(66 - (h[key] / maxBoth) * 60).toFixed(1)}`).join(' ');

  // Expenses donut
  const C = 2 * Math.PI * 56;
  let off = 0;
  const donut = EXPENSE_CATS.map((k) => ({ k, v: exp.cats[k] })).filter((x) => x.v > 0).map((x) => {
    const len = exp.total ? (x.v / exp.total) * C : 0;
    const seg = { ...x, len, off };
    off += len;
    return seg;
  });
  const maxAge = Math.max(1, ...ms.aging.map((a) => a.total));
  const per = f.per;

  return (
    <div className="fn">
      <div className="ep-head fn-head">
        <div>
          <p className="ep-crumb">Finance · in {c}</p>
          <h1>{monthLabel(ym)}{rev.current && <span className="fn-soft"> so far</span>}</h1>
          <p>{rev.current ? `Day ${rev.day} of ${rev.days}. Revenue is what you have billed so far; expenses are what you recorded and what each shipped order cost.` : 'Revenue is what you invoiced for the month; expenses are what you recorded and what each shipped order cost.'}</p>
        </div>
        <div className="ep-actions">
          <MonthPick base="/finance" label={monthLabel(ym)} prev={addMonths(ym, -1)} next={ym < cur ? addMonths(ym, 1) : null} />
          <Link className="ep-btn ep-btn--ghost" href={`/finance/expenses?m=${ym}#add`}>Add an expense</Link>
          <Link className="ep-btn ep-btn--ghost" href={`/finance/export?m=${ym}`} prefetch={false}>Export for my accountant</Link>
          <form action={createAllInvoices}>
            <input type="hidden" name="month" value={toInvoice} />
            <Submit confirm={`Create draft invoices for ${monthBounds(toInvoice).label} for every client with a price list?`}>Create {monthBounds(toInvoice).label} invoices <Arrow /></Submit>
          </form>
        </div>
      </div>
      <FinanceNav on="/finance" m={ym} />

      <Warnings items={[
        f.noRate.length > 0 && <>Amounts in <b>{f.noRate.join(', ')}</b> are left out until you add the exchange rate in <Link href="/finance/settings">Finance settings</Link>.</>,
        ...rev.errors.map((e) => <>Couldn’t work out the bill for {e}</>),
        rev.missing.length > 0 && <>No invoice yet for {monthLabel(ym)}: <b>{rev.missing.join(', ')}</b>. Their revenue isn’t counted until the invoice exists. <Link href="/invoices?t=draft">Invoices →</Link></>,
      ]} />

      <div className="fn-grid">
        {/* Revenue */}
        <Link className="fn-t fn-t--rev" href="/invoices" data-figure="revenue" data-value={Math.round(rev.total)}>
          <div className="fn-t-top"><span className="fn-eb fn-eb--blue">Revenue</span>{change !== null && rev.current && <span className={`fn-sub ${change >= 0 ? 'fn-up' : 'fn-dn'}`}>{change >= 0 ? '↗' : '↘'} {Math.abs(change)}% forecast vs {monthLabel(prev.ym, true)}</span>}</div>
          <div><span className="fn-xl">{fm(rev.total, c)}</span><div className="fn-sub fn-mu">{rev.current ? <>billed so far · forecast <b>{fm(rev.forecast, c)}</b></> : `invoiced for ${monthLabel(ym)}`}</div></div>
          <svg className="fn-bars" viewBox="0 0 520 80" preserveAspectRatio="none" aria-hidden="true">
            {hist.map((h, i) => {
              const x = i * 44;
              const hgt = Math.max(2, (h.revenue / maxRev) * 76);
              const fc = h.ym === ym && rev.current ? Math.max(2, (rev.forecast / maxRev) * 76) : 0;
              return (
                <g key={h.ym}>
                  {fc > 0 && <rect className="fn-bar-fc" x={x} y={80 - fc} width="34" height={fc} rx="6" />}
                  <rect className={`fn-bar${h.ym === ym ? ' is-on' : i >= 9 ? ' is-near' : ''}`} x={x} y={80 - hgt} width="34" height={hgt} rx="6" style={{ animationDelay: `${i * 35}ms` }} />
                </g>
              );
            })}
          </svg>
          <div className="fn-axis"><span>{hist[0].label}</span><span>{hist[5].label}</span><span>{hist[11].label}{rev.current ? ' · dashed = forecast' : ''}</span></div>
        </Link>

        {/* Profit */}
        <Link className="fn-t fn-t--dark" href={`/finance/expenses?m=${ym}#pnl`} data-figure="profit" data-value={Math.round(f.profit)}>
          <div className="fn-t-top"><span className="fn-eb fn-eb--orange">Profit</span><span className="fn-sub">{f.margin === null ? '—' : `${f.margin}% margin`}</span></div>
          <span className={`fn-xl${f.profit < 0 ? ' fn-dn' : ''}`}>{fm(f.profit, c)}</span>
          <span className="fn-sub fn-on-dark">Revenue {fm(rev.total, c)} − expenses {fm(exp.total, c)}</span>
          <svg className="fn-lines" viewBox="0 0 380 70" preserveAspectRatio="none" aria-hidden="true">
            <path d={line('revenue')} className="fn-line-rev" pathLength={1} />
            <path d={line('expenses')} className="fn-line-exp" pathLength={1} />
          </svg>
          <div className="fn-axis fn-on-dark"><span><i className="fn-key fn-key--rev" /> revenue</span><span><i className="fn-key fn-key--exp" /> expenses</span><span>12 months</span></div>
        </Link>

        {/* Cash */}
        <div className="fn-t fn-t--cash">
          <Link href="/invoices?t=paid" className="fn-sublink" data-figure="paid30" data-value={Math.round(ms.paid30.total)}>
            <span className="fn-eb fn-eb--ok">Cash in · 30 days</span>
            <span className="fn-l">{fm(ms.paid30.total, c)}</span>
            <span className="fn-sub fn-mu">{ms.paid30.n} invoice{ms.paid30.n === 1 ? '' : 's'} paid{ms.paid30.n ? ` · ${Object.entries(ms.paid30.methods).map(([k, n]) => `${n} by ${k === 'bank' ? 'transfer' : k}`).join(', ')}` : ''}</span>
          </Link>
          <Link href="/invoices?t=open" className="fn-sublink fn-sublink--split" data-figure="owed" data-value={Math.round(ms.open.total)}>
            <span className="fn-eb fn-eb--err">Owed to you</span>
            <div className="fn-owe"><span className="fn-l">{fm(ms.open.total, c)}</span>{ms.overdue.total > 0 ? <span className="fn-sub fn-dn">{fm(ms.overdue.total, c)} late</span> : <span className="fn-sub fn-up">nothing late</span>}</div>
          </Link>
        </div>

        {/* Expenses */}
        <div className="fn-t fn-t--exp">
          <div className="fn-t-top"><span className="fn-eb fn-eb--violet">Expenses · {monthLabel(ym, true)}</span><Link className="fn-sub fn-link" href={`/finance/expenses?m=${ym}`}>All expenses →</Link></div>
          <div className="fn-donut-row">
            <svg className="fn-donut" viewBox="0 0 140 140" aria-hidden="true">
              <circle cx="70" cy="70" r="56" className="fn-donut-track" />
              {donut.map((s) => <circle key={s.k} cx="70" cy="70" r="56" className={`fn-seg fn-c--${CAT_TONE[s.k]}`} style={{ strokeDasharray: `${s.len.toFixed(1)} ${C.toFixed(1)}`, strokeDashoffset: (-s.off).toFixed(1) }} />)}
            </svg>
            <div>
              <div className="fn-l" data-figure="expenses" data-value={Math.round(exp.total)}>{fm(exp.total, c)}</div>
              <div className="fn-sub fn-mu">{per ? `${fm2(per.cost, c)} per order · ` : ''}{f.ship.total.toLocaleString('en')} order{f.ship.total === 1 ? '' : 's'} shipped</div>
            </div>
          </div>
          <div className="fn-rows">
            {EXPENSE_CATS.filter((k) => exp.cats[k] > 0).map((k) => (
              <Link key={k} className="fn-row" href={`/finance/expenses?m=${ym}&cat=${k}`}><i className={`fn-d fn-c-bg--${CAT_TONE[k]}`} />{CAT_LABEL[k]}<b>{fm(exp.cats[k], c)}</b></Link>
            ))}
            {!exp.total && <p className="fn-sub fn-mu">Nothing recorded for {monthLabel(ym)} yet. <Link href={`/finance/expenses?m=${ym}#add`}>Add an expense</Link>, or type the label cost when shipping.</p>}
          </div>
        </div>

        {/* Ageing */}
        <div className="fn-t fn-t--age">
          <span className="fn-eb fn-eb--err">Who owes you, by age</span>
          <div className="fn-ages">
            {ms.aging.map((a, i) => (
              <Link key={a.label} href={i === 0 ? '/invoices?t=open' : '/invoices?t=overdue'} className="fn-age">
                <div className="fn-sub"><span>{a.label}</span><b className={a.total && i ? 'fn-dn' : ''}>{fm(a.total, c)}</b></div>
                <div className="fn-track">{a.total > 0 && <i className={`fn-gx fn-c-bg--${i === 0 ? 'blue' : i === 1 ? 'orange' : 'red'}`} style={{ width: `${Math.max(3, (a.total / maxAge) * 100)}%`, animationDelay: `${i * 80}ms` }} />}</div>
              </Link>
            ))}
          </div>
          <span className="fn-sub fn-mu">Average time to get paid: <b>{ms.avgDays === null ? 'not enough paid invoices yet' : `${ms.avgDays} day${ms.avgDays === 1 ? '' : 's'}`}</b></span>
        </div>

        {/* Invoices */}
        <div className="fn-t fn-t--inv">
          <div className="fn-t-top"><span className="fn-eb fn-eb--blue">Invoices</span><Link className="fn-sub fn-link" href="/invoices">All invoices →</Link></div>
          <div className="fn-tri">
            <Link href="/invoices?t=draft" data-figure="drafts" data-value={ms.drafts.n}><span className="fn-eb">Drafts</span><b>{ms.drafts.n}</b><span className="fn-sub">{fm(ms.drafts.total, c)} to review</span></Link>
            <Link href="/invoices?t=open" data-figure="waiting" data-value={ms.open.n}><span className="fn-eb">To be paid</span><b>{ms.open.n}</b><span className="fn-sub">{fm(ms.open.total, c)} open</span></Link>
            <Link href="/invoices?t=paid"><span className="fn-eb">Paid · 30 days</span><b>{ms.paid30.n}</b><span className="fn-sub">{fm(ms.paid30.total, c)}</span></Link>
          </div>
          {ms.next.length > 0 ? (
            <div className="ep-tablewrap"><table className="fn-table">
              <thead><tr><th>Invoice</th><th>Client</th><th className="ep-right">Amount</th><th>Status</th><th className="ep-right">Next step</th></tr></thead>
              <tbody>
                {ms.next.slice(0, 4).map((i) => (
                  <tr key={i.id}>
                    <td><Link href={`/invoices/${i.id}`}><b>{i.number}</b></Link></td>
                    <td>{i.who}</td>
                    <td className="ep-right">{new Intl.NumberFormat('en-US', { style: 'currency', currency: i.currency, maximumFractionDigits: 0 }).format(Number(i.total))}</td>
                    <td><span className={`fn-act fn-act--${i.tone}`}>{i.state}</span></td>
                    <td className="ep-right"><Link className={`fn-act fn-act--btn fn-act--${i.tone}`} href={`/invoices/${i.id}`}>{i.step}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <p className="fn-sub fn-mu">Nothing to issue or chase.</p>}
        </div>

        {/* Profit by client */}
        <div className="fn-t fn-t--clients">
          <div className="fn-t-top"><span className="fn-eb fn-eb--ok">Profit by client · {monthLabel(ym, true)}</span><span className="fn-sub fn-mu">revenue − the costs of their orders and a share of rent, team and other costs</span></div>
          {f.clients.length ? (
            <div className="ep-tablewrap"><table className="fn-table">
              <thead><tr><th>Client</th><th className="ep-right">Revenue</th><th className="ep-right">Costs</th><th className="ep-right">Profit</th><th>Margin</th></tr></thead>
              <tbody>
                {f.clients.slice(0, 8).map((x) => (
                  <tr key={x.id}>
                    <td><Link href={`/clients/${x.id}`}><b>{x.name}</b></Link><small>{x.orders.toLocaleString('en')} order{x.orders === 1 ? '' : 's'} shipped</small></td>
                    <td className="ep-right">{fm(x.revenue, c)}</td>
                    <td className="ep-right">{fm(x.costs, c)}</td>
                    <td className={`ep-right ${x.profit >= 0 ? 'fn-up' : 'fn-dn'}`}>{fm(x.profit, c)}</td>
                    <td><div className="fn-margin"><div className="fn-track">{x.margin !== null && x.margin > 0 && <i className={`fn-gx fn-c-bg--${x.margin >= 30 ? 'green' : x.margin >= 15 ? 'orange' : 'red'}`} style={{ width: `${Math.min(100, x.margin * 2)}%` }} />}</div><b className={x.margin !== null && x.margin < 0 ? 'fn-dn' : ''}>{x.margin === null ? '—' : `${x.margin}%`}</b></div></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <p className="fn-sub fn-mu">No revenue or costs for {monthLabel(ym)} yet.</p>}
        </div>

        {/* Per order */}
        <div className="fn-t fn-t--per">
          <span className="fn-eb fn-eb--blue">One order, on average · {f.ship.total.toLocaleString('en')} shipped</span>
          {per ? (
            <>
              <div className="fn-per">
                <div><span className="fn-l">{fm2(per.earn, c)}</span><div className="fn-sub fn-mu">you earn</div></div>
                <div><span className="fn-l fn-mu2">{fm2(per.cost, c)}</span><div className="fn-sub fn-mu">it costs you</div></div>
                <div><span className={`fn-l ${per.keep >= 0 ? 'fn-up' : 'fn-dn'}`}>{fm2(per.keep, c)}</span><div className="fn-sub fn-mu">you keep</div></div>
              </div>
              {per.earn > 0 && (
                <div className="fn-stack" aria-hidden="true">
                  {([['blue', per.carrier], ['orange', per.duties], ['grey', per.other], ['violet', per.team], ['green', Math.max(0, per.keep)]] as const).map(([t, v], i) => v > 0 ? <i key={i} className={`fn-gx fn-c-bg--${t}`} style={{ width: `${(v / Math.max(per.earn, per.cost)) * 100}%`, animationDelay: `${i * 80}ms` }} /> : null)}
                </div>
              )}
              <div className="fn-legend fn-sub fn-mu">
                <span><i className="fn-d fn-c-bg--blue" /> carrier {fm2(per.carrier, c)}</span>
                <span><i className="fn-d fn-c-bg--orange" /> duties {fm2(per.duties, c)}</span>
                <span><i className="fn-d fn-c-bg--grey" /> packaging &amp; other {fm2(per.other, c)}</span>
                <span><i className="fn-d fn-c-bg--violet" /> team &amp; rent {fm2(per.team, c)}</span>
                <span className={per.keep >= 0 ? 'fn-up' : 'fn-dn'}><i className="fn-d fn-c-bg--green" /> profit {fm2(per.keep, c)}</span>
              </div>
            </>
          ) : <p className="fn-sub fn-mu">No orders shipped in {monthLabel(ym)} yet.</p>}
        </div>

        {/* Duties */}
        <div className="fn-t fn-t--duty">
          <span className="fn-eb fn-eb--orange">Duties you advance (DDP)</span>
          <span className="fn-l" data-figure="dutiesPaid" data-value={Math.round(f.duties.paid * 100) / 100}>{fm(f.duties.paid, c)}</span>
          <span className="fn-sub">paid to customs for your clients in {monthLabel(ym, true)}</span>
          {f.duties.paid > 0 || f.duties.billed > 0 ? (
            <div className="fn-duty">
              <div className="fn-sub fn-duty-row"><span>Billed back</span><b data-figure="dutiesBilled" data-value={Math.round(f.duties.billed * 100) / 100}>{fm(f.duties.billed, c)}{f.duties.paid ? ` · ${pct(f.duties.billed, f.duties.paid)}%` : ''}</b></div>
              <div className="fn-track fn-track--light"><i className="fn-gx fn-c-bg--orange" style={{ width: `${Math.min(100, pct(f.duties.billed, f.duties.paid) ?? 0)}%` }} /></div>
              <div className="fn-sub">{!f.duties.on ? <>Billing duties back is off · <Link href="/finance/settings">Settings</Link></> : f.duties.paid - f.duties.billed > 0.5 ? <>{fm(f.duties.paid - f.duties.billed, c)} not billed yet{rev.current ? ': it goes on the next invoices' : ''}</> : 'All billed back to your clients.'}</div>
            </div>
          ) : <span className="fn-sub fn-mu">The shipper types the duties paid when shipping a DDP order; they show here and go on the client’s invoice{f.duties.on ? '' : ' (switched off in Settings)'}.</span>}
        </div>
      </div>
    </div>
  );
}
