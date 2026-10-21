'use server';

import { redirect } from 'next/navigation';
import { getCtx, type Ctx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { inviteToOrg } from '@/lib/invite';
import { logActivity } from '@/lib/log';
import { permsFor, type RoleDef } from '@/lib/roles';
import { getOrgRoles } from '@/lib/roles-db';
import { str, withMsg } from '@/lib/format';

/** Which organisation's team this person may manage, which roles they can give, and whether they can change roles. */
export async function teamScope(ctx: Ctx) {
  const admin = supabaseAdmin();
  if (ctx.backOffice && ctx.can('team.manage')) {
    const { data } = await admin.from('organizations').select('id, name').eq('kind', 'owner').single();
    const { roles: defs, editable } = await getOrgRoles(data!.id, true);
    const roles = defs.map((r) => r.key).filter((r) => ctx.staffRole === 'owner' || r !== 'owner');
    // Only the owner changes what Elmamsflow staff roles can do.
    return { orgId: data!.id as string, orgName: 'Elmamsflow', staff: true, roles, defs, canEditRoles: editable && ctx.staffRole === 'owner' };
  }
  if (ctx.org && ((ctx.clientRole && ctx.can('team.manage')) || (ctx.viewingAs && ctx.can('clients.manage')))) {
    const { roles: defs, editable } = await getOrgRoles(ctx.org.id, false);
    return { orgId: ctx.org.id, orgName: ctx.org.name, staff: false, roles: defs.map((r) => r.key), defs, canEditRoles: editable };
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
  const msg = !r.ok ? withMsg('/team', `${email} is added, but ${r.error}.`, 'warn') : withMsg('/team', r.emailed ? `Invitation emailed to ${email}.` : `${email} already had an account and now has access.`);
  // The owner (and managers) also get the private link on screen; client admins only get the email.
  const showLink = r.link && s.staff ? `&link=${encodeURIComponent(r.link)}&for=${encodeURIComponent(email)}` : r.link && !s.staff && ctx.viewingAs ? `&link=${encodeURIComponent(r.link)}&for=${encodeURIComponent(email)}` : '';
  redirect(msg + showLink);
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

// ---------- Roles: adjust what each role can do, add or delete roles ----------

async function roleScope() {
  const { ctx, s } = await scope();
  if (!s.canEditRoles) redirect(withMsg('/team', 'Only the owner can change roles.', 'err'));
  return { ctx, s };
}

function pickPerms(fd: FormData, staff: boolean) {
  const allowed = new Set(permsFor(staff).map((p) => p.key as string));
  return fd.getAll('perm').map(String).filter((p) => allowed.has(p));
}

function cleanText(v: string, max: number) {
  return v.replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function saveRole(fd: FormData) {
  const { ctx, s } = await roleScope();
  const key = str(fd, 'key');
  const def = s.defs.find((r: RoleDef) => r.key === key);
  if (!def) redirect(withMsg('/team#roles', 'That role doesn’t exist.', 'err'));
  const label = cleanText(str(fd, 'label'), 40) || def.label;
  const about = cleanText(str(fd, 'about'), 160);
  const perms = def.locked ? def.perms : pickPerms(fd, s.staff);
  await supabaseAdmin().from('roles').update({ label, about: about || null, perms }).eq('org_id', s.orgId).eq('key', key);
  await logActivity(supabaseAdmin(), ctx.userId, s.staff ? null : s.orgId, 'role_changed', `${label}: ${perms.length} permissions`);
  redirect(withMsg('/team#roles', `“${label}” saved. It applies straight away to everyone with this role.`));
}

export async function createRole(fd: FormData) {
  const { ctx, s } = await roleScope();
  const label = cleanText(str(fd, 'label'), 40);
  if (!label) redirect(withMsg('/team#roles', 'Give the new role a name.', 'err'));
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'role';
  let key = base;
  for (let i = 2; s.defs.some((r: RoleDef) => r.key === key); i++) key = `${base}-${i}`;
  const copy = s.defs.find((r: RoleDef) => r.key === str(fd, 'copy'));
  const picked = pickPerms(fd, s.staff);
  const allowed = new Set(permsFor(s.staff).map((p) => p.key as string));
  const perms = picked.length ? picked : copy ? (copy.locked ? [...allowed] : copy.perms.filter((p) => allowed.has(p))) : [];
  const position = Math.max(0, ...s.defs.map((r: RoleDef) => r.position)) + 1;
  const { error } = await supabaseAdmin().from('roles').insert({ org_id: s.orgId, key, label, about: cleanText(str(fd, 'about'), 160) || null, perms, position });
  if (error) redirect(withMsg('/team#roles', error.message, 'err'));
  await logActivity(supabaseAdmin(), ctx.userId, s.staff ? null : s.orgId, 'role_created', label);
  redirect(withMsg('/team#roles', `“${label}” added. You can now give it to anyone on the team.`));
}

export async function deleteRole(fd: FormData) {
  const { ctx, s } = await roleScope();
  const key = str(fd, 'key');
  const def = s.defs.find((r: RoleDef) => r.key === key);
  if (!def || def.system) redirect(withMsg('/team#roles', 'Default roles can be adjusted but not deleted.', 'err'));
  const { count } = await supabaseAdmin().from('memberships').select('id', { count: 'exact', head: true }).eq('org_id', s.orgId).eq('role', key);
  if (count) redirect(withMsg('/team#roles', `${count} ${count === 1 ? 'person has' : 'people have'} this role. Give them another role first.`, 'err'));
  await supabaseAdmin().from('roles').delete().eq('org_id', s.orgId).eq('key', key);
  await logActivity(supabaseAdmin(), ctx.userId, s.staff ? null : s.orgId, 'role_deleted', def.label);
  redirect(withMsg('/team#roles', `“${def.label}” deleted.`));
}
