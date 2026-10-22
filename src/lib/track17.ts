import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from './supabase/admin';

/**
 * 17TRACK connection (https://api.17track.net, API v2.4).
 * The key lives only in the server environment variable TRACK17_API_KEY — never in the database, the browser or logs.
 * Flow: an order ships with a tracking number → register() → 17TRACK follows the parcel and pushes every update to
 * /api/tracking/17track (webhook) → applyTrack() stores it. A daily sync (/api/cron/tracking) registers anything
 * missed and refreshes parcels that went quiet.
 */
// Local tests only may point at a fake 17TRACK on this machine; anything else always uses the real API.
const BASE = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.TRACK17_API_URL ?? '') ? `${process.env.TRACK17_API_URL}/track/v2.4` : 'https://api.17track.net/track/v2.4';
export const trackKey = () => {
  const k = process.env.TRACK17_API_KEY?.trim();
  return k && k.length >= 16 ? k : null;
};

export const TRACK_STATUSES = ['NotFound', 'InfoReceived', 'InTransit', 'Expired', 'AvailableForPickup', 'OutForDelivery', 'DeliveryFailure', 'Delivered', 'Exception', 'Stopped'] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

async function call<T>(path: string, body: unknown): Promise<T> {
  const key = trackKey();
  if (!key) throw new Error('17TRACK is not connected (TRACK17_API_KEY missing).');
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: { '17token': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`17TRACK ${path}: HTTP ${res.status}`);
  const j = (await res.json()) as { code: number; data?: T; message?: string };
  if (j.code !== 0) throw new Error(`17TRACK ${path}: ${j.message ?? `code ${j.code}`}`);
  return j.data as T;
}

type Rejected = { number: string; error?: { code: number; message: string } };
type Accepted = { number: string; carrier?: number; tag?: string; track_info?: TrackInfo };

export type TrackEvent = { time_iso?: string | null; time_utc?: string | null; description?: string | null; location?: string | null; sub_status?: string | null };
export type TrackInfo = {
  latest_status?: { status?: string | null; sub_status?: string | null };
  latest_event?: TrackEvent | null;
  time_metrics?: { estimated_delivery_date?: { from?: string | null; to?: string | null } | null };
  tracking?: { providers?: { events?: TrackEvent[] | null }[] | null };
};

/** Clean, storable version of 17TRACK's tracking info. Pure — unit tested. */
export function normalize(info: TrackInfo | null | undefined) {
  const raw = info?.latest_status?.status ?? null;
  const status = (TRACK_STATUSES as readonly string[]).includes(raw ?? '') ? (raw as TrackStatus) : null;
  const when = (e?: TrackEvent | null) => {
    const v = e?.time_utc || e?.time_iso;
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
  };
  const events = (info?.tracking?.providers ?? [])
    .flatMap((p) => p?.events ?? [])
    .filter((e) => (e?.description ?? '').trim())
    .map((e) => ({ at: when(e), description: String(e.description).trim().slice(0, 500), location: (e.location ?? '').trim().slice(0, 200) || null, sub_status: e.sub_status ?? null }))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  const latest = info?.latest_event ?? null;
  const eta = info?.time_metrics?.estimated_delivery_date?.to || info?.time_metrics?.estimated_delivery_date?.from || null;
  return {
    status,
    sub_status: info?.latest_status?.sub_status ?? null,
    last_event: (latest?.description ?? events[0]?.description ?? '').trim() || null,
    last_location: (latest?.location ?? events[0]?.location ?? '')?.trim() || null,
    last_event_at: when(latest) ?? events[0]?.at ?? null,
    eta: eta && /^\d{4}-\d{2}-\d{2}/.test(eta) ? eta.slice(0, 10) : null,
    events: events.slice(0, 200),
  };
}

/**
 * 17TRACK signs every push: header `sign` = SHA-256 (hex) of the raw request body + "/" + your API key.
 * Some integrations describe it as event + "/" + data + "/" + key; both are accepted. Constant-time compare.
 */
export function validSignature(rawBody: string, sign: string | null, key: string | null) {
  if (!key || !sign || !/^[0-9a-f]{64}$/i.test(sign.trim())) return false;
  const given = Buffer.from(sign.trim().toLowerCase(), 'hex');
  const candidates = [`${rawBody}/${key}`];
  try {
    const j = JSON.parse(rawBody) as { event?: string; data?: unknown };
    const m = rawBody.match(/"data"\s*:\s*([\s\S]*)\}\s*$/); // data exactly as sent, when it is the last key
    if (j.event) {
      candidates.push(`${j.event}/${JSON.stringify(j.data)}/${key}`);
      if (m) candidates.push(`${j.event}/${m[1].trim()}/${key}`);
    }
  } catch {
    /* not JSON: only the raw form can match */
  }
  return candidates.some((c) => {
    const d = createHash('sha256').update(c).digest();
    return d.length === given.length && timingSafeEqual(d, given);
  });
}

