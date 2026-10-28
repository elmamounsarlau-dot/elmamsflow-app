import Link from 'next/link';
import type { FeedItem, Pipe, Speed } from '@/lib/owner-dashboard';
import { CountUp } from './orders-overview';

/** Seeded positions, so the picture is the same on every load (no flicker between server and browser). */
function rng(seed: number) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

const CAP = [90, 60, 360] as const;

/**
 * Open orders as a living picture: an orange core (all open orders) and three slowly turning rings,
 * one dot per order — inner to pack (and on hold), middle packed, outer on the road.
 */
export function Pulse({ pipe, label = 'open', links }: { pipe: Pipe; label?: string; links: { toPack: string; hold: string; packed: string; road: string } }) {
  const total = pipe.toPack + pipe.hold + pipe.packed + pipe.road;
  const rnd = rng(11);
  const ring = (n: number, cap: number, r: number, size: number, jitter: number, hold = 0) => {
    const k = Math.max(1, Math.ceil(n / cap));
    const shown = Math.ceil(n / k);
    const heldShown = Math.ceil(hold / k);
    return Array.from({ length: shown }, (_, i) => {
      const a = (i / Math.max(1, shown)) * Math.PI * 2 + rnd() * 0.05;
      const rr = r + (rnd() - 0.5) * jitter;
      return { x: +(200 + Math.cos(a) * rr).toFixed(1), y: +(200 + Math.sin(a) * rr).toFixed(1), r: +(size * (0.7 + rnd() * 0.6)).toFixed(1), held: i < heldShown };
    });
  };
  const r1 = ring(pipe.toPack + pipe.hold, CAP[0], 90, 3, 8, pipe.hold);
  const r2 = ring(pipe.packed, CAP[1], 130, 3.6, 5);
  const r3 = ring(pipe.road, CAP[2], 175, 2.1, 16);
  const scaled = pipe.road > CAP[2] || pipe.toPack + pipe.hold > CAP[0] || pipe.packed > CAP[1];
  return (
    <div className="ds-pulse">
      <svg viewBox="0 0 400 400" role="img" aria-label={`${total} ${label} orders: ${pipe.toPack} to pack, ${pipe.hold} on hold, ${pipe.packed} packed, ${pipe.road} on the road`}>
        <circle cx="200" cy="200" r="90" className="ds-orbit ds-orbit--1" />
        <circle cx="200" cy="200" r="130" className="ds-orbit ds-orbit--2" />
        <circle cx="200" cy="200" r="175" className="ds-orbit ds-orbit--3" />
        <g className="ds-spin ds-spin--1">{r1.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.r} className={p.held ? 'ds-dot ds-dot--hold' : 'ds-dot ds-dot--pack'} />)}</g>
        <g className="ds-spin ds-spin--2">{r2.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.r} className="ds-dot ds-dot--packed" />)}</g>
        <g className="ds-spin ds-spin--3">{r3.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.r} className="ds-dot ds-dot--road" />)}</g>
        <circle className="ds-halo" cx="200" cy="200" r="58" />
        <g className="ds-core"><circle cx="200" cy="200" r="58" fill="url(#dsCore)" /></g>
        <defs><radialGradient id="dsCore" cx="50%" cy="40%" r="60%"><stop offset="0%" stopColor="#FFB25B" /><stop offset="100%" stopColor="#E06D10" /></radialGradient></defs>
        <text x="200" y="203" textAnchor="middle" className="ds-core-n">{total.toLocaleString('en')}</text>
        <text x="200" y="227" textAnchor="middle" className="ds-core-l">{label.toUpperCase()}</text>
      </svg>
      <ul className="ds-pulse-legend">
        <li><Link href={links.toPack}><i className="ds-sw ds-sw--pack" />{label === 'open' ? 'To pack' : 'Being prepared'}<b><CountUp value={pipe.toPack} /></b></Link></li>
        <li><Link href={links.hold}><i className="ds-sw ds-sw--hold" />On hold<b><CountUp value={pipe.hold} /></b></Link></li>
        <li><Link href={links.packed}><i className="ds-sw ds-sw--packed" />Packed<b><CountUp value={pipe.packed} /></b></Link></li>
        <li><Link href={links.road}><i className="ds-sw ds-sw--road" />On the road<b><CountUp value={pipe.road} /></b></Link></li>
      </ul>
      {scaled && <small className="ds-note">Busy day: each dot stands for a few orders.</small>}
    </div>
  );
}

const rateTone = (r: number | null) => (r === null ? 'none' : r >= 90 ? 'ok' : r >= 75 ? 'warn' : 'err');

