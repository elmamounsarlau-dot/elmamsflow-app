import { NextResponse, type NextRequest } from 'next/server';
import { cronAllowed } from '@/lib/cron-auth';
import { sweepOrders } from '@/lib/integrations/flow';

/** Daily (Vercel Cron), or more often from any scheduler with CRON_SECRET: keep the warehouse, the balance and the clients' stores in step. */
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = cronAllowed(req.headers.get('authorization'));
  if (!auth.ok) {
    console.warn(`cron/sync refused: ${auth.reason}`);
    return NextResponse.json({ error: auth.reason === 'not_configured' ? 'CRON_SECRET is not configured' : 'forbidden' }, { status: auth.reason === 'not_configured' ? 503 : 401 });
  }
  try {
    return NextResponse.json(await sweepOrders());
  } catch (e) {
    console.error('cron/sync failed:', (e as Error).message);
    return NextResponse.json({ error: 'sync failed' }, { status: 502 });
  }
}
