import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

/** The app's public address. The production *.vercel.app address forwards here so clients only ever see it. */
const CANONICAL = (process.env.APP_CANONICAL_URL || 'https://app.elmamsflow.com').replace(/\/$/, '');

export async function middleware(request: NextRequest) {
  const host = request.headers.get('host') ?? '';
  // Production only (previews keep their own address). Webhooks (/api) keep working on the old address.
  if (process.env.VERCEL_ENV === 'production' && host.endsWith('.vercel.app') && !request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.redirect(`${CANONICAL}${request.nextUrl.pathname}${request.nextUrl.search}`, 308);
  }
  return updateSession(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|brand/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2)$).*)'],
};
