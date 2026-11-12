import 'server-only';
import { supabaseAdmin } from '../supabase/admin';
import { logEvent, type Integration } from './core';
import { gql, shopifyToken } from './shopify';

/**
 * The bridge: our own Shopify store, connected to the fulfilment partner (ST Fulfill). Clients never see it.
 *   client's store → Elmamsflow → bridge store → partner ships → bridge store → Elmamsflow → client's store
 * A client uses the bridge when it has a client code (its products become CODE-SKU in the bridge store,
 * and the partner holds its stock under exactly those SKUs).
 */

export const BRIDGE_SCOPES = [
  'read_orders', 'write_orders', 'read_products', 'write_products', 'read_fulfillments',
  'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
  'read_third_party_fulfillment_orders', 'write_third_party_fulfillment_orders',
];
export const BRIDGE_TOPICS = [
  'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE',
  'FULFILLMENT_EVENTS_CREATE', 'FULFILLMENT_ORDERS_PLACED_ON_HOLD', 'FULFILLMENT_ORDERS_HOLD_RELEASED',
];

export async function loadBridge(): Promise<Integration | null> {
  const { data } = await supabaseAdmin().from('integrations').select('*').eq('role', 'bridge').eq('status', 'active').maybeSingle();
  return (data as Integration) ?? null;
}

/** CODE-SKU, unless the client's SKU already starts with its code (ATL-001 stays ATL-001). */
export const bridgeSkuOf = (code: string, sku: string) => {
  const s = sku.trim().toUpperCase();
  return s.startsWith(`${code.toUpperCase()}-`) ? s : `${code}-${s}`.toUpperCase();
};

type Prod = { id: string; org_id: string; sku: string; name: string; weight_g: number; customs_value: number; kind: string; bridge_ref: string | null; bridge_sku: string | null };

async function findVariant(b: Integration, token: string, sku: string) {
  const d = await gql<{ productVariants: { nodes: { id: string; sku: string | null }[] } }>(b.store_url, token,
    `query($q: String!) { productVariants(first: 5, query: $q) { nodes { id sku } } }`, { q: `sku:"${sku.replace(/"/g, '')}"` });
  return d.productVariants.nodes.find((v) => (v.sku ?? '').toUpperCase() === sku)?.id ?? null;
}

/** Make sure this product exists in the bridge store under CODE-SKU (stock not tracked there: the partner has it). */
export async function ensureBridgeProduct(b: Integration, token: string, p: Prod, code: string) {
  const sku = bridgeSkuOf(code, p.sku);
  if (p.bridge_ref && p.bridge_sku === sku) return p.bridge_ref;
  const admin = supabaseAdmin();
  let id = await findVariant(b, token, sku);
  if (!id) {
    const d = await gql<{ productSet: { product: { variants: { nodes: { id: string }[] } } | null; userErrors: { message: string }[] } }>(b.store_url, token,
      `mutation($input: ProductSetInput!) { productSet(synchronous: true, input: $input) { product { variants(first: 1) { nodes { id } } } userErrors { field message } } }`,
      { input: {
        title: `${code} · ${p.name}`.slice(0, 250), status: 'ACTIVE', vendor: code, tags: [code, 'elmamsflow'],
        productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
        variants: [{
          optionValues: [{ optionName: 'Title', name: 'Default Title' }],
          price: Number(p.customs_value || 0).toFixed(2),
          inventoryItem: { sku, tracked: false, requiresShipping: true, ...(p.weight_g > 0 ? { measurement: { weight: { unit: 'GRAMS', value: p.weight_g } } } : {}) },
        }],
      } });
    if (d.productSet.userErrors.length) {
      const msg = d.productSet.userErrors.map((e) => e.message).join('; ');
      await admin.from('products').update({ bridge_error: msg.slice(0, 300) }).eq('id', p.id);
      throw new Error(`${sku}: ${msg}`);
    }
    id = d.productSet.product?.variants.nodes[0]?.id ?? null;
    if (!id) throw new Error(`${sku}: the bridge store didn’t return the product`);
  }
  await admin.from('products').update({ bridge_ref: id, bridge_sku: sku, bridge_synced_at: new Date().toISOString(), bridge_error: null }).eq('id', p.id);
  return id;
}

