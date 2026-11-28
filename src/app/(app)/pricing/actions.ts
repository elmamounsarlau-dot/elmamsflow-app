'use server';

import { getCtx } from '@/lib/session';
import { getRateCard } from '@/lib/billing';
import { shipQuoter } from '@/lib/order-shipping';
import { isShipType, transitLabel } from '@/lib/shipping-rates';

export type ShipOption = { label: string; price: number; kg: number; transit: string };

/** The Pricing page calculator: the client's shipping price on every line for one parcel. Client prices only. */
export async function quoteParcel(country: string, type: string, grams: number): Promise<{ options: ShipOption[] } | { error: string }> {
  const ctx = await getCtx();
  if (!ctx?.org || !ctx.can('invoices.view')) return { error: 'No access.' };
  if (!/^[A-Z]{2}$/.test(country) || !isShipType(type) || !(grams > 0) || grams > 100_000) return { options: [] };
  const rates = await getRateCard(ctx.org.id);
  try {
    const { options } = await shipQuoter(ctx.org.id, rates?.currency ?? 'USD');
    const opts = await options({ country, weight_g: Math.round(grams), order_items: [{ qty: 1, products: { weight_g: Math.round(grams), ship_type: type } }] });
    return { options: opts.map((o) => ({ label: o.label, price: o.price, kg: o.kg, transit: transitLabel(o.transit) })) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
