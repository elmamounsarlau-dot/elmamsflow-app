import Link from 'next/link';
import { Arrow } from '@/components/ui';
import { CountUp, ClientPicker } from '@/components/orders-overview';
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

/** Two lines (received, shipped) over the last days, drawn in when the page opens. */
function FlowChart({ series }: { series: Data['series'] }) {
  const w = 640, h = 200, pad = 26;
  const max = Math.max(4, ...series.map((d) => Math.max(d.received, d.shipped)));
  const x = (i: number) => pad + (i * (w - pad * 2)) / Math.max(1, series.length - 1);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);
  const path = (k: 'received' | 'shipped') => series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d[k]).toFixed(1)}`).join(' ');
  const ticks = [0, Math.round(max / 2), max];
  const total = series.reduce((a, d) => a + d.received, 0);
  const sent = series.reduce((a, d) => a + d.shipped, 0);
  return (
    <figure className="ep-flow" aria-label={`Last ${series.length} days: ${total} orders received, ${sent} shipped`}>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-hidden="true">
        {ticks.map((t) => <g key={t}><line x1={pad} x2={w - pad} y1={y(t)} y2={y(t)} className="grid" /><text x={pad - 8} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
        <path className="area" d={`${path('received')} L${x(series.length - 1)} ${h - pad} L${x(0)} ${h - pad}Z`} />
        <path className="ln ln--in" d={path('received')} pathLength={1} />
        <path className="ln ln--out" d={path('shipped')} pathLength={1} />
        {series.map((d, i) => <circle key={i} className="dot" cx={x(i)} cy={y(d.received)} r={i === series.length - 1 ? 4.5 : 0} />)}
        {series.map((d, i) => (i % 2 === (series.length - 1) % 2 ? <text key={`l${i}`} x={x(i)} y={h - 6} textAnchor="middle">{d.label}</text> : null))}
      </svg>
      <figcaption>
        <span><i className="sw sw--in" />Received <b>{total}</b></span>
        <span><i className="sw sw--out" />Shipped <b>{sent}</b></span>
      </figcaption>
    </figure>
  );
}

/** Where every open order is right now, as a ring that fills in. */
function PipeRing({ pipe }: { pipe: Data['pipe'] }) {
  const parts: [string, number, string, string][] = [
    ['To pack', pipe.new, 'var(--blue)', '/orders?c=all&s=new'],
    ['On hold', pipe.on_hold, 'var(--warn)', '/orders?c=all&t=attention'],
    ['Packed', pipe.packed, 'var(--violet)', '/orders?c=all&s=packed'],
    ['In transit', pipe.shipped, 'var(--ok)', '/tracking'],
  ];
  const total = parts.reduce((a, p) => a + p[1], 0);
  const r = 62, c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="ep-ring">
      <svg viewBox="0 0 160 160" aria-hidden="true">
        <circle cx="80" cy="80" r={r} className="track" />
        {total > 0 && parts.map(([l, n, col], i) => {
          const len = (n / total) * c;
          const el = <circle key={l} cx="80" cy="80" r={r} className="seg" style={{ stroke: col, strokeDasharray: `${Math.max(0, len - 3)} ${c}`, strokeDashoffset: -acc, animationDelay: `${i * 120}ms` }} />;
          acc += len;
          return el;
        })}
      </svg>
      <div className="ep-ring-mid"><b><CountUp value={total} /></b><small>open orders</small></div>
      <ul>
        {parts.map(([l, n, col, href]) => (
          <li key={l}><Link href={href}><i style={{ background: col }} />{l}<b>{n.toLocaleString('en')}</b></Link></li>
        ))}
      </ul>
    </div>
  );
}

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
          <PipeRing pipe={pipe} />
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
