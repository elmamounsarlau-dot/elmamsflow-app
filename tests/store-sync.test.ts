// Store address sync, against the LOCAL test stack only (npm run test:stack). Never production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncShipTo, type ExtOrder, type Integration } from '../src/lib/integrations/core';
import { supabaseAdmin } from '../src/lib/supabase/admin';

if (!/^http:\/\/127\.0\.0\.1/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')) throw new Error('local stack only');
const db = () => supabaseAdmin();
const I = { id: '1e000000-0000-0000-0000-000000000001', org_id: '11111111-1111-1111-1111-111111111111', kind: 'shopify' } as Integration;
const ext = (over: Partial<ExtOrder> = {}): ExtOrder => ({
  external_id: 'x', ref: '#1', customer: 'Camille Durand', email: 'c@example.com', phone: '+33 6 00 00 00 00',
  address: '5 Avenue Foch', city: 'Lyon', zip: '69006', country: 'FR', lines: [], shippable: true, cancelled: false, ...over,
});
const get = async (id: string) => (await db().from('orders').select('status, hold_kind, hold_reason, address, city, zip, country').eq('id', id).single()).data!;
const set = (id: string, patch: Record<string, unknown>) => db().from('orders').update(patch).eq('id', id);
const ORD = (n: number) => `0a000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

test('new order: a changed address in the store is applied, order stays ready', async () => {
  assert.equal(await syncShipTo(I, ORD(3), ext()), true);
  const o = await get(ORD(3));
  assert.deepEqual([o.status, o.address, o.city, o.zip, o.country], ['new', '5 Avenue Foch', 'Lyon', '69006', 'FR']);
  assert.equal(await syncShipTo(I, ORD(3), ext()), false, 'same data again changes nothing');
});

test('address hold: completing the address in the store releases the order by itself', async () => {
  await set(ORD(6), { status: 'on_hold', hold_reason: 'The shipping address is incomplete in the store', address: '—', city: null, zip: null, country: 'XX' });
  assert.equal((await get(ORD(6))).hold_kind, 'address');
  await syncShipTo(I, ORD(6), ext({ address: '', country: '' })); // only the contact details can change
  assert.equal((await get(ORD(6))).status, 'on_hold', 'still incomplete: stays on hold');
  assert.equal(await syncShipTo(I, ORD(6), ext({ address: '9 Kaiserstraße', city: 'Berlin', zip: '10115', country: 'DE' })), true);
  const o = await get(ORD(6));
  assert.deepEqual([o.status, o.hold_reason, o.address, o.country], ['new', null, '9 Kaiserstraße', 'DE']);
});

test('a store update without an address never wipes the address we have', async () => {
  assert.equal(await syncShipTo(I, ORD(3), ext({ address: '', city: null, zip: null, country: '' })), false);
  assert.equal((await get(ORD(3))).address, '5 Avenue Foch');
});

test('other holds stay: product hold keeps its reason, the address still updates', async () => {
  const before = await get(ORD(9));
  assert.equal(before.hold_kind, 'products');
  assert.equal(await syncShipTo(I, ORD(9), ext({ address: '1 Damrak', city: 'Amsterdam', country: 'NL' })), true);
  const o = await get(ORD(9));
  assert.deepEqual([o.status, o.hold_kind, o.address], ['on_hold', 'products', '1 Damrak']);
});

test('a hold set by a person stays when the address changes', async () => {
  await set(ORD(12), { status: 'on_hold', hold_reason: 'Customer asked to wait until Friday' });
  assert.equal(await syncShipTo(I, ORD(12), ext({ address: '7 Via Roma', city: 'Milano', country: 'IT' })), true);
  const o = await get(ORD(12));
  assert.deepEqual([o.status, o.hold_kind, o.address], ['on_hold', 'manual', '7 Via Roma']);
});

test('packed: not changed automatically, the team is warned to check the label', async () => {
  await set(ORD(15), { status: 'packed' });
  const before = await get(ORD(15));
  assert.equal(await syncShipTo(I, ORD(15), ext({ address: 'Somewhere else 1' })), false);
  assert.equal((await get(ORD(15))).address, before.address);
  const { data } = await db().from('activity_log').select('detail').eq('action', 'order_address_late').limit(1);
  assert.equal(data?.length, 1);
});

test('shipped: never changed', async () => {
  const before = await get(ORD(25));
  assert.equal(await syncShipTo(I, ORD(25), ext({ address: 'Too late 1' })), false);
  assert.equal((await get(ORD(25))).address, before.address);
});

test('with store lines: address fixed → the remaining product check decides (unknown SKU becomes a product hold)', async () => {
  await set(ORD(3), { status: 'on_hold', hold_reason: 'The shipping address is incomplete in the store', address: '—', country: 'XX',
    external_lines: [{ sku: 'ATL-001', qty: 1, name: 'Sheets' }, { sku: 'NOPE-1', qty: 1, name: 'Unknown' }] });
  assert.equal(await syncShipTo(I, ORD(3), ext({ address: '2 Rue Neuve', country: 'FR' })), true);
  let o = await get(ORD(3));
  assert.deepEqual([o.status, o.hold_kind], ['on_hold', 'products']);
  await set(ORD(3), { status: 'on_hold', hold_reason: 'The shipping address is incomplete in the store', address: '—', country: 'XX',
    external_lines: [{ sku: 'ATL-001', qty: 1, name: 'Sheets' }] });
  assert.equal(await syncShipTo(I, ORD(3), ext({ address: '2 Rue Neuve', country: 'FR' })), true);
  o = await get(ORD(3));
  assert.deepEqual([o.status, o.hold_reason], ['new', null]);
});