/** Copy all of a client's single products to the bridge store (bundles ship as their products). */
export async function syncClientProducts(orgId: string) {
  const b = await loadBridge();
  if (!b) return { error: 'The bridge store isn’t connected yet (Stores → Bridge store).' };
  const admin = supabaseAdmin();
  const { data: org } = await admin.from('organizations').select('client_code').eq('id', orgId).maybeSingle();
  if (!org?.client_code) return { error: 'Give this client a client code first.' };
  const { data: prods } = await admin.from('products').select('id, org_id, sku, name, weight_g, customs_value, kind, bridge_ref, bridge_sku').eq('org_id', orgId).eq('kind', 'item');
  const token = await shopifyToken(b);
  let done = 0;
  const errors: string[] = [];
  for (const p of (prods ?? []) as Prod[]) {
    try { await ensureBridgeProduct(b, token, p, org.client_code); done++; } catch (e) { errors.push((e as Error).message); }
  }
  await logEvent(b, errors.length ? 'error' : 'products_imported', `${org.client_code}: ${done} product${done === 1 ? '' : 's'} in the bridge store${errors.length ? ` · ${errors.length} failed: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  return { done, errors };
}

type OrderRow = {
  id: string; number: string; org_id: string; status: string; hold_kind: string | null; store_ref: string | null;
  customer: string; phone: string | null; address: string; city: string | null; zip: string | null; country: string;
  bridge_id: string | null; bridge_name: string | null;
  order_items: { qty: number; products: Prod | null }[];
};
const ORDER_SEL = 'id, number, org_id, status, hold_kind, store_ref, customer, phone, address, city, zip, country, bridge_id, bridge_name, order_items(qty, products(id, org_id, sku, name, weight_g, customs_value, kind, bridge_ref, bridge_sku))';

function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] } : { firstName: '', lastName: parts[0] || 'Customer' };
}
function addressOf(o: Pick<OrderRow, 'customer' | 'phone' | 'address' | 'city' | 'zip' | 'country'>) {
  const [line1, ...rest] = o.address.split(', ');
  return { ...splitName(o.customer), address1: line1, address2: rest.join(', ') || null, city: o.city, zip: o.zip, countryCode: o.country, phone: o.phone };
}

/** Copy a new order to the bridge store as a real, paid order — without the customer's email, so it can never email them. */
async function createBridgeOrder(b: Integration, token: string, o: OrderRow, code: string) {
  const admin = supabaseAdmin();
  const lines: { variantId: string; quantity: number; priceSet: { shopMoney: { amount: string; currencyCode: string } } }[] = [];
  let total = 0;
  for (const it of o.order_items) {
    if (!it.products) continue;
    const variantId = await ensureBridgeProduct(b, token, it.products, code);
    const price = Number(it.products.customs_value || 0);
    total += price * it.qty;
    lines.push({ variantId, quantity: it.qty, priceSet: { shopMoney: { amount: price.toFixed(2), currencyCode: 'USD' } } });
  }
  if (!lines.length) throw new Error('No products on this order');
  const name = `${code}-${(o.store_ref || o.number).replace(/^#/, '')}`.slice(0, 60);
  const d = await gql<{ orderCreate: { order: { id: string; name: string } | null; userErrors: { field: string[] | null; message: string }[] } }>(b.store_url, token,
    `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) { orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } } }`,
    {
      order: {
        name, currency: 'USD', lineItems: lines, shippingAddress: addressOf(o), billingAddress: addressOf(o),
        transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'Elmamsflow', amountSet: { shopMoney: { amount: total.toFixed(2), currencyCode: 'USD' } } }],
        tags: [code, 'elmamsflow'], note: `Elmamsflow #${o.number}${o.store_ref ? ` · client order ${o.store_ref}` : ''}`,
        customAttributes: [{ key: 'elmamsflow_order', value: o.id }, { key: 'client', value: code }],
      },
      options: { sendReceipt: false, sendFulfillmentReceipt: false, inventoryBehaviour: 'BYPASS' },
    });
  if (d.orderCreate.userErrors.length || !d.orderCreate.order) throw new Error(d.orderCreate.userErrors.map((e) => e.message).join('; ') || 'The bridge store didn’t create the order');
  await admin.from('orders').update({ bridge_id: d.orderCreate.order.id, bridge_name: d.orderCreate.order.name, bridge_sent_at: new Date().toISOString(), bridge_error: null }).eq('id', o.id);
  await admin.from('activity_log').insert({ org_id: o.org_id, action: 'order_updated', detail: `#${o.number} · sent to the warehouse` });
  await logEvent(b, 'imported', `#${o.number} → ${d.orderCreate.order.name}`);
}

