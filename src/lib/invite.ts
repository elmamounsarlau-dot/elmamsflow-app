import 'server-only';
import { supabaseAdmin } from './supabase/admin';
import { siteUrl } from './format';

const redirectTo = () => `${siteUrl()}/auth/confirm?next=/set-password`;

/**
 * Add someone to an organisation and email them a private link.
 * - New person: Supabase creates the account and sends the invite email.
 * - Existing person who never signed in: they get a fresh "choose your password" email.
 * - Existing active person: added straight away (no email needed).
 * The membership is always saved, even if the email fails, so a new link can be sent later.
 */
export async function inviteToOrg(opts: { email: string; name: string; orgId: string; role: string; invitedBy: string }) {
  const admin = supabaseAdmin();
  const email = opts.email.toLowerCase();
  const { data: existing } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();

  if (existing) {
    const { data: u } = await admin.auth.admin.getUserById(existing.id);
    const neverSignedIn = !u.user?.last_sign_in_at;
    const { error } = await admin.from('memberships').upsert(
      { org_id: opts.orgId, user_id: existing.id, role: opts.role, status: neverSignedIn ? 'invited' : 'active', invited_by: opts.invitedBy },
      { onConflict: 'org_id,user_id' },
    );
    if (error) return { ok: false, existing: true, emailed: false, error: error.message };
    if (!neverSignedIn) return { ok: true, existing: true, emailed: false };
    const r = await emailSignInLink(email);
    return { ok: r.ok, existing: true, emailed: r.ok, error: r.error };
  }

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: opts.name }, redirectTo: redirectTo() });
  // Supabase may create the account even when the email itself fails.
  let userId = data?.user?.id;
  if (!userId) {
    const { data: p } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
    userId = p?.id;
  }
  if (userId) {
    await admin.from('profiles').upsert({ id: userId, email, full_name: opts.name });
    await admin.from('memberships').upsert({ org_id: opts.orgId, user_id: userId, role: opts.role, status: 'invited', invited_by: opts.invitedBy }, { onConflict: 'org_id,user_id' });
  }
  if (error) return { ok: false, existing: false, emailed: false, error: emailError(error.message) };
  return { ok: true, existing: false, emailed: true };
}

/** Email a fresh "choose your password" link (works for invited and active people). */
export async function emailSignInLink(email: string) {
  const admin = supabaseAdmin();
  const { error } = await admin.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
  return { ok: !error, error: error ? emailError(error.message) : undefined };
}

/** A private link to copy and send yourself (replaces any earlier link). */
export async function copyableSignInLink(email: string) {
  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
  if (error || !data.properties?.hashed_token) return { ok: false, error: error?.message ?? 'Could not create link' };
  return { ok: true, link: `${siteUrl()}/auth/confirm?token_hash=${data.properties.hashed_token}&type=recovery&next=/set-password` };
}

function emailError(msg: string) {
  if (/sending|smtp|535|credential/i.test(msg)) return 'the email could not be sent. Check the email settings (SMTP) in Supabase, or use “Copy a link” and send it yourself';
  if (/rate limit/i.test(msg)) return 'too many emails were sent in a short time. Wait a few minutes or use “Copy a link”';
  return msg;
}
