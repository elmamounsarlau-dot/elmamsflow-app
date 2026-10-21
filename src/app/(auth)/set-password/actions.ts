'use server';

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logActivity } from '@/lib/log';

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
  const { error } = await supabase.auth.updateUser({ password: p1 });
  if (error) redirect('/set-password?err=' + encodeURIComponent(error.message));
  // First time in: invitations become active memberships.
  const admin = supabaseAdmin();
  const { data: invited } = await admin.from('memberships').update({ status: 'active' }).eq('user_id', user.id).eq('status', 'invited').select('org_id');
  for (const m of invited ?? []) await logActivity(admin, user.id, m.org_id, 'password_set', user.email ?? '');
  redirect('/?welcome=1');
}
