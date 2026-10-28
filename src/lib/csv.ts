/** CSV helpers shared by the import screens (browser and server). */

/** Small CSV reader: commas or semicolons, quoted values, header row. Headers are lower-cased with spaces → "_". */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const clean = text.replace(/^﻿/, '');
  const first = clean.split(/\r?\n/)[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (q) {
      if (c === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  const lines = out.filter((r) => r.some((v) => v.trim() !== ''));
  const headers = (lines.shift() ?? []).map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return { headers, rows: lines.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** First non-empty value among several possible column names. */
export const pick = (r: Record<string, string>, keys: string[]) => keys.map((k) => r[k]).find((v) => v !== undefined && v !== '') ?? '';

let byName: Map<string, string> | null = null;
/** "FR", "fr", "France", "france" → "FR". Unknown → "". Every ISO country, English names. */
export function resolveCountry(v: string): string {
  const s = v.trim();
  if (!s) return '';
  if (!byName) {
    byName = new Map();
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      let name: string | undefined;
      try { name = dn.of(code); } catch { name = undefined; }
      if (name && name !== code) { byName.set(code, code); if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), code); }
    }
    for (const [alias, code] of [['uk', 'GB'], ['great britain', 'GB'], ['england', 'GB'], ['usa', 'US'], ['united states of america', 'US'], ['uae', 'AE'], ['holland', 'NL'], ['south korea', 'KR'], ['russia', 'RU'], ['UK', 'GB'], ['EL', 'GR'], ['FX', 'FR']]) byName.set(alias, code);
  }
  return byName.get(s.length === 2 ? s.toUpperCase() : s.toLowerCase()) ?? '';
}

/** One store/CSV order, grouped from one or more rows (one row per product line). */
export type CsvOrder = {
  ref: string; customer: string; email: string; phone: string; address: string; city: string; zip: string; country: string;
  service: 'express' | 'ddp'; lines: { sku: string; qty: number }[]; lineNos: number[]; errors: string[];
};

export const ORDER_COLS: [string, boolean, string][] = [
  ['order', true, 'Your order number, e.g. 1042. Rows with the same number become one order'],
  ['customer', true, 'Full name'],
  ['address', true, 'Street and number'],
  ['city', false, 'City'],
  ['zip', false, 'Postcode'],
  ['country', true, 'FR or France'],
  ['email', false, 'Customer email'],
  ['phone', false, 'Customer phone'],
    ['sku', true, 'One product per row'],
  ['qty', true, 'Units of that product'],
];

/** Group CSV rows into orders and check each one (pure; same rules in the browser preview and on the server). */
export function groupOrders(rows: Record<string, string>[], knownSkus: Set<string>) {
  const map = new Map<string, CsvOrder>();
  rows.forEach((r, i) => {
    const line = i + 2;
    const ref = pick(r, ['order', 'order_number', 'order_no', 'order_id', 'reference', 'ref', 'name']).replace(/^#/, '').slice(0, 60);
    const key = ref || `__row${line}`;
    let o = map.get(key);
    if (!o) {
      const countryRaw = pick(r, ['country', 'country_code', 'shipping_country']);
      o = {
        ref, customer: pick(r, ['customer', 'name_on_parcel', 'full_name', 'shipping_name', 'recipient']).slice(0, 120),
        email: pick(r, ['email', 'e-mail', 'customer_email']).slice(0, 160), phone: pick(r, ['phone', 'telephone', 'mobile']).slice(0, 40),
        address: [pick(r, ['address', 'address1', 'address_1', 'street']), pick(r, ['address2', 'address_2'])].filter(Boolean).join(', ').slice(0, 240),
        city: pick(r, ['city', 'town']).slice(0, 80), zip: pick(r, ['zip', 'postcode', 'postal_code', 'zip_code']).slice(0, 20),
        country: resolveCountry(countryRaw), service: 'ddp', lines: [], lineNos: [], errors: [], // every order ships DDP (duties and taxes paid)
      };
      if (!ref) o.errors.push('Order number missing');
      if (!o.customer) o.errors.push('Customer missing');
      if (!o.address) o.errors.push('Address missing');
      if (!o.country) o.errors.push(countryRaw ? `Unknown country “${countryRaw}”` : 'Country missing');
      map.set(key, o);
    }
    o.lineNos.push(line);
    const sku = pick(r, ['sku', 'product_sku', 'item_sku']).toUpperCase();
    const qty = Number(pick(r, ['qty', 'quantity', 'units']) || '1');
    if (!sku) o.errors.push(`Line ${line}: SKU missing`);
    else if (!knownSkus.has(sku)) o.errors.push(`Line ${line}: ${sku} is not one of your products`);
    if (!Number.isInteger(qty) || qty <= 0 || qty > 10000) o.errors.push(`Line ${line}: quantity must be a whole number above 0`);
    if (sku && Number.isInteger(qty) && qty > 0) {
      const same = o.lines.find((l) => l.sku === sku);
      if (same) same.qty += qty; else o.lines.push({ sku, qty });
    }
  });
  return [...map.values()];
}
