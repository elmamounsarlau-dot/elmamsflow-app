import { after, NextResponse, type NextRequest } from 'next/server';
import { open, hmacOk } from '@/lib/integrations/crypto';
import { loadIntegration, logEvent } from '@/lib/integrations/core';
import { webhookSecretOf, type ShopifySecrets } from '@/lib/integrations/shopify';
import { handleStoreOrder } from '@/lib/integrations/service';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { applyBridgeOrder, bridgeOrderGid } from '@/lib/integrations/bridge';
import { afterOrderChange } from '@/lib/integrations/flow';

/** Shopify tells us an order was created, updated or cancelled (a client's store), or that the partner moved an order (our bridge store). Signed with the app's secret. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.text();
  const i = await loadIntegration(id).catch(() => null);
  if (!i || i.kind !== 'shopify') return NextResponse.json({ ok: false }, { status: 404 });
  const secret = webhookSecretOf(open<ShopifySecrets>(i.secret_enc));
  if (!hmacOk(secret, body, req.headers.get('x-shopify-hmac-sha256'))) return NextResponse.json({ ok: false }, { status: 401 });
  const topic = req.headers.get('x-shopify-topic') ?? '';
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(body) as Record<string, unknown>; } catch { /* ignore */ }
  const gid = payload.admin_graphql_api_id as string | undefined;
  // Answer Shopify straight away; do the work right after.
  after(async () => {
    try {
      if (topic === 'app/uninstalled') {
        await supabaseAdmin().from('integrations').update({ status: 'error', last_error: 'The app was uninstalled from the store.' }).eq('id', i.id);
        return;
      }
      // Our bridge store: the partner moved one of our orders. Apply it, then tell the client's store.
      if (i.role === 'bridge') {
        const bid = await bridgeOrderGid(i, topic, payload);
        const changed = bid ? await applyBridgeOrder(i, bid) : null;
        if (changed) await afterOrderChange([changed]);
        return;
      }
      if (topic.startsWith('orders/') && gid) await handleStoreOrder(i, { shopifyGid: gid });
    } catch (e) {
      await logEvent(i, 'error', `${topic}: ${(e as Error).message}`);
    }
  });
  return NextResponse.json({ ok: true });
}
