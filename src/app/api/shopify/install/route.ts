import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { normalizeShop } from '@/lib/integrations/shopify';
import { authorizeUrl, findInstall, freshTimestamp, installPage, queryHmacOk, secretOf } from '@/lib/integrations/shopify-install';

export const dynamic = 'force-dynamic';

/** App URL: Shopify sends the store owner here after they click Install (and when they open the app later). */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const shop = normalizeShop(q.get('shop') ?? '');
  if (!shop) return installPage('Link not recognised', 'Open the install link Elmamsflow sent you, from your Shopify admin.', false, 400);
  const x = await findInstall(shop);
  if (!x) return installPage('This store isn’t expected yet', 'Ask Elmamsflow for your install link — it’s made for your store only.', false, 404);
  if (!queryHmacOk(secretOf(x), q) || !freshTimestamp(q.get('timestamp'))) return installPage('Link not recognised', 'This request didn’t come from Shopify. Open the install link again.', false, 401);
  if (x.status === 'installed') return installPage('Your store is connected', 'Paid orders reach Elmamsflow by themselves, and tracking comes back to your store when they ship.', true);
  const state = randomBytes(18).toString('base64url');
  const res = NextResponse.redirect(authorizeUrl(x, state));
  res.cookies.set('elm_shopify_state', `${state}.${x.id}`, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/shopify', maxAge: 600 });
  return res;
}
