'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';

export async function openTicket(fd: FormData) {
  const ctx = await getCtx();
  const orgId = ctx?.org?.id;
  if (!ctx || !orgId || !ctx.can('support.reply')) redirect(withMsg('/support', 'You don’t have access to that.', 'err'));
  const subject = str(fd, 'subject');
  const body = str(fd, 'body');
  if (!subject || !body) redirect(withMsg('/support/new', 'Add a subject and a message.', 'err'));
  const sb = await supabaseServer();
  const team = !!ctx.staffRole;
  const { data: t, error } = await sb.from('tickets').insert({ org_id: orgId, subject, order_ref: str(fd, 'order_ref') || null, status: team ? 'answered' : 'open', created_by: ctx.userId }).select('id').single();
  if (error || !t) redirect(withMsg('/support/new', error?.message ?? 'Could not send.', 'err'));
  await sb.from('ticket_messages').insert({ ticket_id: t.id, user_id: ctx.userId, from_team: team, body });
  await logActivity(sb, ctx.userId, orgId, 'ticket_opened', subject);
  redirect(withMsg(`/support/${t.id}`, 'Ticket sent. We usually reply within the hour during working hours.'));
}

export async function replyTicket(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id');
  const body = str(fd, 'body');
  if (!ctx || !ctx.can('support.reply') || !body) redirect(withMsg(`/support/${id}`, 'Write a message first.', 'err'));
  const sb = await supabaseServer();
  const team = !!ctx.staffRole;
  const { error } = await sb.from('ticket_messages').insert({ ticket_id: id, user_id: ctx.userId, from_team: team, body });
  if (!error) await sb.from('tickets').update({ status: team ? 'answered' : 'open', updated_at: new Date().toISOString() }).eq('id', id);
  redirect(withMsg(`/support/${id}`, error ? error.message : 'Reply sent.', error ? 'err' : 'ok'));
}

export async function closeTicket(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id');
  if (!ctx?.staffRole) redirect(`/support/${id}`);
  const sb = await supabaseServer();
  await sb.from('tickets').update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', id);
  redirect(withMsg(`/support/${id}`, 'Ticket closed.'));
}
