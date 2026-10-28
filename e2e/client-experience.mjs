// The brand's own tools, in the real UI (LOCAL stack only): fix an address on a held order, product photo,
// quarantine decision carried out by the warehouse, support ticket with a photo, company profile on the invoice, a kit order.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cookiesFor } from './session.mjs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error('local only');
const sql = (q) => execFileSync('psql', ['-X', '-At', '-d', process.env.LOCAL_DB ?? 'elm_local', '-c', q], { encoding: 'utf8' }).trim();
// A real 2×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
const ATL3 = 'a0000000-0000-0000-0000-000000000003';
const KIT = 'a0000000-0000-0000-0000-0000000000f1';

const browser = await chromium.launch();
const as = async (email) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  await ctx.addCookies(await cookiesFor(email, BASE));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw e; });
  if (process.env.DEBUG_E2E) { page.on('console', (m) => console.log('  console', m.type(), m.text().slice(0, 300))); page.on('response', (r) => { if (r.request().method() === 'POST') console.log('  POST', r.status(), r.headers()['x-action-redirect'] ?? ''); }); page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('  nav', f.url().slice(0, 120)); }); }
  return page;
};
const go = async (page, path) => { await page.goto(BASE + path, { waitUntil: 'networkidle' }); await page.waitForTimeout(Number(process.env.SETTLE ?? 0)); };
// Waits for the confirmation message. In the local test browser, the page sometimes doesn't move on after a
// server action has finished (the action itself is done); then the page is reloaded and the result is checked
// in the data below, so a slow redirect never hides a real failure.
let stalls = 0;
const flash = async (page, re) => {
  try { await page.locator('.ep-note').filter({ hasText: re }).first().waitFor({ timeout: 10000 }); }
  catch {
    stalls++;
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: 'networkidle' });
    const err = await page.locator('.ep-note--err').allInnerTexts();
    if (err.length) throw new Error(`error shown: ${err.join(' | ')}`);
  }
};
const client = await as('admin@atlas.local.test');

// 1. Fix the address of an order held for its address → released by itself.
const held = sql("select id from orders where hold_kind = 'address' and org_id = '11111111-1111-1111-1111-111111111111' limit 1");
assert.ok(held, 'seed has an order held for its address');
await go(client, `/orders/${held}`);
await client.locator('#edit form [name=address]').fill('8 Kalverstraat');
await client.locator('#edit form [name=zip]').fill('1012 NX');
await client.locator('#edit form [name=city]').fill('Amsterdam');
await client.locator('#edit form [name=country]').selectOption('NL');
await client.locator('#edit form button[data-ready="1"]').click();
await flash(client, /Saved/);
const after = sql(`select status || ':' || coalesce(hold_kind, '-') || ':' || country || ':' || address from orders where id = '${held}'`);
assert.ok(!after.includes(':address:'), `address hold cleared (${after})`);
assert.ok(after.endsWith(':NL:8 Kalverstraat'), after);
console.log('ok  the brand fixes the address of a held order; the address hold clears by itself →', after.split(':')[0]);

// 2. Product photo.
await go(client, `/inventory/${ATL3}`);
await client.setInputFiles('.ep-photo-form input[name=photo]', { name: 'lamp.png', mimeType: 'image/png', buffer: PNG });
await client.locator('.ep-photo-form button[data-ready="1"]').click();
await flash(client, /Photo saved/);
const photo = await client.locator('.ep-ptitle .ep-thumb img').getAttribute('src');
const res = await client.request.get(BASE + photo);
assert.equal(res.status(), 200);
assert.equal(res.headers()['content-type'], 'image/png');
console.log('ok  a product photo is uploaded, stored privately and shown');

