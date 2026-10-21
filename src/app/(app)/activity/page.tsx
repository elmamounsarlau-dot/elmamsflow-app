import { requirePerm } from '@/lib/guard';
import { supabaseServer } from '@/lib/supabase/server';
import { orgNames } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { ACTIVITY_LABELS } from '@/lib/log';
import { Empty } from '@/components/ui';

export const metadata = { title: 'Activity' };

export default async function Activity() {
  const ctx = await requirePerm('activity.view');
  const sb = await supabaseServer();
  let q = sb.from('activity_log').select('*, profile:profiles!activity_log_user_profile_fkey(full_name, email)').order('created_at', { ascending: false }).limit(150);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const [{ data }, names] = await Promise.all([q, ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  return (
    <>
      <h1 className="ep-page-title">Activity</h1>
      <section className="ep-card ep-card--narrow">
        {(data ?? []).length === 0 ? <Empty title="Nothing yet" text="Every action shows here: who did what, and when." /> : (
          <ul className="ep-activity">
            {(data ?? []).map((a) => {
              const p = a.profile as unknown as { full_name: string; email: string } | null;
              return <li key={a.id}><b>{ACTIVITY_LABELS[a.action] ?? a.action}</b><span>{[a.org_id ? names[a.org_id] : '', a.detail].filter(Boolean).join(' · ')}</span><small>{p?.full_name || p?.email || 'System'} · {fmtDate(a.created_at, true)}</small></li>;
            })}
          </ul>
        )}
      </section>
    </>
  );
}
