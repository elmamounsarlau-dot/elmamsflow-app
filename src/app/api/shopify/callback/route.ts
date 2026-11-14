import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { normalizeShop } from '@/lib/integrations/shopify';
import { completeInstall, findInstall, freshTimestamp, installPage, queryHmacOk, secretOf } from '@/lib/integrations/shopify-install';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Redirect URL: the store owner approved the permissions; Shopify hands us a one-time code. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const shop = normalizeShop(q.get('shop') ?? '');
  const code = q.get('code') ?? '';
  const [state, installId] = (req.cookies.get('elm_shopify_state')?.value ?? '').split('.');
  const x = shop ? await findInstall(shop) : null;
  const fail = (t: string, m: string, s: number) => installPage(t, m, false, s);
  if (!shop || !code || !x) return fail('Link not recognised', 'Open the install link Elmamsflow sent you again.', 400);
  if (!queryHmacOk(secretOf(x), q) || !freshTimestamp(q.get('timestamp'))) return fail('Link not recognised', 'This request didn’t come from Shopify. Open the install link again.', 401);
  if (!state || installId !== x.id || !same(state, q.get('state') ?? '')) return fail('Please try again', 'The connection took too long or was opened in another browser. Open the install link again.', 400);
  if (x.status === 'installed') return installPage('Your store is connected', 'Paid orders reach Elmamsflow by themselves, and tracking comes back to your store when they ship.', true);
  const r = await completeInstall(x, code);
  const page = r.ok
    ? installPage(`${r.name} is connected`, 'Paid orders now reach Elmamsflow by themselves, and your customers get their tracking number when the parcel leaves. You can close this page.', true)
    : installPage('The connection didn’t finish', `${r.error} — Elmamsflow has been told; you can also open the install link again.`, false, 502);
  const res = new NextResponse(page.body, { status: page.status, headers: page.headers });
  res.cookies.set('elm_shopify_state', '', { path: '/api/shopify', maxAge: 0 });
  return res;
}