/** "Are we keeping our promise?" Shipped within 24 h over 7 days, and what is waiting to be packed, by age. */
export function SpeedPanel({ speed, href, lateHref, title = 'Shipping speed' }: { speed: Speed; href: string; lateHref: string; title?: string }) {
  const [a, b, c, d] = speed.ages;
  const w = Math.max(1, speed.waiting);
  const late = c + d;
  return (
    <section className="ds-card ds-speed">
      <div className="ds-head"><h2>{title}</h2><span className="ds-muted">Promise: shipped within 24 h</span></div>
      <div className="ds-speed-top">
        <div>
          <b className={`ds-big ds-tone--${rateTone(speed.rate)}`}>{speed.rate === null ? '—' : <><CountUp value={speed.rate} />%</>}</b>
          <span className="ds-muted">shipped within 24 h · last 7 days</span>
        </div>
        <ol className="ds-days" aria-label="Share shipped within 24 hours, day by day">
          {speed.days.map((x, i) => (
            <li key={i} title={x.rate === null ? `${x.label}: nothing shipped` : `${x.label}: ${x.rate}% of ${x.n}`}>
              <span className={`ds-col ds-tone-bg--${rateTone(x.rate)}`} style={{ height: `${x.rate === null ? 6 : Math.max(10, x.rate)}%`, animationDelay: `${i * 40}ms` }} />
              <small>{x.label}</small>
            </li>
          ))}
        </ol>
      </div>
      <div className="ds-ages">
        <div className="ds-head ds-head--sub"><span className="ds-lbl">Waiting to be packed · {speed.waiting.toLocaleString('en')} order{speed.waiting === 1 ? '' : 's'}, by age</span>
          {late ? <Link className="ds-late" href={lateHref}>{late} over 24 h → open</Link> : <span className="ds-ok">none late</span>}</div>
        <div className="ds-stack" aria-hidden="true">
          {[a, b, c, d].map((n, i) => n ? <i key={i} className={`ds-age ds-age--${i}`} style={{ width: `${(n / w) * 100}%`, animationDelay: `${i * 100}ms` }} /> : null)}
          {!speed.waiting && <i className="ds-age ds-age--empty" style={{ width: '100%' }} />}
        </div>
        <ul className="ds-agelist">
          {(['under 6 h', '6–24 h', '24–48 h', 'over 48 h'] as const).map((l, i) => (
            <li key={l}><Link href={i >= 2 ? lateHref : href}><b className={i === 3 && d ? 'ds-tone--err' : ''}>{[a, b, c, d][i].toLocaleString('en')}</b><span><i className={`ds-sw ds-age--${i}`} />{l}</span></Link></li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Two small lines (received / shipped) for a KPI tile. */
export function TwinSpark({ a, b }: { a: number[]; b: number[] }) {
  const w = 90, h = 30, max = Math.max(1, ...a, ...b);
  const d = (v: number[]) => v.map((x, i) => `${i ? 'L' : 'M'}${((i * w) / Math.max(1, v.length - 1)).toFixed(1)} ${(h - 3 - (x / max) * (h - 6)).toFixed(1)}`).join(' ');
  return <svg className="ds-twin" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true"><path d={d(a)} className="ds-twin-a" pathLength={1} /><path d={d(b)} className="ds-twin-b" pathLength={1} /></svg>;
}

export function MiniSpark({ values, bad }: { values: number[]; bad?: boolean }) {
  const w = 70, h = 18, max = Math.max(1, ...values);
  const d = values.map((x, i) => `${i ? 'L' : 'M'}${((i * w) / Math.max(1, values.length - 1)).toFixed(1)} ${(h - 2 - (x / max) * (h - 4)).toFixed(1)}`).join(' ');
  return <svg className={`ds-mini${bad ? ' is-bad' : ''}`} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><path d={d} pathLength={1} /></svg>;
}

/** Part of the month gone, as a ring. */
export function MonthRing({ share }: { share: number }) {
  const c = 2 * Math.PI * 46;
  return <svg className="ds-ring" viewBox="0 0 110 110" aria-hidden="true"><circle cx="55" cy="55" r="46" className="ds-ring-track" /><circle cx="55" cy="55" r="46" className="ds-ring-val" style={{ strokeDasharray: `${(share * c).toFixed(1)} ${c.toFixed(1)}` }} /></svg>;
}

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

/** The latest events, gliding along the bottom (still for people who prefer less motion). */
export function Feed({ items }: { items: FeedItem[] }) {
  if (!items.length) return null;
  const row = items.map((f, i) => <span key={i} className="ds-tk"><i className={`ds-sw ds-tk--${f.tone}`} />{f.who && <b>{f.who}</b>}{f.text}<small>{ago(f.at)}</small></span>);
  return (
    <div className="ds-feed" aria-label="Latest events">
      <div className="ds-feed-track">{row}<span aria-hidden="true" className="ds-feed-dup">{row}</span></div>
    </div>
  );
}
