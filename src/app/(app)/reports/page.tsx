import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx, shippingOnly } from '@/lib/session';
import { invoiceTz, money, CATEGORY } from '@/lib/billing';
import { monthReport, recentMonths } from '@/lib/report';
import { countryName } from '@/lib/format';
import { HOLD_KIND } from '@/lib/orders-query';
import { Thumb } from '@/components/ui';
import { CountUp } from '@/components/orders-overview';
import { Bars, FlowChart, PipeRing } from '@/components/viz';
import { PrintButton, Reveal } from '@/components/client';
import { AutoSubmit } from '@/components/orders';

export const metadata = { title: 'Monthly report' };

const mlabel = (ym: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-15T00:00:00Z`));

export default async function Reports({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  if (shippingOnly(ctx)) redirect('/shipping');
  if (!ctx.org) redirect('/clients?warn=' + encodeURIComponent('Open a client and choose “View as” to see their monthly report.'));
  const sp = await searchParams;
  const tz = await invoiceTz();
  const months = recentMonths(tz);
  const ym = months.includes(sp.m ?? '') ? sp.m! : months[0];
  const r = await monthReport(ctx, ym);
  const i = months.indexOf(ym);
  const older = months[i + 1], newer = i > 0 ? months[i - 1] : null;
  const delta = r.prevShipped ? Math.round(((r.shipped - r.prevShipped) / r.prevShipped) * 100) : null;
  const catTotals = r.costs ? Object.entries(r.costs.lines.reduce<Record<string, number>>((a, l) => ({ ...a, [l.category]: (a[l.category] ?? 0) + l.amount }), {})).sort((a, b) => b[1] - a[1]) : [];
  const perOrder = r.costs && r.shipped ? r.costs.total / r.shipped : null;

  return (
    <div className="ep-report">
      <header className="ep-rp-head">
        <div>
          <p className="ep-eyebrow"><i />Monthly report · {ctx.org.name}</p>
          <h1>{r.label}</h1>
          <p>{r.partial ? 'This month so far — the report fills in day by day.' : 'The whole month, as it happened in our warehouse.'}</p>
        </div>
        <div className="ep-rp-nav ep-noprint">
          <div className="ep-rp-step">
            {older ? <Link href={`/reports?m=${older}`} aria-label={`Previous month, ${mlabel(older)}`}>‹</Link> : <span>‹</span>}
            <form action="/reports"><select name="m" defaultValue={ym} aria-label="Month" data-autosubmit="">{months.map((m) => <option key={m} value={m}>{mlabel(m)}</option>)}</select><noscript><button>Go</button></noscript></form>
            {newer ? <Link href={`/reports?m=${newer}`} aria-label={`Next month, ${mlabel(newer)}`}>›</Link> : <span>›</span>}
          </div>
          <PrintButton />
        </div>
      </header>

      <section className="ep-rp-hero ep-reveal">
        <div><small>Orders shipped</small><b><CountUp value={r.shipped} /></b><span className={delta === null ? '' : delta >= 0 ? 'up' : 'down'}>{delta === null ? `${r.received.toLocaleString('en')} received` : `${delta >= 0 ? '+' : ''}${delta}% vs ${mlabel(months[i + 1] ?? ym)}`}</span></div>
        <div><small>Units sent</small><b><CountUp value={r.units} /></b><span>{r.countries.length} countr{r.countries.length === 1 ? 'y' : 'ies'}</span></div>
        <div><small>Door to door</small><b>{r.avgTrip !== null ? r.avgTrip.toFixed(1) : '—'}<i> days</i></b><span>{r.fast !== null ? `${Math.round(r.fast * 100)}% within 9 days` : 'No deliveries yet'}</span></div>
        {r.costs ? <div><small>Fulfilment cost</small><b className="ep-rp-money">{money(r.costs.total, r.currency)}</b><span>{perOrder ? `${money(perOrder, r.currency)} per order, all in` : 'Nothing billed yet'}</span></div>
          : <div><small>Support tickets</small><b><CountUp value={r.tickets} /></b><span>opened this month</span></div>}
      </section>

      <section className="ep-card ep-reveal">
        <div className="ep-card-head"><h2>Day by day</h2><span className="ep-muted ep-small">Orders received and shipped · China time</span></div>
        <FlowChart series={r.series} every={r.series.length > 20 ? 5 : 3} />
      </section>

      <div className="ep-rp-grid">
        <section className="ep-card ep-reveal">
          <div className="ep-card-head"><h2>Where your parcels went</h2><span className="ep-muted ep-small">{r.shipped.toLocaleString('en')} parcels</span></div>
          {r.countries.length ? <Bars rows={r.countries.slice(0, 8).map(([c, n]) => ({ key: c, label: countryName(c), n }))} /> : <p className="ep-muted ep-small">Nothing shipped in {r.label} yet.</p>}
        </section>
        <section className="ep-card ep-reveal">
          <div className="ep-card-head"><h2>Delivery speed</h2><span className="ep-muted ep-small">{r.delivered} delivered</span></div>
          <PipeRing unit="delivered" parts={[
            [r.speed[0].label, r.speed[0].n, 'var(--ok)', null],
            [r.speed[1].label, r.speed[1].n, 'var(--blue)', null],
            [r.speed[2].label, r.speed[2].n, 'var(--violet)', null],
            [r.speed[3].label, r.speed[3].n, 'var(--orange)', null],
          ]} />
        </section>
      </div>

      <section className="ep-card ep-reveal">
        <div className="ep-card-head"><h2>Best sellers</h2><span className="ep-muted ep-small">Units shipped in {r.label}</span></div>
        {r.top.length ? (
          <ol className="ep-rp-top">
            {r.top.map((t, k) => (
              <li key={t.id} style={{ animationDelay: `${k * 60}ms` }}>
                <span className="ep-rank">{k + 1}</span>
                <Thumb id={t.id} photo={t.p?.photo_path} name={t.p?.name ?? ''} size={40} />
                <Link href={`/inventory/${t.id}`}><b>{t.p?.name ?? 'Product'}</b><small>{t.p?.sku}</small></Link>
                <span className="ep-rp-bar" aria-hidden="true"><i style={{ width: `${(t.n / r.top[0].n) * 100}%` }} /></span>
                <b className="ep-rp-n">{t.n.toLocaleString('en')}</b>
              </li>
            ))}
          </ol>
        ) : <p className="ep-muted ep-small">Your best sellers appear here once orders ship.</p>}
      </section>

      <div className="ep-rp-grid ep-rp-grid--3">
        <section className="ep-card ep-reveal ep-rp-stat">
          <h2>Stock</h2>
          <dl>
            <div><dt>Received into the warehouse</dt><dd className="ep-pos">+{r.stockIn.toLocaleString('en')}</dd></div>
            <div><dt>Shipped to customers</dt><dd className="ep-neg">−{r.stockOut.toLocaleString('en')}</dd></div>
            {r.corrections !== 0 && <div><dt>Counts &amp; corrections</dt><dd>{r.corrections > 0 ? '+' : ''}{r.corrections.toLocaleString('en')}</dd></div>}
          </dl>
        </section>
        <section className="ep-card ep-reveal ep-rp-stat">
          <h2>Orders that needed you</h2>
          {r.heldCount ? (
            <dl>{r.holds.map(([k, n]) => <div key={k}><dt>{HOLD_KIND[k]?.[1] ?? k}</dt><dd>{n}</dd></div>)}</dl>
          ) : <p className="ep-rp-ok">None — every order went straight to the warehouse.</p>}
          {r.cancelled > 0 && <p className="ep-small ep-muted">{r.cancelled} order{r.cancelled === 1 ? '' : 's'} cancelled.</p>}
        </section>
        <section className="ep-card ep-reveal ep-rp-stat">
          <h2>Support</h2>
          <dl><div><dt>Tickets opened</dt><dd>{r.tickets}</dd></div></dl>
          <Link className="ep-link ep-small ep-noprint" href="/support">Open support →</Link>
        </section>
      </div>

      {r.costs && (
        <section className="ep-card ep-reveal">
          <div className="ep-card-head"><h2>What it cost</h2>{r.invoice ? <Link className="ep-link ep-small" href={`/invoices/${r.invoice.id}`}>Invoice {r.invoice.number} →</Link> : <span className="ep-muted ep-small">{r.partial ? 'So far · invoiced on the 1st' : 'Invoice on its way'}</span>}</div>
          <Bars rows={catTotals.map(([c, n]) => ({ key: c, label: CATEGORY[c] ?? c, n: Math.round(n) }))} unit={r.currency} />
          <p className="ep-small ep-muted" style={{ marginTop: '.6rem' }}>Total {money(r.costs.total, r.currency)}{r.costs.stats.kg ? ` · ${r.costs.stats.kg.toLocaleString('en')} kg billed` : ''}. Same figures as your invoice.</p>
        </section>
      )}
      <Reveal />
      <AutoSubmit />
    </div>
  );
}
