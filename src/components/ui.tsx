import Link from 'next/link';
import type { ReactNode } from 'react';

export function Arrow() {
  return (
    <svg className="ep-ar" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 11L11 5M6 5h5v5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Badge({ map, value }: { map: Record<string, [string, string]>; value: string }) {
  const [label, tone] = map[value] ?? [value, 'mute'];
  return <span className={`ep-st ep-st--${tone}`}>{label}</span>;
}

export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="ep-empty">
      <b>{title}</b>
      <p>{text}</p>
      {children}
    </div>
  );
}

export function Kpi({ label, value, href }: { label: string; value: ReactNode; href?: string }) {
  const inner = (
    <>
      <small>{label}</small>
      <b>{value}</b>
    </>
  );
  return href ? (
    <Link className="ep-kpi" href={href}>
      {inner}
    </Link>
  ) : (
    <div className="ep-kpi">{inner}</div>
  );
}

export function Back({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className="ep-back" href={href}>
      ← {children}
    </Link>
  );
}

export function TeamOnly() {
  return <p className="ep-teamtag">Only your team sees this</p>;
}

/** The same page header everywhere: small label, title, one line of explanation, actions on the right. */
export function PageHead({ crumb, title, sub, children }: { crumb: string; title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ep-head">
      <div>
        <p className="ep-crumb">{crumb}</p>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="ep-actions">{children}</div>}
    </div>
  );
}

/** Page links under a list: total, page x of y, first / previous / next / last. */
export function Pager({ total, page, per, href, noun = 'item' }: { total: number; page: number; per: number; href: (p: number) => string; noun?: string }) {
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, page), pages);
  const link = (n: number, label: string, text: string, off: boolean) =>
    off ? <span className="ep-pg is-off" aria-hidden="true">{text}</span> : <Link className="ep-pg" href={href(n)} aria-label={label}>{text}</Link>;
  return (
    <div className="ep-pager">
      <span className="ep-muted">{total.toLocaleString('en')} {noun}{total === 1 ? '' : 's'}</span>
      {pages > 1 && <span>Page {p} of {pages}</span>}
      {pages > 1 && (
        <div className="ep-pager-nav">
          {link(1, 'First page', '«', p <= 1)}{link(p - 1, 'Previous page', '‹', p <= 1)}{link(p + 1, 'Next page', '›', p >= pages)}{link(pages, 'Last page', '»', p >= pages)}
        </div>
      )}
    </div>
  );
}

export const pageOf = (v: string | undefined) => Math.max(1, parseInt(v ?? '1', 10) || 1);

/** A product's photo (private, served by the app), or its initials on a soft tile when there is none. */
export function Thumb({ id, photo, name, size = 40, kit }: { id: string; photo?: string | null; name: string; size?: number; kit?: boolean }) {
  const ini = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className={`ep-thumb${kit ? ' ep-thumb--kit' : ''}`} style={{ width: size, height: size, ['--h' as string]: h }} aria-hidden="true">
      {photo
        // eslint-disable-next-line @next/next/no-img-element -- private file served by our own route
        ? <img src={`/files/product/${id}?v=${encodeURIComponent(photo.split('/').pop() ?? '')}`} alt="" loading="lazy" decoding="async" />
        : <i style={{ fontSize: Math.max(10, size * 0.34) }}>{ini}</i>}
    </span>
  );
}
