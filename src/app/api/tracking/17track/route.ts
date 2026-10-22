import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { applyTrack, trackKey, validSignature, type TrackInfo } from '@/lib/track17';

/**
 * 17TRACK pushes every carrier update here (set this URL in 17TRACK → Settings → Webhook).
 * Only signed pushes are accepted; the signature uses the same API key, so nobody else can fake a status.
 * The order is found by the tag we sent at registration (our order id) and must still carry that tracking number.
 */
export const maxDuration = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Item = { number?: string; carrier?: number; tag?: string | null; track_info?: TrackInfo };

export async function POST(req: NextRequest) {
  const key = trackKey();
  if (!key) return NextResponse.json({ error: 'not configured' }, { status: 503 });
  const raw = await req.text();
  if (raw.length > 2_000_000) return NextResponse.json({ error: 'too large' }, { status: 413 });
  if (!validSignature(raw, req.headers.get('sign'), key)) {
    console.warn('17track webhook refused: bad signature');
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }
  let body: { event?: string; data?: Item & { accepted?: Item[] } };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  const items: Item[] = body.data?.accepted ?? (body.data ? [body.data] : []);
  const admin = supabaseAdmin();
  let applied = 0;
  for (const it of items) {
    const number = String(it.number ?? '').trim();
    if (!number) continue;
    let q = admin.from('orders').select('id, tracking').eq('tracking', number).in('status', ['shipped', 'delivered']);
    if (it.tag && UUID.test(it.tag)) q = q.eq('id', it.tag);
    const { data: orders } = await q.limit(5);
    for (const o of orders ?? []) {
      if (body.event === 'TRACKING_STOPPED') {
        await admin.from('orders').update({ tracking_status: 'Stopped', tracking_checked_at: new Date().toISOString() }).eq('id', o.id).eq('status', 'shipped');
        applied++;
      } else if (it.track_info) {
        const r = await applyTrack(o.id, o.tracking, it.track_info, it.carrier);
        if (r !== 'ignored') applied++;
      }
    }
  }
  return NextResponse.json({ received: true, applied });
}