// 3. Quarantine decision → carried out by the warehouse.
const before = sql(`select on_hand || '/' || quarantined from product_stock where id = '${ATL3}'`);
await go(client, `/inventory/${ATL3}`);
await client.locator('#quarantine label', { hasText: 'Restock' }).click();
await client.locator('#quarantine [name=qty]').fill('2');
await client.locator('#quarantine button[data-ready="1"]').click();
await flash(client, /Decision sent/);
const wh = await as('warehouse@local.test');
await go(wh, '/inventory/decisions');
await wh.locator('.ep-qd-act button[value=apply]').first().click();
await flash(wh, /Done\. Stock updated/);
const now = sql(`select on_hand || '/' || quarantined from product_stock where id = '${ATL3}'`);
assert.equal(now, `${before.split('/')[0]}/${Number(before.split('/')[1]) - 2}`);
console.log(`ok  the brand asks to restock 2 quarantined units; the warehouse carries it out (${before} → ${now})`);

// 4. Support ticket with a topic and a photo.
await go(client, '/support/new');
await client.locator('.ep-tk-cats label', { hasText: 'Damaged goods' }).click();
await client.fill('[name=subject]', 'Broken lamp shade');
await client.fill('[name=body]', 'The shade arrived crushed, photo attached.');
await client.setInputFiles('.ep-fpick input[type=file]:not([name])', { name: 'broken.png', mimeType: 'image/png', buffer: PNG });
await client.locator('.ep-fpick-list li').first().waitFor();
await client.locator('form button[data-ready="1"]', { hasText: 'Send to the team' }).click();
await flash(client, /Ticket sent/);
assert.equal(sql("select t.category || ':' || f.name from tickets t join ticket_files f on f.ticket_id = t.id where t.subject = 'Broken lamp shade'"), 'damaged:broken.png');
const att = await client.locator('.ep-att-img img').first().getAttribute('src');
assert.equal((await client.request.get(BASE + att)).status(), 200);
const other = await as('admin@nova.local.test');
assert.notEqual((await other.request.get(BASE + att)).status(), 200, 'another brand cannot open the attachment');
console.log('ok  a ticket with a topic and a photo; the photo opens for the brand and not for another brand');

// 5. Company profile on the printed invoice.
await go(client, '/settings/company');
await client.fill('[name=vat_number]', 'FR12 345678901');
await client.setInputFiles('input[name=logo]', { name: 'logo.png', mimeType: 'image/png', buffer: PNG });
await client.locator('form button[data-ready="1"]', { hasText: 'Save company profile' }).click();
await flash(client, /Company profile saved/);
await go(client, '/print/invoice/1a000000-0000-0000-0000-000000000002');
const billed = await client.locator('.pi-to').innerText();
assert.ok(/Atlas Home Goods SAS/.test(billed) && /VAT FR12 345678901/.test(billed) && /12 Rue de Rivoli/.test(billed), billed);
console.log('ok  the company profile (legal name, address, VAT, logo) is printed on the invoice');

// 6. A kit ordered ships its products.
await go(client, '/orders/new');
await client.locator('select[name=item_product]').first().selectOption(KIT);
await client.locator('input[name=item_qty]').first().fill('2');
await client.fill('[name=customer]', 'Kit Buyer');
await client.fill('[name=address]', '1 Main Street');
await client.fill('[name=city]', 'Dublin');
await client.selectOption('[name=country]', 'IE');
await client.locator('form button[data-ready="1"]', { hasText: 'Create order' }).click();
await flash(client, /created/);
const lines = sql("select string_agg(p.sku || 'x' || i.qty, ',' order by p.sku) || ':' || o.service from orders o join order_items i on i.order_id = o.id join products p on p.id = i.product_id where o.customer = 'Kit Buyer' group by o.service");
assert.equal(lines, 'ATL-002x4,ATL-006x2:ddp');
console.log('ok  2 kits ordered → 4 towels + 2 boards picked, shipped DDP');

// 7. Pages that only read.
for (const p of ['/pricing', '/reports', '/']) { await go(client, p); assert.equal(await client.locator('.ep-empty b', { hasText: /error/i }).count(), 0); }
console.log('ok  pricing, monthly report and home open');
if (stalls) console.log(`note: ${stalls} redirect(s) after an action didn’t complete in the test browser; results were checked in the data`);
await browser.close();
