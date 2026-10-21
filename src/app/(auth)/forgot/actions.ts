'use server';

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { siteUrl, str } from '@/lib/format';

export async function sendReset(fd: FormData) {
  const supabase = await supabaseServer();
  await supabase.auth.resetPasswordForEmail(str(fd, 'email').toLowerCase(), { redirectTo: `${siteUrl()}/auth/confirm?next=/set-password` });
  redirect('/forgot?sent=1');
}