async function fulfillmentOrders(b: Integration, token: string, gid: string) {
  const d = await gql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string }[] } } | null }>(b.store_url, token,
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`, { id: gid });
  return d.order?.fulfillmentOrders.nodes ?? [];
}

/** Cancel on the bridge store (never refunds there: no money is in that store). Tries the newer, then the older form. */
export async function shopifyCancel(i: Integration, token: string, gid: string, refund: boolean, notify: boolean) {
  const attempts = [
    { q: `mutation($id: ID!, $refund: Boolean!, $notify: Boolean!) { orderCancel(orderId: $id, reason: OTHER, refundMethod: { originalPaymentMethodsRefund: $refund }, restock: true, notifyCustomer: $notify, staffNote: "Cancelled through Elmamsflow") { orderCancelUserErrors { message } } }` },
    { q: `mutation($id: ID!, $refund: Boolean!, $notify: Boolean!) { orderCancel(orderId: $id, reason: OTHER, refund: $refund, restock: true, notifyCustomer: $notify, staffNote: "Cancelled through Elmamsflow") { orderCancelUserErrors { message } } }` },
  ];
  let last: Error | null = null;
  for (const a of attempts) {
    try {
      const d = await gql<{ orderCancel: { orderCancelUserErrors: { message: string }[] } }>(i.store_url, token, a.q, { id: gid, refund, notify });
      const errs = d.orderCancel.orderCancelUserErrors.map((e) => e.message).filter((m) => !/already.*cancel/i.test(m));
      if (errs.length) throw new Error(errs.join('; '));
      return;
    } catch (e) {
      last = e as Error;
      if (!/refundMethod|argument|Unknown|doesn't accept|isn't defined/i.test(last.message)) throw last;
    }
  }
  throw last ?? new Error('Could not cancel');
}

/** Bring the bridge copy in line with our order: create it, cancel it, hold or release it. Safe to call any time. */
export async function syncBridge(orderId: string) {
  const b = await loadBridge();
  if (!b) return 'no_bridge';
  const admin = supabaseAdmin();
  const { data } = await admin.from('orders').select(ORDER_SEL).eq('id', orderId).maybeSingle();
  const o = data as unknown as OrderRow | null;
  if (!o) return 'missing';
  const { data: org } = await admin.from('organizations').select('client_code').eq('id', o.org_id).maybeSingle();
  if (!org?.client_code) return 'not_bridged';
  try {
    const token = await shopifyToken(b);
    if (!o.bridge_id) {
      if (o.status !== 'new') return 'waiting';
      await createBridgeOrder(b, token, o, org.client_code);
      return 'sent';
    }
    if (o.status === 'cancelled') {
      await shopifyCancel(b, token, o.bridge_id, false, false);
      return 'cancelled';
    }
    if (o.status === 'on_hold' && o.hold_kind !== 'partner') {
      for (const f of (await fulfillmentOrders(b, token, o.bridge_id)).filter((f) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(f.status))) {
        await gql(b.store_url, token, `mutation($id: ID!) { fulfillmentOrderHold(id: $id, fulfillmentHold: { reason: OTHER, reasonNotes: "Paused in Elmamsflow", notifyMerchant: false }) { userErrors { message } } }`, { id: f.id });
      }
      return 'held';
    }
    if (o.status === 'new') {
      for (const f of (await fulfillmentOrders(b, token, o.bridge_id)).filter((f) => f.status === 'ON_HOLD')) {
        await gql(b.store_url, token, `mutation($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { userErrors { message } } }`, { id: f.id });
      }
      return 'released';
    }
    return 'same';
  } catch (e) {
    const msg = (e as Error).message;
    await admin.from('orders').update({ bridge_error: msg.slice(0, 300) }).eq('id', o.id);
    await logEvent(b, 'error', `#${o.number}: ${msg}`);
    return 'error';
  }
}

