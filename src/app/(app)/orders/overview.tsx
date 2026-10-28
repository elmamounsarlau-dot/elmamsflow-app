import Link from 'next/link';
import { Arrow } from '@/components/ui';
import { CountUp, ClientPicker } from '@/components/orders-overview';
import { FlowChart, PipeRing } from '@/components/viz';
import { HOLD_KIND } from '@/lib/orders-query';
import { fmtDate } from '@/lib/format';
import type { ordersOverview } from '@/lib/orders-overview';

type Data = Awaited<ReturnType<typeof ordersOverview>>;

const delta = (now: number, before: number) => {
  if (!before && !now) return null;
  if (!before) return { up: true, text: 'new today' };
  const d = Math.round(((now - before) / before) * 100);
  return { up: d >= 0, text: `${d >= 0 ? '+' : ''}${d}% vs yesterday` };
};

function Spark({ values }: { values: number[] }) {
  const w = 96, h = 28, max = Math.max(1, ...values);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i * w) / Math.max(1, values.length - 1)).toFixed(1)} ${(h - 3 - (v / max) * (h - 6)).toFixed(1)}`).join(' ');
  return <svg className="ep-bspark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true"><path d={d} pathLength={1} /></svg>;
}

export function OrdersOverview({ data, canCreate }: { data: Data; canCreate: boolean }) {
  const { today, pipe, series, brands, noWarehouse } = data;
  const r = delta(today.received, today.receivedY);
  const s = delta(today.shipped, today.shippedY);
  const pickList = brands.map((b) => ({ id: b.id, name: b.name, code: b.code, open: b.toShip + b.onHold + b.packed }));
  const active = brands.filter((b) => b.week || b.toShip || b.onHold || b.packed || b.inTransit);
  const quiet = brands.length - active.length;
  return (
    <div className="ep-oview">
      <div className="ep-head ep-head--orders">
        <div>
          <p className="ep-crumb">Orders</p>
          <h1>Orders across your brands</h1>
          <p>Today’s flow at a glance. Choose a brand to work on its orders.</p>
        </div>
        <div className="ep-actions">
          <ClientPicker clients={pickList} />
          {canCreate && <Link className="ep-btn ep-btn--ghost" href="/orders/import">Import CSV</Link>}
          {canCreate && <Link className="ep-btn" href="/orders/new">New order <Arrow /></Link>}
        </div>
      </div>

      <div className="ep-okpis">
        <div className="ep-okpi ep-okpi--in"><small>Received today</small><b><CountUp value={today.received} /></b>{r ? <span className={r.up ? 'up' : 'down'}>{r.text}</span> : <span>No orders yet today</span>}</div>
        <div className="ep-okpi ep-okpi--out"><small>Shipped today</small><b><CountUp value={today.shipped} /></b>{s ? <span className={s.up ? 'up' : 'down'}>{s.text}</span> : <span>Nothing shipped yet</span>}</div>
        <div className="ep-okpi ep-okpi--done"><small>Delivered today</small><b><CountUp value={today.delivered} /></b><span>confirmed by the carrier</span></div>
        <Link className={`ep-okpi ep-okpi--todo${noWarehouse || pipe.on_hold ? ' is-hot' : ''}`} href="/orders?c=all&t=attention">
          <small>Needs you</small><b><CountUp value={pipe.on_hold + noWarehouse} /></b>
          <span>{pipe.on_hold} on hold{noWarehouse ? ` · ${noWarehouse} without a warehouse` : ''}</span>
        </Link>
      </div>

      <div className="ep-ogrid">
        <section className="ep-card">
          <div className="ep-card-head"><h2>Received vs shipped</h2><span className="ep-muted ep-small">Last {series.length} days · China time</span></div>
          <FlowChart series={series} />
        </section>
        <section className="ep-card">
          <div className="ep-card-head"><h2>Right now</h2><Link className="ep-link ep-small" href="/orders?c=all">All open orders →</Link></div>
          <PipeRing parts={[
            ['To pack', pipe.new, 'var(--blue)', '/orders?c=all&s=new'],
            ['On hold', pipe.on_hold, 'var(--warn)', '/orders?c=all&t=attention'],
            ['Packed', pipe.packed, 'var(--violet)', '/orders?c=all&s=packed'],
            ['In transit', pipe.shipped, 'var(--ok)', '/tracking'],
          ]} />
        </section>
      </div>

      <section className="ep-card ep-card--flush">
        <div className="ep-card-head ep-pad">
          <h2>Brands</h2>
          <span className="ep-muted ep-small">{active.length} active{quiet ? ` · ${quiet} quiet` : ''} · sorted by work waiting, then last 7 days</span>
        </div>
        <div className="ep-tablewrap">
          <table className="ep-table ep-brands">
            <thead><tr><th>Brand</th><th>Last 14 days</th><th className="ep-right">Today</th><th className="ep-right">7 days</th><th className="ep-right">To ship</th><th className="ep-right">In transit</th><th>Needs</th><th><span className="ep-sr">Open</span></th></tr></thead>
            <tbody>
              {active.map((b) => {
                const trend = b.prevWeek ? Math.round(((b.week - b.prevWeek) / b.prevWeek) * 100) : null;
                const needs: [string, string][] = [
                  ...(b.noWarehouse ? [[`${b.noWarehouse} no warehouse`, 'err'] as [string, string]] : []),
                  ...Object.entries(b.holds).map(([k, n]) => [`${n} ${(HOLD_KIND[k]?.[1] ?? k).toLowerCase()}`, 'warn'] as [string, string]),
                ];
                return (
                  <tr key={b.id} data-href={`/orders?c=${b.id}`}>
                    <td><span className="ep-bname"><i aria-hidden="true">{b.name.slice(0, 1).toUpperCase()}</i><span><Link href={`/orders?c=${b.id}`}><b>{b.name}</b></Link><small>{b.code ?? ''}{b.lastOrderAt ? ` · last order ${fmtDate(b.lastOrderAt)}` : ''}</small></span></span></td>
                    <td><Spark values={b.spark} /></td>
                    <td className="ep-right"><b>{b.today}</b></td>
                    <td className="ep-right"><b>{b.week}</b>{trend !== null && <small className={trend >= 0 ? 'ep-pos' : 'ep-neg'}>{trend >= 0 ? '+' : ''}{trend}%</small>}</td>
                    <td className="ep-right"><b>{b.toShip + b.packed}</b>{b.packed ? <small>{b.packed} packed</small> : null}</td>
                    <td className="ep-right">{b.inTransit}</td>
                    <td>{needs.length ? <span className="ep-needs">{needs.map(([t, tone]) => <span key={t} className={`ep-st ep-st--${tone}`}>{t}</span>)}</span> : <span className="ep-st ep-st--ok">All clear</span>}</td>
                    <td className="ep-right"><Link className="ep-btn ep-btn--sm ep-btn--ghost" href={`/orders?c=${b.id}`}>Open</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!active.length && <p className="ep-pad ep-muted">No orders yet. They appear here as soon as a client’s store sends one.</p>}
      </section>
    </div>
  );
}
