'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { copyableSignInLink, emailSignInLink, inviteToOrg } from '@/lib/invite';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';

async function manager() {
  const ctx = await getCtx();
  if (!ctx?.backOffice || !ctx.can('clients.manage')) redirect(withMsg('/clients', 'You don’t have access to that.', 'err'));
  return ctx;
}

export async function createClient(fd: FormData) {
  const ctx = await manager();
  const company = str(fd, 'company');
  const email = str(fd, 'email').toLowerCase();
  const name = str(fd, 'name');
  if (!company || !/^\S+@\S+\.\S+$/.test(email)) redirect(withMsg('/clients', 'Add the company name and a valid email.', 'err'));
  const admin = supabaseAdmin();
  const { data: org, error } = await admin.from('organizations').insert({ kind: 'client', name: company, country: str(fd, 'country') || null, phone: str(fd, 'phone') || null }).select('id, code').single();
  if (error || !org) redirect(withMsg('/clients', error?.message ?? 'Could not create the client.', 'err'));
  const inv = await inviteToOrg({ email, name, orgId: org.id, role: 'admin', invitedBy: ctx.userId });
  await logActivity(admin, ctx.userId, org.id, 'client_created', `${company} (${email})`);
  if (!inv.ok) redirect(withMsg(`/clients/${org.id}`, `${company} is created and ${email} is added as admin, but ${inv.error}.`, 'warn'));
  redirect(withMsg(`/clients/${org.id}`, inv.emailed ? `${company} is created. We emailed ${email} a private link to choose their password.` : `${company} is created. ${email} already had an account and was added straight away.`));
}

/** Add (or re-add) a person to a client workspace from the client page. */
export async function inviteClientMember(fd: FormData) {
  const ctx = await manager();
  const orgId = str(fd, 'org');
  const email = str(fd, 'email').toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) redirect(withMsg(`/clients/${orgId}`, 'Add a valid email.', 'err'));
  const role = ['admin', 'operations', 'support', 'finance'].includes(str(fd, 'role')) ? str(fd, 'role') : 'admin';
  const inv = await inviteToOrg({ email, name: str(fd, 'name'), orgId, role, invitedBy: ctx.userId });
  await logActivity(supabaseAdmin(), ctx.userId, orgId, 'member_invited', `${email} as ${role}`);
  redirect(withMsg(`/clients/${orgId}`, inv.ok ? (inv.emailed ? `Invitation emailed to ${email}.` : `${email} now has access.`) : `${email} is added, but ${inv.error}.`, inv.ok ? 'ok' : 'warn'));
}

export async function updateClient(fd: FormData) {
  const ctx = await manager();
  const id = str(fd, 'org');
  const admin = supabaseAdmin();
  await admin.from('organizations').update({ name: str(fd, 'company'), phone: str(fd, 'phone') || null, country: str(fd, 'country') || null, notes: str(fd, 'notes') || null }).eq('id', id).eq('kind', 'client');
  await logActivity(admin, ctx.userId, id, 'client_updated');
  redirect(withMsg(`/clients/${id}`, 'Client details saved.'));
}

export async function toggleClient(fd: FormData) {
  const ctx = await manager();
  const id = str(fd, 'org');
  const admin = supabaseAdmin();
  const { data: org } = await admin.from('organizations').select('status').eq('id', id).single();
  const next = org?.status === 'paused' ? 'active' : 'paused';
  await admin.from('organizations').update({ status: next }).eq('id', id).eq('kind', 'client');
  await logActivity(admin, ctx.userId, id, next === 'paused' ? 'client_paused' : 'client_restored');
  redirect(withMsg(`/clients/${id}`, next === 'paused' ? 'Access paused for everyone in this workspace.' : 'Access restored.'));
}

/** Email or copy a sign-in link for one member (used by clients and team pages). */
export async function memberLink(fd: FormData) {
  const ctx = await getCtx();
  const back = str(fd, 'back') || '/team';
  const userId = str(fd, 'user');
  const orgId = str(fd, 'org');
  if (!ctx) redirect('/login');
  const admin = supabaseAdmin();
  const { data: m } = await admin.from('memberships').select('org_id, organizations(kind)').eq('user_id', userId).eq('org_id', orgId).maybeSingle();
  const isClientOrg = (m?.organizations as unknown as { kind: string } | null)?.kind === 'client';
  const allowed = (ctx.backOffice || ctx.viewingAs) ? ctx.can(isClientOrg ? 'clients.manage' : 'team.manage') : ctx.can('team.manage') && ctx.org?.id === orgId;
  if (!m || !allowed) redirect(withMsg(back, 'You don’t have access to that.', 'err'));
  const { data: p } = await admin.from('profiles').select('email').eq('id', userId).single();
  if (!p?.email) redirect(withMsg(back, 'No email for this person.', 'err'));
  if (str(fd, 'mode') === 'copy') {
    const r = await copyableSignInLink(p.email);
    await logActivity(admin, ctx.userId, orgId, 'link_copied', p.email);
    if (!r.ok) redirect(withMsg(back, r.error ?? 'Could not create link', 'err'));
    redirect(`${back}${back.includes('?') ? '&' : '?'}link=${encodeURIComponent(r.link!)}&for=${encodeURIComponent(p.email)}`);
  }
  const r = await emailSignInLink(p.email);
  await logActivity(admin, ctx.userId, orgId, 'link_emailed', p.email);
  redirect(withMsg(back, r.ok ? `A new private link was emailed to ${p.email}. Older links stop working.` : `Email failed: ${r.error}`, r.ok ? 'ok' : 'err'));
}
