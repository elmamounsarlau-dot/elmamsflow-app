/* eslint-disable @typescript-eslint/no-explicit-any -- the fake Shopify below takes loosely-typed GraphQL variables */
// The whole loop, against the LOCAL test stack and a fake Shopify (npm run test:stack). Never production.
//   client's Shopify → Elmamsflow → bridge Shopify → partner → bridge Shopify → Elmamsflow → client's Shopify
// Plus the prepaid balance: orders wait when it is too low, are paid when they ship, and a top-up releases them.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseAdmin } from '../src/lib/supabase/admin';
import { seal } from '../src/lib/integrations/crypto';
import { afterOrderChange } from '../src/lib/integrations/flow';
import { applyBridgeOrder, loadBridge, syncClientProducts } from '../src/lib/integrations/bridge';
import { decideTopup, balanceOf } from '../src/lib/wallet';

if (!/^http:\/\/127\.0\.0\.1/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')) throw new Error('local stack only');
const db = () => supabaseAdmin();
const ATLAS = '11111111-1111-1111-1111-111111111111';
const CLIENT_STORE = '1e000000-0000-0000-0000-000000000001';
const BRIDGE = '1e000000-0000-0000-0000-0000000000b0';
const OWNER_ORG = async () => (await db().from('organizations').select('id').eq('kind', 'owner').single()).data!.id as string;

// ---------- A tiny fake of the Shopify Admin GraphQL API (two shops) ----------
type FO = { id: string; status: string };
type Ful = { id: string; status: string; displayStatus: string | null; createdAt: string; trackingInfo: { company: string | null; number: string | null; url: string | null }[]; events: string[] };
type ShopOrder = { id: string; name: string; cancelledAt: string | null; cancelRefund?: boolean; fos: FO[]; fulfillments: Ful[]; input?: Record<string, unknown> };
const PHOTO_HOST = 'cdn.shop-photos.example';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const storeList: { id: string; sku: string; image: string }[] = [];
const shops: Record<string, { orders: Map<string, ShopOrder>; variants: Map<string, string>; calls: string[]; files: Map<string, string[]> }> = {};
const shop = (host: string) => (shops[host] ??= { orders: new Map(), variants: new Map(), calls: [], files: new Map() });
let seq = 1;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  if (u.hostname === PHOTO_HOST) return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } });
  if (!u.hostname.endsWith('.myshopify.com')) return realFetch(url as string, init);
  const s = shop(u.hostname);
  const { query, variables: v } = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables: Record<string, any> };
  const op = (query.match(/\b(productVariants|productVariant\(|productUpdate|productSet|orderCreate|orderCancel|orderUpdate|fulfillmentOrderHold|fulfillmentOrderReleaseHold|fulfillmentOrderReportProgress|fulfillmentCreate|fulfillmentEventCreate|fulfillmentTrackingInfoUpdate|fulfillmentOrder\(|order\(|shop)\b/) ?? [''])[0];
  s.calls.push(op);
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  const foOwner = (id: string) => [...s.orders.values()].find((o) => o.fos.some((f) => f.id === id))!;
  switch (op) {
    case 'shop': return ok({ shop: { name: u.hostname } });
    case 'productVariants': {
      if (!v.q) return ok({ productVariants: { nodes: storeList.map((x) => ({ id: x.id, sku: x.sku, barcode: null, title: 'Default Title', image: null, product: { title: x.sku, featuredMedia: { preview: { image: { url: x.image } } } }, inventoryItem: null })), pageInfo: { hasNextPage: false, endCursor: null } } });
      const sku = /sku:"([^"]+)"/.exec(v.q)?.[1] ?? '';
      const id = s.variants.get(sku);
      return ok({ productVariants: { nodes: id ? [{ id, sku }] : [] } });
    }
    case 'productSet': {
      const sku = v.input.variants[0].inventoryItem.sku as string;
      assert.equal(v.input.variants[0].inventoryItem.tracked, false, 'stock is not tracked in the bridge store');
      const id = `gid://shopify/ProductVariant/${seq++}`;
      s.variants.set(sku, id);
      s.files.set(id, (v.input.files ?? []).map((f: any) => f.originalSource));
      return ok({ productSet: { product: { variants: { nodes: [{ id }] } }, userErrors: [] } });
    }
    case 'productVariant(': return ok({ productVariant: { product: { id: `P-${v.id}`, media: { nodes: (s.files.get(v.id) ?? []).map((x) => ({ id: x })) } } } });
    case 'productUpdate': {
      const id = String(v.p.id).replace(/^P-/, '');
      s.files.set(id, [...(s.files.get(id) ?? []), ...v.m.map((m: any) => m.originalSource)]);
      return ok({ productUpdate: { product: { id: v.p.id }, userErrors: [] } });
    }
    case 'orderCreate': {
      const id = `gid://shopify/Order/${seq++}`;
      s.orders.set(id, { id, name: v.order.name, cancelledAt: null, fos: [{ id: `gid://shopify/FulfillmentOrder/${seq++}`, status: 'OPEN' }], fulfillments: [], input: { ...v.order, options: v.options } });
      return ok({ orderCreate: { order: { id, name: v.order.name }, userErrors: [] } });
    }
    case 'orderCancel': {
      const o = s.orders.get(v.id)!;
      o.cancelledAt = new Date().toISOString(); o.cancelRefund = v.refund;
      o.fos.forEach((f) => { f.status = 'CANCELLED'; });
      return ok({ orderCancel: { orderCancelUserErrors: [] } });
    }
    case 'orderUpdate': { s.orders.get(v.input.id)!.input!.shippingAddress = v.input.shippingAddress; return ok({ orderUpdate: { userErrors: [] } }); }
    case 'fulfillmentOrderHold': { const o = foOwner(v.id); o.fos.find((f) => f.id === v.id)!.status = 'ON_HOLD'; return ok({ fulfillmentOrderHold: { userErrors: [] } }); }
    case 'fulfillmentOrderReleaseHold': { const o = foOwner(v.id); o.fos.find((f) => f.id === v.id)!.status = 'OPEN'; return ok({ fulfillmentOrderReleaseHold: { userErrors: [] } }); }
    case 'fulfillmentOrderReportProgress': { const o = foOwner(v.id); o.fos.find((f) => f.id === v.id)!.status = 'IN_PROGRESS'; return ok({ fulfillmentOrderReportProgress: { userErrors: [] } }); }
    case 'fulfillmentCreate': {
      const foId = v.f.lineItemsByFulfillmentOrder[0].fulfillmentOrderId;
      const o = foOwner(foId);
      o.fos.forEach((f) => { f.status = 'CLOSED'; });
      o.fulfillments.push({ id: `gid://shopify/Fulfillment/${seq++}`, status: 'SUCCESS', displayStatus: 'FULFILLED', createdAt: new Date().toISOString(), trackingInfo: [v.f.trackingInfo], events: [] });
      return ok({ fulfillmentCreate: { fulfillment: { id: 'x' }, userErrors: [] } });
    }
    case 'fulfillmentEventCreate': {
      const o = [...s.orders.values()].find((x) => x.fulfillments.some((f) => f.id === v.e.fulfillmentId))!;
      o.fulfillments[0].events.push(v.e.status); o.fulfillments[0].displayStatus = v.e.status;
      return ok({ fulfillmentEventCreate: { userErrors: [] } });
    }
    case 'fulfillmentTrackingInfoUpdate': {
      const o = [...s.orders.values()].find((x) => x.fulfillments.some((f) => f.id === v.id))!;
      o.fulfillments[0].trackingInfo = [v.t];
      return ok({ fulfillmentTrackingInfoUpdate: { userErrors: [] } });
    }
    case 'fulfillmentOrder(': return ok({ fulfillmentOrder: { order: { id: foOwner(v.id).id } } });
    case 'order(': {
      const o = s.orders.get(v.id);
      if (!o) return ok({ order: null });
      return ok({ order: { id: o.id, cancelledAt: o.cancelledAt, fulfillmentOrders: { nodes: o.fos }, fulfillments: o.fulfillments.map(({ events: _e, ...f }) => ({ ...f, trackingInfo: f.trackingInfo })) } });
    }
  }
  throw new Error(`fake Shopify: no handler for ${op || query.slice(0, 80)}`);
}) as typeof fetch;

