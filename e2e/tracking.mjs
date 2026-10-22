// End-to-end check of live tracking against the LOCAL stack + fake 17TRACK (never production).
// 1) a signed webhook updates an order, 2) an unsigned/forged one is refused, 3) Delivered closes the order,
// 4) the daily sync registers parcels and pulls their status.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error('local only');
const key = process.env.TRACK17_API_KEY;
const sql = (q) => execFileSync('psql', ['-X', '-At', '-d', process.env.LOCAL_DB ?? 'elm_local', '-c', q], { encoding: 'utf8' }).trim();
const sign = (body) => createHash('sha256').update(`${body}/${key}`).digest('hex');
const push = async (payload, signature) => {
  const body = JSON.stringify(payload);
  const r = await fetch(`${BASE}/api/tracking/17track`, { method: 'POST', headers: { 'content-type': 'application/json', sign: signature ?? sign(body) }, body });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const [id, number] = sql("select id || '|' || tracking from orders where status = 'shipped' and tracking is not null order by number limit 1").split('|');
const info = (status, desc, at) => ({ latest_status: { status }, latest_event: { time_utc: at, description: desc, location: 'Paris, FR' }, tracking: { providers: [{ events: [{ time_utc: at, description: desc, location: 'Paris, FR' }] }] } });

let r = await push({ event: 'TRACKING_UPDATED', data: { number, tag: id, carrier: 190008, track_info: info('InTransit', 'Arrived at sorting center', '2030-01-01T10:00:00Z') } });
assert.equal(r.status, 200); assert.equal(r.json.applied, 1);
assert.equal(sql(`select tracking_status || '|' || tracking_last_event from orders where id = '${id}'`), 'InTransit|Arrived at sorting center');
console.log('ok  signed webhook updates the order');

r = await push({ event: 'TRACKING_UPDATED', data: { number, tag: id, track_info: info('Delivered', 'Forged', '2030-01-02T10:00:00Z') } }, 'a'.repeat(64));
assert.equal(r.status, 401);
assert.equal(sql(`select status from orders where id = '${id}'`), 'shipped');
console.log('ok  forged webhook refused (401), order unchanged');

r = await push({ event: 'TRACKING_UPDATED', data: { number, tag: id, track_info: info('Delivered', 'Delivered to recipient', '2030-01-03T10:00:00Z') } });
assert.equal(r.status, 200);
assert.equal(sql(`select status from orders where id = '${id}'`), 'delivered');
console.log('ok  carrier Delivered closes the order automatically');

// Sync: one parcel with a bad number, the rest valid.
sql("update orders set tracking_registered_at = null, tracking_checked_at = null where id in (select id from orders where status = 'shipped' and tracking is not null order by number desc limit 3)");
sql("update orders set tracking = 'BAD-' || number where id = (select id from orders where status = 'shipped' and tracking is not null order by number limit 1)");
const res = await fetch(`${BASE}/api/cron/tracking`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
const j = await res.json();
assert.equal(res.status, 200, JSON.stringify(j));
assert.ok(j.registered > 0 && j.rejected === 1, JSON.stringify(j));
console.log(`ok  daily sync registered ${j.registered}, rejected ${j.rejected} (bad number flagged)`);
const res2 = await fetch(`${BASE}/api/cron/tracking`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
const j2 = await res2.json();
assert.equal(res2.status, 200);
console.log(`ok  second sync: ${j2.registered} new, ${j2.refreshed} refreshed`);
assert.ok(Number(sql("select count(*) from orders where tracking_error is not null")) === 1);
assert.equal((await fetch(`${BASE}/api/cron/tracking`)).status, 401);
console.log('ok  sync refuses calls without the cron secret');
