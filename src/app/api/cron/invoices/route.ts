import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { draftInvoice, lastMonth } from '@/lib/billing';

/** Runs on the 1st of every month (Vercel Cron): drafts last month's invoice for every client with a price list.
 *  Drafts are only visible to your team until someone issues them, and running it twice changes nothing. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const fromVercel = (req.headers.get('user-agent') ?? '').includes('vercel-cron');
  if (secret ? req.headers.get('authorization') !== `Bearer ${secret}` : !fromVercel) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const admin = supabaseAdmin();
  const ym = lastMonth();
  const { data: cards } = await admin.from('rate_cards').select('org_id, organizations!inner(kind, status)').eq('organizations.kind', 'client').eq('organizations.status', 'active');
  let created = 0;
  for (const c of (cards ?? []) as unknown as { org_id: string }[]) {
    const r = await draftInvoice(c.org_id, ym, null);
    if ('created' in r && r.created) created++;
  }
  if (created) await admin.from('activity_log').insert({ org_id: null, action: 'invoice_drafted', detail: `${created} drafts for ${ym} (automatic)` });
  return NextResponse.json({ month: ym, created });
}