const CLIENT_HOST = 'atlas-home.myshopify.com';
const BRIDGE_HOST = 'elmamsflow-bridge.myshopify.com';
const order = async (id: string) => (await db().from('orders').select('status, hold_kind, bridge_id, bridge_name, bridge_error, tracking, carrier, shipment_status, store_state, store_error').eq('id', id).single()).data!;
const clientOrder = (gid: string) => {
  const s = shop(CLIENT_HOST);
  if (!s.orders.has(gid)) s.orders.set(gid, { id: gid, name: '#1001', cancelledAt: null, fos: [{ id: `gid://shopify/FulfillmentOrder/${seq++}`, status: 'OPEN' }], fulfillments: [] });
  return s.orders.get(gid)!;
};
async function newStoreOrder(n: number, items: [string, number][]) {
  const gid = `gid://shopify/Order/77${n}`;
  clientOrder(gid);
  const { data: o, error } = await db().from('orders').insert({
    org_id: ATLAS, customer: 'Camille Durand', email: 'camille@example.com', phone: '+33600000000', address: '5 Avenue Foch, Apt 3', city: 'Lyon', zip: '69006', country: 'FR',
    service: 'ddp', status: 'new', source: 'shopify', integration_id: CLIENT_STORE, external_id: gid, store_ref: `#10${n}`,
  }).select('id').single();
  assert.ifError(error);
  await db().from('order_items').insert(items.map(([p, qty]) => ({ order_id: o!.id, product_id: p, qty })));
  return { id: o!.id as string, gid };
}
const P1 = 'a0000000-0000-0000-0000-000000000001';
const P2 = 'a0000000-0000-0000-0000-000000000002';

