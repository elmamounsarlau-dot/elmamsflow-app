import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { allRows, orgNames } from '@/lib/data';
import { COUNTRIES, fmtDate } from '@/lib/format';
import { flag } from '@/lib/orders-query';
import { getWarehouses, whLabel } from '@/lib/warehouses';
import { dayKey } from '@/lib/orders-overview';
import { Kpi, PageHead } from '@/components/ui';

export const metadata = { title: 'Shipping' };

type O = {
  id: string; number: string; store_ref: string | null; org_id: string; status: string; customer: string; city: string | null; country: string;
  service: string; created_at: string; shipped_at: string | null; warehouse_id: string | null; tracking: string | null; carrier: string | null;
  label_path: string | null; label_uploaded_by: string | null; order_items: { qty: number; products: { weight_g: number } | null }[];
};

export default async function Shipping({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  if (!ctx.staffRole || ctx.viewingAs || !ctx.can('orders.warehouse')) redirect('/');
  const sp = await searchParams;
  const sb = await supabaseServer();
  const since = new Date(Date.now() - 2 * 864e5).toISOString();
  const cols = 'id, number, store_ref, org_id, status, customer, city, country, service, created_at, shipped_at, warehouse_id, tracking, carrier, label_path, label_uploaded_by, order_items(qty, products(weight_g))';
  const [queue, recent, whs, names] = await Promise.all([
    allRows<O>(() => sb.from('orders').select(cols).in('status', ['new', 'packed']).order('created_at').order('id')),
    sb.from('orders').select(cols).in('status', ['shipped', 'delivered']).gte('shipped_at', since).order('shipped_at', { ascending: false }).limit(200),
    getWarehouses(),
    orgNames(),
  ]);
  const today = dayKey(new Date());
  const shippedToday = ((recent.data ?? []) as unknown as O[]).filter((o) => o.shipped_at && dayKey(o.shipped_at) === today);
  const physical = whs.filter((w) => w.kind === 'physical' && w.active);
  const tabs: [string, string, (o: O) => boolean][] = [
    ['', 'All', () => true],
    ...physical.map((w) => [w.id, w.name, (o: O) => o.warehouse_id === w.id] as [string, string, (o: O) => boolean]),
    ['none', 'No warehouse', (o: O) => !o.warehouse_id || !physical.some((w) => w.id === o.warehouse_id)],
  ];
  const tab = tabs.find(([k]) => k === (sp.w ?? '')) ?? tabs[0];
  const st = sp.s === 'packed' || sp.s === 'new' ? sp.s : '';
  const list = queue.filter(tab[2]).filter((o) => !st || o.status === st);
  const href = (w: string, s = st) => `/shipping${w || s ? '?' : ''}${new URLSearchParams({ ...(w ? { w } : {}), ...(s ? { s } : {}) })}`;
  const weight = (o: O) => o.order_items.reduce((a, i) => a + i.qty * (i.products?.weight_g ?? 0), 0);
  const units = (o: O) => o.order_items.reduce((a, i) => a + i.qty, 0);
  const wh = new Map(whs.map((w) => [w.id, w]));
  return (
    <>
      <PageHead crumb="Shipping" title="Orders to ship" sub="Open an order, add the carrier, the tracking number and a photo of the label, then mark it in transit. Tracking then updates by itself for the brand and its customer." />
      <div className="ep-kpis ep-kpis--4">
        <Kpi label="To ship" value={queue.length} />
        <Kpi label="Packed, waiting" value={queue.filter((o) => o.status === 'packed').length} href={href(tab[0], 'packed')} />
        <Kpi label="Shipped today" value={shippedToday.length} />
        <Kpi label="By you today" value={shippedToday.filter((o) => o.label_uploaded_by === ctx.userId).length} />
      </div>
      <section className="ep-card ep-card--flush">
        <div className="ep-tabbar">
          {tabs.map(([k, l, f]) => <Link key={k || 'all'} href={href(k)} className={tab[0] === k ? 'is-on' : ''}>{l}<em>{queue.filter(f).length}</em></Link>)}
        </div>
        <div className="ep-pad ep-ship-filter">
          <Link className={`ep-todo-item${!st ? '' : ' is-off'}`} href={href(tab[0], '')}>All</Link>
          <Link className={`ep-todo-item${st === 'new' ? '' : ' is-off'}`} href={href(tab[0], 'new')}>Not packed yet</Link>
          <Link className={`ep-todo-item${st === 'packed' ? '' : ' is-off'}`} href={href(tab[0], 'packed')}>Packed</Link>
        </div>
        {list.length === 0 ? <p className="ep-pad ep-muted">Nothing to ship here. New orders appear as soon as they’re ready.</p> : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Order</th><th>Ship to</th><th>Parcel</th><th>From</th><th>Waiting since</th><th><span className="ep-sr">Ship</span></th></tr></thead>
              <tbody>
                {list.map((o) => (
                  <tr key={o.id} data-href={`/orders/${o.id}#ship`}>
                    <td><Link href={`/orders/${o.id}#ship`}><b>#{o.number}</b></Link><small>{names[o.org_id] ?? ''}{o.store_ref ? ` · ${o.store_ref}` : ''}</small></td>
                    <td>{o.customer}<small><span aria-hidden="true">{flag(o.country)}</span> {[o.city, COUNTRIES[o.country] ?? o.country].filter(Boolean).join(', ')}</small></td>
                    <td>{units(o)} unit{units(o) === 1 ? '' : 's'}<small>{weight(o) ? `${(weight(o) / 1000).toFixed(2)} kg · ` : ''}{o.service === 'ddp' ? 'DDP' : 'Express'}</small></td>
                    <td>{o.warehouse_id ? whLabel(wh.get(o.warehouse_id)) : <span className="ep-warn">Not set</span>}<small>{o.status === 'packed' ? 'Packed' : 'Not packed yet'}</small></td>
                    <td>{fmtDate(o.created_at, true)}</td>
                    <td className="ep-right"><Link className="ep-btn ep-btn--sm" href={`/orders/${o.id}#ship`}>Ship</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ep-card ep-card--flush" style={{ marginTop: '1.2rem' }}>
        <div className="ep-card-head ep-pad"><h2>Shipped today</h2><Link className="ep-link ep-small" href="/tracking">Tracking →</Link></div>
        {shippedToday.length === 0 ? <p className="ep-pad ep-muted" style={{ paddingTop: 0 }}>Nothing shipped yet today.</p> : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Order</th><th>Carrier · tracking</th><th>Label</th><th>Shipped</th></tr></thead>
              <tbody>
                {shippedToday.map((o) => (
                  <tr key={o.id} data-href={`/orders/${o.id}`}>
                    <td><Link href={`/orders/${o.id}`}><b>#{o.number}</b></Link><small>{names[o.org_id] ?? ''}</small></td>
                    <td>{o.carrier ?? '—'}<small>{o.tracking ?? 'no tracking number'}</small></td>
                    <td>{o.label_path ? <a className="ep-link" href={`/orders/${o.id}/label`} target="_blank" rel="noopener">View label</a> : <span className="ep-warn">Missing</span>}</td>
                    <td>{fmtDate(o.shipped_at, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
