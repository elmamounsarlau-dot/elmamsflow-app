import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { orgNames } from '@/lib/data';
import { fmtDate, ORDER_STATUS } from '@/lib/format';
import { Arrow, Badge, Empty } from '@/components/ui';

export const metadata = { title: 'Orders' };

export default async function Orders({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const sb = await supabaseServer();
  let q = sb.from('orders').select('id, number, store_ref, customer, city, country, created_at, status, org_id, carrier, service, source, order_items(qty)').order('created_at', { ascending: false }).limit(300);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const [{ data }, names] = await Promise.all([q, ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  const all = data ?? [];
  const f = sp.s && ORDER_STATUS[sp.s] ? sp.s : '';
  const src = ['shopify', 'woocommerce', 'manual'].includes(sp.src ?? '') ? sp.src : '';
  const list = all.filter((o) => (!f || o.status === f) && (!src || o.source === src));
  return (
    <>
      <div className="ep-title-row"><h1 className="ep-page-title">Orders</h1><span className="ep-muted ep-small">{all.length.toLocaleString('en')} orders</span></div>
      <div className="ep-bar">
        <div className="ep-pills">
          <Link href="/orders" className={!f ? 'is-on' : ''}>All <em>{all.length}</em></Link>
          {Object.entries(ORDER_STATUS).map(([k, [l]]) => (
            <Link key={k} href={`/orders?s=${k}`} className={f === k ? 'is-on' : ''}>{l} <em>{all.filter((o) => o.status === k).length}</em></Link>
          ))}
        </div>
        {ctx.can('orders.create') && <Link className="ep-btn" href="/orders/new">New order <Arrow /></Link>}
      </div>
      <section className="ep-card">
        {list.length === 0 ? <Empty title="No orders here" text="Orders you create or send us appear here." /> : (
          <table className="ep-table">
            <thead><tr><th>Order</th>{ctx.backOffice && <th>Client</th>}<th>Customer</th><th className="ep-right">Items</th><th>Destination</th><th>Carrier</th><th>Created</th><th>Status</th></tr></thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id} data-href={`/orders/${o.id}`}>
                  <td><b>#{o.number}</b>{o.store_ref && <small>{o.source !== 'manual' && <span className={`ep-store-chip ep-store-chip--${o.source}`}>{o.source === 'shopify' ? 'Shopify' : 'Woo'}</span>} {o.store_ref}</small>}</td>
                  {ctx.backOffice && <td>{names[o.org_id]}</td>}
                  <td>{o.customer}</td>
                  <td className="ep-right">{(o.order_items as { qty: number }[]).reduce((a, i) => a + i.qty, 0)}</td>
                  <td>{[o.city, o.country].filter(Boolean).join(', ')}</td>
                  <td>{o.carrier || (o.service === 'ddp' ? 'DDP' : 'Express')}</td>
                  <td>{fmtDate(o.created_at)}</td>
                  <td><Badge map={ORDER_STATUS} value={o.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
