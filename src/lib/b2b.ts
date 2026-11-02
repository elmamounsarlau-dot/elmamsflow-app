/** B2B wholesale orders: the maths and the words (no database here, so it can be tested on its own). */

export const B2B_KINDS = ['goods', 'freight', 'customs', 'forwarder', 'delivery', 'commission', 'other'] as const;
export type B2BKind = (typeof B2B_KINDS)[number];
export const KIND_LABEL: Record<B2BKind, string> = {
  goods: 'Goods', freight: 'Freight', customs: 'Customs & duties', forwarder: 'Forwarder (transitaire)', delivery: 'Delivery', commission: 'Commission', other: 'Other',
};
export const KIND_FR: Record<B2BKind, string> = {
  goods: 'Marchandise', freight: 'Fret', customs: 'Frais de douanes', forwarder: 'Transitaire', delivery: 'Livraison', commission: 'Frais commission', other: 'Divers',
};
export const TRANSPORT: Record<string, string> = { sea: 'Sea', air: 'Air', rail: 'Rail', road: 'Road', express: 'Express' };
export const INCOTERMS = ['EXW', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP'] as const;
export const DOC_KIND: Record<string, string> = { devis: 'Devis', facture: 'Facture', invoice: 'Invoice' };

export type Line = {
  id?: string;
  kind: string;
  description: string;
  hs_code?: string | null;
  qty: number | null;
  unit?: string | null;
  unit_price: number | null;
  price_currency?: string | null;
  rate: number;
  pct: number | null;
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Each line's amount in the order currency. A % line is a share of the priced lines above it. */
export function lineAmounts(lines: Line[]): number[] {
  let base = 0;
  return lines.map((l) => {
    if (l.pct !== null && l.pct !== undefined) return r2((base * Number(l.pct)) / 100);
    const a = r2((l.qty === null || l.qty === undefined ? 1 : Number(l.qty)) * Number(l.unit_price ?? 0) * Number(l.rate || 1));
    base += a;
    return a;
  });
}

export type Totals = { amounts: number[]; ht: number; tva: number; discount: number; ttc: number };
export function totals(lines: Line[], tvaRate: number, discount: number): Totals {
  const amounts = lineAmounts(lines);
  const ht = r2(amounts.reduce((s, a) => s + a, 0));
  const tva = r2((ht * (Number(tvaRate) || 0)) / 100);
  const d = r2(Number(discount) || 0);
  return { amounts, ht, tva, discount: d, ttc: r2(ht + tva - d) };
}

/** 1 234 567.89 — the way the Moroccan documents print amounts. */
export function numMa(n: number, decimals = 2) {
  const [i, d] = Math.abs(n).toFixed(decimals).split('.');
  return `${n < 0 ? '−' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${d ? `.${d}` : ''}`;
}
/** Currency as written on the Moroccan documents. */
export const curMa = (c: string | null | undefined) => ({ MAD: 'DHs', USD: '$', CNY: 'Yuan', EUR: '€', GBP: '£' } as Record<string, string>)[c ?? ''] ?? c ?? '';
/** Unit price figure: up to 4 decimals, no trailing zeros below 2. */
export function priceMa(n: number) {
  if (Number.isInteger(Number(n))) return numMa(Number(n), 0);
  const s = Number(n).toFixed(4).replace(/0{1,2}$/, '');
  return numMa(Number(s), Math.max(2, (s.split('.')[1] ?? '').length));
}

const pad4 = (n: number) => String(n).padStart(4, '0');
/** 0031/10/2026 (devis, facture), B2B-INV-0057 (international), B2B-0031 (order). */
export function docNumber(kind: 'devis' | 'facture' | 'invoice' | 'order', n: number, isoDate: string, intl = false) {
  if (kind === 'order') return `B2B-${pad4(n)}`;
  if (kind === 'invoice' || intl) return `${kind === 'devis' ? 'B2B-Q' : 'B2B-INV'}-${pad4(n)}`;
  return `${pad4(n)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
}

// ---------- Amounts in words ----------
const FR_U = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const FR_T = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];

function fr99(n: number): string {
  if (n < 20) return FR_U[n];
  const t = Math.floor(n / 10), u = n % 10;
  if (t === 7 || t === 9) return `${FR_T[t]}${t === 7 && u === 1 ? '-et-' : '-'}${FR_U[10 + u]}`;
  if (u === 0) return t === 8 ? 'quatre-vingts' : FR_T[t];
  if (u === 1 && t !== 8) return `${FR_T[t]}-et-un`;
  return `${FR_T[t]}-${FR_U[u]}`;
}
function fr999(n: number, last: boolean): string {
  const h = Math.floor(n / 100), r = n % 100;
  let s = '';
  if (h) s = h === 1 ? 'cent' : `${FR_U[h]} cent${r === 0 && last ? 's' : ''}`;
  if (r) s += `${s ? ' ' : ''}${last || r !== 80 ? fr99(r) : 'quatre-vingt'}`;
  return s;
}
/** Whole number in French words (traditional spelling): 3720 → "trois mille sept cent vingt". */
export function frWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zéro';
  const parts: string[] = [];
  const bn = Math.floor(n / 1e9), mn = Math.floor((n % 1e9) / 1e6), th = Math.floor((n % 1e6) / 1000), rest = n % 1000;
  if (bn) parts.push(`${fr999(bn, true)} milliard${bn > 1 ? 's' : ''}`);
  if (mn) parts.push(`${fr999(mn, true)} million${mn > 1 ? 's' : ''}`);
  if (th) parts.push(th === 1 ? 'mille' : `${fr999(th, false)} mille`);
  if (rest) parts.push(fr999(rest, true));
  return parts.join(' ');
}

const EN_U = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_T = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function en999(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const tens = r < 20 ? (r ? EN_U[r] : '') : `${EN_T[Math.floor(r / 10)]}${r % 10 ? `-${EN_U[r % 10]}` : ''}`;
  return [h ? `${EN_U[h]} hundred` : '', tens].filter(Boolean).join(' ');
}
/** Whole number in English words: 31800 → "thirty-one thousand eight hundred". */
export function enWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zero';
  const scales: [number, string][] = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand'], [1, '']];
  const out: string[] = [];
  for (const [v, name] of scales) {
    const g = Math.floor(n / v) % 1000;
    if (g) out.push(`${en999(g)}${name ? ` ${name}` : ''}`);
  }
  return out.join(' ');
}

const FR_CUR: Record<string, [string, string, string, string]> = {
  // one, many, cent one, cents many
  MAD: ['dirham', 'dirhams', 'centime', 'centimes'],
  USD: ['dollar américain', 'dollars américains', 'cent', 'cents'],
  EUR: ['euro', 'euros', 'centime', 'centimes'],
  CNY: ['yuan', 'yuans', 'fen', 'fens'],
  GBP: ['livre sterling', 'livres sterling', 'penny', 'pence'],
};
const EN_CUR: Record<string, [string, string, string, string]> = {
  MAD: ['Moroccan dirham', 'Moroccan dirhams', 'centime', 'centimes'],
  USD: ['US dollar', 'US dollars', 'cent', 'cents'],
  EUR: ['euro', 'euros', 'cent', 'cents'],
  CNY: ['yuan', 'yuan', 'fen', 'fen'],
  GBP: ['pound sterling', 'pounds sterling', 'penny', 'pence'],
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Trois mille sept cent vingt dirhams" / "… et cinquante centimes". */
export function amountFr(amount: number, cur: string) {
  const [one, many, c1, cn] = FR_CUR[cur] ?? [cur, cur, 'centime', 'centimes'];
  const whole = Math.floor(Math.abs(amount) + 1e-9), cents = Math.round((Math.abs(amount) - whole) * 100);
  const big = whole >= 1e6 && whole % 1e6 === 0 ? 'de ' : '';
  let s = `${frWords(whole)} ${big}${whole > 1 ? many : one}`;
  if (cents) s += ` et ${frWords(cents)} ${cents > 1 ? cn : c1}`;
  return cap(s);
}
/** "Thirty-one thousand eight hundred US dollars" / "… and fifty cents". */
export function amountEn(amount: number, cur: string) {
  const [one, many, c1, cn] = EN_CUR[cur] ?? [cur, cur, 'cent', 'cents'];
  const whole = Math.floor(Math.abs(amount) + 1e-9), cents = Math.round((Math.abs(amount) - whole) * 100);
  let s = `${enWords(whole)} ${whole === 1 ? one : many}`;
  if (cents) s += ` and ${enWords(cents)} ${cents === 1 ? c1 : cn}`;
  return cap(s);
}

/** The stage list from settings, always a clean array of names. */
export function stagesOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  return list.length ? Array.from(new Set(list)).slice(0, 20) : ['Quote', 'Confirmed', 'Shipped', 'Delivered', 'Paid & closed'];
}
