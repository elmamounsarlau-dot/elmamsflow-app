'use server';

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { logActivity } from '@/lib/log';
import { getCtx } from '@/lib/session';
import { str, withMsg } from '@/lib/format';

export async function saveProfile(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  const sb = await supabaseServer();
  await sb.from('profiles').update({ full_name: str(fd, 'name'), phone: str(fd, 'phone') || null }).eq('id', ctx.userId);
  redirect(withMsg('/settings', 'Profile saved.'));
}

export async function changePassword(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  const p1 = String(fd.get('pass1') ?? '');
  if (p1.length < 8 || p1 !== String(fd.get('pass2') ?? '')) redirect(withMsg('/settings', 'The new password needs at least 8 characters, typed the same twice.', 'err'));
  const sb = await supabaseServer();
  const { error: e1 } = await sb.auth.signInWithPassword({ email: ctx.email, password: String(fd.get('current') ?? '') });
  if (e1) redirect(withMsg('/settings', 'Your current password is not right.', 'err'));
  const { error } = await sb.auth.updateUser({ password: p1 });
  if (error) redirect(withMsg('/settings', error.message, 'err'));
  await logActivity(sb, ctx.userId, ctx.clientRole ? ctx.org!.id : null, 'password_changed');
  redirect(withMsg('/settings', 'Password changed.'));
}
