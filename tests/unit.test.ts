// Unit tests for pure logic (no database): run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { applyTab, flag, ordersHref, parseFilters, storeAdminUrl } from '../src/lib/orders-query';
import { withMsg } from '../src/lib/format';
import { hmacOk, open, seal } from '../src/lib/integrations/crypto';
import { roleCan, type RoleDef } from '../src/lib/roles';

test('orders filters: unknown values are dropped, not passed to the database', () => {
  const f = parseFilters({ s: 'hacked', t: 'nope', field: 'password', q: 'a,b(c)*%', country: 'FRA', from: '2026-13-99x', per: '9999', p: '-4', c: 'x' }, true);
  assert.equal(f.s, '');
  assert.equal(f.t, '');
  assert.equal(f.field, 'order');
  assert.equal(f.q, 'a b c');           // PostgREST filter syntax characters removed
  assert.equal(f.country, '');
  assert.equal(f.from, '');
  assert.equal(f.per, 25);
  assert.equal(f.p, 1);
  assert.equal(f.c, '');
});

test('orders filters: a client can never filter by another client id', () => {
  const f = parseFilters({ c: '22222222-2222-2222-2222-222222222222' }, false);
  assert.equal(f.c, '');
});

test('orders links keep filters and drop defaults', () => {
  const f = parseFilters({ t: 'address', q: 'EM-1', per: '50', p: '3' }, false);
  assert.equal(ordersHref(f), '/orders?t=address&q=EM-1&per=50&p=3');
  assert.equal(ordersHref(f, { p: 1 }), '/orders?t=address&q=EM-1&per=50');
});

test('problem tabs map to on-hold + kind', () => {
  const calls: [string, string][] = [];
  const q = { eq(c: string, v: string) { calls.push([c, v]); return q; } };
  applyTab(q, parseFilters({ t: 'customs' }, false));
  assert.deepEqual(calls, [['status', 'on_hold'], ['hold_kind', 'customs']]);
});

test('store admin links', () => {
  assert.equal(storeAdminUrl('shopify', 'abc.myshopify.com', 'gid://shopify/Order/123'), 'https://admin.shopify.com/store/abc/orders/123');
  assert.equal(storeAdminUrl('woocommerce', 'https://shop.example', '77'), 'https://shop.example/wp-admin/post.php?post=77&action=edit');
  assert.equal(storeAdminUrl(null, null, null), null);
});

test('country flags', () => {
  assert.equal(flag('FR'), '🇫🇷');
  assert.equal(flag('XX'), '');
  assert.equal(flag('fr'), '');
});

test('messages in redirects keep the page hash', () => {
  assert.equal(withMsg('/team#roles', 'Saved'), '/team?ok=Saved#roles');
});

test('store credentials: encrypted, and tampering is detected', () => {
  process.env.INTEGRATIONS_KEY = 'unit-test-key';
  const sealed = seal({ token: 'secret-value' });
  assert.ok(!sealed.includes('secret-value'));
  assert.deepEqual(open(sealed), { token: 'secret-value' });
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => open(parts.join('.')));
});

test('webhook signatures: only the exact HMAC of the exact body passes', () => {
  const body = '{"id":1}';
  const good = createHmac('sha256', 's3cret').update(body).digest('base64');
  assert.equal(hmacOk('s3cret', body, good), true);
  assert.equal(hmacOk('s3cret', body + ' ', good), false);
  assert.equal(hmacOk('other', body, good), false);
  assert.equal(hmacOk('s3cret', body, null), false);
  assert.equal(hmacOk('s3cret', body, 'short'), false);
});

test('roles: locked roles have everything, others only what is ticked; client roles never get staff permissions', () => {
  const admin = { key: 'admin', label: 'Admin', perms: [], locked: true, system: true, position: 1 } as unknown as RoleDef;
  const ops = { key: 'ops', label: 'Ops', perms: ['orders.create'], locked: false, system: false, position: 2 } as unknown as RoleDef;
  assert.equal(roleCan(admin, 'orders.create', false), true);
  assert.equal(roleCan(ops, 'orders.create', false), true);
  assert.equal(roleCan(ops, 'products.edit', false), false);
  assert.equal(roleCan(admin, 'billing.manage', false), false);
});

