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

test('shipping weight: every parcel is billed rounded UP to the full kg', async () => {
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

test('17TRACK: push signature must match the API key (raw body form and event/data form)', async () => {
  const { validSignature } = await import('../src/lib/track17');
  const { createHash } = await import('node:crypto');
  const key = 'test-17track-key-0123456789';
  const body = '{"event":"TRACKING_UPDATED","data":{"number":"YT1234567890","tag":"x"}}';
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  assert.equal(validSignature(body, sha(`${body}/${key}`), key), true);
  assert.equal(validSignature(body, sha(`TRACKING_UPDATED/{"number":"YT1234567890","tag":"x"}/${key}`), key), true);
  assert.equal(validSignature(body, sha(`${body}/wrong-key-0000000000`), key), false);
  assert.equal(validSignature(body.replace('YT', 'XX'), sha(`${body}/${key}`), key), false); // body changed after signing
  assert.equal(validSignature(body, null, key), false);
  assert.equal(validSignature(body, 'not-hex', key), false);
  assert.equal(validSignature(body, sha(`${body}/${key}`), null), false); // not configured → refuse
});

test('17TRACK: tracking info is normalised (status whitelist, newest event first, dates in UTC)', async () => {
  const { normalize } = await import('../src/lib/track17');
  const n = normalize({
    latest_status: { status: 'Delivered', sub_status: 'Delivered_Other' },
    latest_event: { time_utc: '2026-10-20T08:15:00Z', description: 'Delivered, in mailbox', location: 'Paris, FR' },
    time_metrics: { estimated_delivery_date: { from: '2026-10-19T00:00:00Z', to: '2026-10-21T00:00:00Z' } },
    tracking: { providers: [{ events: [
      { time_utc: '2026-10-15T02:00:00Z', description: 'Departed from Guangzhou', location: 'Guangzhou, CN' },
      { time_utc: '2026-10-20T08:15:00Z', description: 'Delivered, in mailbox', location: 'Paris, FR' },
      { time_utc: '2026-10-18T10:00:00Z', description: '   ' },
    ] }] },
  });
  assert.equal(n.status, 'Delivered');
  assert.equal(n.last_event, 'Delivered, in mailbox');
  assert.equal(n.last_event_at, '2026-10-20T08:15:00.000Z');
  assert.equal(n.eta, '2026-10-21');
  assert.equal(n.events.length, 2);                       // blank event dropped
  assert.equal(n.events[0].description, 'Delivered, in mailbox');
  assert.equal(normalize({ latest_status: { status: 'DROP TABLE' } }).status, null); // unknown status never stored
  assert.equal(normalize(null).events.length, 0);
});
