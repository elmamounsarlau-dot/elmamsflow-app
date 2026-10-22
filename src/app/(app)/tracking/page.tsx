import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { CARRIER_PROBLEM, CARRIER_STATUS, fmtDate, ORDER_STATUS } from '@/lib/format';
import { Badge, Empty, Kpi, PageHead, Pager, pageOf } from '@/components/ui';
import { Submit } from '@/components/client';
import { allRows, orgNames } from '@/lib/data';
import { trackKey } from '@/lib/track17';
import { syncTrackingNow } from '../orders/actions';

export const metadata = { title: 'Tracking' };

type T = {
  id: string; number: string; org_id: string; city: string | null; country: string; carrier: string | null; tracking: string | null;
  shipped_at: string | null; delivered_at: string | null; status: string; tracking_status: string | null; tracking_last_event: string | null;
  tracking_last_location: string | null; tracking_last_event_at: string | null; tracking_eta: string | null; tracking_registered_at: string | null; tracking_error: string | null;
};

const TABS: [string, string, (o: T) => boolean][] = [
  ['', 'All', () => true],
  ['moving', 'In transit', (o) => o.status === 'shipped' && !CARRIER_PROBLEM.includes(o.tracking_status ?? '') && o.tracking_status !== 'OutForDelivery' && o.tracking_status !== 'AvailableForPickup'],
  ['last', 'Out for delivery', (o) => o.status === 'shipped' && ['OutForDelivery', 'AvailableForPickup'].includes(o.tracking_status ?? '')],
  ['problem', 'Problems', (o) => o.status === 'shipped' && (CARRIER_PROBLEM.includes(o.tracking_status ?? '') || !!o.tracking_error || !o.tracking)],
  ['delivered', 'Delivered', (o) => o.status === 'delivered'],
];

export default async function Tracking({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const sb = await supabaseServer();
  const [all, names] = await Promise.all([
    allRows<T>(() => {
      let q = sb.from('orders')
        .select('id, number, org_id, city, country, carrier, tracking, shipped_at, delivered_at, status, tracking_status, tracking_last_event, tracking_last_location, tracking_last_event_at, tracking_eta, tracking_registered_at, tracking_error')
        .in('status', ['shipped', 'delivered']).order('shipped_at', { ascending: false }).order('id');
      if (ctx.org) q = q.eq('org_id', ctx.org.id);
      return q;
    }),
    ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>),
  ]);
  const live = !!trackKey();
  const tab = TABS.find(([k]) => k === sp.t) ?? TABS[0];
  const list = all.filter(tab[2]);
  const PER = 25;
  const page = Math.min(pageOf(sp.p), Math.max(1, Math.ceil(list.length / PER)));
  const rows = list.slice((page - 1) * PER, page * PER);
  const done = all.filter((o) => o.delivered_at && o.shipped_at);
  const avg = done.length ? done.reduce((a, o) => a + (Date.parse(o.delivered_at!) - Date.parse(o.shipped_at!)) / 864e5, 0) / done.length : 0;
  const href = (t: string, p = 1) => `/tracking${t || p > 1 ? '?' : ''}${new URLSearchParams({ ...(t ? { t } : {}), ...(p > 1 ? { p: String(p) } : {}) })}`;
  const problems = all.filter(TABS[3][2]).length;
  return (
    <>
      <PageHead crumb="Tracking" title="Tracking" sub={live ? 'Live carrier status for every parcel, updated automatically by 17TRACK. Delivered parcels close themselves.' : 'Parcels that left the warehouse. Live carrier tracking switches on once 17TRACK is connected.'}>
        {ctx.staffRole && live && <form action={syncTrackingNow}><Submit className="ep-btn ep-btn--ghost">Sync now</Submit></form>}
      </PageHead>
      <div className="ep-kpis ep-kpis--4">
        <Kpi label="In transit" value={all.filter((o) => o.status === 'shipped').length} />
        <Kpi label="Problems" value={problems} href={problems ? href('problem') : undefined} />
        <Kpi label="Delivered" value={done.length} />
        <Kpi label="Average door to door" value={avg ? <>{avg.toFixed(1)} <i>days</i></> : '—'} />
      </div>
      <section className="ep-card ep-card--flush">
        <div className="ep-tabbar">
          {TABS.map(([k, l, f]) => <Link key={k} href={href(k)} className={tab[0] === k ? 'is-on' : ''}>{l}<em>{all.filter(f).length}</em></Link>)}
        </div>
        {rows.length === 0 ? <Empty title={all.length ? 'Nothing here' : 'Nothing shipped yet'} text={all.length ? 'No parcel matches this view.' : 'Parcels appear here as soon as they leave our warehouse.'} /> : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Order</th>{ctx.backOffice && <th>Client</th>}<th>Destination</th><th>Tracking</th><th>Carrier status</th><th>Latest update</th><th>Shipped</th></tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} data-href={`/orders/${o.id}#carrier`}>
                    <td><Link href={`/orders/${o.id}`}><b>#{o.number}</b></Link></td>
                    {ctx.backOffice && <td>{names[o.org_id] ?? '—'}</td>}
                    <td>{[o.city, o.country].filter(Boolean).join(', ')}</td>
                    <td>{o.tracking ? <a className="ep-link" target="_blank" rel="noopener noreferrer" href={`https://t.17track.net/en#nums=${encodeURIComponent(o.tracking)}`}>{o.tracking}</a> : <span className="ep-warn">Missing</span>}<small>{o.carrier || ''}</small></td>
                    <td>
                      {o.status === 'delivered' ? <Badge map={ORDER_STATUS} value="delivered" />
                        : o.tracking_status ? <Badge map={CARRIER_STATUS} value={o.tracking_status} />
                        : o.tracking_error ? <span className="ep-st ep-st--err">Not tracked</span>
                        : <span className="ep-st ep-st--mute">{live && o.tracking ? (o.tracking_registered_at ? 'Waiting for scan' : 'Starting…') : 'In transit'}</span>}
                    </td>
                    <td className="ep-trk-last">
                      {o.tracking_last_event ? <><span>{o.tracking_last_event}</span><small>{[o.tracking_last_location, o.tracking_last_event_at ? fmtDate(o.tracking_last_event_at, true) : null].filter(Boolean).join(' · ')}</small></> : o.tracking_error ? <small>{o.tracking_error}</small> : <small>—</small>}
                    </td>
                    <td>{fmtDate(o.shipped_at)}{o.delivered_at ? <small>Delivered {fmtDate(o.delivered_at)}</small> : o.tracking_eta ? <small>ETA {fmtDate(o.tracking_eta)}</small> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager total={list.length} page={page} per={PER} href={(n) => href(tab[0], n)} noun="parcel" />
      </section>
    </>
  );
}
