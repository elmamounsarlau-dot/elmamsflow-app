import Link from 'next/link';
import { b2bMonth, b2bOrders, b2bSettings } from '@/lib/b2b-data';
import { currentYm, monthLabel } from '@/lib/finance';
import { financeSettings, toReport } from '@/lib/fx';
import { TRANSPORT } from '@/lib/b2b';
import { fmtDate } from '@/lib/format';
import { ClickableRows } from '@/components/client';
import { Arrow, Empty } from '@/components/ui';
import { B2BNav, flag, money, requireB2B, stageTone } from './ui';

export const metadata = { title: 'B2B orders' };

export default async function B2B({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireB2B();
  const sp = await searchParams;
  const [rows, st, fin, ym] = await Promise.all([b2bOrders(), b2bSettings(), financeSettings(), currentYm()]);
  const month = await b2bMonth(ym);
  const c = fin.report_currency;
  const done = st.stages[st.stages.length - 1];
  const live = rows.filter((o) => !o.cancelled && o.stage !== done);
  const q = (sp.q ?? '').trim().toLowerCase();
  const view = sp.stage && (st.stages.includes(sp.stage) || sp.stage === 'cancelled' || sp.stage === 'all') ? sp.stage : 'open';
  let shown = view === 'all' ? rows : view === 'cancelled' ? rows.filter((o) => o.cancelled) : view === 'open' ? live : rows.filter((o) => !o.cancelled && o.stage === view);
  if (q) shown = shown.filter((o) => `${o.number} ${o.title} ${o.client} ${o.client_ref ?? ''} ${o.container ?? ''}`.toLowerCase().includes(q));
  const sum = (list: typeof rows, f: (o: (typeof rows)[number]) => number) => list.reduce((s, o) => s + (toReport(f(o), o.currency, fin) ?? 0), 0);
  const pipeline = sum(live, (o) => o.money.ttc);
  const owed = sum(rows.filter((o) => !o.cancelled), (o) => Math.max(0, (o.money.billed || 0) - o.money.paid));
  const count = (s: string) => rows.filter((o) => !o.cancelled && o.stage === s).length;
  const href = (stage: string) => `/b2b?stage=${encodeURIComponent(stage)}${q ? `&q=${encodeURIComponent(q)}` : ''}`;

  return (
    <div className="fn bb">
      <div className="ep-head fn-head">
        <div>
          <p className="ep-crumb">B2B · wholesale · only you, managers and finance see this</p>
          <h1>B2B orders</h1>
          <p>Wholesale orders you enter by hand: the client, the goods, shipping, what it cost you, what they paid, and the devis / facture.</p>
        </div>
        <div className="ep-actions">
          <Link className="ep-btn ep-btn--ghost" href="/b2b/clients">Clients</Link>
          <Link className="ep-btn" href="/b2b/new">New B2B order <Arrow /></Link>
        </div>
      </div>
      <B2BNav on="/b2b" />

      <div className="bb-kpis">
        <Link className="fn-t bb-kpi" href="/b2b" data-figure="b2b-open" data-value={live.length}>
          <span className="fn-eb fn-eb--blue">Open orders</span><span className="fn-l">{live.length}</span>
          <span className="fn-sub fn-mu">{money(pipeline, c, true)} in progress</span>
        </Link>
        <Link className="fn-t bb-kpi" href="/b2b?stage=all" data-figure="b2b-owed" data-value={Math.round(owed)}>
          <span className="fn-eb fn-eb--err">Owed to you</span><span className="fn-l">{money(owed, c, true)}</span>
          <span className="fn-sub fn-mu">invoiced, not paid yet</span>
        </Link>
        <Link className="fn-t bb-kpi" href={`/finance?scope=b2b&m=${ym}`} data-figure="b2b-revenue" data-value={Math.round(month.revenue)}>
          <span className="fn-eb fn-eb--ok">Invoiced · {monthLabel(ym, true)}</span><span className="fn-l">{money(month.revenue, c, true)}</span>
          <span className="fn-sub fn-mu">{month.invoices} invoice{month.invoices === 1 ? '' : 's'}, before TVA</span>
        </Link>
        <Link className="fn-t fn-t--dark bb-kpi" href={`/finance?scope=b2b&m=${ym}`} data-figure="b2b-profit" data-value={Math.round(month.profit)}>
          <span className="fn-eb fn-eb--orange">Profit · {monthLabel(ym, true)}</span><span className={`fn-l${month.profit < 0 ? ' fn-dn' : ''}`}>{money(month.profit, c, true)}</span>
          <span className="fn-sub fn-on-dark">{month.margin === null ? 'invoiced − costs paid' : `${month.margin}% margin · invoiced − costs paid`}</span>
        </Link>
      </div>

      <section className="fn-t fn-t--plain">
        <div className="bb-pipe" role="group" aria-label="Stages">
          <Link className={`bb-pipe-step${view === 'open' ? ' is-on' : ''}`} href={href('open')}><small>All open</small><b>{live.length}</b></Link>
          {st.stages.map((s, i) => (
            <Link key={s} className={`bb-pipe-step bb-tone--${stageTone(s, st.stages)}${view === s ? ' is-on' : ''}`} href={href(s)}><small>{i + 1}. {s}</small><b>{count(s)}</b></Link>
          ))}
          <Link className={`bb-pipe-step bb-pipe-step--x${view === 'cancelled' ? ' is-on' : ''}`} href={href('cancelled')}><small>Cancelled</small><b>{rows.filter((o) => o.cancelled).length}</b></Link>
          <Link className={`bb-pipe-step bb-pipe-step--x${view === 'all' ? ' is-on' : ''}`} href={href('all')}><small>Everything</small><b>{rows.length}</b></Link>
        </div>
        <form className="bb-search" action="/b2b">
          {view !== 'open' && <input type="hidden" name="stage" value={view} />}
          <input name="q" type="search" defaultValue={sp.q ?? ''} placeholder="Search order, client, PO or container" aria-label="Search B2B orders" />
        </form>

        {rows.length === 0 ? (
          <Empty title="No B2B orders yet" text="Add your first wholesale order: pick or add the client, then the goods, shipping and costs.">
            <Link className="ep-btn" href="/b2b/new">New B2B order <Arrow /></Link>
          </Empty>
        ) : shown.length === 0 ? (
          <p className="fn-sub fn-mu fn-empty">No order {q ? `matching “${sp.q}” ` : ''}here.</p>
        ) : (
          <div className="ep-tablewrap"><table className="fn-table bb-table">
            <thead><tr><th>Order</th><th>Client</th><th>Stage</th><th>Shipment</th><th className="ep-right">Value</th><th className="ep-right">Paid</th><th className="ep-right">Profit</th></tr></thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.id} data-href={`/b2b/${o.id}`}>
                  <td><Link href={`/b2b/${o.id}`}><b>{o.number}</b></Link><small>{o.title}</small></td>
                  <td><span className="bb-flag" aria-hidden="true">{flag(o.country)}</span> {o.client}{o.client_ref && <small>PO {o.client_ref}</small>}</td>
                  <td><span className={`ep-st ep-st--${stageTone(o.stage, st.stages, o.cancelled)}`}>{o.cancelled ? 'Cancelled' : o.stage}</span>{o.lastDoc && <small>{o.lastDoc}</small>}</td>
                  <td>{o.transport ? TRANSPORT[o.transport] : '—'}{o.origin || o.destination ? <small>{o.origin ?? '?'} → {o.destination ?? '?'}</small> : null}{o.eta && <small>ETA {fmtDate(o.eta)}</small>}</td>
                  <td className="ep-right"><b>{money(o.money.ttc, o.currency)}</b></td>
                  <td className="ep-right">{money(o.money.paid, o.currency)}{o.money.ttc > 0 && <div className="bb-paid"><i style={{ width: `${Math.min(100, (o.money.paid / o.money.ttc) * 100)}%` }} /></div>}</td>
                  <td className={`ep-right ${o.money.profit !== null && o.money.profit < 0 ? 'fn-dn' : 'fn-up'}`}>{o.money.profit === null ? <small className="fn-dn">no rate</small> : <>{money(o.money.profit, c, true)}{o.money.margin !== null && <small>{o.money.margin}%</small>}</>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      <ClickableRows />
    </div>
  );
}
