import { NextResponse, type NextRequest } from 'next/server';
import { cronAllowed } from '@/lib/cron-auth';
import { syncTracking } from '@/lib/track17';

/** Daily (Vercel Cron): register shipped parcels 17TRACK doesn't know yet and refresh any that went quiet. */
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = cronAllowed(req.headers.get('authorization'));
  if (!auth.ok) {
    console.warn(`cron/tracking refused: ${auth.reason}`);
    return NextResponse.json({ error: auth.reason === 'not_configured' ? 'CRON_SECRET is not configured' : 'forbidden' }, { status: auth.reason === 'not_configured' ? 503 : 401 });
  }
  try {
    return NextResponse.json(await syncTracking());
  } catch (e) {
    console.error('cron/tracking failed:', (e as Error).message);
    return NextResponse.json({ error: 'sync failed' }, { status: 502 });
  }
}
