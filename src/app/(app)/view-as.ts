'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCtx, VIEW_AS_COOKIE } from '@/lib/session';

export async function viewAs(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx?.staffRole) redirect('/');
  (await cookies()).set(VIEW_AS_COOKIE, String(fd.get('org') ?? ''), { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 8 });
  redirect('/');
}

export async function exitViewAs(fd: FormData) {
  (await cookies()).delete(VIEW_AS_COOKIE);
  const org = String(fd.get('org') ?? '');
  redirect(org ? `/clients/${org}` : '/clients');
}
