export default function Loading() {
  return (
    <div className="ep-skel" aria-busy="true" aria-label="Loading">
      <i className="ep-skel-title" />
      <div className="ep-kpis">{Array.from({ length: 5 }).map((_, i) => <i key={i} className="ep-skel-kpi" />)}</div>
      <i className="ep-skel-card" />
    </div>
  );
}
