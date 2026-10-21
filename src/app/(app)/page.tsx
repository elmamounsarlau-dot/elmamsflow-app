import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { getProducts, orgNames } from '@/lib/data';
import { fmtDate, greeting, ORDER_STATUS } from '@/lib/format';
import { ACTIVITY_LABELS } from '@/lib/log';
import { Badge, Empty, Kpi } from '@/components/ui';

export const metadata = { title: 'Home' };

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const sb = await supabaseServer();
  const scope = <T,>(q: T) => (ctx.org ? (q as unknown as { eq: (a: string, b: string) => T }).eq('org_id', ctx.org.id) : q);
  const count = async (table: string, f: (q: any) => any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const { count: c } = await f(scope(sb.from(table).select('id', { count: 'exact', head: true })));
    return c ?? 0;
  };
  const [products, latest, names] = await Promise.all([getProducts(ctx), scope(sb.from('orders').select('id, number, customer, city, country, created_at, status, org_id').order('created_at', { ascending: false }).limit(6)), ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  const low = products.filter((p) => p.on_hand - p.reserved <= p.low_stock);
  const today = new Date(Date.now() - 864e5).toISOString();

  let kpis: [string, number, string][];
  if (ctx.backOffice) {
    kpis = [
      ['Active clients', Object.keys(names).length, '/clients'],
      ['Orders to ship', await count('orders', (q) => q.in('status', ['new', 'packed'])), '/orders?s=new'],
      ['On hold', await count('orders', (q) => q.eq('status', 'on_hold')), '/orders?s=on_hold'],
      ['Inbounds expected', await count('inbounds', (q) => q.neq('status', 'received')), '/inbounds'],
      ['Open tickets', await count('tickets', (q) => q.eq('status', 'open')), '/support'],
    ];
  } else {
    kpis = [
      ['Orders, last 24h', await count('orders', (q) => q.gte('created_at', today)), '/orders'],
      ['In transit', await count('orders', (q) => q.eq('status', 'shipped')), '/tracking'],
      ['Need your action', await count('orders', (q) => q.eq('status', 'on_hold')), '/orders?s=on_hold'],
      ['Low stock SKUs', low.length, '/inventory'],
      ['Open tickets', await count('tickets', (q) => q.neq('status', 'closed')), '/support'],
    ];
  }
  const { data: activity } = ctx.backOffice ? await sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(8) : { data: [] };
  const orders = latest.data ?? [];
  const [{ count: inbCount }, { count: ordCount }] = ctx.backOffice
    ? [{ count: 1 }, { count: 1 }]
    : await Promise.all([scope(sb.from('inbounds').select('id', { count: 'exact', head: true })), scope(sb.from('orders').select('id', { count: 'exact', head: true }))]);

  return (
    <>
      <h1 className="ep-page-title">{ctx.backOffice ? 'Overview' : 'Home'}</h1>
      <p className="ep-hello">
        {greeting()}, {ctx.viewingAs ? ctx.org?.name : ctx.name}. {ctx.backOffice ? 'Here’s the warehouse today.' : 'Here’s where your operation stands today.'}
      </p>
      {!ctx.backOffice && (sp.welcome || products.length === 0) && (
        <div className="ep-welcome">
          <div>
            <p className="ep-eyebrow"><i />Getting started</p>
            <h2>Three steps to your first parcel.</h2>
          </div>
          <ol>
            <li className={products.length ? 'done' : ''}><b>Add your products</b><span>SKU, weight, HS code and customs value.</span><Link href="/inventory?new=1">Add a product</Link></li>
            <li className={inbCount ? 'done' : ''}><b>Announce your stock</b><span>Tell us what your factory is sending.</span><Link href="/inbounds/new">Announce an inbound</Link></li>
            <li className={ordCount ? 'done' : ''}><b>Send your first order</b><span>We pick, pack and ship it.</span><Link href="/orders/new">Create an order</Link></li>
          </ol>
        </div>
      )}
      <div className="ep-kpis">
        {kpis.map(([l, v, h]) => <Kpi key={l} label={l} value={v} href={h} />)}
      </div>
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
          <div className="ep-card-head"><h2>{ctx.backOffice ? 'Latest activity' : 'Stock to watch'}</h2></div>
          {ctx.backOffice ? (
            (activity ?? []).length === 0 ? <Empty title="Nothing yet" text="Actions by your team and your clients show here." /> : (
              <ul className="ep-activity">
                {(activity ?? []).map((a) => (
                  <li key={a.id}><b>{ACTIVITY_LABELS[a.action] ?? a.action}</b><span>{[a.org_id ? names[a.org_id] : '', a.detail].filter(Boolean).join(' · ')}</span><small>{fmtDate(a.created_at, true)}</small></li>
                ))}
              </ul>
            )
          ) : low.length === 0 ? <Empty title="All good" text={products.length ? 'No product is below its low-stock level.' : 'Add products to see stock alerts here.'} /> : (
            <ul className="ep-list">
              {low.slice(0, 6).map((p) => (
                <li key={p.id}><span><b>{p.sku}</b> {p.name}</span><span className="ep-st ep-st--warn">{Math.max(0, p.on_hand - p.reserved)} left</span></li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
