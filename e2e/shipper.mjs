// The Shipper role end to end, in the real UI (LOCAL stack + fake 17TRACK only):
// sees only shipping, cannot ship without tracking + label, uploads the label, the order goes in transit,
// tracking starts, and the label is visible to the team and the brand, never to another brand.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cookiesFor } from './session.mjs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error('local only');
const sql = (q) => execFileSync('psql', ['-X', '-At', '-d', process.env.LOCAL_DB ?? 'elm_local', '-c', q], { encoding: 'utf8' }).trim();
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let current = null;
process.on('uncaughtException', async (e) => {
  let where = '';
  try { if (current) where = ` || at ${current.url()} || ${String(await current.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 900)}`; } catch (x) { where = ` || (no page text: ${x?.message})`; }
  let log = '';
  try { const { readFileSync, existsSync } = await import('node:fs'); const f = process.env.APP_LOG ?? 'app.log'; if (existsSync(f)) log = ` || APP LOG: ${readFileSync(f, 'utf8').slice(-1500).replace(/\s+/g, ' ')}`; } catch { /* none */ }
  console.log(`::error title=shipper e2e::${String(e?.message ?? e).split('\n').slice(0, 2).join(' | ')} || NET: ${(globalThis.__net ?? []).join(' ; ')}${log.slice(0, 600)}`); process.exit(1);
});
process.on('unhandledRejection', (e) => { console.log(`::error title=shipper e2e::${String(e?.message ?? e).split('\n').slice(0, 6).join(' | ')}`); process.exit(1); });
// Full Chromium (new headless), not the stripped headless shell: the label file field needs a real browser.
const browser = await chromium.launch({ channel: 'chromium' });
const as = async (email) => { const c = await browser.newContext(); await c.addCookies(await cookiesFor(email, BASE)); return c.newPage(); };
const p = await as('shipper@local.test');
const net = []; globalThis.__net = net;
p.on('request', (r) => { if (r.method() === 'POST') net.push(`REQ ${r.url().replace(BASE, '')} ${r.headers()['content-type']?.slice(0, 30)}`); });
p.on('requestfinished', async (r) => { if (r.method() === 'POST') { const res = await r.response(); net.push(`DONE ${res?.status()} ${res?.headers()['x-action-redirect'] ?? ''}`); } });
p.on('requestfailed', (r) => { if (r.method() === 'POST') net.push(`FAIL ${r.failure()?.errorText}`); });
p.on('pageerror', (e) => net.push(`PAGEERR ${e.message.slice(0, 120)}`));
p.on('console', (m) => { if (m.type() === 'error') net.push(`CONSOLE ${m.text().slice(0, 160)}`); });
// Submit the ship form and wait for the server's answer (flash message in the address); on slow machines the first
// click can land before the page is interactive, so it is retried once.
const save = async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    await ready();
    const before = p.url();
    await p.click('#ship form button.ep-btn--full');
    try { await p.waitForURL((u) => u.toString() !== before && /[?&](ok|warn|err)=/.test(u.toString()), { timeout: 15000, waitUntil: 'commit' }); return; } catch { /* retry */ }
  }
  throw new Error('the ship form did not submit');
};
const ready = () => p.locator('#ship form button.ep-btn--full[data-ready="1"]').waitFor({ timeout: 30000 });
const openOrder = async (oid) => { await p.goto(`${BASE}/orders/${oid}`, { waitUntil: 'networkidle' }); await ready(); };
current = p;

await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
assert.equal(new URL(p.url()).pathname, '/shipping', 'shipper lands on the shipping queue');
const nav = (await p.locator('nav a').allInnerTexts()).map((t) => t.trim());
for (const hidden of ['Overview', 'Inventory', 'Clients', 'Invoices', 'Warehouses', 'Team']) assert.ok(!nav.includes(hidden), `${hidden} hidden for the shipper`);
for (const shown of ['Shipping', 'Orders', 'Tracking']) assert.ok(nav.includes(shown), `${shown} shown`);
for (const path of ['/inventory', '/invoices', '/clients', '/warehouses']) {
  await p.goto(BASE + path, { waitUntil: 'networkidle' });
  assert.equal(new URL(p.url()).pathname, '/shipping', `${path} sends the shipper back to shipping`);
}
console.log('ok  shipper sees only Shipping, Orders and Tracking');

const id = sql("select o.id from orders o join organizations g on g.id = o.org_id where o.status = 'packed' and g.name like 'Atlas%' order by o.number limit 1");
await p.goto(`${BASE}/shipping`, { waitUntil: 'networkidle' });
assert.ok(await p.locator(`a[href="/orders/${id}#ship"]`).count(), 'packed order is in the queue');
await openOrder(id);
const options = await p.locator('#ship select[name=status] option').allInnerTexts();
assert.ok(!options.includes('On hold') && !options.includes('Cancelled'), 'no hold/cancel for the shipper');

await ready();
await p.selectOption('#ship select[name=status]', 'shipped');
await p.fill('#ship input[name=carrier]', 'YunExpress');
await p.fill('#ship input[name=tracking]', 'YT2299000001');
await save();
await p.getByText(/Add the label photo/).waitFor();
assert.equal(sql(`select status from orders where id = '${id}'`), 'packed');
console.log('ok  cannot mark in transit without the label');

await ready();
await p.selectOption('#ship select[name=status]', 'shipped');
await p.fill('#ship input[name=tracking]', 'YT2299000001');
await p.setInputFiles('#ship input[name=label]', { name: 'label.txt.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') });
await save();
await p.getByText(/must be a photo/).waitFor();
console.log('ok  a file that is not really an image or PDF is refused');

await ready();
await p.selectOption('#ship select[name=status]', 'shipped');
await p.fill('#ship input[name=carrier]', 'YunExpress');
await p.fill('#ship input[name=tracking]', 'YT2299000001');
await p.setInputFiles('#ship input[name=label]', { name: 'label.png', mimeType: 'image/png', buffer: PNG });
await save();
await p.getByText(/Order saved/).waitFor();
const row = sql(`select status || '|' || tracking || '|' || (label_path is not null) || '|' || (tracking_registered_at is not null) from orders where id = '${id}'`);
assert.equal(row, 'shipped|YT2299000001|true|true');
assert.ok(await p.locator('#label img').count(), 'label shown on the order');
console.log('ok  shipped with tracking + label; 17TRACK tracking started');

const get = async (page) => page.request.get(`${BASE}/orders/${id}/label`).then((r) => [r.status(), r.headers()['content-type']]);
assert.deepEqual(await get(p), [200, 'image/png']);
assert.deepEqual(await get(await as('owner@local.test')), [200, 'image/png']);
assert.deepEqual(await get(await as('admin@atlas.local.test')), [200, 'image/png']);
assert.equal((await get(await as('admin@nova.local.test')))[0], 404);
console.log('ok  label visible to the team and the brand, not to another brand');
await browser.close();
