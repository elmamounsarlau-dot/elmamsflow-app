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
