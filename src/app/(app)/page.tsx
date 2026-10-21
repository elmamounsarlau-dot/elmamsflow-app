import Link from 'next/link';
import { PendingLink } from '@/components/access';
import type { AccessLink } from '@/lib/invite';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { getProducts, orgNames } from '@/lib/data';
import { fmtDays, HEALTH, RANGE_LABEL, RANGES, rangeOf, runway, salesByProduct } from '@/lib/insights';
import { COUNTRIES, fmtDate, greeting, ORDER_STATUS } from '@/lib/format';
import { ACTIVITY_LABELS } from '@/lib/log';
import { Arrow, Badge, Empty } from '@/components/ui';
import { Spark } from '@/components/charts';
import { MiniSteps } from '@/components/steps';

export const metadata = { title: 'Home' };

const TZ = 'Asia/Shanghai';
const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const OPEN = ['new', 'on_hold', 'packed'];

type OrderLite = { id: string; number: string; customer: string; country: string; city: string | null; created_at: string; status: string; org_id: string; hold_reason: string | null };

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const range = rangeOf(sp.r);
  const days = RANGES[range];
  const sb = await supabaseServer();
  const now = Date.now();
  const start = new Date(now - days * 864e5).toISOString();
  const prevStart = new Date(now - 2 * days * 864e5).toISOString();
  const chartDays = Math.max(days, 14);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = (q: any) => (ctx.org ? q.eq('org_id', ctx.org.id) : q);
  const headCount = (table: string) => scope(sb.from(table).select('id', { count: 'exact', head: true }));

  const [products, names, sales30, salesRange, ordersRange, prevCount, delivered, openOrders, inbounds, tickets, latest, activity, everInbounds] = await Promise.all([
    getProducts(ctx),
    ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>),
    salesByProduct(ctx, 30),
    salesByProduct(ctx, days),
    scope(sb.from('orders').select('created_at, country').gte('created_at', new Date(now - chartDays * 864e5).toISOString()).limit(20000)),
    headCount('orders').gte('created_at', prevStart).lt('created_at', start),
    scope(sb.from('orders').select('shipped_at, delivered_at')).gte('delivered_at', start).not('shipped_at', 'is', null).limit(5000),
    scope(sb.from('orders').select('id, number, customer, country, city, created_at, status, org_id, hold_reason, order_items(product_id)').in('status', OPEN).order('created_at').limit(2000)),
    scope(sb.from('inbounds').select('id, ref, status, eta, supplier, org_id, inbound_items(expected)').neq('status', 'received').order('eta', { ascending: true, nullsFirst: false }).limit(50)),
    headCount('tickets').eq('status', 'open'),
    scope(sb.from('orders').select('id, number, customer, city, country, created_at, status, org_id, hold_reason').order('created_at', { ascending: false }).limit(6)),
    ctx.backOffice ? sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(8) : Promise.resolve({ data: [] as { id: number; action: string; detail: string | null; org_id: string | null; created_at: string }[] }),
    ctx.backOffice ? Promise.resolve({ count: 1 }) : headCount('inbounds'),
  ]);

  // ---------- Orders: per day, this range vs the one before ----------
  const rows = (ordersRange.data ?? []) as { created_at: string; country: string }[];
  const inRange = rows.filter((o) => o.created_at >= start);
  const byDay = new Map<string, number>();
  for (const o of rows) byDay.set(dayKey(new Date(o.created_at)), (byDay.get(dayKey(new Date(o.created_at))) ?? 0) + 1);
  const series = Array.from({ length: chartDays }, (_, i) => byDay.get(dayKey(new Date(now - (chartDays - 1 - i) * 864e5))) ?? 0);
  const avgDaily = inRange.length / days;
  const prevAvg = (prevCount.count ?? 0) / days;
  const change = prevAvg ? ((avgDaily - prevAvg) / prevAvg) * 100 : null;

  // ---------- Fulfilment: open orders whose every product is physically in stock ----------
  const open = (openOrders.data ?? []) as (OrderLite & { order_items: { product_id: string }[] })[];
  const short = new Set(products.filter((p) => p.on_hand - p.quarantined < p.reserved).map((p) => p.id));
  const blocked = open.filter((o) => o.order_items.some((i) => short.has(i.product_id)));
  const fulfilRate = open.length ? ((open.length - blocked.length) / open.length) * 100 : 100;

  // ---------- Delivery ----------
  const trips = ((delivered.data ?? []) as { shipped_at: string; delivered_at: string }[]).map((o) => (Date.parse(o.delivered_at) - Date.parse(o.shipped_at)) / 864e5);
  const avgTrip = trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : null;
  const onTime = trips.length ? (trips.filter((d) => d <= 9).length / trips.length) * 100 : null;

  // ---------- Stock health ----------
  const health = products.map((p) => ({ p, r: runway(p, sales30.get(p.id) ?? 0) }));
  const reorder = health.filter((x) => x.r.health === 'critical' || x.r.health === 'out').sort((a, b) => (a.r.days ?? -1) - (b.r.days ?? -1));
  const noCustoms = products.filter((p) => !p.hs_code || !Number(p.customs_value));
  const quarantined = products.reduce((a, p) => a + p.quarantined, 0);
  const best = products.map((p) => ({ p, n: salesRange.get(p.id) ?? 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5);

  // ---------- Issues ----------
  const onHold = open.filter((o) => o.status === 'on_hold');
  const today = new Date().toISOString().slice(0, 10);
  const activeIn = (inbounds.data ?? []) as { id: string; ref: string; status: string; eta: string | null; supplier: string | null; org_id: string; inbound_items: { expected: number }[] }[];
  const lateIn = activeIn.filter((b) => b.eta && b.eta < today);
  const critical = onHold.length + reorder.length + lateIn.length + (noCustoms.length ? 1 : 0) + (quarantined ? 1 : 0);

  // ---------- Markets ----------
  const byCountry = new Map<string, number>();
  for (const o of inRange) byCountry.set(o.country, (byCountry.get(o.country) ?? 0) + 1);
  const markets = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const orders = (latest.data ?? []) as OrderLite[];
  const ownerView = ctx.backOffice && (ctx.staffRole === 'owner' || ctx.staffRole === 'manager');
  const { data: pendingLinks } = ownerView ? await sb.from('access_links').select('*').order('created_at', { ascending: false }).limit(10) : { data: [] as AccessLink[] };
  const pending = (pendingLinks ?? []) as AccessLink[];
  const who = ctx.backOffice ? 'the warehouse' : ctx.org?.name;
  const dateLine = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(new Date());
  const rlabel = range === 'today' ? 'today' : `${days} days`;
  const ageDays = (iso: string) => Math.max(0, Math.floor((now - Date.parse(iso)) / 864e5));

  return (
    <>
      <div className="ep-home-head">
        <div>
          <p className="ep-crumb">{dateLine}</p>
          <h1>{greeting()}, {ctx.viewingAs ? ctx.org?.name : ctx.name.split(' ')[0]}</h1>
          <p>
            Here’s where {who} stands {range === 'today' ? 'today' : `over the last ${days} days`}:{' '}
            {critical ? <a href="#attention" className="ep-crit">{critical} item{critical === 1 ? '' : 's'} need{critical === 1 ? 's' : ''} attention.</a> : <span className="ep-good">everything is on track.</span>}
          </p>
        </div>
      </div>
      <div className="ep-home-bar">
        <nav className="ep-range" aria-label="Period">
          {(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((k) => <Link key={k} href={k === '30d' ? '/' : `/?r=${k}`} className={range === k ? 'is-on' : ''}>{k === 'today' && <i />}{RANGE_LABEL[k]}</Link>)}
        </nav>
        <div className="ep-actions">
          {ctx.can('orders.create') && !ctx.backOffice && <Link className="ep-btn ep-btn--ghost" href="/orders/new">New order</Link>}
          {ctx.can('inbounds.create') && <Link className="ep-btn" href="/inbounds/new">New inbound <Arrow /></Link>}
        </div>
      </div>

      {!ctx.backOffice && (sp.welcome || products.length === 0) && (
        <div className="ep-welcome">
          <div>
            <p className="ep-eyebrow"><i />Getting started</p>
            <h2>Three steps to your first parcel.</h2>
          </div>
          <ol>
            <li className={products.length ? 'done' : ''}><b>Add your products</b><span>SKU, weight, HS code and customs value.</span><Link href="/inventory/new">Add a product</Link></li>
            <li className={everInbounds.count ? 'done' : ''}><b>Announce your stock</b><span>Tell us what your factory is sending.</span><Link href="/inbounds/new">Announce an inbound</Link></li>
            <li className={orders.length ? 'done' : ''}><b>Send your first order</b><span>We pick, pack and ship it.</span><Link href="/orders/new">Create an order</Link></li>
          </ol>
        </div>
      )}

      <div className="ep-home-kpis">
        <section className="ep-card ep-hk">
          <div className="ep-hk-head"><small>{range === 'today' ? 'Orders today' : `Avg daily orders · ${RANGE_LABEL[range]}`}</small></div>
          <div className="ep-hk-val">
            <b>{range === 'today' ? inRange.length : avgDaily.toFixed(1)}</b>
            {change !== null && <em className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '↗' : '↘'} {change >= 0 ? '+' : ''}{change.toFixed(1)}%</em>}
          </div>
          <Spark values={series} />
          <span className="ep-hk-foot">{inRange.length.toLocaleString('en')} orders in {rlabel}{change === null ? '' : ` · vs previous ${rlabel}`}</span>
        </section>

        <section className="ep-card ep-hk">
          <div className="ep-hk-head"><small>Fulfilment rate · open orders</small></div>
          <div className="ep-hk-val">
            <b className={fulfilRate < 95 ? 'ep-warn' : ''}>{fulfilRate.toFixed(1)}%</b>
            {blocked.length > 0 && <em className="down">{blocked.length} waiting for stock</em>}
          </div>
          <div className="ep-meter"><i style={{ width: `${fulfilRate}%` }} /><s style={{ left: '99%' }} /></div>
          <span className="ep-hk-foot ep-hk-split"><span>{open.length ? `${open.length - blocked.length} of ${open.length} can ship from stock` : 'No open orders'}</span><span>Target 99%</span></span>
          <div className="ep-hk-mini">
            <span><b>{avgTrip !== null ? `${avgTrip.toFixed(1)} d` : '—'}</b> avg delivery</span>
            <span><b>{onTime !== null ? `${onTime.toFixed(0)}%` : '—'}</b> within 9 days</span>
          </div>
        </section>

        <section className="ep-card ep-hk">
          <div className="ep-hk-head">
            <small>Ready to reorder</small>
            {reorder.length > 0 && ctx.can('inbounds.create') && <Link className="ep-chip" href="/inbounds/new">New inbound · {reorder.length}</Link>}
          </div>
          {reorder.length === 0 ? (
            <div className="ep-hk-ok"><b>Stock is healthy</b><span>No SKU has under 3 weeks of stock.</span></div>
          ) : (
            <ul className="ep-reorder">
              {reorder.slice(0, 3).map(({ p, r }) => (
                <li key={p.id}>
                  <Link href={`/inventory/${p.id}`}><b>{p.name}</b><small>{p.sku}{ctx.backOffice ? ` · ${names[p.org_id]}` : ''}</small></Link>
                  <span className="ep-days">{r.health === 'out' ? 'Out' : fmtDays(r.days)}</span>
                  <span className="ep-rec"><small>Recommend</small><b>{r.reorder >= 1000 ? `${(r.reorder / 1000).toFixed(1)}K` : r.reorder}</b></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="ep-card">
        <div className="ep-card-head">
          <h2 className="ep-h-ic">Best sellers</h2>
          <span className="ep-muted ep-small">{range === 'today' ? 'Today' : `Last ${days} days`} · top 5 · <Link href="/inventory?sort=sales">Open inventory →</Link></span>
        </div>
        {best.length === 0 ? <Empty title="No sales yet in this period" text="Your best-selling SKUs show here once orders ship." /> : (
          <ol className="ep-best">
            {best.map(({ p, n }, i) => (
              <li key={p.id}>
                <span className="ep-rank">{i + 1}</span>
                <span className="ep-prod-ic" aria-hidden="true">{p.sku.slice(0, 2)}</span>
                <Link href={`/inventory/${p.id}`}><b>{p.name}</b><small>{p.sku}</small></Link>
                <span className="ep-best-n"><b>{n.toLocaleString('en')}</b><small>units</small></span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="ep-grid2 ep-grid2--wide" id="attention">
        <section className="ep-card">
          <div className="ep-card-head"><h2>What needs attention</h2><span className="ep-muted ep-small">{critical ? <><b className="ep-crit">{critical}</b> open</> : 'All clear'}</span></div>
          <div className="ep-issues">
            <Link href="/orders?s=on_hold" className={onHold.length ? 'is-on' : ''}><b>{onHold.length}</b><span>On hold</span><small>orders waiting</small></Link>
            <Link href="/inventory?f=reorder" className={reorder.length ? 'is-on' : ''}><b>{reorder.length}</b><span>Reorder</span><small>under 3 weeks</small></Link>
            <Link href="/inbounds?t=late" className={lateIn.length ? 'is-on' : ''}><b>{lateIn.length}</b><span>Late inbounds</span><small>past ETA</small></Link>
            <Link href="/inventory" className={noCustoms.length ? 'is-on' : ''}><b>{noCustoms.length}</b><span>Customs info</span><small>HS code missing</small></Link>
            <Link href="/inventory?f=quarantine" className={quarantined ? 'is-on' : ''}><b>{quarantined}</b><span>Quarantine</span><small>units set aside</small></Link>
            <Link href="/support" className={tickets.count ? 'is-on is-soft' : ''}><b>{tickets.count ?? 0}</b><span>Tickets</span><small>waiting reply</small></Link>
          </div>
          {onHold.length > 0 && (
            <>
              <p className="ep-sub">Most urgent · oldest on hold</p>
              <ul className="ep-urgent">
                {onHold.slice(0, 3).map((o) => (
                  <li key={o.id}>
                    <Link href={`/orders/${o.id}`}><b>#{o.number}</b><span>{o.customer}{ctx.backOffice ? ` · ${names[o.org_id]}` : ''}</span></Link>
                    <span className="ep-late">{o.hold_reason || 'On hold'}</span>
                    <small>{ageDays(o.created_at)}d</small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="ep-card">
          <div className="ep-card-head"><h2>Stock inbounds</h2><Link href="/inbounds">Open inbounds →</Link></div>
          {activeIn.length === 0 ? (
            <div className="ep-allgood"><b>All inbounds delivered</b><span>Nothing on the way right now.</span></div>
          ) : (
            <ul className="ep-in-list">
              {activeIn.slice(0, 4).map((b) => {
                const late = b.eta && b.eta < today;
                return (
                  <li key={b.id}>
                    <Link href={`/inbounds/${b.id}`}>
                      <b className="ep-mono">{b.ref}</b>
                      <small>{b.inbound_items.reduce((a, i) => a + i.expected, 0).toLocaleString('en')} units{ctx.backOffice ? ` · ${names[b.org_id]}` : b.supplier ? ` · ${b.supplier}` : ''}</small>
                    </Link>
                    <MiniSteps status={b.status} overdue={!!late} />
                    <small className={late ? 'ep-late' : ''}>{b.eta ? `${late ? 'Late · ' : 'ETA '}${fmtDate(b.eta)}` : 'No ETA'}</small>
                  </li>
                );
              })}
              {activeIn.length > 4 && <li className="ep-more"><Link href="/inbounds?t=active">+{activeIn.length - 4} more on the way</Link></li>}
            </ul>
          )}
        </section>
      </div>

      <div className="ep-grid2 ep-grid2--wide">
        <section className="ep-card">
          <div className="ep-card-head"><h2>Top markets</h2><span className="ep-muted ep-small">{RANGE_LABEL[range]} · {inRange.length.toLocaleString('en')} orders</span></div>
          {markets.length === 0 ? <Empty title="No orders in this period" text="Where your orders go will show here." /> : (
            <ul className="ep-markets">
              {markets.map(([c, n]) => (
                <li key={c}>
                  <span>{COUNTRIES[c] ?? c}</span>
                  <b>{n.toLocaleString('en')}</b>
                  <small>{((n / inRange.length) * 100).toFixed(1)}%</small>
                  <div className="ep-meter ep-meter--thin"><i style={{ width: `${(n / markets[0][1]) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ep-card">
          <div className="ep-card-head"><h2>Latest orders</h2><Link href="/orders">All orders →</Link></div>
          {orders.length === 0 ? <Empty title="No orders yet" text="Orders will appear here." /> : (
            <table className="ep-table">
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} data-href={`/orders/${o.id}`}>
                    <td><b>#{o.number}</b><small>{o.customer}{ctx.backOffice ? ` · ${names[o.org_id]}` : ''}</small></td>
                    <td><small>{[o.city, COUNTRIES[o.country] ?? o.country].filter(Boolean).join(', ')}</small></td>
                    <td className="ep-right"><Badge map={ORDER_STATUS} value={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {pending.length > 0 && (
        <section className="ep-card ep-card--hl">
          <div className="ep-card-head"><h2>Waiting to sign in</h2><span className="ep-muted ep-small">Invitation links only you and managers can see</span></div>
          <div className="ep-pending-list">
            {pending.map((l) => (
              <div key={l.user_id}>
                <b>{l.email}{l.org_id && names[l.org_id] ? <> · <Link href={`/clients/${l.org_id}`}>{names[l.org_id]}</Link></> : ' · your team'}</b>
                <PendingLink link={l} />
              </div>
            ))}
          </div>
        </section>
      )}

      {ctx.backOffice && (activity.data ?? []).length > 0 && (
        <section className="ep-card">
          <div className="ep-card-head"><h2>Latest activity</h2><Link href="/activity">All activity →</Link></div>
          <ul className="ep-activity">
            {(activity.data ?? []).map((a) => (
              <li key={a.id}><b>{ACTIVITY_LABELS[a.action] ?? a.action}</b><span>{[a.org_id ? names[a.org_id] : '', a.detail].filter(Boolean).join(' · ')}</span><small>{fmtDate(a.created_at, true)}</small></li>
            ))}
          </ul>
        </section>
      )}

      <p className="ep-small ep-muted ep-foot-note">
        Runway uses the last 30 days of shipments. Reorder suggestions cover 60 days of sales, minus what is already sellable or on its way. Status legend: {Object.values(HEALTH).map(([l]) => l).join(' · ')}.
      </p>
    </>
  );
}