/** Store one parcel update on its order (and move it to Delivered when the carrier confirms). */
export async function applyTrack(orderId: string, tracking: string, info: TrackInfo | null | undefined, carrier?: number | null) {
  const n = normalize(info);
  const { data, error } = await supabaseAdmin().rpc('apply_tracking', {
    p_order: orderId, p_tracking: tracking, p_status: n.status, p_sub_status: n.sub_status, p_last_event: n.last_event,
    p_last_location: n.last_location, p_last_event_at: n.last_event_at, p_eta: n.eta, p_carrier: carrier ?? null, p_events: n.events,
  });
  if (error) throw new Error(error.message);
  return data as 'delivered' | 'updated' | 'stale' | 'ignored';
}

type OrderRef = { id: string; tracking: string };
const chunks = <T,>(a: T[], n = 40) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
// 17TRACK error codes meaning "already being tracked" — not a failure for us.
const ALREADY = new Set([-18019901]);

/** Start tracking these parcels (max 40 per call; the order id rides along as the tag). Returns how many were accepted. */
export async function registerOrders(orders: OrderRef[]) {
  if (!trackKey() || !orders.length) return { accepted: 0, rejected: 0 };
  const admin = supabaseAdmin();
  let accepted = 0, rejected = 0;
  for (const part of chunks(orders)) {
    const data = await call<{ accepted?: Accepted[]; rejected?: Rejected[] }>('register', part.map((o) => ({ number: o.tracking, tag: o.id, auto_detection: true })));
    const now = new Date().toISOString();
    for (const a of data.accepted ?? []) {
      const o = part.find((x) => x.tracking === a.number);
      if (!o) continue;
      accepted++;
      await admin.from('orders').update({ tracking_registered_at: now, tracking_carrier_code: a.carrier ?? null, tracking_error: null }).eq('id', o.id).eq('tracking', o.tracking);
    }
    for (const r of data.rejected ?? []) {
      const o = part.find((x) => x.tracking === r.number);
      if (!o) continue;
      if (r.error && ALREADY.has(r.error.code)) {
        accepted++;
        await admin.from('orders').update({ tracking_registered_at: now, tracking_error: null }).eq('id', o.id).eq('tracking', o.tracking);
      } else {
        rejected++;
        await admin.from('orders').update({ tracking_error: (r.error?.message ?? 'Rejected by 17TRACK').slice(0, 300), tracking_checked_at: now }).eq('id', o.id).eq('tracking', o.tracking);
      }
    }
  }
  return { accepted, rejected };
}

/** Pull the latest carrier data for these parcels and store it (used by the daily sync and "Refresh now"). */
export async function refreshOrders(orders: OrderRef[]) {
  if (!trackKey() || !orders.length) return { updated: 0, delivered: 0 };
  let updated = 0, delivered = 0;
  for (const part of chunks(orders)) {
    const data = await call<{ accepted?: Accepted[]; rejected?: Rejected[] }>('gettrackinfo', part.map((o) => ({ number: o.tracking })));
    for (const a of data.accepted ?? []) {
      const o = part.find((x) => x.tracking === a.number);
      if (!o) continue;
      const r = await applyTrack(o.id, o.tracking, a.track_info, a.carrier);
      if (r === 'updated' || r === 'delivered') updated++;
      if (r === 'delivered') delivered++;
    }
  }
  return { updated, delivered };
}

/** Called right after an order ships: register its number now (the daily sync retries if this fails). */
export async function trackShippedOrder(orderId: string) {
  if (!trackKey()) return null;
  const { data: o } = await supabaseAdmin().from('orders').select('id, tracking, status, tracking_registered_at').eq('id', orderId).maybeSingle();
  if (!o?.tracking || o.tracking_registered_at || !['shipped', 'delivered'].includes(o.status)) return null;
  try {
    await registerOrders([{ id: o.id, tracking: o.tracking }]);
    return 'ok';
  } catch (e) {
    return (e as Error).message;
  }
}

/** Remaining 17TRACK quota (shown to the owner). */
export async function trackQuota() {
  if (!trackKey()) return null;
  try {
    return await call<{ quota_total: number; quota_used: number; quota_remain: number }>('getquota', {});
  } catch {
    return null;
  }
}

/** Daily safety net (and "Sync now"): register shipped parcels not yet registered, refresh those that went quiet. */
export async function syncTracking(limit = 200) {
  if (!trackKey()) return { configured: false as const };
  const admin = supabaseAdmin();
  const dayAgo = new Date(Date.now() - 20 * 3600e3).toISOString();
  const monthAgo = new Date(Date.now() - 45 * 864e5).toISOString();
  const { data: todo } = await admin.from('orders').select('id, tracking')
    .in('status', ['shipped', 'delivered']).not('tracking', 'is', null).is('tracking_registered_at', null).gte('shipped_at', monthAgo)
    .or(`tracking_checked_at.is.null,tracking_checked_at.lt.${dayAgo}`).order('shipped_at', { ascending: false }).limit(limit);
  const reg = await registerOrders((todo ?? []) as OrderRef[]);
  const { data: quiet } = await admin.from('orders').select('id, tracking')
    .eq('status', 'shipped').not('tracking', 'is', null).not('tracking_registered_at', 'is', null)
    .or(`tracking_checked_at.is.null,tracking_checked_at.lt.${dayAgo}`).order('tracking_checked_at', { ascending: true, nullsFirst: true }).limit(limit);
  const ref = await refreshOrders((quiet ?? []) as OrderRef[]);
  return { configured: true as const, registered: reg.accepted, rejected: reg.rejected, refreshed: ref.updated, delivered: ref.delivered };
}
