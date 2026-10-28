import Link from 'next/link';
import type { Ctx } from '@/lib/session';
import { clientDashboard } from '@/lib/owner-dashboard';
import { countryName, fmtDate, greeting } from '@/lib/format';
import { Feed, MonthRing, Pulse, SpeedPanel, Tile, TwinSpark } from '@/components/dash';
import { CountUp } from '@/components/orders-overview';
import { ViewReady, ViewSwitch } from '@/components/home-view';
import { Arrow, Thumb } from '@/components/ui';
import { money } from '@/lib/billing';

const TZ = 'Asia/Shanghai';
const NOTICE_TONE: Record<string, string> = { action: 'err', warn: 'warn', info: 'blue' };

/** A brand's Quick view: the same figures as the Full view, on one screen, close to the owner's Overview. */
export async function ClientQuick({ ctx }: { ctx: Ctx }) {
  const d = await clientDashboard(ctx);
  const T = d.today;
  const k = d.kpi;
  const name = ctx.viewingAs ? d.org.name : ctx.name.split(' ')[0];
  const when = `${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }).format(new Date())} · ${d.org.name}`;
  const late = d.speed.ages[2] + d.speed.ages[3];
  const bill = d.bill;

  return (
    <div className="ds ds--client" data-view="quick">
      <ViewReady view="quick" />
      <header className="ds-top">
        <div className="ds-title">
          <span className="ds-mono" aria-hidden="true">{d.org.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>
          <div><span className="ds-lbl ds-lbl--orange">{when}</span><h1>{greeting()}, {name}</h1></div>
        </div>
        <div className="ep-actions">
          <ViewSwitch view="quick" />
          {ctx.can('orders.create') && <Link className="ep-btn ep-btn--ghost" href="/orders/import">Import orders</Link>}
          {ctx.can('inbounds.create') && <Link className="ep-btn ep-btn--ghost" href="/inbounds/new">Send us stock</Link>}
          {ctx.can('orders.create') && <Link className="ep-btn" href="/orders/new">New order <Arrow /></Link>}
        </div>
      </header>

      <div className="ds-kpis">
        <Tile label="Orders today" href={`/orders?from=${T}&to=${T}`} figure="ordersToday" value={k.ordersToday}
          sub={k.change !== null ? <><span className={k.change >= 0 ? 'ds-up' : 'ds-dn'}>{k.change >= 0 ? '↗ +' : '↘ '}{k.change}%</span> this week</> : `${k.week.toLocaleString('en')} this week`}>
          <div className="ds-kv-row"><span className="ds-kv"><CountUp value={k.ordersToday} /></span><TwinSpark a={d.spark.in} b={d.spark.out} /></div>
        </Tile>
        <Tile label="Shipped today" href={`/orders?shipped=${T}`} figure="shippedToday" value={k.shippedToday} delay={50} sub={d.speed.rate !== null ? `${d.speed.rate}% within 24 h this week` : 'shipped within 24 h'}>
          <span className="ds-kv"><CountUp value={k.shippedToday} /></span>
        </Tile>
        <Tile label="On the road" href="/orders?s=shipped" figure="road" value={d.pipe.road} delay={100} sub={d.problems ? <span className="ds-dn">{d.problems} need{d.problems === 1 ? 's' : ''} a look</span> : 'all moving'}>
          <span className="ds-kv"><CountUp value={d.pipe.road} /></span>
        </Tile>
        <Tile label="Door to door" href="/tracking" figure="doorToDoor" value={d.trip.avg === null ? -1 : Number(d.trip.avg.toFixed(1))} delay={150} sub="last 30 days · duties paid (DDP)">
          <span className="ds-kv">{d.trip.avg === null ? '—' : <>{d.trip.avg.toFixed(1)}<small> days</small></>}</span>
        </Tile>
        <Tile label="Sellable stock" href="/inventory" figure="sellable" value={d.sellable} delay={200} sub={d.daysLeft !== null ? (d.daysLeft > 365 ? 'over a year of stock' : `about ${Math.round(d.daysLeft)} days left`) : 'units ready to ship'}>
          <span className="ds-kv"><CountUp value={d.sellable} /></span>
        </Tile>
        {bill ? (
          <Tile label={`${bill.label.split(' ')[0]} so far`} href="/invoices" figure="bill" value={Math.round(bill.total)} delay={250} sub={bill.perOrder !== null ? `≈ ${money(bill.perOrder, bill.currency)} per order, all in` : 'invoiced on the 1st'}>
            <span className="ds-kv">{new Intl.NumberFormat('en-US', { style: 'currency', currency: bill.currency, maximumFractionDigits: 0 }).format(Math.round(bill.total))}</span>
          </Tile>
        ) : (
          <Tile label="To reorder" href="/inventory?f=reorder" figure="reorder" value={d.reorder} delay={250} tone={d.reorder ? 'err' : undefined} sub={d.reorder ? 'under 3 weeks of stock, or out' : 'nothing about to run out'}>
            <span className="ds-kv"><CountUp value={d.reorder} /></span>
          </Tile>
        )}
      </div>

      <div className="ds-main">
        <section className="ds-card ds-card--pulse" style={{ animationDelay: '120ms' }}>
          <div className="ds-head"><h2>Your orders, live</h2><Link className="ds-link" href="/orders">Orders →</Link></div>
          <Pulse pipe={d.pipe} label="open" links={{ toPack: '/orders?s=new', hold: '/orders?s=on_hold', packed: '/orders?s=packed', road: '/orders?s=shipped' }} client />
          <p className="ds-muted ds-foot">Every dot is one of your orders, moving outward until it’s delivered.</p>
        </section>

        <div className="ds-mid">
          <SpeedPanel speed={d.speed} href="/orders?s=new" lateHref="/orders?s=new&older=24" title="How fast we ship for you" waitingLabel="Being prepared now" />
          <section className="ds-card ds-stock" style={{ animationDelay: '220ms' }}>
            <div className="ds-head"><h2>Stock</h2><Link className="ds-link" href="/inventory">Inventory →</Link></div>
            <div className="ds-stock-grid">
              <div>
                <span className="ds-lbl">Running low</span>
                {d.low.length ? d.low.map(({ p, r }) => (
                  <div key={p.id} className="ds-row">
                    <Thumb id={p.id} photo={p.photo_path} name={p.name} size={30} />
                    <span className="ds-row-txt"><Link href={`/inventory/${p.id}`}>{p.name}</Link> · <b className={r.health === 'warning' ? 'ds-warn' : 'ds-dn'}>{r.days === null || r.health === 'out' ? 'out' : `${Math.round(r.days)} days`}</b></span>
                    {ctx.can('inbounds.create') && r.reorder > 0 && <Link className="ds-cta" href="/inbounds/new">Send {r.reorder.toLocaleString('en')}</Link>}
                  </div>
                )) : <p className="ds-muted ds-small">Nothing running low.</p>}
              </div>
              <div>
                <span className="ds-lbl">On its way to us</span>
                {d.inbounds.length ? d.inbounds.map((b) => (
                  <div key={b.id} className="ds-row">
                    <Link href={`/inbounds/${b.id}`}><b>{b.ref}</b></Link>
                    <span className={`ds-row-txt ds-ks${b.late ? ' ds-dn' : ''}`}>{b.late ? 'late' : b.status.replace('_', ' ')} · {b.units.toLocaleString('en')} units</span>
                    {b.late && ctx.can('inbounds.create') ? <Link className="ds-cta" href={`/inbounds/${b.id}`}>Update</Link> : <span className="ds-row-n">{b.eta ? `ETA ${fmtDate(b.eta).replace(/ \d{4}$/, '')}` : 'no date'}</span>}
                  </div>
                )) : <p className="ds-muted ds-small">Nothing on its way. <Link href="/inbounds/new">Send us stock</Link></p>}
              </div>
            </div>
          </section>
        </div>

        <section className="ds-card ds-card--actions" style={{ animationDelay: '200ms' }} aria-labelledby="ds-needs">
          <div className="ds-head"><h2 id="ds-needs">Needs you</h2><span className={`ds-pill${d.notices.length ? ' ds-pill--err' : ' ds-pill--ok'}`}>{d.notices.length || 'All clear'}</span></div>
          {d.notices.length ? (
            <ul className="ds-list ds-list--cta">
              {d.notices.slice(0, 7).map((n) => (
                <li key={n.key}><span><i className={`ds-d ds-d--${NOTICE_TONE[n.level]}`} /><span className="ds-row-txt">{n.title}</span><Link className="ds-cta" href={n.href}>{n.cta}</Link></span></li>
              ))}
              {d.notices.length > 7 && <li><Link href="/notifications">See all {d.notices.length} →</Link></li>}
            </ul>
          ) : <p className="ds-calm"><span aria-hidden="true">✓</span> Nothing needs you. {late ? '' : 'Every order is on time.'}</p>}
        </section>
      </div>

      <div className={`ds-bottom${bill ? '' : ' ds-bottom--one'}`}>
        <section className="ds-card" style={{ animationDelay: '260ms' }}>
          <div className="ds-head"><h2>Best sellers · 7 days</h2><Link className="ds-link" href="/reports">Monthly report →</Link></div>
          {d.best.length ? (
            <div className="ep-tablewrap"><table className="ds-table">
              <thead><tr><th>Product</th><th className="ep-right">Sold</th><th className="ep-right">Trend</th><th className="ep-right">Sellable</th><th className="ep-right">Days left</th><th>Top market</th></tr></thead>
              <tbody>
                {d.best.map((x) => (
                  <tr key={x.p.id}>
                    <td><Link className="ds-brand" href={`/inventory/${x.p.id}`}><Thumb id={x.p.id} photo={x.p.photo_path} name={x.p.name} size={28} /><b>{x.p.name}</b></Link></td>
                    <td className="ep-right">{x.n.toLocaleString('en')}</td>
                    <td className="ep-right">{x.change === null ? <span className="ds-muted">new</span> : <span className={x.change >= 0 ? 'ds-up' : 'ds-dn'}>{x.change >= 0 ? '+' : '−'}{Math.abs(x.change)}%</span>}</td>
                    <td className="ep-right">{x.r.available.toLocaleString('en')}</td>
                    <td className="ep-right">{x.r.days === null ? '—' : <span className={x.r.days < 21 ? 'ds-pill ds-pill--err' : x.r.days < 45 ? 'ds-pill ds-pill--warn' : ''}>{x.r.days > 365 ? '365+' : Math.round(x.r.days)} d</span>}</td>
                    <td>{x.market ? countryName(x.market) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <p className="ds-muted">Your best sellers show here after the first week of orders.</p>}
        </section>

        {bill && (
          <section className="ds-card ds-money" style={{ animationDelay: '300ms' }}>
            <div className="ds-head"><h2>Billing</h2><Link className="ds-link" href="/pricing">Pricing →</Link></div>
            <div className="ds-money-top">
              <MonthRing share={bill.share} />
              <div><span className="ds-lbl">{bill.label.split(' ')[0]} so far</span><div className="ds-kv ds-kv--m">{money(bill.total, bill.currency)}</div><span className="ds-ks">forecast {new Intl.NumberFormat('en-US', { style: 'currency', currency: bill.currency, maximumFractionDigits: 0 }).format(Math.round(bill.forecast))} · invoiced on the 1st</span></div>
            </div>
            <ul className="ds-list">
              {d.invoices.map((i) => (
                <li key={i.id}><Link href={`/invoices/${i.id}`}>{i.number} · {new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(`${i.period_start}T12:00:00Z`))}
                  <b className={i.status === 'paid' ? 'ds-up' : i.due_date && i.due_date < new Date().toISOString().slice(0, 10) ? 'ds-dn' : 'ds-warn'}>{i.status === 'paid' ? 'Paid' : `${money(Number(i.total), i.currency)}${i.due_date ? ` due ${fmtDate(i.due_date).replace(/ \d{4}$/, '')}` : ''}`}</b></Link></li>
              ))}
              {!d.invoices.length && <li><Link href="/invoices">No invoice yet<b>Invoices →</b></Link></li>}
            </ul>
          </section>
        )}
      </div>

      <Feed items={d.feed} />
    </div>
  );
}
