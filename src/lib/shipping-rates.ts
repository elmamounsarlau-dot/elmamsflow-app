/**
 * Shipping rates: the partner's price sheets (pasted by staff) turned into one final price per option.
 * Price = (chargeable kg × price per kg + fee per parcel) for the country's weight bracket, then the margin.
 * Chargeable kg = the highest of: weight + packaging, volumetric weight (L × W × H in cm ÷ factor), the minimum billing weight.
 * Nothing here is shown to clients except the final price, transit time and chargeable weight.
 */

export const SERVICES = { economic: 'Economic', expedited: 'Expedited' } as const;
export type Service = keyof typeof SERVICES;
export const SHIP_TYPES = { general: 'General goods', battery: 'With batteries', clothing: 'Clothing', cosmetics: 'Cosmetics' } as const;
export type ShipType = keyof typeof SHIP_TYPES;
export const isService = (s: string): s is Service => s in SERVICES;
export const isShipType = (s: string): s is ShipType => s in SHIP_TYPES;

export type RateRow = { country: string; subregion: string | null; transit: string | null; w_min: number; w_max: number; per_kg: number; per_parcel: number; min_kg: number };
export type ShipSettings = { margin_pct: number; margin_fixed: number; packaging_g: number; volume_factor: number; remind_days: number };
export const DEFAULT_SETTINGS: ShipSettings = { margin_pct: 20, margin_fixed: 0, packaging_g: 150, volume_factor: 8000, remind_days: 7 };

// ---------- Reading a pasted sheet ----------

const REGION = new Intl.DisplayNames(['en'], { type: 'region' });
const ALIASES: Record<string, string> = {
  usa: 'US', 'united states of america': 'US', america: 'US', us: 'US', uk: 'GB', 'great britain': 'GB', england: 'GB', britain: 'GB',
  'south korea': 'KR', korea: 'KR', 'republic of korea': 'KR', russia: 'RU', 'czech republic': 'CZ', czech: 'CZ', turkey: 'TR', 'türkiye': 'TR',
  vietnam: 'VN', 'viet nam': 'VN', uae: 'AE', 'hong kong': 'HK', macau: 'MO', macao: 'MO', taiwan: 'TW', holland: 'NL', 'the netherlands': 'NL',
  'saudi arabia': 'SA', 'ivory coast': 'CI', 'cote d’ivoire': 'CI', "cote d'ivoire": 'CI', 'bosnia': 'BA', 'north macedonia': 'MK', macedonia: 'MK',
  'puerto rico': 'PR', 'new zealand': 'NZ', 'south africa': 'ZA', 'the united kingdom': 'GB', 'the united states': 'US',
};
let NAMES: Map<string, string> | null = null;
// Old or special codes that share a name with a real country (DD = East Germany, FX = Metropolitan France, …).
const NOT_COUNTRIES = new Set(['DD', 'FX', 'UK', 'YU', 'CS', 'SU', 'TP', 'ZR', 'BU', 'NT', 'AN', 'EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'CQ']);
const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** ISO code for a country written in English (or a 2-letter code). */
export function countryCode(name: string): string | null {
  const n = norm(name.replace(/\(.*?\)/g, ''));
  if (!n) return null;
  if (/^[a-z]{2}$/.test(n) && ALIASES[n] === undefined && !NOT_COUNTRIES.has(n.toUpperCase())) { try { const r = REGION.of(n.toUpperCase()); if (r && r !== n.toUpperCase()) return n.toUpperCase(); } catch { /* not a code */ } }
  if (ALIASES[n]) return ALIASES[n];
  if (!NAMES) {
    NAMES = new Map();
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const cc = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(cc)) continue;
      try { const r = REGION.of(cc); if (r && r !== cc && !NAMES.has(norm(r))) NAMES.set(norm(r), cc); } catch { /* not a region */ }
    }
  }
  return NAMES.get(n) ?? null;
}

