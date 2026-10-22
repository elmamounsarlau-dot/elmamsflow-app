'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/** Selection bar for the Orders list: counts the ticked rows, select-all, and shows bulk buttons. */
export function BulkBar({ formId, children }: { formId: string; children: ReactNode }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    const boxes = () => [...form.querySelectorAll<HTMLInputElement>('input[name="ids"]')];
    const all = form.querySelector<HTMLInputElement>('input[data-all]');
    const sync = () => {
      const b = boxes();
      const on = b.filter((x) => x.checked).length;
      setN(on);
      if (all) { all.checked = on > 0 && on === b.length; all.indeterminate = on > 0 && on < b.length; }
      b.forEach((x) => x.closest('tr')?.classList.toggle('is-picked', x.checked));
    };
    const onChange = (e: Event) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.all !== undefined) boxes().forEach((x) => { x.checked = t.checked; });
      sync();
    };
    form.addEventListener('change', onChange);
    sync();
    return () => form.removeEventListener('change', onChange);
  }, [formId]);
  const clear = () => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    form?.querySelectorAll<HTMLInputElement>('input[name="ids"], input[data-all]').forEach((x) => { x.checked = false; x.indeterminate = false; });
    form?.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (!n) return null;
  return (
    <div className="ep-bulk" role="toolbar" aria-label="Selected orders">
      <b>{n} selected</b>
      {children}
      <button type="button" className="ep-bulk-btn" onClick={clear}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>Clear
      </button>
    </div>
  );
}

/** A submit button that can ask first; while the form is sending it is just disabled (no label change). */
export function Act({ children, className, confirm, name = 'act', value, title, formAction, formMethod }: {
  children: ReactNode; className?: string; confirm?: string; name?: string; value?: string; title?: string;
  formAction?: string | ((fd: FormData) => void | Promise<void>); formMethod?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      className={className}
      name={name}
      value={value}
      title={title}
      aria-label={title}
      disabled={pending}
      formAction={formAction as never}
      formMethod={formMethod}
      onClick={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}
    >
      {children}
    </button>
  );
}

const COLS: [string, string][] = [
  ['items', 'Items'], ['email', 'Email'], ['dest', 'Destination'], ['wh', 'Warehouse'], ['channel', 'Channel'], ['carrier', 'Carrier'], ['date', 'Order date'],
];

/** "View" menu: show or hide columns; remembered in this browser. */
export function ColumnsMenu({ target }: { target: string }) {
  const [hidden, setHidden] = useState<string[]>(['carrier']);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { const v = localStorage.getItem('elm_order_cols'); if (v) setHidden(JSON.parse(v)); } catch { /* storage off */ }
  }, []);
  useEffect(() => {
    document.getElementById(target)?.setAttribute('data-hide', hidden.join(' '));
    try { localStorage.setItem('elm_order_cols', JSON.stringify(hidden)); } catch { /* storage off */ }
  }, [hidden, target]);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  return (
    <div className="ep-pop" ref={ref}>
      <button type="button" className="ep-tool" onClick={() => setOpen(!open)} aria-expanded={open}>
        <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="7" cy="5" r="1.8" fill="var(--surface)" stroke="currentColor" strokeWidth="1.4" /><circle cx="13" cy="10" r="1.8" fill="var(--surface)" stroke="currentColor" strokeWidth="1.4" /><circle cx="9" cy="15" r="1.8" fill="var(--surface)" stroke="currentColor" strokeWidth="1.4" /></svg>
        View
      </button>
      {open && (
        <div className="ep-pop-panel ep-pop-panel--sm">
          <p className="ep-pop-title">Columns</p>
          {COLS.map(([k, l]) => (
            <label key={k} className="ep-check">
              <input type="checkbox" checked={!hidden.includes(k)} onChange={(e) => setHidden(e.target.checked ? hidden.filter((h) => h !== k) : [...hidden, k])} />
              {l}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Submits the surrounding form when a select marked data-autosubmit changes. */
export function AutoSubmit() {
  useEffect(() => {
    const on = (e: Event) => {
      const t = e.target as HTMLSelectElement;
      if (t.matches?.('select[data-autosubmit]')) t.form?.requestSubmit();
    };
    document.addEventListener('change', on);
    return () => document.removeEventListener('change', on);
  }, []);
  return null;
}
