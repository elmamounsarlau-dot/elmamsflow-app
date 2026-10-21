'use server';

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { str } from '@/lib/format';

export async function signIn(fd: FormData) {
  const email = str(fd, 'email').toLowerCase();
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email, password: String(fd.get('password') ?? '') });
  if (error) {
    redirect(`/login?err=${encodeURIComponent('That email and password don’t match. Check them and try again.')}&email=${encodeURIComponent(email)}`);
  }
  redirect('/');
}
