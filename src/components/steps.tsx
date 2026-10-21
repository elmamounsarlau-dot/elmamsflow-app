export const STEPS = ['Booked', 'Picked up', 'Receiving', 'Counted', 'Available'] as const;
export const STEP_OF: Record<string, number> = { announced: 0, in_transit: 1, receiving: 2, counted: 3, received: 4 };

/** Five dots joined by a line: done, current, to come. */
export function MiniSteps({ status, overdue }: { status: string; overdue?: boolean }) {
  const at = STEP_OF[status] ?? 0;
  const done = status === 'received';
  return (
    <div className={`ep-mini${overdue ? ' is-late' : ''}`} title={STEPS[at]}>
      <div className="ep-mini-track">
        {STEPS.map((s, i) => <i key={s} className={done || i < at ? 'done' : i === at ? 'now' : ''} />)}
      </div>
      <small>{STEPS[at]}</small>
    </div>
  );
}
