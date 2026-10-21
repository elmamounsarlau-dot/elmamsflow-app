import Link from 'next/link';
import { PendingLink } from '@/components/access';
import type { AccessLink } from '@/lib/invite';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { available, getProducts, orgNames } from '@/lib/data';
import { fmtDate, greeting, ORDER_STATUS } from '@/lib/format';
import { ACTIVITY_LABELS } from '@/lib/log';
import { Badge, Empty } from '@/components/ui';
import { DailyOrders } from '@/components/charts';

export const metadata = { title: 'Home' };

const TZ = 'Asia/Shanghai';
const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

function pct(now: number, before: number) {
  if (!before) return now ? { text: 'new today', up: true } : { text: 'same as yesterday', up: false };
  const p = ((now - before) / before) * 100;
  return { text: `${p >= 0 ? '+' : ''}${p.toFixed(1)}% vs yesterday`, up: p >= 0 };
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const sb = await supabaseServer();
  const since = new Date(Date.now() - 15 * 864e5).toISOString();
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = (q: any) => (ctx.org ? q.eq('org_id', ctx.org.id) : q);
  const headCount = (table: string) => scope(sb.from(table).select('id', { count: 'exact', head: true }));

  const [products, names, recent, delivered, latest, toShip, onHold, inboundsOpen, tickets, activity, everInbounds] = await Promise.all([
    getProducts(ctx),
    ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>),
    scope(sb.from('orders').select('created_at')).gte('created_at', since),
    scope(sb.from('orders').select('shipped_at, delivered_at')).gte('delivered_at', since30).not('shipped_at', 'is', null),
    scope(sb.from('orders').select('id, number, customer, city, country, created_at, status, org_id, carrier').order('created_at', { ascending: false }).limit(6)),
    headCount('orders').in('status', ['new', 'packed']),
    headCount('orders').eq('status', 'on_hold'),
    headCount('inbounds').neq('status', 'received'),
    headCount('tickets').eq('status', 'open'),
    ctx.backOffice ? sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(8) : Promise.resolve({ data: [] as { id: number; action: string; detail: string | null; org_id: string | null; created_at: string }[] }),
    ctx.backOffice ? Promise.resolve({ count: 1 }) : headCount('inbounds'),
  ]);
  const { data: moveData } = await scope(sb.from('stock_moves').select('id, qty, type, ref, note, source, created_at, org_id, products(sku, name)').order('created_at', { ascending: false }).limit(8));
  const moves = (moveData ?? []) as { id: number; qty: number; type: string; ref: string | null; note: string | null; source: string; created_at: string; org_id: string; products: { sku: string; name: string } | null }[];
  const MOVE: Record<string, string> = { inbound: 'Received', order: 'Shipped', adjust: 'Correction', count: 'Warehouse count', quarantine: 'To quarantine', release: 'Out of quarantine' };

  // Daily orders, last 14 days
  const byDay = new Map<string, number>();
  for (const o of (recent.data ?? []) as { created_at: string }[]) byDay.set(dayKey(new Date(o.created_at)), (byDay.get(dayKey(new Date(o.created_at))) ?? 0) + 1);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 864e5);
    return { key: dayKey(d), label: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: TZ }).format(d), count: byDay.get(dayKey(d)) ?? 0 };
  });
  const today = days[13].count;
  const yesterday = days[12].count;
  const trend = pct(today, yesterday);

  // Delivery: average days door to door, and share delivered within 9 days (our 3–9 day promise)
  const trips: number[] = ((delivered.data ?? []) as { shipped_at: string; delivered_at: string }[]).map((o) => (Date.parse(o.delivered_at) - Date.parse(o.shipped_at)) / 864e5);
  const avg = trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : null;
  const onTime = trips.length ? (trips.filter((d) => d <= 9).length / trips.length) * 100 : null;

  const low = products.filter((p) => available(p) <= p.low_stock);
  const totalAvailable = products.reduce((a, p) => a + available(p), 0);
  const inQuarantine = products.filter((p) => p.quarantined > 0);
  const quarantinedUnits = inQuarantine.reduce((a, p) => a + p.quarantined, 0);
  const orders = (latest.data ?? []) as { id: string; number: string; customer: string; city: string | null; country: string; created_at: string; status: string; org_id: string; carrier: string | null }[];
  const ownerView = ctx.backOffice && (ctx.staffRole === 'owner' || ctx.staffRole === 'manager');
  const { data: pendingLinks } = ownerView ? await sb.from('access_links').select('*').order('created_at', { ascending: false }).limit(10) : { data: [] as AccessLink[] };
  const pending = (pendingLinks ?? []) as AccessLink[];
  const who = ctx.backOffice ? 'Elmamsflow back office' : ctx.org?.name;
  const dateLine = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).format(new Date());

  const attention: [string, number, string, string][] = ctx.backOffice
    ? [
        ['Orders to ship', toShip.count ?? 0, '/orders?s=new', 'go'],
        ['On hold', onHold.count ?? 0, '/orders?s=on_hold', 'warn'],
        ['Inbounds expected', inboundsOpen.count ?? 0, '/inbounds', 'pk'],
        ['Open tickets', tickets.count ?? 0, '/support', 'warn'],
      ]
    : [
        ['Need your action', onHold.count ?? 0, '/orders?s=on_hold', 'warn'],
        ['Low stock SKUs', low.length, '/inventory', 'warn'],
        ['Inbounds on the way', inboundsOpen.count ?? 0, '/inbounds', 'pk'],
        ['Open tickets', tickets.count ?? 0, '/support', 'go'],
      ];

  return (
    <>
      <div className="ep-hello2">
        <small>{dateLine} · {who}</small>
        <b>{greeting()}, {ctx.viewingAs ? ctx.org?.name : ctx.name.split(' ')[0]}</b>
        <span>{ctx.backOffice ? 'Here’s the warehouse today, across every client.' : 'Here’s where your operation stands today.'}</span>
      </div>

      {!ctx.backOffice && (sp.welcome || products.length === 0) && (
        <div className="ep-welcome">
          <div>
            <p className="ep-eyebrow"><i />Getting started</p>
            <h2>Three steps to your first parcel.</h2>
          </div>
          <ol>
            <li className={products.length ? 'done' : ''}><b>Add your products</b><span>SKU, weight, HS code and customs value.</span><Link href="/inventory?new=1">Add a product</Link></li>
            <li className={everInbounds.count ? 'done' : ''}><b>Announce your stock</b><span>Tell us what your factory is sending.</span><Link href="/inbounds/new">Announce an inbound</Link></li>
            <li className={orders.length ? 'done' : ''}><b>Send your first order</b><span>We pick, pack and ship it.</span><Link href="/orders/new">Create an order</Link></li>
          </ol>
        </div>
      )}

      <div className="ep-kpis ep-kpis--3">
        <div className="ep-kpi">
          <small>Orders today</small>
          <b>{today}</b>
          <em className={trend.up ? 'up' : ''}>{trend.text}</em>
        </div>
        <div className="ep-kpi">
          <small>Avg. delivery</small>
          <b>{avg ? <>{avg.toFixed(1)} <i>days</i></> : '—'}</b>
          <em>{avg ? 'Door to door, last 30 days' : 'Shows after the first deliveries'}</em>
        </div>
        <div className="ep-kpi">
          <small>On-time rate</small>
          <b>{onTime !== null ? `${onTime.toFixed(1)}%` : '—'}</b>
          <em className={onTime !== null && onTime >= 95 ? 'up' : ''}>{onTime !== null ? 'Delivered within 9 days' : 'Our promise: 3–9 days'}</em>
        </div>
      </div>

      <DailyOrders days={days} />

      <h2 className="ep-section-title">Inventory</h2>
      <div className="ep-kpis ep-kpis--4">
        <Link className="ep-kpi" href="/inventory"><small>Available stock</small><b>{totalAvailable.toLocaleString('en')} <i>units</i></b><em>{products.length ? `${products.length} SKU${products.length === 1 ? '' : 's'}` : 'No products yet'}</em></Link>
        <Link className="ep-kpi" href="/inventory"><small>Low stock</small><b className={low.length ? 'ep-warn' : ''}>{low.length}</b><em>{low.length ? 'At or below their alert level' : 'Nothing below its alert level'}</em></Link>
        <Link className="ep-kpi" href="/inbounds"><small>Pending receipts</small><b>{inboundsOpen.count ?? 0}</b><em>Announced, on the way or being received</em></Link>
        <Link className={`ep-kpi${quarantinedUnits ? ' ep-kpi--alert' : ''}`} href="/inventory"><small>Quarantine</small><b>{quarantinedUnits.toLocaleString('en')} <i>units</i></b><em>{quarantinedUnits ? `${inQuarantine.length} SKU${inQuarantine.length === 1 ? '' : 's'} need a decision` : 'Nothing set aside'}</em></Link>
      </div>

      <div className="ep-attn">
        {attention.map(([l, n, h, tone]) => (
          <Link key={l} href={h} className={n ? `is-${tone}` : ''}>
            <b>{n}</b>
            <span>{l}</span>
          </Link>
        ))}
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

      <section className="ep-card">
        <div className="ep-card-head"><h2>Recent stock movements</h2><Link href="/inventory">Inventory</Link></div>
        {moves.length === 0 ? <Empty title="No movements yet" text="Receipts, shipments, counts and corrections will appear here as they are recorded." /> : (
          <table className="ep-table">
            <thead><tr><th>When</th><th>Product</th>{ctx.backOffice && <th>Client</th>}<th>Movement</th><th>Reference</th><th>Source</th><th className="ep-right">Units</th></tr></thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id}>
                  <td><small>{fmtDate(m.created_at, true)}</small></td>
                  <td><b>{m.products?.sku}</b><small>{m.products?.name}</small></td>
                  {ctx.backOffice && <td>{names[m.org_id]}</td>}
                  <td>{MOVE[m.type] ?? m.type}</td>
                  <td>{m.ref || <span className="ep-muted">{m.note?.slice(0, 40) || '—'}</span>}</td>
                  <td><small>{m.source === 'csv' ? 'CSV import' : m.source === 'warehouse' ? 'Warehouse confirmed' : 'Entered in app'}</small></td>
                  <td className="ep-right"><b className={['quarantine', 'release'].includes(m.type) ? 'ep-q' : m.qty < 0 ? 'ep-neg' : 'ep-pos'}>{m.qty > 0 ? '+' : ''}{m.qty}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="ep-grid2">
        <section className="ep-card">
          <div className="ep-card-head"><h2>Latest orders</h2><Link href="/orders">All orders</Link></div>
          {orders.length === 0 ? <Empty title="No orders yet" text="Orders will appear here." /> : (
            <table className="ep-table">
              <thead><tr><th>Order</th>{ctx.backOffice && <th>Client</th>}<th>Destination</th><th>Created</th><th>Status</th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} data-href={`/orders/${o.id}`}>
                    <td><b>#{o.number}</b><small>{o.customer}</small></td>
                    {ctx.backOffice && <td>{names[o.org_id]}</td>}
                    <td>{[o.city, o.country].filter(Boolean).join(', ')}</td>
                    <td>{fmtDate(o.created_at)}</td>
                    <td><Badge map={ORDER_STATUS} value={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="ep-card">
          <div className="ep-card-head"><h2>{ctx.backOffice ? 'Latest activity' : 'Ready to reorder'}</h2></div>
          {ctx.backOffice ? (
            (activity.data ?? []).length === 0 ? <Empty title="Nothing yet" text="Actions by your team and your clients show here." /> : (
              <ul className="ep-activity">
                {(activity.data ?? []).map((a) => (
                  <li key={a.id}><b>{ACTIVITY_LABELS[a.action] ?? a.action}</b><span>{[a.org_id ? names[a.org_id] : '', a.detail].filter(Boolean).join(' · ')}</span><small>{fmtDate(a.created_at, true)}</small></li>
                ))}
              </ul>
            )
          ) : low.length === 0 ? <Empty title="All good" text={products.length ? 'No product is below its low-stock level.' : 'Add products to see stock alerts here.'} /> : (
            <ul className="ep-list">
              {low.slice(0, 6).map((p) => (
                <li key={p.id}><span><b>{p.sku}</b> {p.name}</span><span className="ep-st ep-st--warn">{available(p)} left</span></li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
