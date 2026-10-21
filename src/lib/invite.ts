import 'server-only';
import { supabaseAdmin } from './supabase/admin';
import { siteUrl } from './format';

/** Add someone to an organisation. New people get Supabase's invite email; existing users are added straight away. */
export async function inviteToOrg(opts: { email: string; name: string; orgId: string; role: string; invitedBy: string }) {
  const admin = supabaseAdmin();
  const email = opts.email.toLowerCase();
  const { data: existing } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
  if (existing) {
    const { error } = await admin.from('memberships').upsert(
      { org_id: opts.orgId, user_id: existing.id, role: opts.role, status: 'active', invited_by: opts.invitedBy },
      { onConflict: 'org_id,user_id' },
    );
    return { ok: !error, existing: true, error: error?.message };
  }
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: opts.name },
    redirectTo: `${siteUrl()}/auth/confirm?next=/set-password`,
  });
  if (error || !data.user) return { ok: false, existing: false, error: error?.message ?? 'Invite failed' };
  await admin.from('profiles').upsert({ id: data.user.id, email, full_name: opts.name });
  const { error: mErr } = await admin.from('memberships').insert({ org_id: opts.orgId, user_id: data.user.id, role: opts.role, status: 'invited', invited_by: opts.invitedBy });
  return { ok: !mErr, existing: false, error: mErr?.message };
}

/** Email a fresh "choose your password" link (works for invited and active people). */
export async function emailSignInLink(email: string) {
  const admin = supabaseAdmin();
  const { error } = await admin.auth.resetPasswordForEmail(email, { redirectTo: `${siteUrl()}/auth/confirm?next=/set-password` });
  return { ok: !error, error: error?.message };
}

/** A private link to copy and send yourself (replaces any earlier link). */
export async function copyableSignInLink(email: string) {
  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
  if (error || !data.properties?.hashed_token) return { ok: false, error: error?.message ?? 'Could not create link' };
  return { ok: true, link: `${siteUrl()}/auth/confirm?token_hash=${data.properties.hashed_token}&type=recovery&next=/set-password` };
}
