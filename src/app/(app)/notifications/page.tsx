import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { getNotices, type Notice } from '@/lib/notifications';
import { fmtDate } from '@/lib/format';
import { PageHead } from '@/components/ui';
import { NoticeIcon } from '@/components/notices';

export const metadata = { title: 'Notifications' };

const GROUPS: [Notice['level'], string, string][] = [
  ['action', 'To do now', 'These block shipping or are payments due.'],
  ['warn', 'Needs a look', 'Not blocking yet, but worth checking.'],
  ['info', 'Good to know', ''],
];

export default async function Notifications() {
  const ctx = await requireCtx();
  if (!ctx.org) redirect('/');
  const list = await getNotices(ctx);
  return (
    <>
      <PageHead crumb="Notifications" title="Notifications" sub="Everything that needs your attention, in one place. Items disappear by themselves once they’re fixed." />
      {list.length === 0 ? (
        <section className="ep-card"><div className="ep-hk-ok"><b>You’re all set</b><span>Nothing needs your attention right now.</span></div></section>
      ) : GROUPS.map(([level, title, sub]) => {
        const items = list.filter((n) => n.level === level);
        if (!items.length) return null;
        return (
          <section key={level} className={`ep-card ep-notices ep-notices--${level}`}>
            <div className="ep-card-head"><h2>{title} <em className="ep-count">{items.length}</em></h2>{sub && <span className="ep-small ep-muted">{sub}</span>}</div>
            <ul className="ep-notice-list">
              {items.map((n) => (
                <li key={n.key}>
                  <NoticeIcon kind={n.kind} level={n.level} />
                  <div className="ep-notice-body"><b>{n.title}</b><span>{n.detail}</span>{n.at && <small>{fmtDate(n.at, true)}</small>}</div>
                  <Link className="ep-btn ep-btn--sm ep-btn--ghost" href={n.href}>{n.cta}</Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