before(async () => {
  await db().from('integrations').update({ secret_enc: seal({ mode: 'token', token: 'client-token', api_secret: 'client-secret' }) }).eq('id', CLIENT_STORE);
  await db().from('integrations').upsert({ id: BRIDGE, org_id: await OWNER_ORG(), kind: 'shopify', role: 'bridge', store_url: BRIDGE_HOST, name: 'Elmamsflow - Bridge', status: 'active', secret_enc: seal({ mode: 'token', token: 'bridge-token', api_secret: 'bridge-secret' }), settings: { auto_import: false, push_tracking: false } });
  await db().from('organizations').update({ client_code: 'ATL', billing_mode: 'prepaid', credit_limit: 0, low_balance: 20 }).eq('id', ATLAS);
  await db().from('wallet_entries').delete().eq('org_id', ATLAS);
  await db().from('wallet_entries').insert({ org_id: ATLAS, kind: 'topup', amount: 5000, currency: 'EUR', status: 'confirmed', ref: 'ATL-TOP-START' });
});

test('out: a paid store order goes to the bridge store as a real paid order, without the customer email, with CODE-SKUs', async () => {
  const { id } = await newStoreOrder(1, [[P1, 2], [P2, 1]]);
  await afterOrderChange([id]);
  const o = await order(id);
  assert.equal(o.status, 'new');
  assert.ok(o.bridge_id, `sent to the bridge (${o.bridge_error})`);
  assert.equal(o.bridge_name, 'ATL-101', 'client code + the store’s order number');
  const b = shop(BRIDGE_HOST).orders.get(o.bridge_id!)!;
  const inp = b.input as any;
  assert.equal(inp.email, undefined, 'no customer email on the bridge order');
  assert.equal(inp.shippingAddress.address1, '5 Avenue Foch');
  assert.equal(inp.shippingAddress.address2, 'Apt 3');
  assert.equal(inp.shippingAddress.lastName, 'Durand');
  assert.equal(inp.options.sendReceipt, false);
  assert.equal(inp.options.sendFulfillmentReceipt, false);
  assert.equal(inp.transactions[0].status, 'SUCCESS');
  assert.deepEqual([...shop(BRIDGE_HOST).variants.keys()].sort(), ['ATL-001', 'ATL-002'], 'SKUs that already start with the code are not prefixed twice');
  // Calling again changes nothing (no second bridge order).
  await afterOrderChange([id]);
  assert.equal(shop(BRIDGE_HOST).orders.size, 1);
});

