/**
 * Shipping rates: the partner's price sheets (pasted by staff) turned into one final price per option.
 * Price = (chargeable kg × price per kg + fee per parcel) for the country's weight bracket, then the margin.
 * Chargeable kg = the highest of: weight + packaging, volumetric weight (L × W × H in cm ÷ factor), the minimum billing weight.
 * Nothing here is shown to clients except the final price, transit time and chargeable weight.
 */

/** A partner line offered to clients under the name the team gives it (Standard, Priority, Express…). */
export type Line = { id: string; key: string; name: string; note: string | null; sort: number; active: boolean };
export const SHIP_TYPES = { general: 'General goods', battery: 'With batteries', clothing: 'Clothing', cosmetics: 'Cosmetics' } as const;
export type ShipType = keyof typeof SHIP_TYPES;
export const isShipType = (s: string): s is ShipType => s in SHIP_TYPES;

export type RateRow = { country: string; subregion: string | null; transit: string | null; carrier?: string | null; w_min: number; w_max: number; per_kg: number; per_parcel: number; min_kg: number; step_kg?: number };
export type ShipSettings = { margin_pct: number; margin_fixed: number; packaging_g: number; volume_factor: number; remind_days: number };
export const DEFAULT_SETTINGS: ShipSettings = { margin_pct: 20, margin_fixed: 0, packaging_g: 0, volume_factor: 8000, remind_days: 7 };

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

/** Tab-separated text as spreadsheets copy it: a cell with a line break or a tab comes in "quotes". */
export function splitTsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const t = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === '\t') { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') { row.push(cell.trim()); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell.trim()); out.push(row);
  return out;
}

const isHeader = (r: string[]) => { const j = r.join('|').toLowerCase(); return /country/.test(j) && /weight/.test(j); };

/**
 * Turn a sheet copied from the partner into rate rows. A tab can hold more than one table (each with its own header).
 * Tables after the first (Japan in the partner's sheets) are priced per step: "fee" = the first step (e.g. 0.5 kg) and
 * the next column = each extra step. They are stored so the same formula works: per kg = extra ÷ step, per parcel =
 * first − extra, weight rounded up to the step.
 */
export function parseSheet(text: string): ParsedSheet { return parseRows(splitTsv(text)); }

