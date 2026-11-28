import 'server-only';
import { supabaseAdmin } from './supabase/admin';
import { convert, financeSettings } from './fx';
import { marginFor, sheetsFor, shippingLines, shipSettings } from './shipping-db';
import { countryCode, flatShipping, orderParcel, orderShipType, quoteAll, type BillItem, type QuoteLine } from './shipping-rates';

/**
 * Shipping for one order, the way the client is billed: the client's price on a shipping line (same numbers as the
 * Shipping rates page — to the gram, with the client's margin). The order's own line when it has one, otherwise the
 * cheapest line to that country. Only when no line prices the parcel does the rate card's flat rate (per parcel +
 * per full kg) apply. Server only: partner costs are used here but never returned.
 */

export type ShipOrder = {
  country: string | null;
  weight_g: number | null;
  ship_line_id?: string | null;
  ship_price?: number | string | null;
  ship_kg?: number | string | null;
  order_items: BillItem[];
};
export type ShipQuote = { price: number; kg: number; line_id: string | null; line: string; flat: boolean };
export type FlatRate = { currency: string; shipping_base: number; shipping_per_kg: number };

/** Columns a caller must select on `orders` to price shipping. */
export const SHIP_SEL = 'country, weight_g, ship_line_id, ship_price, ship_kg, order_items(qty, products(weight_g, ship_type, length_mm, width_mm, height_mm))';

export const FLAT_LABEL = 'Standard rate';

/** One quoter per client (and per invoice / page): settings, margin and sheets are read once. Prices come out in
 *  `currency` (line prices are in USD and are converted with Finance → Settings rates). When that rate is missing,
 *  `strict` (invoices, prepaid charges) stops with a clear message; otherwise (pages showing running totals) the line
 *  prices are left out and the flat fallback applies, so the page still opens. */
export async function shipQuoter(orgId: string, currency = 'USD', opts: { strict?: boolean } = {}) {
  const s = await shipSettings();
  const [margin, lines, fin] = await Promise.all([marginFor(orgId, s), shippingLines(), financeSettings()]);
  const toCur = (usd: number) => {
    const v = convert(usd, 'USD', currency, fin);
    if (v === null) throw new Error(`Shipping prices are in USD and can’t be converted to ${currency}: add the exchange rate in Finance → Settings.`);
    return v;
  };
  const canConvert = convert(1, 'USD', currency, fin) !== null;
  const names = new Map(lines.map((l) => [l.id, l.name]));
  const cache = new Map<string, ReturnType<typeof sheetsFor>>();
  const sheets = (type: Parameters<typeof sheetsFor>[0], cc: string) => {
    const k = `${type}|${cc}`;
    if (!cache.has(k)) cache.set(k, sheetsFor(type, cc));
    return cache.get(k)!;
  };

  /** Every line's client price for this parcel, cheapest first (no costs). */
  const options = async (o: Omit<ShipOrder, 'ship_price' | 'ship_kg' | 'ship_line_id'>): Promise<Omit<QuoteLine, 'cost'>[]> => {
    const cc = countryCode(o.country ?? '');
    const parcel = orderParcel(o);
    if (!cc || !(parcel.weight_g > 0)) return [];
    if (!canConvert && !opts.strict) return [];
    const q = quoteAll(await sheets(orderShipType(o.order_items), cc), cc, parcel, s, margin);
    return q.map((x) => ({ line: x.line, label: x.label, carrier: x.carrier, transit: x.transit, kg: x.kg, actual: x.actual, volumetric: x.volumetric, price: toCur(x.price) }));
  };

  /** The price this order is billed, in `currency` (null = can't be priced: no weight, or no line and no flat rate).
   *  A price locked on the order when it shipped is kept as it is. */
  const quote = async (o: ShipOrder, flat: FlatRate | null): Promise<ShipQuote | null> => {
    if (o.ship_price != null) {
      return { price: Number(o.ship_price), kg: Number(o.ship_kg ?? 0), line_id: o.ship_line_id ?? null, line: (o.ship_line_id && names.get(o.ship_line_id)) || FLAT_LABEL, flat: !o.ship_line_id };
    }
    const opts = await options(o);
    const pick = (o.ship_line_id && opts.find((x) => x.line === o.ship_line_id)) || opts[0];
    if (pick) return { price: pick.price, kg: pick.kg, line_id: pick.line, line: pick.label, flat: false };
    const grams = orderParcel(o).weight_g * (orderParcel(o).qty ?? 1);
    if (!flat || !(flat.shipping_base > 0 || flat.shipping_per_kg > 0) || !(grams > 0)) return null;
    const f = flatShipping(grams, Number(flat.shipping_base) || 0, Number(flat.shipping_per_kg) || 0);
    return { price: f.price, kg: f.kg, line_id: null, line: FLAT_LABEL, flat: true };
  };

  return { quote, options };
}

/** An order has shipped: lock its shipping price (in the client's invoice currency) on the order, so the invoice and
 *  the prepaid charge agree. */
export async function priceShipped(orderId: string, flatFor: (orgId: string) => Promise<FlatRate | null>) {
  const admin = supabaseAdmin();
  const { data: o } = await admin.from('orders').select(`id, org_id, status, ship_priced_at, ${SHIP_SEL}`).eq('id', orderId).maybeSingle();
  if (!o || !['shipped', 'delivered'].includes(o.status) || o.ship_priced_at) return null;
  const flat = await flatFor(o.org_id);
  const { quote } = await shipQuoter(o.org_id, flat?.currency ?? 'USD', { strict: true });
  const q = await quote({ ...(o as unknown as ShipOrder), ship_price: null }, flat);
  if (!q) return null;
  await admin.from('orders').update({ ship_line_id: q.line_id, ship_price: q.price, ship_kg: q.kg, ship_priced_at: new Date().toISOString() })
    .eq('id', o.id).is('ship_priced_at', null);
  return q;
}
