import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { orgNames } from '@/lib/data';
import { fmtDate, TICKET_STATUS } from '@/lib/format';
import { Arrow, Badge, Empty } from '@/components/ui';

export const metadata = { title: 'Support' };

export default async function Support() {
  const ctx = await requireCtx();
  const sb = await supabaseServer();
  let q = sb.from('tickets').select('*').order('updated_at', { ascending: false }).limit(200);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const [{ data }, names] = await Promise.all([q, ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  const order = { open: 0, answered: 1, closed: 2 } as Record<string, number>;
  const list = (data ?? []).sort((a, b) => order[a.status] - order[b.status]);
  return (
    <>
      <h1 className="ep-page-title">Support</h1>
      <div className="ep-bar"><p className="ep-muted">{ctx.backOffice ? 'Questions from every client.' : 'Questions about an order, your stock or an invoice.'}</p>{!ctx.backOffice && ctx.can('support.reply') && <Link className="ep-btn" href="/support/new">New ticket <Arrow /></Link>}</div>
      <section className="ep-card">
        {list.length === 0 ? <Empty title="No tickets yet" text="Messages and answers stay together in one thread." /> : (
          <table className="ep-table">
            <thead><tr><th>Subject</th>{ctx.backOffice && <th>Client</th>}<th>Order</th><th>Updated</th><th>Status</th></tr></thead>
            <tbody>{list.map((t) => <tr key={t.id} data-href={`/support/${t.id}`}><td><b>{t.subject}</b></td>{ctx.backOffice && <td>{names[t.org_id]}</td>}<td>{t.order_ref ? `#${t.order_ref}` : '—'}</td><td>{fmtDate(t.updated_at, true)}</td><td><Badge map={TICKET_STATUS} value={t.status} /></td></tr>)}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
