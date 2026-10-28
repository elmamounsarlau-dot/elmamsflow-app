'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { logActivity } from '@/lib/log';
import { str, TICKET_CATEGORY, withMsg } from '@/lib/format';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { saveFile } from '@/lib/files';

const ATTACH = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

/** Saves the files sent with a message. Returns an error text for the first file that couldn't be saved. */
async function attach(fd: FormData, ticket: { id: string; org_id: string }, messageId: string | null, userId: string) {
  const files = fd.getAll('files').filter((f): f is File => f instanceof File && f.size > 0).slice(0, 4);
  const rows: Record<string, unknown>[] = [];
  let problem: string | null = null;
  for (const f of files) {
    try {
      const saved = await saveFile('tickets', `${ticket.org_id}/${ticket.id}`, f, { types: ATTACH, maxMb: 8, what: `file “${f.name}”` });
      rows.push({ ticket_id: ticket.id, message_id: messageId, path: saved.path, name: f.name.slice(0, 120) || 'file', type: saved.type, size: saved.size, uploaded_by: userId });
    } catch (e) {
      problem ??= (e as Error).message;
    }
  }
  if (rows.length) await supabaseAdmin().from('ticket_files').insert(rows);
  return problem;
}

export async function openTicket(fd: FormData) {
  const ctx = await getCtx();
  const orgId = ctx?.org?.id;
  if (!ctx || !orgId || !ctx.can('support.reply')) redirect(withMsg('/support', 'You don’t have access to that.', 'err'));
  const subject = str(fd, 'subject');
  const body = str(fd, 'body');
  if (!subject || !body) redirect(withMsg('/support/new', 'Add a subject and a message.', 'err'));
  const sb = await supabaseServer();
  const team = !!ctx.staffRole;
  const category = str(fd, 'category') in TICKET_CATEGORY ? str(fd, 'category') : 'other';
  const { data: t, error } = await sb.from('tickets').insert({ org_id: orgId, subject, category, order_ref: str(fd, 'order_ref').replace(/^#/, '') || null, status: team ? 'answered' : 'open', created_by: ctx.userId }).select('id').single();
  if (error || !t) redirect(withMsg('/support/new', error?.message ?? 'Could not send.', 'err'));
  const { data: m } = await sb.from('ticket_messages').insert({ ticket_id: t.id, user_id: ctx.userId, from_team: team, body }).select('id').single();
  const problem = await attach(fd, { id: t.id, org_id: orgId }, m?.id ?? null, ctx.userId);
  await logActivity(sb, ctx.userId, orgId, 'ticket_opened', subject);
  if (problem) redirect(withMsg(`/support/${t.id}`, `Ticket sent, but a file wasn’t attached: ${problem}`, 'warn'));
  redirect(withMsg(`/support/${t.id}`, 'Ticket sent. We usually reply within the hour during working hours.'));
}

export async function replyTicket(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id');
  const body = str(fd, 'body');
  if (!ctx || !ctx.can('support.reply') || !body) redirect(withMsg(`/support/${id}`, 'Write a message first.', 'err'));
  const sb = await supabaseServer();
  const team = !!ctx.staffRole;
  const { data: t } = await sb.from('tickets').select('id, org_id').eq('id', id).maybeSingle();
  if (!t) redirect(withMsg('/support', 'Ticket not found.', 'err'));
  const { data: m, error } = await sb.from('ticket_messages').insert({ ticket_id: id, user_id: ctx.userId, from_team: team, body }).select('id').single();
  if (error || !m) redirect(withMsg(`/support/${id}`, error?.message ?? 'Could not send.', 'err'));
  await sb.from('tickets').update({ status: team ? 'answered' : 'open', updated_at: new Date().toISOString() }).eq('id', id);
  const problem = await attach(fd, t, m.id, ctx.userId);
  redirect(withMsg(`/support/${id}`, problem ? `Reply sent, but a file wasn’t attached: ${problem}` : 'Reply sent.', problem ? 'warn' : 'ok'));
}

export async function closeTicket(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id');
  if (!ctx?.staffRole) redirect(`/support/${id}`);
  const sb = await supabaseServer();
  await sb.from('tickets').update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', id);
  redirect(withMsg(`/support/${id}`, 'Ticket closed.'));
}