const num = (s: string | undefined) => {
  const m = String(s ?? '').replace(/[,\s$]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};

/** "0.1<W≤0.2", "0<W≤0.1", "W≤0.5", "2-30", "0.5 - 1" → [min, max] in kg. */
export function bracket(s: string): [number, number] | null {
  const t = s.replace(/\s+/g, '').replace(/[＜]/g, '<').replace(/[≦＝]/g, '≤');
  const nums = (t.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  if (nums.length >= 2 && nums[1] > nums[0]) return [nums[0], nums[1]];
  if (nums.length === 1 && /[≤<]/.test(t) && /W/i.test(t) && t.indexOf('W') < t.search(/\d/)) return [0, nums[0]];
  return null;
}

export type ParsedSheet = { dated: string | null; rows: RateRow[]; unknown: string[]; skipped: number };

/** Turn a sheet copied from the partner (tab-separated rows, as copy-paste gives) into rate rows. */
export function parseSheet(text: string): ParsedSheet {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.split('\t').map((c) => c.trim()));
  let dated: string | null = null;
  let head = -1;
  for (let i = 0; i < lines.length && head < 0; i++) {
    const row = lines[i];
    for (const c of row) {
      const d = c.match(/^(20\d\d)[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?$/);
      if (d && !dated) dated = `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
    }
    const joined = row.join('|').toLowerCase();
    if (/country/.test(joined) && /weight/.test(joined)) head = i;
  }
  if (head < 0) return { dated, rows: [], unknown: [], skipped: 0 };
  const h = lines[head].map((c) => c.toLowerCase());
  const col = (re: RegExp) => h.findIndex((c) => re.test(c));
  const cCountry = col(/country/), cTransit = col(/timeframe|transit|time/), cSub = col(/subregion|zone/);
  const cWeight = h.findIndex((c) => /weight/.test(c) && !/increment|minimum|min\b|product/.test(c));
  const cMin = col(/minimum/), cKg = col(/shipping fee|freight|per ?kg|\/kg/), cParcel = col(/processing|registration|handling|per package|\/package|parcel/);
  if (cCountry < 0 || cWeight < 0 || cKg < 0 || cParcel < 0) return { dated, rows: [], unknown: [], skipped: 0 };
  const rows: RateRow[] = [];
  const unknown = new Set<string>();
  let skipped = 0, lastCountry = '', lastTransit = '';
  for (const r of lines.slice(head + 1)) {
    if (r.every((c) => !c)) continue;
    const name = r[cCountry] || lastCountry;
    const transit = (cTransit >= 0 && r[cTransit]) || (r[cCountry] ? '' : lastTransit);
    lastCountry = name; lastTransit = transit;
    const b = bracket(r[cWeight] ?? '');
    const perKg = num(r[cKg]), perParcel = num(r[cParcel]);
    if (!name || !b || !Number.isFinite(perKg) || !Number.isFinite(perParcel)) { skipped++; continue; }
    const cc = countryCode(name);
    if (!cc) { unknown.add(name); skipped++; continue; }
    const minKg = cMin >= 0 ? num(r[cMin]) : NaN;
    rows.push({ country: cc, subregion: (cSub >= 0 && r[cSub]) || null, transit: transit || null, w_min: b[0], w_max: b[1], per_kg: perKg, per_parcel: perParcel, min_kg: Number.isFinite(minKg) ? minKg : 0 });
  }
  return { dated, rows, unknown: [...unknown], skipped };
}

// ---------- Working out a price ----------

export type Parcel = { weight_g: number; length_mm?: number | null; width_mm?: number | null; height_mm?: number | null; qty?: number };
export type Margin = { pct: number; fixed: number };

/** Weight we bill on, in kg (rounded up to the gram). */
export function chargeableKg(p: Parcel, s: Pick<ShipSettings, 'packaging_g' | 'volume_factor'>, minKg = 0) {
  const qty = Math.max(1, Math.floor(p.qty ?? 1));
  const actual = (Math.max(0, p.weight_g) * qty + s.packaging_g) / 1000;
  const vol = p.length_mm && p.width_mm && p.height_mm ? ((p.length_mm / 10) * (p.width_mm / 10) * (p.height_mm / 10) * qty) / s.volume_factor : 0;
  const kg = Math.max(actual, vol, minKg);
  return { kg: Math.ceil(kg * 1000 - 1e-9) / 1000, actual: Math.ceil(actual * 1000 - 1e-9) / 1000, volumetric: Math.ceil(vol * 1000 - 1e-9) / 1000 };
}

/** The partner's cost for one parcel to one country, from that sheet's rows (null = not shipped there / too heavy). */
export function partnerCost(rows: RateRow[], country: string, p: Parcel, s: Pick<ShipSettings, 'packaging_g' | 'volume_factor'>) {
  const mine = rows.filter((r) => r.country === country);
  if (!mine.length) return null;
  // Main rows (no subregion) when there are some; otherwise the most expensive subregion, to stay safe.
  const main = mine.some((r) => !r.subregion) ? mine.filter((r) => !r.subregion) : mine;
  const minKg = Math.max(0, ...main.map((r) => Number(r.min_kg) || 0));
  const w = chargeableKg(p, s, minKg);
  const fits = main.filter((r) => w.kg > Number(r.w_min) && w.kg <= Number(r.w_max));
  if (!fits.length) return null;
  const cost = Math.max(...fits.map((r) => w.kg * Number(r.per_kg) + Number(r.per_parcel)));
  return { cost, ...w, transit: fits[0].transit };
}

export const withMargin = (cost: number, m: Margin) => Math.round((cost * (1 + m.pct / 100) + m.fixed) * 100) / 100;

export type QuoteLine = { service: Service; label: string; transit: string | null; kg: number; actual: number; volumetric: number; price: number; cost: number };

/** Every option we can offer for this parcel, cheapest first. */
export function quoteAll(sheets: { service: Service; rows: RateRow[] }[], country: string, p: Parcel, s: ShipSettings, m: Margin): QuoteLine[] {
  const out: QuoteLine[] = [];
  for (const sh of sheets) {
    const c = partnerCost(sh.rows, country, p, s);
    if (c) out.push({ service: sh.service, label: SERVICES[sh.service], transit: c.transit, kg: c.kg, actual: c.actual, volumetric: c.volumetric, price: withMargin(c.cost, m), cost: Math.round(c.cost * 100) / 100 });
  }
  return out.sort((a, b) => a.price - b.price);
}

/** "6-12 work days" → "6–12 business days" (clients see one wording, whatever the sheet says). */
export const transitLabel = (t: string | null) => !t ? '—' : t.replace(/(\d+)\s*[-~–]\s*(\d+)/, '$1–$2').replace(/work(ing)? ?days?|days?/i, 'business days');
