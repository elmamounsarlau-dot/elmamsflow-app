import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtDate, ORDER_STATUS } from '@/lib/format';
import { Badge, Empty, Kpi, PageHead, Pager, pageOf } from '@/components/ui';
import { allRows } from '@/lib/data';

export const metadata = { title: 'Tracking' };

export default async function Tracking({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const sb = await supabaseServer();
  type T = { id: string; number: string; city: string | null; country: string; carrier: string | null; tracking: string | null; shipped_at: string | null; delivered_at: string | null; status: string };
  const all = await allRows<T>(() => {
    let q = sb.from('orders').select('id, number, city, country, carrier, tracking, shipped_at, delivered_at, status').in('status', ['shipped', 'delivered']).order('shipped_at', { ascending: false }).order('id');
    if (ctx.org) q = q.eq('org_id', ctx.org.id);
    return q;
  });
  const PER = 25;
  const page = Math.min(pageOf(sp.p), Math.max(1, Math.ceil(all.length / PER)));
  const rows = all.slice((page - 1) * PER, page * PER);
  const done = all.filter((o) => o.delivered_at && o.shipped_at);
  const avg = done.length ? done.reduce((a, o) => a + (Date.parse(o.delivered_at!) - Date.parse(o.shipped_at!)) / 864e5, 0) / done.length : 0;
  return (
    <>
      <PageHead crumb="Tracking" title="Tracking" sub="Parcels that left the warehouse. Statuses are set by our team when the carrier confirms — they are not live carrier data yet.">{avg > 0 && <span className="ep-st ep-st--ok">Avg. {avg.toFixed(1)} days door to door</span>}</PageHead>
      <div className="ep-kpis ep-kpis--3">
        <Kpi label="In transit" value={all.filter((o) => o.status === 'shipped').length} />
        <Kpi label="Delivered" value={done.length} />
        <Kpi label="Average door to door" value={avg ? <>{avg.toFixed(1)} <i>days</i></> : '—'} />
      </div>
      <section className="ep-card">
        {rows.length === 0 ? <Empty title="Nothing shipped yet" text="Parcels appear here as soon as they leave our warehouse." /> : (
          <table className="ep-table">
            <thead><tr><th>Order</th><th>Destination</th><th>Carrier</th><th>Tracking</th><th>Shipped</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} data-href={`/orders/${o.id}`}>
                  <td><b>#{o.number}</b></td><td>{[o.city, o.country].filter(Boolean).join(', ')}</td><td>{o.carrier || '—'}</td>
                  <td>{o.tracking ? <a className="ep-link" target="_blank" rel="noopener noreferrer" href={`https://t.17track.net/en#nums=${encodeURIComponent(o.tracking)}`}>{o.tracking}</a> : '—'}</td>
                  <td>{fmtDate(o.shipped_at)}</td><td><Badge map={ORDER_STATUS} value={o.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager total={all.length} page={page} per={PER} href={(n) => (n > 1 ? `/tracking?p=${n}` : '/tracking')} noun="parcel" />
      </section>
    </>
  );
}