test('back: partner pauses → on hold here and in the client store; partner resumes → released in both', async () => {
  const { data } = await db().from('orders').select('id, external_id, bridge_id').eq('bridge_name', 'ATL-101').single();
  const b = shop(BRIDGE_HOST).orders.get(data!.bridge_id!)!;
  const bridge = (await loadBridge())!;
  b.fos[0].status = 'ON_HOLD';
  const changed = await applyBridgeOrder(bridge, b.id);
  assert.equal(changed, data!.id);
  await afterOrderChange([changed!]);
  assert.equal((await order(data!.id)).hold_kind, 'partner');
  assert.equal(clientOrder(data!.external_id!).fos[0].status, 'ON_HOLD', 'client store held');
  // Our own hold must not be sent back to the bridge as a new hold (no loop): the bridge FO is still just ON_HOLD.
  b.fos[0].status = 'OPEN';
  await afterOrderChange([(await applyBridgeOrder(bridge, b.id))!]);
  assert.equal((await order(data!.id)).status, 'new');
  assert.equal(clientOrder(data!.external_id!).fos[0].status, 'OPEN', 'client store released');
});

test('back: partner ships with tracking → shipped here, client store fulfilled with the tracking, order paid from the balance', async () => {
  const { data } = await db().from('orders').select('id, external_id, bridge_id').eq('bridge_name', 'ATL-101').single();
  const before = (await balanceOf(ATLAS)).balance;
  const b = shop(BRIDGE_HOST).orders.get(data!.bridge_id!)!;
  b.fos[0].status = 'CLOSED';
  b.fulfillments.push({ id: 'gid://shopify/Fulfillment/b1', status: 'SUCCESS', displayStatus: 'IN_TRANSIT', createdAt: new Date().toISOString(), trackingInfo: [{ company: 'YunExpress', number: 'YT2611120001', url: null }], events: [] });
  await afterOrderChange([(await applyBridgeOrder((await loadBridge())!, b.id))!]);
  const o = await order(data!.id);
  assert.equal(o.status, 'shipped');
  assert.equal(o.tracking, 'YT2611120001');
  assert.equal(o.carrier, 'YunExpress');
  assert.equal(o.shipment_status, 'IN_TRANSIT');
  const c = clientOrder(data!.external_id!);
  assert.equal(c.fulfillments.length, 1);
  assert.equal(c.fulfillments[0].trackingInfo[0].number, 'YT2611120001');
  assert.match(String(c.fulfillments[0].trackingInfo[0].url), /yuntrack\.com/, 'the customer gets the carrier’s own page');
  assert.ok(c.fulfillments[0].events.includes('IN_TRANSIT'), 'journey shown in the client store');
  const after = (await balanceOf(ATLAS)).balance;
  assert.ok(after < before, `charged (${before} → ${after})`);
  const { count } = await db().from('wallet_entries').select('id', { count: 'exact', head: true }).eq('order_id', data!.id).eq('kind', 'charge');
  assert.equal(count, 1);
  // The same news again: no second charge, no second fulfilment.
  await afterOrderChange([data!.id]);
  assert.equal(c.fulfillments.length, 1);
  assert.equal((await db().from('wallet_entries').select('id', { count: 'exact', head: true }).eq('order_id', data!.id)).count, 1);
});

test('back: delivered → delivered here and in the client store', async () => {
  const { data } = await db().from('orders').select('id, external_id, bridge_id').eq('bridge_name', 'ATL-101').single();
  const b = shop(BRIDGE_HOST).orders.get(data!.bridge_id!)!;
  b.fulfillments[0].displayStatus = 'DELIVERED';
  await afterOrderChange([(await applyBridgeOrder((await loadBridge())!, b.id))!]);
  assert.equal((await order(data!.id)).status, 'delivered');
  assert.ok(clientOrder(data!.external_id!).fulfillments[0].events.includes('DELIVERED'));
});

