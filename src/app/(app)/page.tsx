import { redirect } from 'next/navigation';
import { isOwner, seesBusiness, shippingOnly } from '@/lib/session';
import Link from 'next/link';
import { PendingLink } from '@/components/access';
import type { AccessLink } from '@/lib/invite';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { allRows, getProducts, orgNames } from '@/lib/data';
import { fmtDays, HEALTH, RANGE_LABEL, RANGES, rangeOf, runway, salesByProduct } from '@/lib/insights';
import { countryName, fmtDate, greeting, ORDER_STATUS } from '@/lib/format';
import { ACTIVITY_LABELS } from '@/lib/log';
import { Arrow, Badge, Empty } from '@/components/ui';
import { Spark } from '@/components/charts';
import { MiniSteps } from '@/components/steps';
import { NoticeCard } from '@/components/notices';
import { getNotices } from '@/lib/notifications';
import { money } from '@/lib/billing';

export const metadata = { title: 'Home' };

const TZ = 'Asia/Shanghai';
const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const OPEN = ['new', 'on_hold', 'packed'];

type OrderLite = { id: string; number: string; customer: string; country: string; city: string | null; created_at: string; status: string; org_id: string; hold_reason: string | null };

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  if (shippingOnly(ctx)) redirect('/shipping');
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
    allRows(() => scope(sb.from('orders').select('created_at, country').gte('created_at', new Date(now - chartDays * 864e5).toISOString()).order('created_at').order('id'))).then((data) => ({ data })),
    headCount('orders').gte('created_at', prevStart).lt('created_at', start),
    allRows(() => scope(sb.from('orders').select('shipped_at, delivered_at')).gte('delivered_at', start).not('shipped_at', 'is', null).order('id')).then((data) => ({ data })),
    allRows(() => scope(sb.from('orders').select('id, number, customer, country, city, created_at, status, org_id, hold_reason, order_items(product_id)').in('status', OPEN).order('created_at').order('id'))).then((data) => ({ data })),
    scope(sb.from('inbounds').select('id, ref, status, eta, supplier, org_id, inbound_items(expected)').neq('status', 'received').order('eta', { ascending: true, nullsFirst: false }).limit(50)),
    headCount('tickets').eq('status', 'open'),
    scope(sb.from('orders').select('id, number, customer, city, country, created_at, status, org_id, hold_reason').order('created_at', { ascending: false }).limit(6)),
    isOwner(ctx) ? sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(8) : Promise.resolve({ data: [] as { id: number; action: string; detail: string | null; org_id: string | null; created_at: string }[] }),
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
  // Back office: invoices waiting to be issued (drafts) or chased (overdue). Client: everything to act on.
  const billing = ctx.backOffice && ctx.can('invoices.view');
  type Inv = { id: string; number: string; org_id: string; status: string; total: number; currency: string; period_start: string; due_date: string | null };
  const invRows = billing
    ? (((await sb.from('invoices').select('id, number, org_id, status, total, currency, period_start, due_date').or(`status.eq.draft,and(status.eq.open,due_date.lt.${new Date().toISOString().slice(0, 10)})`).order('period_start', { ascending: false }).limit(50)).data ?? []) as Inv[])
    : [];
  const drafts = invRows.filter((i) => i.status === 'draft');
  const overdue = invRows.filter((i) => i.status === 'open');
  const notices = ctx.org ? await getNotices(ctx) : [];
  const ownerView = ctx.backOffice && (ctx.staffRole === 'owner' || ctx.staffRole === 'manager');
  const { data: pendingLinks } = ownerView ? await sb.from('access_links').select('*').order('created_at', { ascending: false }).limit(10) : { data: [] as AccessLink[] };
  const pending = (pendingLinks ?? []) as AccessLink[];
  const who = ctx.backOffice ? 'the warehouse' : ctx.org?.name;
  const dateLine = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(new Date());
  const rlabel = range === 'today' ? 'today' : `${days} days`;
  const ageDays = (iso: string) => Math.max(0, Math.floor((now - Date.parse(iso)) / 864e5));

  const issues = [
    { href: '/orders?t=attention', n: onHold.length, label: 'Orders on hold', hint: 'waiting for a fix', tone: 'err', icon: 'hold' as const },
    { href: '/inventory?f=reorder', n: reorder.length, label: 'Reorder', hint: 'under 3 weeks of stock', tone: 'err', icon: 'box' as const },
    { href: '/inbounds?t=late', n: lateIn.length, label: 'Late inbounds', hint: 'past their ETA', tone: 'err', icon: 'truck' as const },
    { href: '/inventory?f=customs', n: noCustoms.length, label: 'Customs info', hint: 'HS code or value missing', tone: 'warn', icon: 'doc' as const },
    { href: '/inventory?f=quarantine', n: quarantined, label: 'Quarantine', hint: 'units set aside', tone: 'warn', icon: 'shield' as const },
    { href: '/support', n: tickets.count ?? 0, label: 'Open tickets', hint: 'waiting for a reply', tone: 'blue', icon: 'chat' as const },
  ];

  const latestCard = (
    <section className="ep-bcard ep-bcard--flush">
      <div className="ep-bhead ep-pad"><span className="ep-bic ep-bic--blue"><HIcon d="orders" /></span><h2>Latest orders</h2><Link className="ep-blink" href="/orders">All orders →</Link></div>
      {orders.length === 0 ? <Empty title="No orders yet" text="Orders will appear here." /> : (
        <table className="ep-table ep-htable">
          <thead><tr><th>Order</th><th>Customer</th><th>Destination</th><th className="ep-right">Status</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} data-href={`/orders/${o.id}`}>
                <td><b>#{o.number}</b><small>{fmtDate(o.created_at)}</small></td>
                <td>{o.customer}{ctx.backOffice && <small>{names[o.org_id]}</small>}</td>
                <td>{countryName(o.country)}{o.city && <small>{o.city}</small>}</td>
                <td className="ep-right"><Badge map={ORDER_STATUS} value={o.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
  const invoiceCard = (
    <section className={`ep-bcard ep-bcard--flush${drafts.length || overdue.length ? ' ep-card--hl' : ''}`}>
      <div className="ep-bhead ep-pad"><span className="ep-bic ep-bic--orange"><HIcon d="doc" /></span><h2>Invoices to send</h2><span className="ep-btag">{drafts.length} to issue{overdue.length ? ` · ${overdue.length} overdue` : ''}</span><Link className="ep-blink" href="/invoices">All invoices →</Link></div>
      {drafts.length + overdue.length === 0 ? (
        <div className="ep-pad" style={{ paddingTop: 0 }}><div className="ep-hk-ok"><b>Nothing to send</b><span>Drafts for last month appear here on the 1st. Review and issue them.</span></div></div>
      ) : (
        <table className="ep-table ep-htable">
          <thead><tr><th>Invoice</th><th>Client</th><th className="ep-right">Amount</th><th className="ep-right">Next step</th></tr></thead>
          <tbody>
            {[...overdue, ...drafts].slice(0, 6).map((i) => (
              <tr key={i.id} data-href={`/invoices/${i.id}`}>
                <td><b className="ep-mono">{i.number}</b><small>{new Date(i.period_start).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</small></td>
                <td>{names[i.org_id] ?? '—'}</td>
                <td className="ep-right"><b>{money(Number(i.total), i.currency)}</b></td>
                <td className="ep-right">{i.status === 'draft' ? <span className="ep-st ep-st--warn">Review &amp; issue</span> : <span className="ep-st ep-st--err">Overdue · remind</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {drafts.length + overdue.length > 6 && <p className="ep-small ep-pad" style={{ paddingTop: 0 }}><Link href="/invoices">+{drafts.length + overdue.length - 6} more</Link></p>}
    </section>
  );

  return (
    <div className="ep-home">
      <header className="ep-home-top">
        <div className="ep-home-head">
          <p className="ep-crumb">{dateLine}</p>
          <h1>{greeting()}, {ctx.viewingAs ? ctx.org?.name : ctx.name.split(' ')[0]}</h1>
          <p>
            Here’s where {who} stands {range === 'today' ? 'today' : `over the last ${days} days`}:{' '}
            {critical ? <a href="#attention" className="ep-crit">{critical} item{critical === 1 ? '' : 's'} need{critical === 1 ? 's' : ''} attention.</a> : <span className="ep-good">everything is on track.</span>}
          </p>
        </div>
        <div className="ep-home-side">
          <nav className="ep-range" aria-label="Period">
            {(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((k) => <Link key={k} href={k === '30d' ? '/' : `/?r=${k}`} className={range === k ? 'is-on' : ''}>{k === 'today' && <i />}{RANGE_LABEL[k]}</Link>)}
          </nav>
          <div className="ep-actions">
            {ctx.can('orders.create') && !ctx.backOffice && <Link className="ep-btn ep-btn--ghost" href="/orders/new">New order</Link>}
            {ctx.can('inbounds.create') && <Link className="ep-btn" href="/inbounds/new">New inbound <Arrow /></Link>}
          </div>
        </div>
      </header>

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

      <section className="ep-hstrip" id="attention" aria-label="What needs attention">
        {issues.map((x) => (
          <Link key={x.label} href={x.href} className={`ep-htile${x.n ? ` is-${x.tone}` : ''}`}>
            <span className="ep-htile-ic"><HIcon d={x.icon} /></span>
            <span className="ep-htile-txt"><b>{x.label}</b><small>{x.n ? x.hint : 'all clear'}</small></span>
            <em>{x.n.toLocaleString('en')}</em>
          </Link>
        ))}
      </section>

      <div className="ep-home-kpis">
        <section className="ep-bcard ep-hk">
          <div className="ep-bhead"><span className="ep-bic ep-bic--blue"><HIcon d="chart" /></span><h2>{range === 'today' ? 'Orders today' : 'Avg daily orders'}</h2><span className="ep-btag">{RANGE_LABEL[range]}</span></div>
          <div className="ep-hk-val">
            <b>{range === 'today' ? inRange.length : avgDaily.toFixed(1)}</b>
            {change !== null && <em className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '↗' : '↘'} {change >= 0 ? '+' : ''}{change.toFixed(1)}%</em>}
          </div>
          <Spark values={series} />
          <span className="ep-hk-foot">{inRange.length.toLocaleString('en')} orders in {rlabel}{change === null ? '' : ` · vs previous ${rlabel}`}</span>
        </section>

        <section className="ep-bcard ep-hk">
          <div className="ep-bhead"><span className="ep-bic ep-bic--orange"><HIcon d="box" /></span><h2>Fulfilment rate</h2><span className="ep-btag">Open orders</span></div>
          <div className="ep-hk-val">
            <b className={fulfilRate < 95 ? 'ep-warn' : ''}>{fulfilRate.toFixed(1)}%</b>
            {blocked.length > 0 && <em className="down">{blocked.length} waiting for stock</em>}
          </div>
          <div className="ep-meter"><i style={{ width: `${fulfilRate}%` }} /><s style={{ left: '99%' }} /></div>
          <span className="ep-hk-foot ep-hk-split"><span>{open.length ? `${open.length - blocked.length} of ${open.length} can ship from stock` : 'No open orders'}</span><span>Target 99%</span></span>
        </section>

        <section className="ep-bcard ep-hk">
          <div className="ep-bhead"><span className="ep-bic ep-bic--green"><HIcon d="truck" /></span><h2>Delivery</h2><span className="ep-btag">{RANGE_LABEL[range]}</span></div>
          <div className="ep-hk-val">
            <b>{avgTrip !== null ? avgTrip.toFixed(1) : '—'}<i className="ep-hk-unit">{avgTrip !== null ? ' days' : ''}</i></b>
          </div>
          <div className="ep-meter ep-meter--ok"><i style={{ width: `${onTime ?? 0}%` }} /></div>
          <span className="ep-hk-foot ep-hk-split"><span>{onTime !== null ? `${onTime.toFixed(0)}% delivered within 9 days` : 'No deliveries in this period'}</span><span>{trips.length.toLocaleString('en')} delivered</span></span>
        </section>
      </div>

      <div className="ep-hmain">
        <div className="ep-hcol">
          {billing && invoiceCard}
          {latestCard}

          {seesBusiness(ctx) && (
            <>
          <section className="ep-bcard">
            <div className="ep-bhead"><span className="ep-bic ep-bic--orange"><HIcon d="star" /></span><h2>Best sellers</h2><span className="ep-btag">{range === 'today' ? 'Today' : `Last ${days} days`}</span><Link className="ep-blink" href="/inventory?sort=sales">Inventory →</Link></div>
            {best.length === 0 ? <Empty title="No sales yet in this period" text="Your best-selling SKUs show here once orders ship." /> : (
              <ol className="ep-hbest">
                {best.map(({ p, n }, i) => (
                  <li key={p.id}>
                    <span className="ep-rank">{i + 1}</span>
                    <Link href={`/inventory/${p.id}`}><b>{p.name}</b><small>{p.sku}</small></Link>
                    <div className="ep-meter ep-meter--thin"><i style={{ width: `${(n / best[0].n) * 100}%` }} /></div>
                    <span className="ep-best-n"><b>{n.toLocaleString('en')}</b><small>units</small></span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="ep-bcard">
            <div className="ep-bhead"><span className="ep-bic ep-bic--violet"><HIcon d="globe" /></span><h2>Top markets</h2><span className="ep-btag">{inRange.length.toLocaleString('en')} orders</span></div>
            {markets.length === 0 ? <Empty title="No orders in this period" text="Where your orders go will show here." /> : (
              <ul className="ep-markets">
                {markets.map(([c, n]) => (
                  <li key={c}>
                    <span>{countryName(c)}</span>
                    <b>{n.toLocaleString('en')}</b>
                    <small>{((n / inRange.length) * 100).toFixed(1)}%</small>
                    <div className="ep-meter ep-meter--thin"><i style={{ width: `${(n / markets[0][1]) * 100}%` }} /></div>
                  </li>
                ))}
              </ul>
            )}
          </section>
            </>
          )}
        </div>

        <aside className="ep-hcol">
          {ctx.org && <NoticeCard list={notices} />}
          {!ctx.org && onHold.length > 0 && (
            <section className="ep-bcard ep-bcard--alert">
              <div className="ep-bhead"><span className="ep-bic ep-bic--red"><HIcon d="hold" /></span><h2>On hold</h2><Link className="ep-blink" href="/orders?t=attention">Fix them →</Link></div>
              <ul className="ep-hlist">
                {onHold.slice(0, 4).map((o) => (
                  <li key={o.id}>
                    <Link href={`/orders/${o.id}`}><b>#{o.number}</b><small>{o.hold_reason || 'On hold'}</small></Link>
                    <span className="ep-hage">{ageDays(o.created_at)}d</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="ep-bcard">
            <div className="ep-bhead">
              <span className="ep-bic ep-bic--orange"><HIcon d="box" /></span><h2>Ready to reorder</h2>
              {reorder.length > 0 && ctx.can('inbounds.create') && <Link className="ep-blink" href="/inbounds/new">New inbound →</Link>}
            </div>
            {reorder.length === 0 ? (
              <div className="ep-hk-ok"><b>Stock is healthy</b><span>No SKU has under 3 weeks of stock.</span></div>
            ) : (
              <ul className="ep-reorder">
                {reorder.slice(0, 4).map(({ p, r }) => (
                  <li key={p.id}>
                    <Link href={`/inventory/${p.id}`}><b>{p.name}</b><small>{p.sku}{ctx.backOffice ? ` · ${names[p.org_id]}` : ''}</small></Link>
                    <span className="ep-days">{r.health === 'out' ? 'Out' : fmtDays(r.days)}</span>
                    <span className="ep-rec"><small>Recommend</small><b>{r.reorder >= 1000 ? `${(r.reorder / 1000).toFixed(1)}K` : r.reorder}</b></span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="ep-bcard">
            <div className="ep-bhead"><span className="ep-bic ep-bic--blue"><HIcon d="truck" /></span><h2>Stock inbounds</h2><Link className="ep-blink" href="/inbounds">Open →</Link></div>
            {activeIn.length === 0 ? (
              <div className="ep-allgood"><b>All inbounds delivered</b><span>Nothing on the way right now.</span></div>
            ) : (
              <ul className="ep-in-list ep-in-list--side">
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
        </aside>
      </div>

      {pending.length > 0 && (
        <section className="ep-bcard ep-card--hl">
          <div className="ep-bhead"><span className="ep-bic ep-bic--orange"><HIcon d="key" /></span><h2>Waiting to sign in</h2><span className="ep-btag">Only you and managers see these links</span></div>
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

      {isOwner(ctx) && (activity.data ?? []).length > 0 && (
        <section className="ep-bcard">
          <div className="ep-bhead"><span className="ep-bic ep-bic--violet"><HIcon d="pulse" /></span><h2>Latest activity</h2><Link className="ep-blink" href="/activity">All activity →</Link></div>
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
    </div>
  );
}

const HP = {
  hold: 'M7.5 5v10 M12.5 5v10',
  box: 'M3 6.5l7-3.5 7 3.5v7l-7 3.5-7-3.5v-7z M3 6.5l7 3.5 7-3.5 M10 10v7',
  truck: 'M2.5 6h9v7h-9z M11.5 9h3.5l2.5 2.5V13h-6 M5.5 15.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z M14.5 15.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z',
  doc: 'M5.5 2.5h6l3 3v12h-9z M11.5 2.5v3h3 M7.5 10h5 M7.5 13h5',
  shield: 'M10 2.5l6 2.5v4.5c0 4-2.7 6.7-6 8-3.3-1.3-6-4-6-8V5z M7.5 10l2 2 3-3.5',
  chat: 'M3.5 5.5h13v8h-7l-3.5 3v-3H3.5v-8z',
  chart: 'M3 16.5h14 M5.5 13l3-4 3 2.5 3.5-5.5',
  orders: 'M4 3.5h12v13H4z M7 7.5h6 M7 10.5h6 M7 13.5h3',
  star: 'M10 3l2.1 4.4 4.8.6-3.5 3.3.9 4.8L10 13.8 5.7 16.1l.9-4.8L3.1 8l4.8-.6z',
  globe: 'M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z M2.5 10h15 M10 2.5c2 2.2 3 4.7 3 7.5s-1 5.3-3 7.5c-2-2.2-3-4.7-3-7.5s1-5.3 3-7.5z',
  key: 'M7 12.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z M10 9h7.5 M15 9v2.5 M17.5 9v2',
  pulse: 'M2.5 10h3.5l2-4.5 4 9 2-4.5h3.5',
};
function HIcon({ d }: { d: keyof typeof HP }) {
  return <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={HP[d]} /></svg>;
}
