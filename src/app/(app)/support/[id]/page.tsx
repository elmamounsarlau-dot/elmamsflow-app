import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtDate, TICKET_STATUS } from '@/lib/format';
import { Arrow, Back, Badge } from '@/components/ui';
import { Submit } from '@/components/client';
import { closeTicket, replyTicket } from '../actions';

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('tickets').select('*, organizations(name)').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: t } = await q.maybeSingle();
  if (!t) notFound();
  const { data: msgs } = await sb.from('ticket_messages').select('*, profile:profiles!ticket_messages_user_profile_fkey(full_name, email)').eq('ticket_id', id).order('created_at');
  return (
    <>
      <Back href="/support">Support</Back>
      <div className="ep-client-head"><div><h2>{t.subject} <Badge map={TICKET_STATUS} value={t.status} /></h2><p className="ep-muted">{ctx.backOffice ? `${(t.organizations as unknown as { name: string })?.name} · ` : ''}{t.order_ref ? `Order #${t.order_ref} · ` : ''}Opened {fmtDate(t.created_at)}</p></div></div>
      <section className="ep-card ep-card--narrow">
        <div className="ep-thread">
          {(msgs ?? []).map((m) => {
            const p = m.profile as unknown as { full_name: string; email: string } | null;
            return (
              <div key={m.id} className={`ep-msg${m.from_team ? ' ep-msg--team' : ''}`}>
                <small>{m.from_team ? 'Elmamsflow · ' : ''}{p?.full_name || p?.email} · {fmtDate(m.created_at, true)}</small>
                <p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p>
              </div>
            );
          })}
        </div>
        {t.status !== 'closed' && ctx.can('support.reply') && (
          <form action={replyTicket} className="ep-form">
            <input type="hidden" name="id" value={t.id} />
            <label>Reply<textarea name="body" rows={3} required /></label>
            <div className="ep-form-foot" style={{ justifyContent: 'space-between', margin: 0 }}>
              <span />
              <Submit>Send reply <Arrow /></Submit>
            </div>
          </form>
        )}
        {t.status !== 'closed' && ctx.staffRole && (
          <form action={closeTicket} style={{ marginTop: '.8rem' }}><input type="hidden" name="id" value={t.id} /><Submit className="ep-link">Close ticket</Submit></form>
        )}
      </section>
    </>
  );
}