test('balance: too low → the order waits and is NOT sent to the warehouse; a confirmed top-up releases and sends it', async () => {
  // The balance runs dry.
  const { balance } = await balanceOf(ATLAS);
  await db().from('wallet_entries').insert({ org_id: ATLAS, kind: 'adjust', amount: -(balance + 100), currency: 'EUR', note: 'test: empty the balance' });
  const { id } = await newStoreOrder(2, [[P1, 3]]);
  await afterOrderChange([id]);
  let o = await order(id);
  assert.equal(o.hold_kind, 'balance');
  assert.equal(o.bridge_id, null, 'never sent while unpaid');
  const { data: top } = await db().from('wallet_entries').insert({ org_id: ATLAS, kind: 'topup', amount: 5000, currency: 'EUR', status: 'pending', ref: 'ATL-TOP-TEST' }).select('id').single();
  const r = await decideTopup(top!.id, true, (await db().from('memberships').select('user_id').limit(1).single()).data!.user_id);
  assert.ok('released' in r && r.released!.includes(id));
  await afterOrderChange(r.released!);
  o = await order(id);
  assert.equal(o.status, 'new');
  assert.ok(o.bridge_id, 'sent after the top-up');
});

test('cancel here → cancelled at the bridge store (never refunded there) and in the client store (refund as chosen)', async () => {
  const { data } = await db().from('orders').select('id, external_id, bridge_id').eq('store_ref', '#102').single();
  await db().from('orders').update({ status: 'cancelled', cancel_refund: true }).eq('id', data!.id);
  await afterOrderChange([data!.id]);
  const b = shop(BRIDGE_HOST).orders.get(data!.bridge_id!)!;
  assert.ok(b.cancelledAt);
  assert.equal(b.cancelRefund, false);
  const c = clientOrder(data!.external_id!);
  assert.ok(c.cancelledAt);
  assert.equal(c.cancelRefund, true);
});

test('a client without a code never goes through the bridge', async () => {
  const { data: o } = await db().from('orders').insert({ org_id: '22222222-2222-2222-2222-222222222222', customer: 'X', address: '1 Road', country: 'GB', status: 'new' }).select('id').single();
  await afterOrderChange([o!.id]);
  assert.equal((await order(o!.id)).bridge_id, null);
});

test('products: photos come from the client store into Elmamsflow, then go to the bridge store (new and existing products)', async () => {
  const { data: prods } = await db().from('products').select('id, sku, photo_path, ext_ref').eq('org_id', ATLAS).eq('kind', 'item');
  const keep = new Map((prods ?? []).map((p) => [p.id, p.photo_path]));
  await db().from('products').update({ photo_path: null }).eq('org_id', ATLAS);
  for (const p of prods ?? []) storeList.push({ id: p.ext_ref ?? `gid://shopify/ProductVariant/9${p.id.slice(-4)}`, sku: p.sku, image: `https://${PHOTO_HOST}/${p.sku}.png` });
  try {
    const r = await syncClientProducts(ATLAS);
    assert.ok(!('error' in r), JSON.stringify(r));
    assert.deepEqual(r.errors, []);
    const { data: after } = await db().from('products').select('id, photo_path, bridge_ref').eq('org_id', ATLAS).eq('kind', 'item');
    for (const p of after ?? []) {
      assert.match(p.photo_path ?? '', new RegExp(`^${ATLAS}/${p.id}/.+-store\\.png$`), 'photo saved in Elmamsflow');
      const files = shop(BRIDGE_HOST).files.get(p.bridge_ref!) ?? [];
      assert.equal(files.length, 1, `one photo in the bridge store for ${p.id}`);
    }
    // Run again: nothing is added twice.
    await syncClientProducts(ATLAS);
    for (const p of after ?? []) assert.equal((shop(BRIDGE_HOST).files.get(p.bridge_ref!) ?? []).length, 1);
  } finally {
    for (const [id, path] of keep) await db().from('products').update({ photo_path: path }).eq('id', id);
  }
});
