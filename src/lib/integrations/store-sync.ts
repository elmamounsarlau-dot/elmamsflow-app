import 'server-only';
import { supabaseAdmin } from '../supabase/admin';
import { trackingLink } from '../carriers';
import { KIND_LABEL, loadIntegration, logEvent, type Integration } from './core';
import { gql, shopifyToken } from './shopify';
import { wooCall } from './woocommerce';
import { shopifyCancel } from './bridge';

/**
 * Whatever happens to an order in Elmamsflow is mirrored in the client's own store, so a client who never opens
 * Elmamsflow still sees it in Shopify / WooCommerce:
 *   On hold → On hold · released → Unfulfilled/Processing · Packed → In progress (Shopify) · Shipped → Fulfilled +
 *   tracking (customer emailed) · carrier journey → shipment events (Shopify) · Delivered → Delivered · Cancelled → Cancelled
 * `store_state` remembers what the store was last told, so nothing is sent twice.
 */

type O = {
  id: string; number: string; org_id: string; status: string; carrier: string | null; tracking: string | null; tracking_url: string | null;
  shipment_status: string | null; integration_id: string | null; external_id: string | null; store_state: string | null; cancel_refund: boolean | null;
};

const keyOf = (o: Pick<O, 'status' | 'tracking' | 'shipment_status'>) => `${o.status}|${o.tracking ?? ''}|${o.shipment_status ?? ''}`;
const parse = (s: string | null) => { const [status, tracking, shipment] = (s ?? 'new||').split('|'); return { status: status || 'new', tracking: tracking || null, shipment: shipment || null }; };

