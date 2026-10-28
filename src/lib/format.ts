export const ORDER_STATUS: Record<string, [string, string]> = {
  new: ['New', 'go'],
  on_hold: ['On hold', 'warn'],
  packed: ['Packed', 'pk'],
  shipped: ['In transit', 'go'],
  delivered: ['Delivered', 'ok'],
  cancelled: ['Cancelled', 'mute'],
};

export const TRANSFER_STATUS: Record<string, [string, string]> = {
  requested: ['Requested', 'mute'],
  in_transit: ['On the way', 'go'],
  received: ['Received', 'ok'],
  cancelled: ['Cancelled', 'mute'],
};

export const INBOUND_STATUS: Record<string, [string, string]> = {
  announced: ['Booked', 'mute'],
  in_transit: ['Picked up', 'go'],
  receiving: ['Receiving', 'pk'],
  counted: ['Counted', 'warn'],
  received: ['Available', 'ok'],
};

export const TICKET_STATUS: Record<string, [string, string]> = {
  open: ['Waiting for reply', 'warn'],
  answered: ['Answered', 'ok'],
  closed: ['Closed', 'mute'],
};

export const COUNTRIES: Record<string, string> = {
  FR: 'France', DE: 'Germany', GB: 'United Kingdom', ES: 'Spain', IT: 'Italy', NL: 'Netherlands', BE: 'Belgium',
  PL: 'Poland', SE: 'Sweden', AT: 'Austria', IE: 'Ireland', PT: 'Portugal', US: 'United States', CA: 'Canada',
  AU: 'Australia', NZ: 'New Zealand', MA: 'Morocco', AE: 'United Arab Emirates', SA: 'Saudi Arabia', JP: 'Japan',
  SG: 'Singapore', KR: 'South Korea',
};

const TZ = 'Asia/Shanghai';

export function fmtDate(v: string | null | undefined, time = false) {
  if (!v) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}), timeZone: TZ }).format(new Date(v));
}

export function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TZ }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function siteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')).replace(/\/$/, '');
}

/** Redirect target with a message shown at the top of the page. */
export function withMsg(path: string, msg: string, type: 'ok' | 'err' | 'warn' = 'ok') {
  const u = new URL(path, 'http://x');
  u.searchParams.set(type === 'ok' ? 'ok' : type === 'warn' ? 'warn' : 'err', msg);
  return u.pathname + u.search + u.hash;
}

export function str(fd: FormData, k: string) {
  return String(fd.get(k) ?? '').trim();
}

const REGION = new Intl.DisplayNames(['en'], { type: 'region' });
/** Full country name for any ISO code (falls back to the code). */
export function countryName(cc: string) {
  if (COUNTRIES[cc]) return COUNTRIES[cc];
  try { return REGION.of(cc) ?? cc; } catch { return cc; }
}

/** Every country, by name, for a select (common destinations first). Keeps an unusual current value. */
export function countryList(current?: string | null): [string, string][] {
  const all: [string, string][] = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const cc = String.fromCharCode(a, b);
    if (['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'CQ'].includes(cc)) continue;
    try { const n = REGION.of(cc); if (n && n !== cc && !/unknown/i.test(n)) all.push([cc, n]); } catch { /* not a region */ }
  }
  const top = Object.keys(COUNTRIES);
  const rest = all.filter(([k]) => !top.includes(k)).sort((x, y) => x[1].localeCompare(y[1]));
  const list: [string, string][] = [...top.map((k) => [k, COUNTRIES[k]] as [string, string]), ...rest];
  if (current && /^[A-Z]{2}$/.test(current) && current !== 'XX' && !list.some(([k]) => k === current)) list.unshift([current, current]);
  return list;
}

/** One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @) is prefixed with ' so it stays text —
 *  customer names and addresses come from stores and could otherwise run in Excel. */
export function csvCell(v: unknown) {
  let s = String(v ?? '');
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n;\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Live carrier status from 17TRACK (label, badge tone, plain explanation). */
export const CARRIER_STATUS: Record<string, [string, string]> = {
  NotFound: ['Not scanned yet', 'mute'],
  InfoReceived: ['Label created', 'mute'],
  InTransit: ['In transit', 'go'],
  AvailableForPickup: ['Ready for pickup', 'pk'],
  OutForDelivery: ['Out for delivery', 'pk'],
  Delivered: ['Delivered', 'ok'],
  DeliveryFailure: ['Delivery failed', 'err'],
  Exception: ['Problem', 'err'],
  Expired: ['No updates', 'warn'],
  Stopped: ['Tracking stopped', 'mute'],
};
export const CARRIER_PROBLEM = ['DeliveryFailure', 'Exception', 'Expired'];

/** Support ticket topics: [label, short hint]. */
export const TICKET_CATEGORY: Record<string, [string, string]> = {
  order: ['An order', 'Address, delay, change, cancel'],
  damaged: ['Damaged goods', 'Broken or wrong items — add photos'],
  inbound: ['Stock delivery', 'An inbound, receiving, counts'],
  stock: ['Inventory', 'Stock levels, quarantine, products'],
  billing: ['Billing', 'An invoice, a charge, payment'],
  account: ['Account & stores', 'Access, team, store connection'],
  other: ['Something else', 'Anything else'],
};