/** The customer's address changed here before packing: change it on the bridge copy too. */
export async function bridgeAddress(orderId: string) {
  const b = await loadBridge();
  if (!b) return;
  const { data } = await supabaseAdmin().from('orders').select(ORDER_SEL).eq('id', orderId).maybeSingle();
  const o = data as unknown as OrderRow | null;
  if (!o?.bridge_id || !['new', 'on_hold'].includes(o.status)) return;
  try {
    const token = await shopifyToken(b);
    const d = await gql<{ orderUpdate: { userErrors: { message: string }[] } }>(b.store_url, token,
      `mutation($input: OrderInput!) { orderUpdate(input: $input) { userErrors { message } } }`, { input: { id: o.bridge_id, shippingAddress: addressOf(o) } });
    if (d.orderUpdate.userErrors.length) throw new Error(d.orderUpdate.userErrors.map((e) => e.message).join('; '));
    await supabaseAdmin().from('activity_log').insert({ org_id: o.org_id, action: 'order_address_updated', detail: `#${o.number} · new address sent to the warehouse` });
  } catch (e) {
    await logEvent(b, 'error', `#${o.number}: address not changed at the warehouse — ${(e as Error).message}. Change it in ST Fulfill by hand.`);
  }
}

// ---------- Coming back: what the partner did in the bridge store ----------

const SHIPMENT = new Set(['LABEL_PRINTED', 'LABEL_PURCHASED', 'CONFIRMED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ATTEMPTED_DELIVERY', 'READY_FOR_PICKUP', 'DELIVERED', 'FAILURE']);

