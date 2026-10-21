'use server';

import { redirect } from 'next/navigation';
import { getCtx, type Ctx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { inviteToOrg } from '@/lib/invite';
import { logActivity } from '@/lib/log';
import { CLIENT_ROLES, STAFF_ROLES } from '@/lib/roles';
import { str, withMsg } from '@/lib/format';

/** Which organisation's team this person may manage, and which roles they can give. */
export async function teamScope(ctx: Ctx) {
  const admin = supabaseAdmin();
  if (ctx.backOffice && ctx.can('team.manage')) {
    const { data } = await admin.from('organizations').select('id, name').eq('kind', 'owner').single();
    const roles = Object.keys(STAFF_ROLES).filter((r) => ctx.staffRole === 'owner' || r !== 'owner');
    return { orgId: data!.id as string, orgName: 'Elmamsflow', staff: true, roles };
  }
  if (ctx.org && ((ctx.clientRole && ctx.can('team.manage')) || (ctx.viewingAs && ctx.can('clients.manage')))) {
    return { orgId: ctx.org.id, orgName: ctx.org.name, staff: false, roles: Object.keys(CLIENT_ROLES) };
  }
  return null;
}

async function scope() {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  const s = await teamScope(ctx);
  if (!s) redirect(withMsg('/', 'You don’t have access to that.', 'err'));
  return { ctx, s };
}

async function target(orgId: string, userId: string) {
  const { data } = await supabaseAdmin().from('memberships').select('role, status').eq('org_id', orgId).eq('user_id', userId).maybeSingle();
  return data;
}

export async function inviteMember(fd: FormData) {
  const { ctx, s } = await scope();
  const email = str(fd, 'email').toLowerCase();
  const role = str(fd, 'role');
  if (!/^\S+@\S+\.\S+$/.test(email) || !s.roles.includes(role)) redirect(withMsg('/team', 'Add a valid email and choose a role.', 'err'));
  const r = await inviteToOrg({ email, name: str(fd, 'name'), orgId: s.orgId, role, invitedBy: ctx.userId });
  await logActivity(supabaseAdmin(), ctx.userId, s.staff ? null : s.orgId, 'member_invited', `${email} as ${role}`);
  if (!r.ok) redirect(withMsg('/team', `Invite failed: ${r.error}`, 'err'));
  redirect(withMsg('/team', r.existing ? `${email} already had an account and now has access.` : `Invitation emailed to ${email}.`));
}

export async function changeRole(fd: FormData) {
  const { ctx, s } = await scope();
  const userId = str(fd, 'user');
  const role = str(fd, 'role');
  const t = await target(s.orgId, userId);
  if (!t || userId === ctx.userId || !s.roles.includes(role) || (t.role === 'owner' && ctx.staffRole !== 'owner')) redirect(withMsg('/team', 'You can’t change this person’s role.', 'err'));
  await supabaseAdmin().from('memberships').update({ role }).eq('org_id', s.orgId).eq('user_id', userId);
  await logActivity(supabaseAdmin(), ctx.userId, s.staff ? null : s.orgId, 'member_role', role);
  redirect(withMsg('/team', 'Role updated.'));
}

export async function toggleMember(fd: FormData) {
  const { ctx, s } = await scope();
  const userId = str(fd, 'user');
  const t = await target(s.orgId, userId);
  if (!t || userId === ctx.userId || (t.role === 'owner' && ctx.staffRole !== 'owner')) redirect(withMsg('/team', 'You can’t change this person’s access.', 'err'));
  const next = t.status === 'paused' ? 'active' : 'paused';
  await supabaseAdmin().from('memberships').update({ status: next }).eq('org_id', s.orgId).eq('user_id', userId);
  await logActivity(supabaseAdmin(), ctx.userId, s.staff ? null : s.orgId, next === 'paused' ? 'member_paused' : 'member_restored');
  redirect(withMsg('/team', next === 'paused' ? 'Access paused.' : 'Access restored.'));
}

export async function removeMember(fd: FormData) {
  const { ctx, s } = await scope();
  const userId = str(fd, 'user');
  const t = await target(s.orgId, userId);
  if (!t || userId === ctx.userId || (t.role === 'owner' && ctx.staffRole !== 'owner')) redirect(withMsg('/team', 'You can’t remove this person.', 'err'));
  await supabaseAdmin().from('memberships').delete().eq('org_id', s.orgId).eq('user_id', userId);
  await logActivity(supabaseAdmin(), ctx.userId, s.staff ? null : s.orgId, 'member_removed');
  redirect(withMsg('/team', 'Removed from the team.'));
}
