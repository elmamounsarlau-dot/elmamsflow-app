export const ORDER_STATUS: Record<string, [string, string]> = {
  new: ['New', 'go'],
  on_hold: ['On hold', 'warn'],
  packed: ['Packed', 'pk'],
  shipped: ['In transit', 'go'],
  delivered: ['Delivered', 'ok'],
  cancelled: ['Cancelled', 'mute'],
};

export const INBOUND_STATUS: Record<string, [string, string]> = {
  announced: ['Announced', 'mute'],
  in_transit: ['On its way', 'go'],
  receiving: ['Receiving', 'pk'],
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
  return u.pathname + u.search;
}

export function str(fd: FormData, k: string) {
  return String(fd.get(k) ?? '').trim();
}
