import Link from 'next/link';
import type { Ctx } from '@/lib/session';
import { ownerDashboard } from '@/lib/owner-dashboard';
import { PendingLink } from '@/components/access';
import type { AccessLink } from '@/lib/invite';
import { Feed, MiniSpark, MonthRing, Pulse, SpeedPanel, Tile, TwinSpark } from '@/components/dash';
import { CountUp } from '@/components/orders-overview';
import { Submit } from '@/components/client';
import { Arrow } from '@/components/ui';
import { createAllInvoices } from './invoices/actions';

const TZ = 'Asia/Shanghai';
const cash = (n: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD', maximumFractionDigits: 0 }).format(Math.round(n));

/** The owner's (and team's) Overview: the whole business on one page, each figure linked to its page. */
export async function OwnerHome({ ctx }: { ctx: Ctx }) {
  const d = await ownerDashboard(ctx);
  const T = d.today;
  const now = new Date();
  const when = `${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }).format(now)} · ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(now)} China time`;
  const k = d.kpi;
  const m = d.money;
  const late = d.speed.ages[2] + d.speed.ages[3];
  const open = d.actions.filter((a) => a.n > 0);
  const total = open.reduce((a, x) => a + x.n, 0);
  const shippedShare = k.ordersToday ? Math.round((k.shippedToday / k.ordersToday) * 100) : null;
  const pending = d.pending as AccessLink[];
  const names = d.names;

  return (
    <div className="ds" data-view="owner">
      <header className="ds-top">
        <div className="ds-title">
          <span className="ds-live" aria-hidden="true" />
          <div><span className="ds-lbl ds-lbl--orange">{when}</span><h1>Overview</h1></div>
        </div>
        <div className="ep-actions">
          {ctx.can('orders.create') && <Link className="ep-btn ep-btn--ghost" href="/orders/new">New order</Link>}
          {m && (
            <form action={createAllInvoices}>
              <input type="hidden" name="month" value={d.toInvoice.ym} />
              <Submit className="ep-btn ep-btn--ghost" confirm={`Create draft invoices for ${d.toInvoice.label} for every client with a price list?`}>Create {d.toInvoice.label.split(' ')[0]} invoices</Submit>
            </form>
          )}
          {d.flags.clients && <Link className="ep-btn" href="/clients#new-client">Add a client <Arrow /></Link>}
        </div>
      </header>

      {m && m.noRate.length > 0 && <p className="ep-note ep-note--warn ds-note-top">Amounts in {m.noRate.join(', ')} are left out of the money figures until the exchange rate is set in <Link href="/finance/settings">Finance settings</Link>.</p>}

      <div className="ds-kpis">
        <Tile label="Orders today" href={`/orders?c=all&from=${T}&to=${T}`} figure="ordersToday" value={k.ordersToday}
          sub={<>{k.change !== null && <span className={k.change >= 0 ? 'ds-up' : 'ds-dn'}>{k.change >= 0 ? '↗ +' : '↘ '}{k.change}% this week</span>}{k.change !== null ? ' · ' : ''}14 days: in {k.in14.toLocaleString('en')} · out {k.out14.toLocaleString('en')}</>}>
          <div className="ds-kv-row"><span className="ds-kv"><CountUp value={k.ordersToday} /></span><TwinSpark a={k.spark.in} b={k.spark.out} /></div>
        </Tile>
        <Tile label="Shipped today" href={`/orders?c=all&shipped=${T}`} figure="shippedToday" value={k.shippedToday} delay={50} sub={shippedShare !== null ? `${shippedShare}% of what came in today` : 'nothing came in yet today'}>
          <span className="ds-kv"><CountUp value={k.shippedToday} /></span>
        </Tile>
        <Tile label="On the road" href="/orders?c=all&s=shipped" figure="road" value={k.road} delay={100} sub={k.problems ? <span className="ds-dn">{k.problems} tracking problem{k.problems === 1 ? '' : 's'}</span> : 'no tracking problems'}>
          <span className="ds-kv"><CountUp value={k.road} /></span>
        </Tile>
        <Tile label="Door to door" href="/tracking" figure="doorToDoor" value={d.trip.avg === null ? -1 : Number(d.trip.avg.toFixed(1))} delay={150} sub={d.trip.onTime !== null ? `30 days · ${d.trip.onTime}% within 9 days` : 'after the first deliveries'}>
          <span className="ds-kv">{d.trip.avg === null ? '—' : <>{d.trip.avg.toFixed(1)}<small> days</small></>}</span>
        </Tile>
        {m ? (
          <>
            <Tile label={`Billed · ${m.label.split(' ')[0]}`} href="/finance" figure="billed" value={Math.round(m.mtd)} delay={200} sub={<span className="ds-up">forecast {cash(m.forecast, m.currency)}</span>}>
              <span className="ds-kv">{cash(m.mtd, m.currency)}</span>
            </Tile>
            <Tile label="Owed to you" href="/finance" figure="owed" value={Math.round(m.owed.total)} delay={250} tone={m.overdue.n ? 'err' : undefined}
              sub={m.overdue.n ? <span className="ds-dn">{cash(m.overdue.total, m.currency)} overdue · {m.overdue.n} invoice{m.overdue.n === 1 ? '' : 's'}</span> : `${m.owed.n} invoice${m.owed.n === 1 ? '' : 's'} · nothing overdue`}>
              <span className="ds-kv">{cash(m.owed.total, m.currency)}</span>
            </Tile>
          </>
        ) : (
          <>
            <Tile label="Sellable stock" href="/inventory" figure="sellable" value={d.sellable} delay={200} sub={d.reorder ? <span className="ds-dn">{d.reorder} product{d.reorder === 1 ? '' : 's'} to reorder</span> : 'nothing about to run out'}>
              <span className="ds-kv"><CountUp value={d.sellable} /></span>
            </Tile>
            {d.tickets !== null ? (
              <Tile label="Tickets waiting" href="/support?s=open" figure="tickets" value={d.tickets} delay={250} sub="waiting for our reply" tone={d.tickets ? 'warn' : undefined}>
                <span className="ds-kv"><CountUp value={d.tickets} /></span>
              </Tile>
            ) : (
              <Tile label="Inbounds late" href="/inbounds?t=late" figure="lateIn" value={d.lateIn} delay={250} sub="past their expected date" tone={d.lateIn ? 'warn' : undefined}>
                <span className="ds-kv"><CountUp value={d.lateIn} /></span>
              </Tile>
            )}
          </>
        )}
      </div>

      <div className="ds-main">
        <section className="ds-card ds-card--pulse" style={{ animationDelay: '120ms' }}>
          <div className="ds-head"><h2>Open orders, live</h2><Link className="ds-link" href="/orders?c=all">Orders →</Link></div>
          <Pulse pipe={d.pipe} links={{ toPack: '/orders?c=all&s=new', hold: '/orders?c=all&s=on_hold', packed: '/orders?c=all&s=packed', road: '/orders?c=all&s=shipped' }} />
          <p className="ds-muted ds-foot">Inner ring to pack, middle packed, outer on the road: every dot is an order.</p>
        </section>

        <div className="ds-mid">
          <SpeedPanel speed={d.speed} href="/orders?c=all&s=new" lateHref="/orders?c=all&s=new&older=24" />
          {d.warehouses.length > 0 && (
            <div className="ds-whs">
              {d.warehouses.map((w, i) => (
                <Link key={w.id} className="ds-card ds-wh" href="/warehouses" style={{ animationDelay: `${200 + i * 40}ms` }} data-figure={`wh-${w.name}`} data-value={w.onHand}>
                  <div className="ds-head"><span className="ds-lbl">{w.name}</span><span className="ds-ks">{w.open.toLocaleString('en')} open order{w.open === 1 ? '' : 's'}</span></div>
                  <span className="ds-kv ds-kv--m">{w.onHand.toLocaleString('en')} <small>units</small></span>
                  <div className="ds-meter"><i style={{ width: `${Math.max(2, (w.onHand / d.whMax) * 100)}%` }} /></div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <section className="ds-card ds-card--actions" style={{ animationDelay: '200ms' }} aria-labelledby="ds-needs">
          <div className="ds-head"><h2 id="ds-needs">Needs action</h2><span className={`ds-pill${total ? ' ds-pill--err' : ' ds-pill--ok'}`}>{total ? `${total.toLocaleString('en')} item${total === 1 ? '' : 's'}` : 'All clear'}</span></div>
          {open.length ? (
            <ul className="ds-list">
              {open.map((a) => (
                <li key={a.key}><Link href={a.href} data-figure={`act-${a.key}`} data-value={a.n}><i className={`ds-d ds-d--${a.tone}`} />{a.label}<b>{a.n.toLocaleString('en')}</b></Link></li>
              ))}
            </ul>
          ) : <p className="ds-calm"><span aria-hidden="true">✓</span> Nothing waiting for you. {late ? '' : 'Every order is on time.'}</p>}
        </section>
      </div>

      <div className={`ds-bottom${m ? '' : ' ds-bottom--one'}`}>
        <section className="ds-card" style={{ animationDelay: '260ms' }}>
          <div className="ds-head"><h2>Brands</h2>{ctx.can('clients.view') && <Link className="ds-link" href="/clients">All clients →</Link>}</div>
          {d.brands.length ? (
            <div className="ep-tablewrap"><table className="ds-table">
              <thead><tr><th>Brand</th><th className="ep-right">Today</th><th>7 days</th><th className="ep-right">To pack</th><th className="ep-right">On hold</th><th className="ep-right">Stock left</th>{m && <><th className="ep-right">{m.label.split(' ')[0]}</th><th className="ep-right">Owes</th></>}</tr></thead>
              <tbody>
                {d.brands.map((b) => (
                  <tr key={b.id}>
                    <td><Link className="ds-brand" href={`/orders?c=${b.id}`}><i className={`ds-d ds-d--${b.tone}`} /><b>{b.name}</b></Link></td>
                    <td className="ep-right">{b.today}</td>
                    <td><span className="ds-trend"><MiniSpark values={b.spark} bad={(b.change ?? 0) < 0} />{b.change === null ? <span className="ds-muted">new</span> : <span className={b.change > 0 ? 'ds-up' : b.change < 0 ? 'ds-dn' : 'ds-muted'}>{b.change > 0 ? '+' : b.change < 0 ? '−' : '±'}{Math.abs(b.change)}%</span>}</span></td>
                    <td className="ep-right">{b.toPack ? <Link href={`/orders?c=${b.id}&s=new`}>{b.toPack}</Link> : 0}</td>
                    <td className="ep-right">{b.hold ? <Link className="ds-pill ds-pill--warn" href={`/orders?c=${b.id}&s=on_hold`}>{b.hold}</Link> : 0}</td>
                    <td className="ep-right">{b.daysLeft === null ? <span className="ds-muted">—</span> : <span className={b.daysLeft < 21 ? 'ds-pill ds-pill--err' : ''}>{b.daysLeft > 365 ? '365+' : Math.round(b.daysLeft)} d</span>}</td>
                    {m && <><td className="ep-right">{b.month === null ? <span className="ds-muted">—</span> : cash(b.month, m.currency)}</td><td className={`ep-right${b.owes?.overdue ? ' ds-dn' : ''}`}>{b.owes ? cash(b.owes.total, m.currency) : cash(0, m.currency)}</td></>}
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <p className="ds-muted">No orders or stock yet.</p>}
        </section>

        {m && (
          <section className="ds-card ds-money" style={{ animationDelay: '300ms' }}>
            <div className="ds-head"><h2>Money</h2><Link className="ds-link" href="/finance">Finance →</Link></div>
            <div className="ds-money-top">
              <MonthRing share={m.share} />
              <div><span className="ds-lbl">{m.label.split(' ')[0]} so far</span><div className="ds-kv ds-kv--m">{cash(m.mtd, m.currency)}</div><span className="ds-ks">day {m.day} of {m.days} · forecast {cash(m.forecast, m.currency)}</span></div>
            </div>
            <ul className="ds-list">
              <li><Link href="/invoices?t=paid">Paid · 30 days<b className="ds-up">{cash(m.paid30.total, m.currency)}</b></Link></li>
              {m.late.map((i) => <li key={i.id}><Link href={`/invoices/${i.id}`}><span className="ds-dn">{i.number} · {i.who} · {i.state}</span><b className="ds-dn">{new Intl.NumberFormat('en-US', { style: 'currency', currency: i.currency, maximumFractionDigits: 0 }).format(Number(i.total))}</b></Link></li>)}
              <li><Link href="/invoices?t=draft">{m.drafts.n} draft{m.drafts.n === 1 ? '' : 's'} to review and issue<b>{cash(m.drafts.total, m.currency)}</b></Link></li>
            </ul>
          </section>
        )}
      </div>

      {pending.length > 0 && (
        <section className="ds-card ds-pending" id="pending">
          <div className="ds-head"><h2>Waiting to sign in</h2><span className="ds-ks">Only you and managers see these links</span></div>
          <div className="ep-pending-list">
            {pending.map((l) => (
              <div key={l.user_id}>
                <b>{l.email}{l.org_id ? <> · <Link href={`/clients/${l.org_id}`}>{names[l.org_id] ?? 'client'}</Link></> : ' · your team'}</b>
                <PendingLink link={l} />
              </div>
            ))}
          </div>
        </section>
      )}

      <Feed items={d.feed} />
      {d.flags.owner && <p className="ds-muted ds-foot ds-foot--end"><Link className="ds-link" href="/activity">All activity →</Link></p>}
    </div>
  );
}