// ---------- Shopify ----------
async function shopFOs(i: Integration, token: string, gid: string) {
  const d = await gql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string }[] }; fulfillments: { id: string; status: string }[] } | null }>(i.store_url, token,
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } fulfillments(first: 10) { id status } } }`, { id: gid });
  return { fos: d.order?.fulfillmentOrders.nodes ?? [], fulfillments: (d.order?.fulfillments ?? []).filter((f) => f.status === 'SUCCESS') };
}
const errsOf = (d: Record<string, { userErrors?: { message: string }[] }>) => Object.values(d).flatMap((v) => v?.userErrors ?? []).map((e) => e.message);

async function shopHold(i: Integration, token: string, gid: string) {
  for (const f of (await shopFOs(i, token, gid)).fos.filter((f) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(f.status))) {
    const d = await gql(i.store_url, token, `mutation($id: ID!) { fulfillmentOrderHold(id: $id, fulfillmentHold: { reason: OTHER, reasonNotes: "On hold at Elmamsflow", notifyMerchant: false }) { userErrors { message } } }`, { id: f.id });
    const e = errsOf(d); if (e.length) throw new Error(e.join('; '));
  }
}
async function shopRelease(i: Integration, token: string, gid: string) {
  for (const f of (await shopFOs(i, token, gid)).fos.filter((f) => f.status === 'ON_HOLD')) {
    const d = await gql(i.store_url, token, `mutation($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { userErrors { message } } }`, { id: f.id });
    const e = errsOf(d); if (e.length) throw new Error(e.join('; '));
  }
}
async function shopInProgress(i: Integration, token: string, gid: string) {
  for (const f of (await shopFOs(i, token, gid)).fos.filter((f) => f.status === 'OPEN')) {
    // Not every store/API version offers this; it's cosmetic, so a refusal is ignored.
    await gql(i.store_url, token, `mutation($id: ID!) { fulfillmentOrderReportProgress(id: $id) { userErrors { message } } }`, { id: f.id }).catch(() => null);
  }
}
async function shopFulfil(i: Integration, token: string, gid: string, o: O, url: string | null) {
  const { fos, fulfillments } = await shopFOs(i, token, gid);
  const open = fos.filter((f) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED', 'ON_HOLD'].includes(f.status));
  for (const f of open.filter((x) => x.status === 'ON_HOLD')) await gql(i.store_url, token, `mutation($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { userErrors { message } } }`, { id: f.id });
  const info = { company: o.carrier || 'Other', number: o.tracking, url };
  if (open.length) {
    const d = await gql<{ fulfillmentCreate: { userErrors: { message: string }[] } }>(i.store_url, token,
      `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { message } } }`,
      { f: { notifyCustomer: true, lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })), trackingInfo: info } });
    if (d.fulfillmentCreate.userErrors.length) throw new Error(d.fulfillmentCreate.userErrors.map((e) => e.message).join('; '));
  } else if (fulfillments[0]) {
    // Already fulfilled (e.g. the tracking number changed): update the tracking on it.
    const d = await gql<{ fulfillmentTrackingInfoUpdate: { userErrors: { message: string }[] } }>(i.store_url, token,
      `mutation($id: ID!, $t: FulfillmentTrackingInput!) { fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $t, notifyCustomer: true) { userErrors { message } } }`,
      { id: fulfillments[0].id, t: info });
    if (d.fulfillmentTrackingInfoUpdate.userErrors.length) throw new Error(d.fulfillmentTrackingInfoUpdate.userErrors.map((e) => e.message).join('; '));
  }
}
async function shopEvent(i: Integration, token: string, gid: string, status: string) {
  const { fulfillments } = await shopFOs(i, token, gid);
  if (!fulfillments[0]) return;
  const d = await gql<{ fulfillmentEventCreate: { userErrors: { message: string }[] } }>(i.store_url, token,
    `mutation($e: FulfillmentEventInput!) { fulfillmentEventCreate(fulfillmentEvent: $e) { userErrors { message } } }`,
    { e: { fulfillmentId: fulfillments[0].id, status } });
  if (d.fulfillmentEventCreate.userErrors.length) throw new Error(d.fulfillmentEventCreate.userErrors.map((e) => e.message).join('; '));
}

// ---------- WooCommerce ----------
const wooStatus = (i: Integration, id: string, status: string) => wooCall(i, `/orders/${encodeURIComponent(id)}`, { method: 'PUT', body: { status } });
const wooNote = (i: Integration, id: string, note: string) => wooCall(i, `/orders/${encodeURIComponent(id)}/notes`, { method: 'POST', body: { note, customer_note: true } });

const JOURNEY: Record<string, string> = {
  IN_TRANSIT: 'is on its way', OUT_FOR_DELIVERY: 'is out for delivery today', ATTEMPTED_DELIVERY: 'had a delivery attempt — the carrier will try again or leave a notice',
  READY_FOR_PICKUP: 'is ready to pick up', FAILURE: 'could not be delivered — we are looking into it', DELIVERED: 'was delivered',
};

/** Tell the client's store about this order's current status. Safe to call any time; does nothing when it already knows. */
export async function syncClientStore(orderId: string) {
  const admin = supabaseAdmin();
  const { data } = await admin.from('orders').select('id, number, org_id, status, carrier, tracking, tracking_url, shipment_status, integration_id, external_id, store_state, cancel_refund').eq('id', orderId).maybeSingle();
  const o = data as O | null;
  if (!o?.integration_id || !o.external_id) return null;
  const key = keyOf(o);
  if (o.store_state === key) return 'same';
  const i = await loadIntegration(o.integration_id);
  if (!i || i.role === 'bridge' || i.status === 'paused' || i.settings?.push_tracking === false) return null;
  const prev = parse(o.store_state);
  const url = trackingLink(o.carrier, o.tracking, o.tracking_url);
  const shipped = ['shipped', 'delivered'].includes(o.status);
  // Shipped without a tracking number yet: wait for it (the customer email needs it).
  if (shipped && !o.tracking) return 'waiting';
  try {
    if (i.kind === 'shopify') {
      const token = await shopifyToken(i);
      const gid = o.external_id;
      if (o.status === 'on_hold') await shopHold(i, token, gid);
      else if (o.status === 'new' && prev.status === 'on_hold') await shopRelease(i, token, gid);
      else if (o.status === 'packed') { if (prev.status === 'on_hold') await shopRelease(i, token, gid); await shopInProgress(i, token, gid); }
      else if (o.status === 'cancelled') {
        const { data: org } = await admin.from('organizations').select('cancel_refund').eq('id', o.org_id).maybeSingle();
        const refund = o.cancel_refund ?? org?.cancel_refund ?? false;
        await shopifyCancel(i, token, gid, refund, refund);
      } else if (shipped) {
        if (!['shipped', 'delivered'].includes(prev.status) || prev.tracking !== o.tracking) await shopFulfil(i, token, gid, o, url);
        const ev = o.status === 'delivered' ? 'DELIVERED' : o.shipment_status;
        if (ev && ev !== prev.shipment && ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ATTEMPTED_DELIVERY', 'READY_FOR_PICKUP', 'DELIVERED', 'FAILURE', 'CONFIRMED', 'LABEL_PRINTED', 'LABEL_PURCHASED'].includes(ev)) {
          await shopEvent(i, token, gid, ev).catch(async (e) => { await logEvent(i, 'error', `#${o.number}: “${ev}” not shown in Shopify — ${(e as Error).message}`); });
        }
      }
    } else {
      const id = o.external_id;
      if (o.status === 'on_hold') await wooStatus(i, id, 'on-hold');
      else if ((o.status === 'new' || o.status === 'packed') && prev.status === 'on_hold') await wooStatus(i, id, 'processing');
      else if (o.status === 'cancelled') await wooStatus(i, id, 'cancelled');
      else if (shipped) {
        if (!['shipped', 'delivered'].includes(prev.status) || prev.tracking !== o.tracking) {
          await wooNote(i, id, `Your order has shipped${o.carrier ? ` with ${o.carrier}` : ''}. Tracking number: ${o.tracking}${url ? ` — follow it here: ${url}` : ''}`);
          await wooStatus(i, id, 'completed');
        }
        const ev = o.status === 'delivered' ? 'DELIVERED' : o.shipment_status;
        if (ev && ev !== prev.shipment && JOURNEY[ev]) await wooNote(i, id, `Your parcel ${JOURNEY[ev]}.`);
      }
    }
    await admin.from('orders').update({ store_state: key, store_error: null, ...(shipped ? { pushed_at: new Date().toISOString(), push_error: null } : {}) }).eq('id', o.id);
    await logEvent(i, shipped ? 'tracking_pushed' : 'imported', `#${o.number} → ${KIND_LABEL[i.kind]}: ${o.status}${shipped && o.tracking ? ` (${o.tracking})` : ''}`);
    return 'ok';
  } catch (e) {
    const msg = (e as Error).message;
    await admin.from('orders').update({ store_error: msg.slice(0, 300), ...(shipped ? { push_error: msg.slice(0, 300) } : {}) }).eq('id', o.id);
    await logEvent(i, 'error', `#${o.number}: ${KIND_LABEL[i.kind]} not updated (${o.status}) — ${msg}`);
    return msg;
  }
}
