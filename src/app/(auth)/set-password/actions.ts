'use server';

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logActivity } from '@/lib/log';
import { forgetLink } from '@/lib/invite';

export async function setPassword(fd: FormData) {
  const p1 = String(fd.get('pass1') ?? '');
  const p2 = String(fd.get('pass2') ?? '');
  if (p1.length < 8) redirect('/set-password?err=' + encodeURIComponent('Use at least 8 characters.'));
  if (p1 !== p2) redirect('/set-password?err=' + encodeURIComponent('The two passwords don’t match.'));
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  // Without the current password, a password can only be set right after opening an invitation or reset link.
  // A normal signed-in session changes it in Settings, which asks for the current one.
  const { data: cl } = await supabase.auth.getClaims();
  const amr = (cl?.claims?.amr ?? []) as { method: string; timestamp: number }[];
  const fromLink = !amr.length || amr.some((a) => a.method !== 'password' && Date.now() / 1000 - a.timestamp < 24 * 3600);
  if (!fromLink) redirect('/settings?err=' + encodeURIComponent('Change your password here — it asks for your current one first.'));
  const { error } = await supabase.auth.updateUser({ password: p1 });
  if (error) redirect('/set-password?err=' + encodeURIComponent(error.message));
  // First time in: invitations become active memberships.
  const admin = supabaseAdmin();
  const { data: invited } = await admin.from('memberships').update({ status: 'active' }).eq('user_id', user.id).eq('status', 'invited').select('org_id');
  for (const m of invited ?? []) await logActivity(admin, user.id, m.org_id, 'password_set', user.email ?? '');
  await forgetLink(user.id);
  redirect('/?welcome=1');
}
