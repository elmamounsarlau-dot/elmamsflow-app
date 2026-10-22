import Link from 'next/link';
import type { Notice } from '@/lib/notifications';

const P: Record<Notice['kind'], string> = {
  order: 'M7.5 5v10 M12.5 5v10',
  product: 'M5.5 2.5h6l3 3v12h-9z M11.5 2.5v3h3 M7.5 10h5 M7.5 13h5',
  invoice: 'M5 2.5h10v15l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5z M8 7h4 M8 10h4',
  tracking: 'M10 17.5s6-5.3 6-9.5a6 6 0 0 0-12 0c0 4.2 6 9.5 6 9.5z M10 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  support: 'M3.5 5.5h13v8h-7l-3.5 3v-3H3.5v-8z',
  stock: 'M3 6.5l7-3.5 7 3.5v7l-7 3.5-7-3.5v-7z M3 6.5l7 3.5 7-3.5 M10 10v7',
  inbound: 'M2.5 6h9v7h-9z M11.5 9h3.5l2.5 2.5V13h-6',
  store: 'M3 7l1.5-4h11L17 7M3 7v10h14V7M8 17v-4h4v4',
};

export function NoticeIcon({ kind, level }: { kind: Notice['kind']; level: Notice['level'] }) {
  return (
    <span className={`ep-notice-ic ep-notice-ic--${level}`} aria-hidden="true">
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={P[kind]} /></svg>
    </span>
  );
}

/** Bell in the top bar: count of things to do, links to the Notifications page. */
export function Bell({ count, urgent }: { count: number; urgent: number }) {
  return (
    <Link href="/notifications" className="ep-bell" aria-label={count ? `Notifications: ${count}${urgent ? `, ${urgent} to do now` : ''}` : 'Notifications: none'}>
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5.5 1.5 5.5h-13S5 12 5 8z M8.3 16.3a1.8 1.8 0 0 0 3.4 0" />
      </svg>
      {count > 0 && <em className={urgent ? 'is-urgent' : ''}>{count > 99 ? '99+' : count}</em>}
    </Link>
  );
}

/** Compact list for the client home page. */
export function NoticeCard({ list, max = 6 }: { list: Notice[]; max?: number }) {
  return (
    <section className={`ep-bcard${list.some((n) => n.level === 'action') ? ' ep-bcard--alert' : ''}`}>
      <div className="ep-bhead">
        <span className="ep-bic ep-bic--red" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5.5 1.5 5.5h-13S5 12 5 8z M8.3 16.3a1.8 1.8 0 0 0 3.4 0" /></svg>
        </span>
        <h2>Notifications</h2>
        {list.length > 0 && <Link className="ep-blink" href="/notifications">All {list.length} →</Link>}
      </div>
      {list.length === 0 ? (
        <div className="ep-hk-ok"><b>You’re all set</b><span>Nothing needs your attention right now.</span></div>
      ) : (
        <ul className="ep-notice-list ep-notice-list--compact">
          {list.slice(0, max).map((n) => (
            <li key={n.key}>
              <NoticeIcon kind={n.kind} level={n.level} />
              <Link className="ep-notice-body" href={n.href}><b>{n.title}</b><span>{n.detail}</span></Link>
            </li>
          ))}
          {list.length > max && <li className="ep-more"><Link href="/notifications">+{list.length - max} more</Link></li>}
        </ul>
      )}
    </section>
  );
}
