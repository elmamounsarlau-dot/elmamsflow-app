import 'server-only';
import { supabaseAdmin } from './supabase/admin';
import { siteUrl } from './format';

const redirectTo = () => `${siteUrl()}/auth/confirm?next=/set-password`;

type Result = { ok: boolean; existing: boolean; emailed: boolean; link?: string; error?: string };

/**
 * Add someone to an organisation, email them an invitation AND keep a private link the owner can copy.
 * The emailed invitation and the copyable link are two separate links: both work, using one does not break the other.
 * The membership is always saved, even if the email fails, so the owner can still copy the link or resend.
 */
export async function inviteToOrg(opts: { email: string; name: string; orgId: string; role: string; invitedBy: string }): Promise<Result> {
  const admin = supabaseAdmin();
  const email = opts.email.toLowerCase();
  const { data: existing } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();

  if (existing) {
    const { data: u } = await admin.auth.admin.getUserById(existing.id);
    const pending = !u.user?.last_sign_in_at;
    const { error } = await admin.from('memberships').upsert(
      { org_id: opts.orgId, user_id: existing.id, role: opts.role, status: pending ? 'invited' : 'active', invited_by: opts.invitedBy },
      { onConflict: 'org_id,user_id' },
    );
    if (error) return { ok: false, existing: true, emailed: false, error: error.message };
    if (!pending) return { ok: true, existing: true, emailed: false };
    const sent = await emailSignInLink(existing.id, email, opts.orgId, opts.invitedBy);
    return { ...sent, existing: true };
  }

  // 1) Try to email the invitation. If the email fails, Supabase does not create the account at all.
  const { error } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: opts.name }, redirectTo: redirectTo() });
  // 2) Always make a private link for the owner. If the account doesn't exist yet (email failed),
  //    creating an invite link creates the account without sending anything.
  let kept = await keepLink(null, email, opts.orgId, opts.invitedBy, !error, error ? emailError(error.message) : null);
  if (!kept.link) kept = await keepLink(null, email, opts.orgId, opts.invitedBy, false, error ? emailError(error.message) : null, false, { full_name: opts.name });
  if (!kept.userId) return { ok: false, existing: false, emailed: false, error: error ? emailError(error.message) : kept.error };
  await admin.from('profiles').upsert({ id: kept.userId, email, full_name: opts.name });
  await admin.from('memberships').upsert({ org_id: opts.orgId, user_id: kept.userId, role: opts.role, status: 'invited', invited_by: opts.invitedBy }, { onConflict: 'org_id,user_id' });
  if (error) return { ok: false, existing: false, emailed: false, link: kept.link, error: emailError(error.message) };
  return { ok: true, existing: false, emailed: true, link: kept.link };
}

/**
 * Email the person a link again.
 * - Never opened the invitation → the invitation email is sent again (the copyable link keeps working).
 * - Already confirmed → a "choose your password" email; this replaces the copyable link, so a fresh one is kept.
 */
export async function emailSignInLink(userId: string, email: string, orgId: string | null, by: string): Promise<Result> {
  const admin = supabaseAdmin();
  const { data: u } = await admin.auth.admin.getUserById(userId);
  if (!u.user?.email_confirmed_at) {
    const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: redirectTo() });
    const kept = await keepLink(userId, email, orgId, by, !error, error ? emailError(error.message) : null);
    return { ok: !error, existing: true, emailed: !error, link: kept.link, error: error ? emailError(error.message) : undefined };
  }
  const { error } = await admin.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
  // The emailed reset link and a copyable recovery link can't both exist, so keep a note without a link.
  await admin.from('access_links').delete().eq('user_id', userId);
  return { ok: !error, existing: true, emailed: !error, error: error ? emailError(error.message) : undefined };
}

/** Make a fresh private link to copy (replaces the previous copyable link) and keep it for the owner. */
export async function copyableSignInLink(userId: string, email: string, orgId: string | null, by: string) {
  const r = await keepLink(userId, email, orgId, by, false, null, true);
  return r.link ? { ok: true, link: r.link } : { ok: false, error: r.error ?? 'Could not create link' };
}

async function keepLink(
  userId: string | null, email: string, orgId: string | null, by: string, emailed: boolean, emailErr: string | null,
  keepEmailedFlag = false, createWith?: Record<string, string>,
): Promise<{ link?: string; userId?: string; error?: string }> {
  const admin = supabaseAdmin();
  const { data, error } = createWith
    ? await admin.auth.admin.generateLink({ type: 'invite', email, options: { data: createWith, redirectTo: redirectTo() } })
    : await admin.auth.admin.generateLink({ type: 'recovery', email });
  if (error || !data.properties?.hashed_token) return { error: error?.message ?? 'Could not create link' };
  const type = createWith ? 'invite' : 'recovery';
  const link = `${siteUrl()}/auth/confirm?token_hash=${data.properties.hashed_token}&type=${type}&next=/set-password`;
  const uid = userId ?? data.user?.id;
  const row: Record<string, unknown> = { user_id: uid, org_id: orgId, email, link, created_by: by, created_at: new Date().toISOString() };
  if (!keepEmailedFlag) Object.assign(row, { emailed, email_error: emailErr });
  await admin.from('access_links').upsert(row, { onConflict: 'user_id' });
  return { link, userId: uid };
}

/** Once someone has chosen their password their stored link is no longer needed. */
export async function forgetLink(userId: string) {
  await supabaseAdmin().from('access_links').delete().eq('user_id', userId);
}

export type AccessLink = { user_id: string; org_id: string | null; email: string; link: string; emailed: boolean; email_error: string | null; created_at: string };

export function linkAge(createdAt: string) {
  const h = (Date.now() - new Date(createdAt).getTime()) / 36e5;
  return { expired: h >= 24, text: h < 1 ? 'made less than an hour ago' : h < 24 ? `made ${Math.floor(h)} h ago` : 'older than 24 h — make a new one' };
}

function emailError(msg: string) {
  if (/sending|smtp|535|credential/i.test(msg)) return 'the email could not be sent (check the SMTP settings in Supabase). The private link below still works — copy it and send it yourself';
  if (/rate limit/i.test(msg)) return 'too many emails were sent in a short time. The private link below still works — copy it and send it yourself';
  return msg;
}