test('flat-rate fallback weight: every parcel rounded UP to the full kg', async () => {
  const { billableKg } = await import('../src/lib/billing');
  assert.deepEqual(billableKg([300]), { kg: 1, unknown: 0, actualKg: 0.3 });
  assert.deepEqual(billableKg([1000]), { kg: 1, unknown: 0, actualKg: 1 });
  assert.deepEqual(billableKg([1001]), { kg: 2, unknown: 0, actualKg: 1.001 });
  // Three 300 g parcels are 3 kg billed, not 0.9 kg.
  assert.equal(billableKg([300, 300, 300]).kg, 3);
  // A parcel with no weight is reported, never silently billed as 0.
  assert.deepEqual(billableKg([0, 2500]), { kg: 3, unknown: 1, actualKg: 2.5 });
});

test('CSV export: formulas from store data are neutralised, quotes escaped', async () => {
  const { csvCell } = await import('../src/lib/format');
  assert.equal(csvCell('=HYPERLINK("http://x","click")'), `"'=HYPERLINK(""http://x"",""click"")"`);
  assert.equal(csvCell('+33 6 12'), "'+33 6 12");
  assert.equal(csvCell(-5), '-5');            // real numbers stay numbers
  assert.equal(csvCell('Paris, FR'), '"Paris, FR"');
  assert.equal(csvCell(null), '');
});

test('cron: fails closed without a secret, never trusts the user agent, needs the exact bearer secret', async () => {
  const { cronAllowed } = await import('../src/lib/cron-auth');
  const secret = 'x'.repeat(40);
  assert.deepEqual(cronAllowed(null, ''), { ok: false, reason: 'not_configured' });
  assert.deepEqual(cronAllowed('Bearer short', 'short'), { ok: false, reason: 'not_configured' });
  assert.equal(cronAllowed(null, secret).ok, false);
  assert.equal(cronAllowed('vercel-cron/1.0', secret).ok, false);       // a user-agent value is not a credential
  assert.equal(cronAllowed(`Bearer ${secret}x`, secret).ok, false);
  assert.equal(cronAllowed(`bearer ${secret}`, secret).ok, false);
  assert.equal(cronAllowed('Bearer ', secret).ok, false);
  assert.deepEqual(cronAllowed(`Bearer ${secret}`, secret), { ok: true, reason: 'ok' });
});

