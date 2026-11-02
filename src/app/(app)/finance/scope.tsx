import Link from 'next/link';
import { b2bMonth, b2bOrders } from '@/lib/b2b-data';
import { KIND_LABEL } from '@/lib/b2b';
import { addMonths, currentYm, monthFinance, monthLabel, moneyStatus } from '@/lib/finance';
import { fmtDate } from '@/lib/format';
import { Arrow } from '@/components/ui';
import { FinanceNav, fm, fm2, Warnings } from './ui';

export type Scope = 'fulfillment' | 'b2b' | 'all';
export const scopeOf = (v: string | undefined): Scope => (v === 'b2b' || v === 'all' ? v : 'fulfillment');

/** Fulfillment / B2B / Everything: which business the Finance pages show. */
export function ScopeSwitch({ on, m }: { on: Scope; m: string }) {
  const items: [Scope, string][] = [['fulfillment', 'Fulfillment'], ['b2b', 'B2B'], ['all', 'Everything']];
  return (
    <nav className="fn-scope" aria-label="Which business">
      {items.map(([k, label]) => (
        <Link key={k} href={`/finance?m=${m}${k === 'fulfillment' ? '' : `&scope=${k}`}`} className={on === k ? 'is-on' : ''} aria-current={on === k ? 'page' : undefined}>{label}</Link>
      ))}
    </nav>
  );
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

async function Head({ ym, scope, sub }: { ym: string; scope: Scope; sub: string }) {
  const cur = await currentYm();
  const base = `/finance`;
  return (
    <>
      <div className="ep-head fn-head">
        <div>
          <p className="ep-crumb">Finance · {scope === 'b2b' ? 'B2B wholesale' : 'everything together'}</p>
          <h1>{monthLabel(ym)}</h1>
          <p>{sub}</p>
        </div>
        <div className="ep-actions">
          <div className="fn-month" role="group" aria-label="Month">
            <Link href={`${base}?m=${addMonths(ym, -1)}&scope=${scope}`} aria-label="Previous month" className="fn-month-btn">‹</Link>
            <span>{monthLabel(ym)}</span>
            {ym < cur ? <Link href={`${base}?m=${addMonths(ym, 1)}&scope=${scope}`} aria-label="Next month" className="fn-month-btn">›</Link> : <span className="fn-month-btn is-off" aria-hidden="true">›</span>}
          </div>
          {scope === 'b2b' && <Link className="ep-btn" href="/b2b/new">New B2B order <Arrow /></Link>}
        </div>
      </div>
      <ScopeSwitch on={scope} m={ym} />
    </>
  );
}

export async function B2BFinance({ ym }: { ym: string }) {
  const [b, orders] = await Promise.all([b2bMonth(ym), b2bOrders()]);
  const c = b.currency;
  const active = orders.filter((o) => !o.cancelled && o.money.profit !== null && o.money.ht > 0 && ((o.money.costs ?? 0) > 0 || o.money.billed > 0)).slice(0, 8);
  const cats = Object.entries(b.cats).sort((x, y) => y[1] - x[1]);
  return (
    <div className="fn">
      <Head ym={ym} scope="b2b" sub="Wholesale orders: what you invoiced (before TVA), what you paid factories, freight and customs, and what clients still owe." />
      <FinanceNav on="/finance" m={ym} />
      <Warnings items={[b.noRate.length > 0 && <>Amounts in <b>{b.noRate.join(', ')}</b> are left out until you add the exchange rate in <Link href="/finance/settings">Finance settings</Link>.</>]} />
      <div className="bb-kpis">
        <div className="fn-t" data-figure="b2b-revenue" data-value={Math.round(b.revenue)}><span className="fn-eb fn-eb--blue">Invoiced</span><span className="fn-l">{fm(b.revenue, c)}</span><span className="fn-sub fn-mu">{b.invoices} facture{b.invoices === 1 ? '' : 's'} / invoice{b.invoices === 1 ? '' : 's'}, before TVA</span></div>
        <div className="fn-t" data-figure="b2b-costs" data-value={Math.round(b.costs)}><span className="fn-eb fn-eb--violet">Costs paid</span><span className="fn-l">{fm(b.costs, c)}</span><span className="fn-sub fn-mu">factories, freight, customs…</span></div>
        <div className="fn-t fn-t--dark" data-figure="b2b-profit" data-value={Math.round(b.profit)}><span className="fn-eb fn-eb--orange">Profit</span><span className={`fn-l${b.profit < 0 ? ' fn-dn' : ''}`}>{fm(b.profit, c)}</span><span className="fn-sub fn-on-dark">{b.margin === null ? 'invoiced − costs' : `${b.margin}% margin`}</span></div>
        <Link className="fn-t" href="/b2b?stage=all" data-figure="b2b-owed" data-value={Math.round(b.owed)}><span className="fn-eb fn-eb--err">Owed to you</span><span className="fn-l">{fm(b.owed, c)}</span><span className="fn-sub fn-mu">all B2B clients, today</span></Link>
      </div>
      <div className="fn-xgrid fn-xgrid--even">
        <section className="fn-t fn-t--plain">
          <div className="fn-t-top"><h2 className="fn-h2">Invoiced in {monthLabel(ym)}</h2><Link className="fn-sub fn-link" href="/b2b">B2B orders →</Link></div>
          {b.docs.length ? (
            <div className="ep-tablewrap"><table className="fn-table">
              <thead><tr><th>Document</th><th>Client</th><th className="ep-right">Amount</th></tr></thead>
              <tbody>{b.docs.map((d) => (
                <tr key={d.id}><td><Link href={`/print/b2b/${d.id}`}><b>{d.kind === 'facture' ? 'Facture' : 'Invoice'} {d.number}</b></Link><small>{fmtDate(d.issued_on)}</small></td><td>{d.client}</td><td className="ep-right"><b>{fm2(d.total, d.currency)}</b>{d.currency !== c && d.report !== null && <small>≈ {fm2(d.report, c)} before TVA</small>}</td></tr>
              ))}</tbody>
            </table></div>
          ) : <p className="fn-sub fn-mu">No facture or invoice issued in {monthLabel(ym)}.</p>}
        </section>
        <section className="fn-t fn-t--plain">
          <div className="fn-t-top"><h2 className="fn-h2">Costs paid in {monthLabel(ym)}</h2></div>
          {cats.length > 0 && <div className="fn-chips">{cats.map(([k, v]) => <span key={k} className="fn-chip">{KIND_LABEL[k as keyof typeof KIND_LABEL] ?? k} <small>{fm(v, c)}</small></span>)}</div>}
          {b.costRows.length ? (
            <div className="ep-tablewrap"><table className="fn-table">
              <thead><tr><th>Paid to</th><th>Order</th><th className="ep-right">Amount</th></tr></thead>
              <tbody>{b.costRows.map((x) => (
                <tr key={x.id}><td><b>{x.payee}</b><small>{KIND_LABEL[x.category as keyof typeof KIND_LABEL]} · {fmtDate(x.paid_on)}</small></td><td><Link href={`/b2b/${x.order_id}#money`}>{x.order}</Link></td><td className="ep-right"><b>{fm2(x.amount, x.currency)}</b>{x.currency !== c && x.report !== null && <small>≈ {fm2(x.report, c)}</small>}</td></tr>
              ))}</tbody>
            </table></div>
          ) : <p className="fn-sub fn-mu">No B2B cost recorded in {monthLabel(ym)}.</p>}
        </section>
        <section className="fn-t fn-t--plain fn-span2">
          <div className="fn-t-top"><h2 className="fn-h2">Profit by order</h2><span className="fn-sub fn-mu">sale before TVA − every cost recorded on the order, whatever the month</span></div>
          {active.length ? (
            <div className="ep-tablewrap"><table className="fn-table">
              <thead><tr><th>Order</th><th>Client</th><th>Stage</th><th className="ep-right">Sale</th><th className="ep-right">Costs</th><th className="ep-right">Profit</th><th>Margin</th></tr></thead>
              <tbody>{active.map((o) => (
                <tr key={o.id}>
                  <td><Link href={`/b2b/${o.id}`}><b>{o.number}</b></Link><small>{o.title}</small></td><td>{o.client}</td><td>{o.stage}</td>
                  <td className="ep-right">{fm2(o.money.ht, o.currency)}</td><td className="ep-right">{fm(o.money.costs ?? 0, c)}</td>
                  <td className={`ep-right ${(o.money.profit ?? 0) >= 0 ? 'fn-up' : 'fn-dn'}`}>{fm(o.money.profit ?? 0, c)}</td>
                  <td><div className="fn-margin"><div className="fn-track">{o.money.margin !== null && o.money.margin > 0 && <i className={`fn-gx fn-c-bg--${o.money.margin >= 25 ? 'green' : o.money.margin >= 12 ? 'orange' : 'red'}`} style={{ width: `${Math.min(100, o.money.margin * 2)}%` }} />}</div><b>{o.money.margin === null ? '—' : `${o.money.margin}%`}</b></div></td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p className="fn-sub fn-mu">Profit shows here once an order has its costs recorded or an invoice issued. <Link href="/b2b">B2B orders</Link>.</p>}
        </section>
      </div>
    </div>
  );
}

export async function AllFinance({ ym }: { ym: string }) {
  const [f, b, ms] = await Promise.all([monthFinance(ym), b2bMonth(ym), moneyStatus()]);
  const c = f.currency;
  const rows: [string, number, number, string][] = [
    ['Fulfillment (3PL)', f.rev.total, f.exp.total, `/finance?m=${ym}`],
    ['B2B wholesale', b.revenue, b.costs, `/finance?m=${ym}&scope=b2b`],
  ];
  const rev = f.rev.total + b.revenue, exp = f.exp.total + b.costs, profit = rev - exp;
  const owed = ms.open.total + b.owed;
  const maxRev = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div className="fn">
      <Head ym={ym} scope="all" sub="Fulfillment and B2B together. Rent, salaries and other shared costs are counted once, under Fulfillment." />
      <FinanceNav on="/finance" m={ym} />
      <Warnings items={[[...new Set([...f.noRate, ...b.noRate])].length > 0 && <>Amounts in <b>{[...new Set([...f.noRate, ...b.noRate])].join(', ')}</b> are left out until you add the exchange rate in <Link href="/finance/settings">Finance settings</Link>.</>]} />
      <div className="bb-kpis">
        <div className="fn-t" data-figure="all-revenue" data-value={Math.round(rev)}><span className="fn-eb fn-eb--blue">Revenue</span><span className="fn-l">{fm(rev, c)}</span><span className="fn-sub fn-mu">{f.rev.current ? 'so far this month' : `in ${monthLabel(ym)}`}</span></div>
        <div className="fn-t" data-figure="all-expenses" data-value={Math.round(exp)}><span className="fn-eb fn-eb--violet">Expenses</span><span className="fn-l">{fm(exp, c)}</span><span className="fn-sub fn-mu">3PL expenses + B2B costs</span></div>
        <div className="fn-t fn-t--dark" data-figure="all-profit" data-value={Math.round(profit)}><span className="fn-eb fn-eb--orange">Profit</span><span className={`fn-l${profit < 0 ? ' fn-dn' : ''}`}>{fm(profit, c)}</span><span className="fn-sub fn-on-dark">{rev ? `${pct(profit, rev)}% margin` : '—'}</span></div>
        <div className="fn-t" data-figure="all-owed" data-value={Math.round(owed)}><span className="fn-eb fn-eb--err">Owed to you</span><span className="fn-l">{fm(owed, c)}</span><span className="fn-sub fn-mu">brands {fm(ms.open.total, c)} · B2B {fm(b.owed, c)}</span></div>
      </div>
      <section className="fn-t fn-t--plain">
        <div className="fn-t-top"><h2 className="fn-h2">Each business in {monthLabel(ym)}</h2></div>
        <div className="ep-tablewrap"><table className="fn-table fn-split">
          <thead><tr><th>Business</th><th>Share of revenue</th><th className="ep-right">Revenue</th><th className="ep-right">Expenses</th><th className="ep-right">Profit</th><th className="ep-right">Margin</th></tr></thead>
          <tbody>
            {rows.map(([name, r, e, href]) => (
              <tr key={name}>
                <td><Link href={href}><b>{name}</b></Link></td>
                <td><div className="fn-track"><i className={`fn-gx fn-c-bg--${name.startsWith('B2B') ? 'orange' : 'blue'}`} style={{ width: `${(r / maxRev) * 100}%` }} /></div><small>{rev ? `${pct(r, rev)}%` : '—'}</small></td>
                <td className="ep-right">{fm(r, c)}</td><td className="ep-right">{fm(e, c)}</td>
                <td className={`ep-right ${r - e >= 0 ? 'fn-up' : 'fn-dn'}`}>{fm(r - e, c)}</td><td className="ep-right">{r ? `${pct(r - e, r)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td>Everything</td><td /><td className="ep-right">{fm(rev, c)}</td><td className="ep-right">{fm(exp, c)}</td><td className="ep-right">{fm(profit, c)}</td><td className="ep-right">{rev ? `${pct(profit, rev)}%` : '—'}</td></tr></tfoot>
        </table></div>
      </section>
    </div>
  );
}
