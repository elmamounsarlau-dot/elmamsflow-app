import Link from 'next/link';
import { CountUp } from './orders-overview';

export type FlowPoint = { label: string; received: number; shipped: number };

/** Two lines (received, shipped) over days, drawn in when they come into view. */
export function FlowChart({ series, names = ['Received', 'Shipped'], every }: { series: FlowPoint[]; names?: [string, string]; every?: number }) {
  const w = 640, h = 200, pad = 26;
  const max = Math.max(4, ...series.map((d) => Math.max(d.received, d.shipped)));
  const x = (i: number) => pad + (i * (w - pad * 2)) / Math.max(1, series.length - 1);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);
  const path = (k: 'received' | 'shipped') => series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d[k]).toFixed(1)}`).join(' ');
  const ticks = [0, Math.round(max / 2), max];
  const total = series.reduce((a, d) => a + d.received, 0);
  const sent = series.reduce((a, d) => a + d.shipped, 0);
  const step = every ?? (series.length > 16 ? Math.ceil(series.length / 8) : 2);
  return (
    <figure className="ep-flow" aria-label={`${series.length} days: ${total} ${names[0].toLowerCase()}, ${sent} ${names[1].toLowerCase()}`}>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-hidden="true">
        {ticks.map((t) => <g key={t}><line x1={pad} x2={w - pad} y1={y(t)} y2={y(t)} className="grid" /><text x={pad - 8} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
        <path className="area" d={`${path('received')} L${x(series.length - 1)} ${h - pad} L${x(0)} ${h - pad}Z`} />
        <path className="ln ln--in" d={path('received')} pathLength={1} />
        <path className="ln ln--out" d={path('shipped')} pathLength={1} />
        {series.map((d, i) => <circle key={i} className="dot" cx={x(i)} cy={y(d.received)} r={i === series.length - 1 ? 4.5 : 0} />)}
        {series.map((d, i) => ((series.length - 1 - i) % step === 0 ? <text key={`l${i}`} x={x(i)} y={h - 6} textAnchor="middle">{d.label}</text> : null))}
      </svg>
      <figcaption>
        <span><i className="sw sw--in" />{names[0]} <b>{total.toLocaleString('en')}</b></span>
        <span><i className="sw sw--out" />{names[1]} <b>{sent.toLocaleString('en')}</b></span>
      </figcaption>
    </figure>
  );
}

/** Parts of a whole as a ring that fills in, with a linked legend. */
export function PipeRing({ parts, unit = 'open orders' }: { parts: [string, number, string, string | null][]; unit?: string }) {
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
      <div className="ep-ring-mid"><b><CountUp value={total} /></b><small>{unit}</small></div>
      <ul>
        {parts.map(([l, n, col, href]) => {
          const inner = <><i style={{ background: col }} />{l}<b>{n.toLocaleString('en')}</b></>;
          return <li key={l}>{href ? <Link href={href}>{inner}</Link> : <span className="ep-ring-row">{inner}</span>}</li>;
        })}
      </ul>
    </div>
  );
}

/** Horizontal bars that grow in, for "top N" lists. */
export function Bars({ rows, unit }: { rows: { key: string; label: React.ReactNode; sub?: React.ReactNode; n: number; href?: string }[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  const total = rows.reduce((a, r) => a + r.n, 0);
  return (
    <ul className="ep-bars">
      {rows.map((r, i) => {
        const body = (
          <>
            <span className="ep-bars-l">{r.label}{r.sub && <small>{r.sub}</small>}</span>
            <span className="ep-bars-n"><b>{r.n.toLocaleString('en')}</b>{unit && <small>{unit}</small>}</span>
            <span className="ep-bars-t" aria-hidden="true"><i style={{ width: `${(r.n / max) * 100}%`, animationDelay: `${120 + i * 70}ms` }} /></span>
            {total > 0 && <span className="ep-bars-p">{Math.round((r.n / total) * 100)}%</span>}
          </>
        );
        return <li key={r.key} style={{ animationDelay: `${i * 60}ms` }}>{r.href ? <Link href={r.href}>{body}</Link> : <div>{body}</div>}</li>;
      })}
    </ul>
  );
}
