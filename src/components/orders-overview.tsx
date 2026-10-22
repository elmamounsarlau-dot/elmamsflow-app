'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/** Number that counts up from 0 when it appears (skipped for people who prefer less motion). */
export function CountUp({ value, ms = 900 }: { value: number; ms?: number }) {
  const [n, setN] = useState(value);
  useEffect(() => {
    if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || value <= 0) { setN(value); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    setN(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{n.toLocaleString('en')}</>;
}

type C = { id: string; name: string; code: string | null; open?: number };

/** "Choose a client": searchable list; picking one opens that client's orders. */
export function ClientPicker({ clients, current, label = 'Choose a client' }: { clients: C[]; current?: string; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return clients.filter((c) => !s || c.name.toLowerCase().includes(s) || (c.code ?? '').toLowerCase().includes(s));
  }, [clients, q]);
  const cur = clients.find((c) => c.id === current);
  return (
    <div className="ep-cpick" ref={ref}>
      <button type="button" className="ep-cpick-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="9" r="6" /><path d="M13.5 13.5L17 17" /></svg>
        <span>{cur ? cur.name : label}</span>
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5.5 8l4.5 4.5L14.5 8" /></svg>
      </button>
      {open && (
        <div className="ep-cpick-panel">
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a brand or client code" aria-label="Search clients"
            onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) { setOpen(false); router.push(`/orders?c=${list[0].id}`); } }} />
          <ul role="listbox" aria-label="Clients">
            {list.map((c) => (
              <li key={c.id} role="option" aria-selected={c.id === current}>
                <Link href={`/orders?c=${c.id}`} onClick={() => setOpen(false)}>
                  <b>{c.name}</b><small>{c.code ?? ''}{c.open ? ` · ${c.open} open` : ''}</small>
                </Link>
              </li>
            ))}
            {!list.length && <li className="ep-cpick-none">No client matches “{q}”.</li>}
          </ul>
          <Link className="ep-cpick-all" href="/orders?c=all" onClick={() => setOpen(false)}>All clients in one list →</Link>
        </div>
      )}
    </div>
  );
}
