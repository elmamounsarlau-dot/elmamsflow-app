import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

/** Stripe tells us a card payment succeeded; the invoice turns to Paid. The signature proves it came from Stripe. */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'not configured' }, { status: 503 });
  const body = await req.text();
  const header = req.headers.get('stripe-signature') ?? '';
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok || !t || Math.abs(Date.now() / 1000 - t) > 300) return NextResponse.json({ error: 'bad signature' }, { status: 400 });

  const event = JSON.parse(body) as { type: string; data: { object: { payment_status?: string; payment_intent?: string; metadata?: { invoice_id?: string }; amount_total?: number; currency?: string } } };
  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    const o = event.data.object;
    const id = o.metadata?.invoice_id;
    if (id) {
      const admin = supabaseAdmin();
      const { data: inv } = await admin.from('invoices').select('id, number, org_id, total, currency, status').eq('id', id).maybeSingle();
      // Only mark paid if the amount and currency match the invoice.
      if (inv && inv.status === 'open' && o.amount_total === Math.round(Number(inv.total) * 100) && o.currency === String(inv.currency).toLowerCase()) {
        await admin.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString(), paid_method: 'card', paid_ref: o.payment_intent ?? null }).eq('id', id);
        await admin.from('activity_log').insert({ org_id: inv.org_id, action: 'invoice_paid', detail: `${inv.number} · card (Stripe)` });
      }
    }
  }
  return NextResponse.json({ received: true });
}