test('invoice month: UTC by default, China time when chosen (EM-025)', async () => {
  const { monthBounds, lastMonth, ymOf } = await import('../src/lib/billing');
  const utc = monthBounds('2026-11', 'UTC');
  assert.equal(utc.start.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(utc.end.toISOString(), '2026-12-01T00:00:00.000Z');
  const cn = monthBounds('2026-11', 'Asia/Shanghai');
  assert.equal(cn.start.toISOString(), '2026-10-31T16:00:00.000Z'); // 1 Nov 00:00 in China
  // A parcel shipped 1 Nov 06:00 China time (31 Oct 22:00 UTC) is October in UTC, November in China time.
  const shipped = new Date('2026-10-31T22:00:00Z');
  assert.equal(ymOf(shipped, 'UTC'), '2026-10');
  assert.equal(ymOf(shipped, 'Asia/Shanghai'), '2026-11');
  assert.equal(lastMonth('Asia/Shanghai', new Date('2026-12-01T01:00:00Z')), '2026-11');
  assert.equal(lastMonth('UTC', new Date('2026-01-15T00:00:00Z')), '2025-12');
});

test('carrier links: the warehouse’s link first, then the carrier’s page, never 17track', async () => {
  const { trackingLink } = await import('../src/lib/carriers');
  assert.equal(trackingLink('YunExpress', 'YT123'), 'https://www.yuntrack.com/parcelTracking?id=YT123');
  assert.equal(trackingLink('4PX', 'AB 1'), 'https://track.4px.com/#/result/0/AB%201');
  assert.equal(trackingLink('YunExpress', 'YT1', 'https://t.yuntrack.com/x'), 'https://t.yuntrack.com/x');
  assert.equal(trackingLink('Other', 'ZZ9', 'https://t.17track.net/en#nums=ZZ9'), 'https://parcelsapp.com/en/tracking/ZZ9');
  assert.equal(trackingLink('YunExpress', 'YT1', 'javascript:alert(1)'), 'https://www.yuntrack.com/parcelTracking?id=YT1'); // only https links are kept
  assert.equal(trackingLink(null, null), null);
});

test('bridge: what the partner did in the bridge store becomes our status', async () => {
  const { readBridgeState } = await import('../src/lib/integrations/bridge');
  const base = { id: 'gid://shopify/Order/1', cancelledAt: null, fulfillmentOrders: { nodes: [{ status: 'OPEN' }] }, fulfillments: [] };
  assert.equal(readBridgeState(base).status, 'new');
  assert.equal(readBridgeState({ ...base, fulfillmentOrders: { nodes: [{ status: 'ON_HOLD' }] } }).status, 'on_hold');
  assert.equal(readBridgeState({ ...base, fulfillmentOrders: { nodes: [{ status: 'IN_PROGRESS' }] } }).status, 'packed');
  assert.equal(readBridgeState({ ...base, cancelledAt: '2026-11-12T00:00:00Z' }).status, 'cancelled');
  const shipped = readBridgeState({ ...base, fulfillmentOrders: { nodes: [{ status: 'CLOSED' }] }, fulfillments: [
    { status: 'CANCELLED', displayStatus: null, createdAt: '2026-11-10T00:00:00Z', trackingInfo: [{ company: 'Old', number: 'OLD1', url: null }] },
    { status: 'SUCCESS', displayStatus: 'IN_TRANSIT', createdAt: '2026-11-11T00:00:00Z', trackingInfo: [{ company: 'YunExpress', number: 'YT9', url: 'https://www.yuntrack.com/parcelTracking?id=YT9' }] },
  ] });
  assert.equal(shipped.status, 'shipped');
  assert.equal('tracking' in shipped && shipped.tracking, 'YT9');            // a cancelled fulfilment is ignored
  assert.equal('shipment' in shipped && shipped.shipment, 'IN_TRANSIT');
  const done = readBridgeState({ ...base, fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', createdAt: '2026-11-11T00:00:00Z', trackingInfo: [{ company: 'X', number: 'N1', url: null }] }] });
  assert.equal(done.status, 'delivered');
  const odd = readBridgeState({ ...base, fulfillments: [{ status: 'SUCCESS', displayStatus: 'DROP TABLE', createdAt: '2026-11-11T00:00:00Z', trackingInfo: [] }] });
  assert.equal('shipment' in odd && odd.shipment, null);                       // unknown journey values never stored
  assert.equal(readBridgeState({ ...base, fulfillmentOrders: { nodes: [{ status: 'CANCELLED' }] } }).status, 'cancelled');
});

test('prepaid: what one order costs at the client’s prices (shipping = the order’s line price)', async () => {
  const { orderCharge } = await import('../src/lib/wallet');
  const rates = { org_id: 'x', currency: 'USD' as const, pick_pack_order: 1.2, pick_pack_extra_unit: 0.3, packaging_order: 0.5, shipping_base: 2, shipping_per_kg: 6.5, ddp_order: 1, receiving_carton: 0, receiving_unit: 0, storage_unit_month: 0, monthly_minimum: 0, payment_terms_days: 14 };
  const o = { id: 'o', number: '1', org_id: 'x', service: 'ddp', country: 'FR', weight_g: 0, order_items: [{ qty: 2, products: { weight_g: 450 } }, { qty: 1, products: { weight_g: 300 } }] };
  const ship = { price: 9.87, kg: 1.2, line_id: 'l', line: 'Standard', flat: false };
  const c = orderCharge(o, rates, ship);
  // 3 units: 1.2 + 2×0.3 + 0.5 + 9.87 (line price, to the gram) + 1 = 13.17 — the flat rate card shipping is not used
  assert.equal(c.kg, 1.2);
  assert.equal(c.amount, 13.17);
  assert.equal(orderCharge({ ...o, service: 'express' }, rates, ship).amount, 12.17);
  assert.equal(orderCharge(o, rates, null).amount, 3.3);                       // no shipping price → shipping not included
});

test('order shipping: product type, parcel and flat fallback', async () => {
  const { flatShipping, orderParcel, orderShipType } = await import('../src/lib/shipping-rates');
  const it = (ship_type: string, weight_g = 100, qty = 1) => ({ qty, products: { weight_g, ship_type } });
  assert.equal(orderShipType([it('general'), it('battery')]), 'battery');
  assert.equal(orderShipType([it('cosmetics'), it('clothing')]), 'cosmetics');
  assert.equal(orderShipType([it('clothing'), it('clothing')]), 'clothing');
  assert.equal(orderShipType([it('clothing'), it('general')]), 'general');
  assert.equal(orderShipType([it('nonsense')]), 'general');
  assert.deepEqual(orderParcel({ weight_g: 0, order_items: [it('general', 450, 2), it('general', 300)] }), { weight_g: 1200 });
  assert.deepEqual(orderParcel({ weight_g: 950, order_items: [it('general', 450, 2)] }), { weight_g: 950 });   // the weighed parcel wins
  const sized = { qty: 2, products: { weight_g: 130, length_mm: 170, width_mm: 70, height_mm: 40 } };
  assert.deepEqual(orderParcel({ weight_g: 0, order_items: [sized] }), { weight_g: 130, qty: 2, length_mm: 170, width_mm: 70, height_mm: 40 });
  assert.deepEqual(flatShipping(300, 2, 6.5), { kg: 1, price: 8.5 });           // fallback only: per parcel + per full kg
  assert.deepEqual(flatShipping(0, 2, 6.5), { kg: 0, price: 2 });
});

test('orders CSV: rows group into orders, countries resolve, bad rows are flagged', async () => {
  const { groupOrders, parseCsv, resolveCountry } = await import('../src/lib/csv');
  assert.equal(resolveCountry('france'), 'FR');
  assert.equal(resolveCountry('de'), 'DE');
  assert.equal(resolveCountry('UK'), 'GB');
  assert.equal(resolveCountry('Narnia'), '');
  const csv = 'Order;Customer;Address;City;Country;SKU;Qty\n#1042;Camille;12 Rue;Paris;France;lemon;2\n1042;Camille;12 Rue;Paris;France;LEMON;1\n1042;Camille;12 Rue;Paris;France;BERRY;1\n1043;;Hauptstr 5;Berlin;Narnia;NOPE;0\n';
  const orders = groupOrders(parseCsv(csv).rows, new Set(['LEMON', 'BERRY']));
  assert.equal(orders.length, 2);
  assert.deepEqual(orders[0].lines, [{ sku: 'LEMON', qty: 3 }, { sku: 'BERRY', qty: 1 }]); // same SKU summed, "#" dropped
  assert.equal(orders[0].ref, '1042');
  assert.equal(orders[0].country, 'FR');
  assert.equal(orders[0].errors.length, 0);
  assert.ok(orders[1].errors.some((e) => /Customer missing/.test(e)));
  assert.ok(orders[1].errors.some((e) => /Unknown country/.test(e)));
  assert.ok(orders[1].errors.some((e) => /NOPE is not one of your products/.test(e)));
  assert.ok(orders[1].errors.some((e) => /quantity/.test(e)));
});

test('B2B: line amounts, % lines on the lines above, TVA and discount', async () => {
  const { totals } = await import('../src/lib/b2b');
  // The Devis sample: tiles in Yuan, freight in $, duties as %, forwarder flat, delivery, 5% commission on everything above
  const t = totals([
    { kind: 'goods', description: 'Carrelage', qty: 1200, unit_price: 112, price_currency: 'CNY', rate: 1.4, pct: null },
    { kind: 'freight', description: 'Fret', qty: 1, unit_price: 4800, price_currency: 'USD', rate: 10, pct: null },
    { kind: 'customs', description: 'Douanes', qty: null, unit_price: null, rate: 1, pct: 20 },
    { kind: 'forwarder', description: 'Transitaire', qty: null, unit_price: 3500, price_currency: 'MAD', rate: 1, pct: null },
    { kind: 'delivery', description: 'Livraison', qty: 1, unit_price: 4000, price_currency: 'MAD', rate: 1, pct: null },
  ], 0, 0);
  assert.deepEqual(t.amounts, [188160, 48000, 47232, 3500, 4000]);
  assert.equal(t.ht, 290892);
  const v = totals([{ kind: 'goods', description: 'x', qty: 3, unit_price: 10.005, rate: 1, pct: null }], 20, 5);
  assert.equal(v.ht, 30.02);
  assert.equal(v.tva, 6);
  assert.equal(v.ttc, 31.02);
});

test('B2B: amounts in French and English words, document numbers', async () => {
  const { amountFr, amountEn, frWords, docNumber, numMa } = await import('../src/lib/b2b');
  assert.equal(amountFr(3720, 'MAD'), 'Trois mille sept cent vingt dirhams');
  assert.equal(amountFr(48300, 'USD'), 'Quarante-huit mille trois cents dollars américains');
  assert.equal(amountFr(300300, 'MAD'), 'Trois cent mille trois cents dirhams');
  assert.equal(amountFr(1, 'EUR'), 'Un euro');
  assert.equal(amountFr(71.5, 'MAD'), 'Soixante-et-onze dirhams et cinquante centimes');
  assert.equal(frWords(80), 'quatre-vingts');
  assert.equal(frWords(80000), 'quatre-vingt mille');
  assert.equal(frWords(200000000), 'deux cents millions');
  assert.equal(frWords(91), 'quatre-vingt-onze');
  assert.equal(frWords(21), 'vingt-et-un');
  assert.equal(amountEn(31800, 'USD'), 'Thirty-one thousand eight hundred US dollars');
  assert.equal(amountEn(26250.05, 'EUR'), 'Twenty-six thousand two hundred fifty euros and five cents');
  assert.equal(docNumber('facture', 113, '2024-11-04'), '0113/11/2024');
  assert.equal(docNumber('invoice', 57, '2026-09-30'), 'B2B-INV-0057');
  assert.equal(docNumber('order', 31, '2026-09-30'), 'B2B-0031');
  assert.equal(numMa(1234567.5), '1 234 567.50');
});

// ---------- Shipping rates (partner sheet → client price) ----------
import { bracket, chargeableKg, countryCode, parseSheet, quoteAll, transitLabel, withMargin } from '../src/lib/shipping-rates';

const L = { id: 'l1', name: 'Standard' };
const SHEET = [
  '\t\t\t2026.11.9\t\t\t\t\t\tCalculation Column',
  '国家/地区\tCountry/Region\tReference Timeframe\tSubregion\tWeight(KG)\tWeight Increment\tMinimum Billing Weight\tShipping Fee(USD/KG)\tProcessing fee (USD/Package)\tProduct Weight(KG)\tTotal Shipping Cost(USD)',
  '美国\tUnited States\t6-12 work days\t\t0<W≤0.1\t\t0.03\t20.86\t5.06\t\t5.06',
  '美国\tUnited States\t6-12 work days\t\t0.1<W≤0.2\t\t0.03\t19.94\t4.75\t\t4.75',
  '美国\tUnited States\t6-12 work days\t\t0.2<W≤0.3\t\t0.03\t19.63\t4.45\t\t4.45',
  '\t\t\t\t0.3<W≤0.45\t\t0.03\t19.48\t4.45\t\t4.45',
  '英国\tUnited Kingdom\t6-10 work days\t\t0<W≤0.3\t\t\t8.59\t3.99\t\t3.99',
  '英国\tUnited Kingdom\t6-10 work days\t\t0.3<W≤0.5\t\t\t8.90\t3.99\t\t3.99',
  '德国\tGermany\t6-10 work days\t\t0<W≤0.1\t\t\t9.97\t11.21\t\t11.21',
  '火星\tMars\t1 day\t\t0<W≤1\t\t\t1\t1\t\t1',
].join('\n');

test('shipping sheet: date, countries, brackets and merged rows are read from a copy-paste', () => {
  const p = parseSheet(SHEET);
  assert.equal(p.dated, '2026-11-09');
  assert.deepEqual(p.unknown, ['Mars']);
  assert.equal(p.rows.length, 7);
  assert.deepEqual(p.rows[0], { country: 'US', subregion: null, transit: '6-12 work days', carrier: null, w_min: 0, w_max: 0.1, per_kg: 20.86, per_parcel: 5.06, min_kg: 0.03, step_kg: 0 });
  assert.equal(p.rows[3].country, 'US', 'a row with an empty country belongs to the one above');
  assert.equal(p.rows[3].transit, '6-12 work days');
  assert.equal(p.rows[4].country, 'GB');
  assert.equal(p.rows[6].country, 'DE');
  assert.equal(parseSheet('hello\tworld').rows.length, 0);
});

test('shipping sheet: country names and weight brackets', () => {
  assert.equal(countryCode('United States'), 'US');
  assert.equal(countryCode('UK'), 'GB');
  assert.equal(countryCode('Czech Republic'), 'CZ');
  assert.equal(countryCode('Turkey'), 'TR');
  assert.equal(countryCode('France'), 'FR');
  assert.equal(countryCode('Atlantis'), null);
  assert.deepEqual(bracket('0.1<W≤0.2'), [0.1, 0.2]);
  assert.deepEqual(bracket('2 < W ≤ 30'), [2, 30]);
  assert.deepEqual(bracket('W≤0.5'), [0, 0.5]);
  assert.equal(bracket('n/a'), null);
  assert.equal(transitLabel('6-12 work days'), '6–12 business days');
});

test('shipping price: weight + packaging, volumetric when bigger, bracket, margin', () => {
  const s = { margin_pct: 20, margin_fixed: 0, packaging_g: 150, volume_factor: 8000, remind_days: 7 };
  const rows = parseSheet(SHEET).rows;
  // 150 g + 150 g packaging = 0.3 kg → US bracket 0.2–0.3: 0.3 × 19.63 + 4.45 = 10.339 → +20% = 12.41
  const us = quoteAll([{ line: L, rows }], 'US', { weight_g: 150 }, s, { pct: 20, fixed: 0 });
  assert.equal(us.length, 1);
  assert.equal(us[0].kg, 0.3);
  assert.equal(us[0].cost, 10.34);
  assert.equal(us[0].price, 12.41);
  assert.equal(us[0].transit, '6-12 work days');
  // UK, fixed margin added on top: 0.3 × 8.59 + 3.99 = 6.567 → ×1.2 + 1.5 = 9.38
  assert.equal(quoteAll([{ line: L, rows }], 'GB', { weight_g: 150 }, s, { pct: 20, fixed: 1.5 })[0].price, 9.38);
  // A big light box is billed on its size: 20 × 20 × 8 cm ÷ 8000 = 0.4 kg (more than 0.3 kg actual)
  const big = chargeableKg({ weight_g: 150, length_mm: 200, width_mm: 200, height_mm: 80 }, s);
  assert.equal(big.kg, 0.4);
  assert.equal(big.actual, 0.3);
  // 3 units in one parcel: 450 g + 150 g = 0.6 kg → too heavy for the UK rows above (max 0.5) → no price
  assert.equal(quoteAll([{ line: L, rows }], 'GB', { weight_g: 150, qty: 3 }, s, { pct: 0, fixed: 0 }).length, 0);
  // A country that isn't in the sheet → no price (never a made-up one)
  assert.equal(quoteAll([{ line: L, rows }], 'JP', { weight_g: 150 }, s, { pct: 0, fixed: 0 }).length, 0);
  // Minimum billing weight applies to tiny parcels
  assert.equal(chargeableKg({ weight_g: 5 }, { packaging_g: 0, volume_factor: 8000 }, 0.03).kg, 0.03);
  assert.equal(withMargin(10, { pct: 0, fixed: 0 }), 10);
});

test('shipping sheet: quoted multi-line cells, weight steps and a second table priced per 0.5 kg (Japan)', () => {
  const text = [
    '\t\t2026.11.9',
    '国家/地区\tCountry/Region\tReference Timeframe\tSubregion\tWeight(KG)\tWeight Increment\tMinimum Billing Weight\tShipping Fee(USD/KG)\tProcessing fee (USD/Package)',
    '尼日利亚\tNigeria\t"8-12 work days\nLagos 6-8"\t\t0＜W≤0.5\t0.5\t\t10\t2',
    '澳大利亚\tAustralia\t7-12 work days\tZone 1\t0＜W≤1\t\t\t8\t5',
    '澳大利亚\tAustralia\t7-12 work days\tZone 4\t0＜W≤1\t\t\t9\t20',
    '国家/地区\tCountry/Region\tReference time limit\tSubregion\tWeight(KG)\tWeight Increment\tMinimum Billing Weight\tShipping Fee(USD/0.5KG)\tincrease price',
    '日本\tJapan\t6-7 work days\t\t0＜W≤2\t0.5\t\t5.21\t2.30',
  ].join('\n');
  const p = parseSheet(text);
  assert.deepEqual(p.unknown, []);
  assert.equal(p.rows.length, 4);
  assert.equal(p.rows[0].transit, '8-12 work days', 'only the first line of a multi-line cell');
  assert.equal(p.rows[0].step_kg, 0.5);
  const jp = p.rows[3];
  assert.equal(jp.country, 'JP');
  assert.equal(jp.step_kg, 0.5);
  const s = { margin_pct: 0, margin_fixed: 0, packaging_g: 150, volume_factor: 8000, remind_days: 7 };
  const q = (cc: string, g: number) => quoteAll([{ line: L, rows: p.rows }], cc, { weight_g: g }, s, { pct: 0, fixed: 0 })[0];
  // Japan: 0.3 kg → one 0.5 kg step = 5.21; 0.7 kg → two steps = 5.21 + 2.30
  assert.equal(q('JP', 150).price, 5.21);
  assert.equal(q('JP', 550).price, 7.51);
  assert.equal(q('JP', 550).kg, 1);
  // Nigeria: 0.3 kg rounded up to the 0.5 kg step: 0.5 × 10 + 2
  assert.equal(q('NG', 150).price, 7);
  // Australia by zone: without the postcode we take the dearest zone (never under-charge)
  assert.equal(q('AU', 150).price, 22.7);
});

test('shipping sheet: the last-mile carrier column (Evri, DHL, USPS…) is read and shown with the price', () => {
  const text = [
    '\t\t\t2026.11.16',
    '国家/地区\tCountry/Region\tReference Timeframe\tLast-mile service provider\tWeight(KG)\tWeight Increment\tMinimum Billing Weight\tShipping Fee(USD/KG)\tProcessing fee (USD/Package)',
    '英国\tUnited Kingdom\t3-5 work days\tEvri\t0＜W≤0.3\t\t\t10.28\t3.99',
    '德国\tGermany\t4-6 work days\tDHL\t0＜W≤0.2\t\t\t12.73\t11.83',
    '国家/地区\tCountry/Region\tReference time limit\tLast-mile service provider\tWeight(KG)\tWeight Increment\tMinimum Billing Weight\tShipping Fee(USD/0.5KG)\tincrease price',
    '日本\tJapan\t6-7 work days\tSagawa\t0＜W≤2\t0.5\t0.5\t5.52\t2.30',
  ].join('\n');
  const p = parseSheet(text);
  assert.deepEqual(p.rows.map((r) => [r.country, r.carrier, r.transit]), [['GB', 'Evri', '3-5 work days'], ['DE', 'DHL', '4-6 work days'], ['JP', 'Sagawa', '6-7 work days']]);
  const s = { margin_pct: 0, margin_fixed: 0, packaging_g: 150, volume_factor: 8000, remind_days: 7 };
  const express = { id: 'x', name: 'Express' }, standard = { id: 's', name: 'Standard' };
  const std = parseSheet(SHEET).rows;
  const q = quoteAll([{ line: express, rows: p.rows }, { line: standard, rows: std }], 'GB', { weight_g: 150 }, s, { pct: 0, fixed: 0 });
  // Both lines ship to the UK: cheapest first, each with its carrier
  assert.deepEqual(q.map((l) => [l.label, l.carrier, l.price]), [['Standard', null, 6.57], ['Express', 'Evri', 7.07]]);
  assert.equal(q[1].transit, '3-5 work days');
  // Japan on the express line: one 0.5 kg step
  assert.equal(quoteAll([{ line: express, rows: p.rows }], 'JP', { weight_g: 150 }, s, { pct: 0, fixed: 0 })[0].price, 5.52);
});

// ---------- Shipping prices from one .xlsx (all tabs at once) ----------
import ExcelJS from 'exceljs';
import { readRateWorkbook } from '../src/lib/shipping-xlsx';
import { tabTarget } from '../src/lib/shipping-rates';

test('shipping workbook: each tab goes to its line and product type by name', () => {
  assert.deepEqual(tabTarget('1-standard general'), { line: 'standard', type: 'general' });
  assert.deepEqual(tabTarget('2- Standard Battery'), { line: 'standard', type: 'battery' });
  assert.deepEqual(tabTarget('4-Standard Cosmetics'), { line: 'standard', type: 'cosmetics' });
  assert.deepEqual(tabTarget('6-Priority Battery'), { line: 'priority', type: 'battery' });
  assert.deepEqual(tabTarget('7-Large General'), { line: 'large', type: 'general' });
  assert.deepEqual(tabTarget('10- US Remote Battery'), { line: 'us-remote', type: 'battery' });
  assert.deepEqual(tabTarget('11- Courier General'), { line: 'courier', type: 'general' });
  assert.deepEqual(tabTarget('13- Express General'), { line: 'express', type: 'general' });
  assert.equal(tabTarget('Sheet1'), null);
});

test('shipping workbook: an .xlsx with real dates, number cells and a Japan table is read like a paste', async () => {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet('1-standard general');
  a.addRow([new Date(Date.UTC(2026, 10, 23)), null, null, null, null, null, null, null, null, 'Calculation Column']);
  a.addRow(['国家/地区', 'Country/Region', 'Reference Timeframe', 'Subregion', 'Weight(KG)', 'Weight Increment', 'Minimum Billing Weight', 'Shipping Fee(USD/KG)', 'Processing fee (USD/Package)']);
  a.addRow(['美国', 'United States', '6-12 work days', null, '0＜W≤0.1', null, 0.03, 22.7, 5.06]);
  a.addRow(['英国', 'United Kingdom', '6-10 work days', null, '0＜W≤0.3', null, null, 10.28, 3.99]);
  const e = wb.addWorksheet('13- Express General');
  e.addRow([new Date(Date.UTC(2026, 10, 23))]);
  e.addRow(['国家/地区', 'Country/Region', 'Reference Timeframe', 'Last-mile service provider', 'Weight(KG)', 'Weight Increment', 'Minimum Billing Weight', 'Shipping Fee(USD/KG)', 'Processing fee (USD/Package)']);
  e.addRow(['英国', 'United Kingdom', '3-5 work days', 'Evri', '0＜W≤0.3', null, null, 11.35, 3.99]);
  e.addRow(['国家/地区', 'Country/Region', 'Reference time limit', 'Last-mile service provider', 'Weight(KG)', 'Weight Increment', 'Minimum Billing Weight', 'Shipping Fee(USD/0.5KG)', 'increase price']);
  e.addRow(['日本', 'Japan', '6-7 work days', 'Sagawa', '0＜W≤2', 0.5, 0.5, 5.52, 2.3]);
  wb.addWorksheet('Notes').addRow(['just a note']);
  const tabs = await readRateWorkbook(await wb.xlsx.writeBuffer() as ArrayBuffer);
  assert.deepEqual(tabs.map((t) => [t.name, t.line, t.type, t.parsed.rows.length]), [
    ['1-standard general', 'standard', 'general', 2], ['13- Express General', 'express', 'general', 2], ['Notes', null, null, 0]]);
  assert.equal(tabs[0].parsed.dated, '2026-11-23');
  assert.deepEqual(tabs[0].parsed.rows[0], { country: 'US', subregion: null, transit: '6-12 work days', carrier: null, w_min: 0, w_max: 0.1, per_kg: 22.7, per_parcel: 5.06, min_kg: 0.03, step_kg: 0 });
  assert.equal(tabs[1].parsed.rows[0].carrier, 'Evri');
  assert.equal(tabs[1].parsed.rows[1].step_kg, 0.5);
});
