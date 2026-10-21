import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '?bye=1';
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.delete('elm_as');
  return res;
}
