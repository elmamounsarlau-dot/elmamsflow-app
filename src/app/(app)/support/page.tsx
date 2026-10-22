import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { allRows, orgNames } from '@/lib/data';
import { fmtDate, TICKET_STATUS } from '@/lib/format';
import { Arrow, Badge, Empty, PageHead, Pager, pageOf } from '@/components/ui';

export const metadata = { title: 'Support' };

export default async function Support({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const sb = await supabaseServer();
  const PER = 25;
  const page = pageOf(sp.p);
  type Tk = { id: string; org_id: string; subject: string; order_ref: string | null; status: string; updated_at: string };
  const [all, names] = await Promise.all([
    allRows<Tk>(() => {
      let q = sb.from('tickets').select('id, org_id, subject, order_ref, status, updated_at').order('updated_at', { ascending: false }).order('id');
      if (ctx.org) q = q.eq('org_id', ctx.org.id);
      return q;
    }),
    ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>),
  ]);
  // Open first, then answered, then closed; newest first inside each.
  const order = { open: 0, answered: 1, closed: 2 } as Record<string, number>;
  const sorted = [...all].sort((a, b) => order[a.status] - order[b.status]);
  const count = sorted.length;
  const list = sorted.slice((page - 1) * PER, page * PER);
  return (
    <>
      <PageHead crumb="Support" title="Support" sub="Ask us anything about an order, stock or billing — answers stay here with the history." />
      <div className="ep-bar"><p className="ep-muted">{ctx.backOffice ? 'Questions from every client.' : 'Questions about an order, your stock or an invoice.'}</p>{!ctx.backOffice && ctx.can('support.reply') && <Link className="ep-btn" href="/support/new">New ticket <Arrow /></Link>}</div>
      <section className="ep-card">
        {list.length === 0 ? <Empty title="No tickets yet" text="Messages and answers stay together in one thread." /> : (
          <table className="ep-table">
            <thead><tr><th>Subject</th>{ctx.backOffice && <th>Client</th>}<th>Order</th><th>Updated</th><th>Status</th></tr></thead>
            <tbody>{list.map((t) => <tr key={t.id} data-href={`/support/${t.id}`}><td><b>{t.subject}</b></td>{ctx.backOffice && <td>{names[t.org_id]}</td>}<td>{t.order_ref ? `#${t.order_ref}` : '—'}</td><td>{fmtDate(t.updated_at, true)}</td><td><Badge map={TICKET_STATUS} value={t.status} /></td></tr>)}</tbody>
          </table>
        )}
        <Pager total={count ?? 0} page={page} per={PER} href={(n) => (n > 1 ? `/support?p=${n}` : '/support')} noun="ticket" />
      </section>
    </>
  );
}
