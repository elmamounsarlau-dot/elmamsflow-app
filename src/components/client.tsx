'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFormStatus } from 'react-dom';

/** Message passed in the URL (?ok= / ?err= / ?warn=) after an action. */
export function Flash() {
  const sp = useSearchParams();
  const path = usePathname();
  const router = useRouter();
  const ok = sp.get('ok');
  const err = sp.get('err');
  const warn = sp.get('warn');
  const msg = ok || err || warn;
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(sp.toString());
      next.delete('ok');
      next.delete('err');
      next.delete('warn');
      router.replace(path + (next.toString() ? `?${next}` : ''), { scroll: false });
    }, 6000);
    return () => clearTimeout(t);
  }, [msg, sp, path, router]);
  if (!msg) return null;
  return <p className={`ep-note ep-note--${err ? 'err' : warn ? 'warn' : 'ok'}`}>{msg}</p>;
}

/** Makes table rows with data-href clickable. */
export function ClickableRows() {
  const router = useRouter();
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('a, button, input, select, textarea, label, summary, .ep-ock')) return;
      const tr = t.closest('tr[data-href]') as HTMLElement | null;
      if (tr) router.push(tr.dataset.href!);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [router]);
  return null;
}

export function Submit({ children, className = 'ep-btn', confirm }: { children: ReactNode; className?: string; confirm?: string }) {
  const { pending } = useFormStatus();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []); // marks the button interactive (used by end-to-end tests)
  return (
    <button
      className={className}
      disabled={pending}
      data-ready={ready ? '1' : undefined}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? 'Working…' : children}
    </button>
  );
}

export function CopyLink({ value, label = 'Copy link' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="ep-copy">
      <input ref={ref} readOnly value={value} aria-label="Private link to copy" onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="ep-btn"
        onClick={async () => {
          ref.current?.select();
          try {
            await navigator.clipboard.writeText(value);
          } catch {
            document.execCommand('copy');
          }
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        }}
      >
        {done ? 'Copied' : label}
      </button>
    </div>
  );
}

export function PasswordField({ name, label, strength, autoComplete = 'new-password', autoFocus }: { name: string; label: string; strength?: boolean; autoComplete?: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  const [score, setScore] = useState(0);
  return (
    <>
      <label>
        {label}
        <span className="ep-pw">
          <input
            type={show ? 'text' : 'password'}
            name={name}
            minLength={autoComplete === 'new-password' ? 8 : undefined}
            required
            autoComplete={autoComplete}
            autoFocus={autoFocus}
            onChange={(e) => {
              const v = e.target.value;
              setScore((v.length >= 8 ? 1 : 0) + (v.length >= 12 ? 1 : 0) + (/[A-Z]/.test(v) && /[a-z]/.test(v) ? 1 : 0) + (/\d/.test(v) && /[^A-Za-z0-9]/.test(v) ? 1 : 0));
            }}
          />
          <button type="button" onClick={() => setShow(!show)}>
            {show ? 'Hide' : 'Show'}
          </button>
        </span>
      </label>
      {strength && (
        <div className="ep-meter" aria-hidden="true">
          <i style={{ width: `${score * 25}%`, background: score < 2 ? '#F7941D' : score < 4 ? '#1E88E5' : '#1B8A4C' }} />
        </div>
      )}
    </>
  );
}

type P = { id: string; label: string; org: string };

/** Product + quantity rows; admins outside a client pick the client first. */
export function ItemRows({ products, clients }: { products: P[]; clients?: { id: string; name: string }[] }) {
  const [rows, setRows] = useState(3);
  const [client, setClient] = useState('');
  const list = clients ? products.filter((p) => !client || p.org === client) : products;
  return (
    <>
      {clients && (
        <label>
          Client
          <select name="org_id" required value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">Choose a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="ep-items">
        <div className="ep-items-head">
          <span>Product</span>
          <span>Quantity</span>
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div className="ep-item" key={i}>
            <select name="item_product" defaultValue="" aria-label={`Product, line ${i + 1}`}>
              <option value="">Choose a product…</option>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <input type="number" name="item_qty" min={0} step={1} placeholder="0" aria-label={`Quantity, line ${i + 1}`} />
          </div>
        ))}
        <button type="button" className="ep-link" onClick={() => setRows(rows + 1)}>
          + Add another product
        </button>
      </div>
    </>
  );
}

export function Burger() {
  return (
    <button type="button" className="ep-burger" aria-label="Menu" onClick={() => document.body.classList.toggle('ep-nav-open')}>
      <i />
      <i />
    </button>
  );
}

/** Closes the mobile menu after navigating. */
export function NavCloser() {
  const path = usePathname();
  useEffect(() => {
    document.body.classList.remove('ep-nav-open');
  }, [path]);
  return null;
}

/** Opens the print dialog (Save as PDF) once the invoice has rendered. */
export function PrintNow() {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, []);
  return (
    <button type="button" className="ep-btn ep-noprint" onClick={() => window.print()}>
      Print or save as PDF
    </button>
  );
}

/**
 * Small screens: each table row becomes a card. Every cell gets its column name (data-label) so the card still
 * says what each value is. Scrollable table areas become keyboard-focusable regions.
 */
export function ResponsiveTables() {
  useEffect(() => {
    const apply = () => {
      document.querySelectorAll<HTMLTableElement>('table.ep-table').forEach((t) => {
        const heads = [...t.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim());
        if (!heads.length) return;
        t.classList.add('ep-stack');
        t.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((tr) => {
          [...tr.children].forEach((td, i) => { if (!td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i] ?? ''); });
        });
      });
      document.querySelectorAll<HTMLElement>('.ep-tablewrap').forEach((el) => {
        if (el.hasAttribute('tabindex')) return;
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'region');
        const h = el.closest('section')?.querySelector('h2, h3')?.textContent?.trim();
        el.setAttribute('aria-label', h ? `${h} (table)` : 'Table');
      });
    };
    apply();
    let t: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(apply, 50); });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { mo.disconnect(); clearTimeout(t); };
  }, []);
  return null;
}
