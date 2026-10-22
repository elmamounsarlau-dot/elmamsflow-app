import { after, NextResponse, type NextRequest } from 'next/server';
import { open, hmacOk } from '@/lib/integrations/crypto';
import { loadIntegration, logEvent } from '@/lib/integrations/core';
import { webhookSecretOf, type ShopifySecrets } from '@/lib/integrations/shopify';
import { handleStoreOrder } from '@/lib/integrations/service';
import { supabaseAdmin } from '@/lib/supabase/admin';

/** Shopify tells us an order was created, updated or cancelled. Signed with the app's secret. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.text();
  const i = await loadIntegration(id).catch(() => null);
  if (!i || i.kind !== 'shopify') return NextResponse.json({ ok: false }, { status: 404 });
  const secret = webhookSecretOf(open<ShopifySecrets>(i.secret_enc));
  if (!hmacOk(secret, body, req.headers.get('x-shopify-hmac-sha256'))) return NextResponse.json({ ok: false }, { status: 401 });
  const topic = req.headers.get('x-shopify-topic') ?? '';
  let gid: string | undefined;
  try { gid = (JSON.parse(body) as { admin_graphql_api_id?: string }).admin_graphql_api_id; } catch { /* ignore */ }
  // Answer Shopify straight away; do the work right after.
  after(async () => {
    try {
      if (topic === 'app/uninstalled') {
        await supabaseAdmin().from('integrations').update({ status: 'error', last_error: 'The app was uninstalled from the store.' }).eq('id', i.id);
        return;
      }
      if (topic.startsWith('orders/') && gid) await handleStoreOrder(i, { shopifyGid: gid });
    } catch (e) {
      await logEvent(i, 'error', `${topic}: ${(e as Error).message}`);
    }
  });
  return NextResponse.json({ ok: true });
}
