// A client imports orders from a CSV in the real UI (LOCAL stack only): preview, confirm, no duplicates, errors block.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cookiesFor } from './session.mjs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error('local only');
const sql = (q) => execFileSync('psql', ['-X', '-At', '-d', process.env.LOCAL_DB ?? 'elm_local', '-c', q], { encoding: 'utf8' }).trim();
const good = 'order,customer,address,city,zip,country,email,sku,qty\nCSV-1,Ana Lima,Rua Augusta 10,Lisboa,1100,Portugal,ana@example.com,ATL-001,2\nCSV-1,Ana Lima,Rua Augusta 10,Lisboa,1100,Portugal,ana@example.com,ATL-002,1\nCSV-2,Tom Berg,Storgatan 3,Stockholm,11122,SE,,ATL-004,1\n';
const bad = 'order,customer,address,country,sku,qty\nCSV-9,,Somewhere 1,Narnia,NOVA-001,1\n';

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addCookies(await cookiesFor('admin@atlas.local.test', BASE));
const page = await ctx.newPage();
const upload = async (name, text) => {
  await page.goto(`${BASE}/orders/import`, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[type=file]', { name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  await page.getByText('Preview', { exact: true }).waitFor();
};

await upload('bad.csv', bad);
assert.equal(await page.getByRole('button', { name: /Confirm and create/ }).isDisabled(), true);
assert.ok(await page.getByText(/Customer missing/).count());
console.log('ok  a file with errors (missing customer, unknown country, another client’s SKU) cannot be imported');

await upload('good.csv', good);
assert.ok(await page.getByText('2 orders · 4 units').count(), 'preview counts');
await page.getByRole('button', { name: 'Confirm and create 2 orders' }).click();
await page.getByText(/2 orders imported/).waitFor();
const rows = sql("select store_ref || ':' || status || ':' || (select sum(qty) from order_items i where i.order_id = o.id) from orders o where source = 'csv' order by store_ref").split('\n');
assert.deepEqual(rows, ['CSV-1:new:3', 'CSV-2:on_hold:1']); // ATL-004 has no HS code → hold
console.log('ok  2 orders created with their products; the one with missing customs info is on hold');

await upload('good.csv', good);
await page.getByRole('button', { name: 'Confirm and create 2 orders' }).click();
await page.getByText(/already imported/).waitFor();
assert.equal(sql("select count(*) from orders where source = 'csv'"), '2');
console.log('ok  uploading the same file again creates no duplicates');
await browser.close();
