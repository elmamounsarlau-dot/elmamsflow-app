import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtDate, TICKET_CATEGORY, TICKET_STATUS } from '@/lib/format';
import { Arrow, Back, Badge } from '@/components/ui';
import { Submit } from '@/components/client';
import { FilesPick } from '@/components/media';
import { closeTicket, replyTicket } from '../actions';

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('tickets').select('*, organizations(name)').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: t } = await q.maybeSingle();
  if (!t) notFound();
  const [{ data: msgs }, { data: fileRows }] = await Promise.all([
    sb.from('ticket_messages').select('*, profile:profiles!ticket_messages_user_profile_fkey(full_name, email)').eq('ticket_id', id).order('created_at'),
    sb.from('ticket_files').select('id, message_id, name, type, size').eq('ticket_id', id).order('created_at'),
  ]);
  type F = { id: string; message_id: string | null; name: string; type: string; size: number };
  const files = (fileRows ?? []) as F[];
  const filesOf = (mid: string, first: boolean) => files.filter((f) => f.message_id === mid || (first && !f.message_id));
  const cat = TICKET_CATEGORY[t.category as string];
  return (
    <>
      <Back href="/support">Support</Back>
      <div className="ep-client-head"><div><h2>{t.subject} <Badge map={TICKET_STATUS} value={t.status} /></h2><p className="ep-muted">{cat && <span className="ep-tk-cat">{cat[0]}</span>}{ctx.backOffice ? `${(t.organizations as unknown as { name: string })?.name} · ` : ''}{t.order_ref ? `Order #${t.order_ref} · ` : ''}Opened {fmtDate(t.created_at)}</p></div></div>
      <section className="ep-card ep-card--narrow">
        <div className="ep-thread">
          {(msgs ?? []).map((m, i) => {
            const p = m.profile as unknown as { full_name: string; email: string } | null;
            const fs = filesOf(m.id, i === 0);
            return (
              <div key={m.id} className={`ep-msg${m.from_team ? ' ep-msg--team' : ''}`}>
                <small>{m.from_team ? 'Elmamsflow · ' : ''}{p?.full_name || p?.email} · {fmtDate(m.created_at, true)}</small>
                <p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p>
                {fs.length > 0 && (
                  <div className="ep-att">
                    {fs.map((f) => f.type.startsWith('image/') && f.type !== 'image/heic' ? (
                      // eslint-disable-next-line @next/next/no-img-element -- private file served by our own route
                      <a key={f.id} href={`/files/ticket/${f.id}`} target="_blank" rel="noopener" className="ep-att-img" title={f.name}><img src={`/files/ticket/${f.id}`} alt={f.name} loading="lazy" /></a>
                    ) : (
                      <a key={f.id} href={`/files/ticket/${f.id}${f.type === 'application/pdf' ? '' : '?download'}`} target="_blank" rel="noopener" className="ep-att-doc"><span>{f.type === 'application/pdf' ? 'PDF' : 'FILE'}</span><b>{f.name}</b><small>{Math.max(1, Math.round(f.size / 1024))} KB</small></a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {t.status !== 'closed' && ctx.can('support.reply') && (
          <form action={replyTicket} className="ep-form">
            <input type="hidden" name="id" value={t.id} />
            <label>Reply<textarea name="body" rows={3} required /></label>
            <FilesPick name="files" />
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
