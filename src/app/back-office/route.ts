import { NextResponse, type NextRequest } from 'next/server';
import { VIEW_AS_COOKIE } from '@/lib/session';

/** Leave "view as client" and go to a back-office page (used when a back-office page is opened while viewing as a client). */
export async function GET(req: NextRequest) {
  const to = req.nextUrl.searchParams.get('to') ?? '/';
  const safe = to.startsWith('/') && !to.startsWith('//') ? to : '/';
  const res = NextResponse.redirect(new URL(safe, req.url));
  res.cookies.delete(VIEW_AS_COOKIE);
  return res;
}
