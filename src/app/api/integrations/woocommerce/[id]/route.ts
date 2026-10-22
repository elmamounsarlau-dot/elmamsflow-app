import { after, NextResponse, type NextRequest } from 'next/server';
import { open, hmacOk } from '@/lib/integrations/crypto';
import { loadIntegration, logEvent } from '@/lib/integrations/core';
import { wooToExt, type WooSecrets } from '@/lib/integrations/woocommerce';
import { handleStoreOrder } from '@/lib/integrations/service';

/** WooCommerce tells us an order was created or updated. Signed with the secret we gave it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.text();
  const i = await loadIntegration(id).catch(() => null);
  if (!i || i.kind !== 'woocommerce') return NextResponse.json({ ok: false }, { status: 404 });
  const topic = req.headers.get('x-wc-webhook-topic');
  if (!topic) return NextResponse.json({ ok: true }); // WooCommerce's test ping when the webhook is created
  if (!hmacOk(open<WooSecrets>(i.secret_enc).webhook_secret, body, req.headers.get('x-wc-webhook-signature'))) return NextResponse.json({ ok: false }, { status: 401 });
  let order: Parameters<typeof wooToExt>[0] | null = null;
  try { order = JSON.parse(body); } catch { /* ignore */ }
  if (order?.id && topic.startsWith('order.')) {
    after(async () => {
      try {
        await handleStoreOrder(i, { woo: wooToExt(order!) });
      } catch (e) {
        await logEvent(i, 'error', `${topic}: ${(e as Error).message}`);
      }
    });
  }
  return NextResponse.json({ ok: true });
}
