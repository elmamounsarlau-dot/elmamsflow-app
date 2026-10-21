/** Daily orders, last 14 days — the same line + soft area as the website demo. */
export function DailyOrders({ days }: { days: { label: string; count: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const w = 400;
  const h = 90;
  const step = w / Math.max(1, days.length - 1);
  const pts = days.map((d, i) => [i * step, h - 8 - (d.count / max) * (h - 20)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const total = days.reduce((a, d) => a + d.count, 0);
  return (
    <div className="ep-chart">
      <div className="ep-chart-head">
        <small>Daily orders · last 14 days</small>
        <b>{total}</b>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <path className="area" d={`${line} L${w} ${h} L0 ${h}Z`} />
        <path className="ln" d={line} />
      </svg>
      <div className="ep-chart-x">
        {days.map((d, i) => (
          <span key={i}>{i % 2 === 0 || i === days.length - 1 ? d.label : ''}</span>
        ))}
      </div>
    </div>
  );
}
