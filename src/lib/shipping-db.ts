import 'server-only';
import { supabaseAdmin } from './supabase/admin';
import { DEFAULT_SETTINGS, type Margin, type RateRow, type Service, type ShipSettings, type ShipType } from './shipping-rates';

/** Server only: partner prices and margins never go to the browser. */

export async function shipSettings(): Promise<ShipSettings> {
  const { data } = await supabaseAdmin().from('shipping_settings').select('margin_pct, margin_fixed, packaging_g, volume_factor, remind_days').maybeSingle();
  if (!data) return DEFAULT_SETTINGS;
  return { margin_pct: Number(data.margin_pct), margin_fixed: Number(data.margin_fixed), packaging_g: data.packaging_g, volume_factor: data.volume_factor, remind_days: data.remind_days };
}

export async function marginFor(orgId: string | null, s: ShipSettings): Promise<Margin> {
  if (!orgId) return { pct: s.margin_pct, fixed: s.margin_fixed };
  const { data } = await supabaseAdmin().from('organizations').select('shipping_margin_pct, shipping_margin_fixed').eq('id', orgId).maybeSingle();
  return {
    pct: data?.shipping_margin_pct != null ? Number(data.shipping_margin_pct) : s.margin_pct,
    fixed: data?.shipping_margin_fixed != null ? Number(data.shipping_margin_fixed) : s.margin_fixed,
  };
}

export type SheetInfo = { id: string; service: Service; product_type: ShipType; source: string | null; dated: string | null; rows_count: number; countries: number; created_at: string };

export async function activeSheets(): Promise<SheetInfo[]> {
  const { data } = await supabaseAdmin().from('shipping_sheets').select('id, service, product_type, source, dated, rows_count, countries, created_at').eq('active', true);
  return (data ?? []) as SheetInfo[];
}

/** The rows of the active sheets for one product type (one entry per service offered). */
export async function sheetsFor(type: ShipType, country?: string) {
  const admin = supabaseAdmin();
  const sheets = (await activeSheets()).filter((s) => s.product_type === type);
  return Promise.all(sheets.map(async (sh) => {
    let q = admin.from('shipping_rates').select('country, subregion, transit, w_min, w_max, per_kg, per_parcel, min_kg').eq('sheet_id', sh.id).limit(5000);
    if (country) q = q.eq('country', country);
    const { data } = await q;
    return { service: sh.service, dated: sh.dated, rows: (data ?? []) as RateRow[] };
  }));
}

/** Countries any active sheet ships to (for the calculator's list). */
export async function shippedCountries() {
  const ids = (await activeSheets()).map((s) => s.id);
  if (!ids.length) return [] as string[];
  const { data } = await supabaseAdmin().from('shipping_rates').select('country').in('sheet_id', ids).limit(20000);
  return [...new Set((data ?? []).map((r) => r.country as string))];
}