/** Same as parseSheet, for rows already split into cells (an uploaded .xlsx tab). */
export function parseRows(lines: string[][]): ParsedSheet {
  let dated: string | null = null;
  for (const row of lines.slice(0, 5)) for (const c of row) {
    const d = c.match(/^(20\d\d)[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?$/);
    if (d && !dated) dated = `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
  }
  const rows: RateRow[] = [];
  const unknown = new Set<string>();
  let skipped = 0, tables = 0;
  let cols: { country: number; transit: number; sub: number; carrier: number; weight: number; step: number; min: number; kg: number; parcel: number; stepPriced: boolean } | null = null;
  let lastCountry = '', lastTransit = '';
  for (const r of lines) {
    if (r.every((c) => !c)) continue;
    if (isHeader(r)) {
      const h = r.map((c) => c.toLowerCase());
      const col = (re: RegExp) => h.findIndex((c) => re.test(c));
      const kg = col(/shipping fee|freight|per ?kg|\/kg/);
      const parcel = col(/processing|registration|handling|per package|\/package|parcel|increase/);
      tables++;
      cols = {
        country: col(/country/), transit: col(/timeframe|transit|time/), sub: col(/subregion|zone/), carrier: col(/provider|carrier|last.?mile/),
        weight: h.findIndex((c) => /weight/.test(c) && !/increment|minimum|min\b|product/.test(c)),
        step: col(/increment/), min: col(/minimum/), kg, parcel,
        stepPriced: tables > 1 || /0\.5 ?kg|increase/.test(h.join('|')),
      };
      if (cols.country < 0 || cols.weight < 0 || cols.kg < 0 || cols.parcel < 0) cols = null;
      lastCountry = ''; lastTransit = '';
      continue;
    }
    if (!cols) continue;
    const name = r[cols.country] || lastCountry;
    const transit = ((cols.transit >= 0 && r[cols.transit]) || (r[cols.country] ? '' : lastTransit)).split('\n')[0].trim();
    lastCountry = name; lastTransit = transit;
    const b = bracket(r[cols.weight] ?? '');
    const a = num(r[cols.kg]), c = num(r[cols.parcel]);
    if (!name || !b || !Number.isFinite(a) || !Number.isFinite(c)) { skipped++; continue; }
    const cc = countryCode(name);
    if (!cc) { unknown.add(name); skipped++; continue; }
    const stepIn = cols.step >= 0 ? num(r[cols.step]) : NaN;
    const minIn = cols.min >= 0 ? num(r[cols.min]) : NaN;
    let step = Number.isFinite(stepIn) && stepIn > 0 ? stepIn : 0;
    let minKg = Number.isFinite(minIn) ? minIn : 0;
    let perKg = a, perParcel = c;
    if (cols.stepPriced) {
      step = step || 0.5;
      perKg = c / step;                 // each extra step
      perParcel = Math.max(0, a - c);   // first step − one extra step
      minKg = Math.max(minKg, step);
    }
    rows.push({ country: cc, subregion: (cols.sub >= 0 && r[cols.sub]) || null, transit: transit || null, carrier: (cols.carrier >= 0 && r[cols.carrier]) || null, w_min: b[0], w_max: b[1],
      per_kg: Math.round(perKg * 1e4) / 1e4, per_parcel: Math.round(perParcel * 1e4) / 1e4, min_kg: minKg, step_kg: step });
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
  // Weight is rounded up to the row's step (0.01 / 0.1 / 0.5 / 1 kg) before pricing.
  const stepped = (r: RateRow) => { const st = Number(r.step_kg) || 0; return st > 0 ? Math.ceil(w.kg / st - 1e-9) * st : w.kg; };
  const best = fits.reduce((x, r) => { const k = stepped(r); const c = k * Number(r.per_kg) + Number(r.per_parcel); return c > x.c ? { c, k } : x; }, { c: -1, k: w.kg });
  return { cost: best.c, ...w, kg: Math.round(best.k * 1000) / 1000, transit: fits[0].transit, carrier: fits[0].carrier ?? null };
}

export const withMargin = (cost: number, m: Margin) => Math.round((cost * (1 + m.pct / 100) + m.fixed) * 100) / 100;

export type QuoteLine = { line: string; label: string; carrier: string | null; transit: string | null; kg: number; actual: number; volumetric: number; price: number; cost: number };

/** Every line we can offer for this parcel, cheapest first. */
export function quoteAll(sheets: { line: { id: string; name: string }; rows: RateRow[] }[], country: string, p: Parcel, s: ShipSettings, m: Margin): QuoteLine[] {
  const out: QuoteLine[] = [];
  for (const sh of sheets) {
    const c = partnerCost(sh.rows, country, p, s);
    if (c) out.push({ line: sh.line.id, label: sh.line.name, carrier: c.carrier, transit: c.transit, kg: c.kg, actual: c.actual, volumetric: c.volumetric, price: withMargin(c.cost, m), cost: Math.round(c.cost * 100) / 100 });
  }
  return out.sort((a, b) => a.price - b.price);
}

/** "6-12 work days" → "6–12 business days" (clients see one wording, whatever the sheet says). */
export const transitLabel = (t: string | null) => !t ? '—' : t.replace(/(\d+)\s*[-~–]\s*(\d+)/, '$1–$2').replace(/work(ing)? ?days?|days?/i, 'business days');

// ---------- Which line and product type a tab is, from its name ----------

/** "1-standard general", "13- Express General", "10- US Remote Battery" → line key + product type. */
export function tabTarget(name: string): { line: string; type: ShipType } | null {
  const n = name.toLowerCase();
  const line = /express|last.?mile/.test(n) ? 'express' : /remote/.test(n) ? 'us-remote' : /courier/.test(n) ? 'courier'
    : /large/.test(n) ? 'large' : /priority/.test(n) ? 'priority' : /standard/.test(n) ? 'standard' : null;
  const type: ShipType | null = /batter/.test(n) ? 'battery' : /cloth/.test(n) ? 'clothing' : /cosmetic/.test(n) ? 'cosmetics' : /general/.test(n) ? 'general' : null;
  return line && type ? { line, type } : null;
}

// ---------- One order's parcel, for billing ----------

export type BillItem = { qty: number; products: { weight_g: number; ship_type?: string | null; length_mm?: number | null; width_mm?: number | null; height_mm?: number | null } | null };

/** The sheet an order is priced on: any battery item → battery; any cosmetics → cosmetics; only clothing → clothing. */
export function orderShipType(items: BillItem[]): ShipType {
  const types = items.map((i) => (isShipType(i.products?.ship_type ?? '') ? i.products!.ship_type as ShipType : 'general'));
  if (types.includes('battery')) return 'battery';
  if (types.includes('cosmetics')) return 'cosmetics';
  if (types.length && types.every((t) => t === 'clothing')) return 'clothing';
  return 'general';
}

/** The parcel to price: the weight the warehouse found (else the products' weights); the size only for one product line. */
export function orderParcel(o: { weight_g: number | null; order_items: BillItem[] }): Parcel {
  const grams = o.weight_g || o.order_items.reduce((a, i) => a + i.qty * (i.products?.weight_g ?? 0), 0);
  const one = o.order_items.length === 1 ? o.order_items[0] : null;
  const p = one?.products;
  if (!o.weight_g && one && p?.length_mm && p.width_mm && p.height_mm) {
    return { weight_g: p.weight_g, qty: one.qty, length_mm: p.length_mm, width_mm: p.width_mm, height_mm: p.height_mm };
  }
  return { weight_g: grams };
}

/** Old flat rate (rate card: per parcel + per full kg), only for parcels no shipping line prices. */
export function flatShipping(grams: number, base: number, perKg: number) {
  const kg = grams > 0 ? Math.ceil(grams / 1000) : 0;
  return { kg, price: Math.round((base + kg * perKg) * 100) / 100 };
}