type BridgeState = {
  id: string; cancelledAt: string | null;
  fulfillmentOrders: { nodes: { status: string }[] };
  fulfillments: { status: string; displayStatus: string | null; createdAt: string; trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[];
};

/** What our order should look like, given the bridge order. */
export function readBridgeState(s: BridgeState) {
  if (s.cancelledAt) return { status: 'cancelled' as const };
  const live = s.fulfillments.filter((f) => !['CANCELLED', 'ERROR', 'FAILURE'].includes(f.status)).sort((a, z) => z.createdAt.localeCompare(a.createdAt));
  if (live.length) {
    const t = live.flatMap((f) => f.trackingInfo).find((x) => x.number) ?? null;
    const disp = live[0].displayStatus ?? '';
    return {
      status: disp === 'DELIVERED' ? 'delivered' as const : 'shipped' as const,
      carrier: t?.company ?? null, tracking: t?.number ?? null, url: t?.url ?? null,
      shipment: SHIPMENT.has(disp) ? disp : null,
    };
  }
  const fo = s.fulfillmentOrders.nodes.map((f) => f.status);
  if (fo.includes('ON_HOLD')) return { status: 'on_hold' as const };
  if (fo.includes('IN_PROGRESS')) return { status: 'packed' as const };
  if (fo.length && fo.every((x) => ['CLOSED', 'CANCELLED'].includes(x))) return { status: 'cancelled' as const };
  return { status: 'new' as const };
}

/** The bridge store told us something changed on one of its orders. Apply it here; the caller then updates the client's store. */
export async function applyBridgeOrder(b: Integration, gid: string): Promise<string | null> {
  const admin = supabaseAdmin();
  const { data: o } = await admin.from('orders').select('id, number, org_id, status, hold_kind, tracking, carrier, shipment_status, tracking_url').eq('bridge_id', gid).maybeSingle();
  if (!o) return null;
  const token = await shopifyToken(b);
  const d = await gql<{ order: BridgeState | null }>(b.store_url, token,
    `query($id: ID!) { order(id: $id) { id cancelledAt fulfillmentOrders(first: 10) { nodes { status } }
      fulfillments(first: 10) { status displayStatus createdAt trackingInfo(first: 5) { company number url } } } }`, { id: gid });
  if (!d.order) return null;
  const want = readBridgeState(d.order);
  let changed = false;

  if (want.status === 'shipped' || want.status === 'delivered') {
    const newTracking = want.tracking && want.tracking !== o.tracking ? want.tracking : null;
    if (o.status !== want.status && !(o.status === 'delivered' && want.status === 'shipped') || newTracking) {
      const { data: r, error } = await admin.rpc('partner_set_status', { p_order: o.id, p_status: o.status === 'delivered' ? 'delivered' : want.status, p_carrier: want.carrier, p_tracking: newTracking ?? (o.status === want.status ? null : want.tracking) });
      if (error) throw new Error(error.message);
      changed = changed || r === 'ok';
    }
    const patch: Record<string, unknown> = {};
    if (want.shipment && want.shipment !== o.shipment_status) patch.shipment_status = want.shipment;
    if (want.url && want.url !== o.tracking_url) patch.tracking_url = want.url;
    if (Object.keys(patch).length) { await admin.from('orders').update(patch).eq('id', o.id); changed = true; }
  } else if (want.status === 'cancelled') {
    if (!['cancelled', 'shipped', 'delivered'].includes(o.status)) {
      await admin.rpc('partner_set_status', { p_order: o.id, p_status: 'cancelled' });
      changed = true;
    }
  } else if (want.status === 'on_hold') {
    if (o.status === 'new' || o.status === 'packed') {
      await admin.rpc('partner_set_status', { p_order: o.id, p_status: 'on_hold', p_hold_reason: 'Warehouse: paused this order (ask ST Fulfill why)' });
      changed = true;
    }
  } else if (want.status === 'packed') {
    if (o.status === 'new' || (o.status === 'on_hold' && o.hold_kind === 'partner')) {
      await admin.rpc('partner_set_status', { p_order: o.id, p_status: 'packed' });
      changed = true;
    }
  } else if (want.status === 'new' && o.status === 'on_hold' && o.hold_kind === 'partner') {
    await admin.rpc('partner_set_status', { p_order: o.id, p_status: 'new' });
    changed = true;
  }
  return changed ? o.id : null;
}

/** Turn any bridge webhook into the bridge order id it is about. */
export async function bridgeOrderGid(b: Integration, topic: string, payload: Record<string, unknown>) {
  if (topic.startsWith('orders/')) return (payload.admin_graphql_api_id as string) ?? null;
  if (payload.order_id) return `gid://shopify/Order/${payload.order_id}`;
  const fo = (payload.fulfillment_order ?? payload) as { id?: string };
  if (fo?.id) {
    const token = await shopifyToken(b);
    const d = await gql<{ fulfillmentOrder: { order: { id: string } } | null }>(b.store_url, token, `query($id: ID!) { fulfillmentOrder(id: $id) { order { id } } }`, { id: String(fo.id).startsWith('gid://') ? fo.id : `gid://shopify/FulfillmentOrder/${fo.id}` });
    return d.fulfillmentOrder?.order.id ?? null;
  }
  return null;
}

/** Re-read every order still at the warehouse (backup for a missed webhook). */
export async function pollBridge() {
  const b = await loadBridge();
  if (!b) return { checked: 0, changed: [] as string[] };
  const { data } = await supabaseAdmin().from('orders').select('bridge_id').not('bridge_id', 'is', null).in('status', ['new', 'packed', 'on_hold', 'shipped']).limit(300);
  const changed: string[] = [];
  for (const r of data ?? []) {
    try { const id = await applyBridgeOrder(b, r.bridge_id as string); if (id) changed.push(id); } catch (e) { await logEvent(b, 'error', (e as Error).message); }
  }
  return { checked: (data ?? []).length, changed };
}
