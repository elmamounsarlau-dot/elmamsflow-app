import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { supabaseServer } from '@/lib/supabase/server';

/** Lands here from the invite / reset email. Signs the person in, then asks for a password. */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/set-password';
  const supabase = await supabaseServer();

  let ok = false;
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    ok = !error;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  }
  const dest = url.clone();
  dest.search = '';
  if (!ok) {
    dest.pathname = '/login';
    dest.searchParams.set('err', 'This link has expired or was already used. Ask your Elmamsflow contact for a new one, or use “Forgot your password”.');
    return NextResponse.redirect(dest);
  }
  dest.pathname = next.startsWith('/') ? next : '/set-password';
  return NextResponse.redirect(dest);
}
