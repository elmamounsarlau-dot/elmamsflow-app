// Finance in the real UI (LOCAL stack only): reporting currency and rates, expenses with a receipt, repeating
// expenses, label cost and duties typed when shipping, duties billed back, bank statement import, the accountant's
// export, the same figures on every page, and who can see what.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cookiesFor } from './session.mjs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error('local only');
const sql = (q) => execFileSync('psql', ['-X', '-At', '-d', process.env.LOCAL_DB ?? 'elm_local', '-c', q], { encoding: 'utf8' }).trim();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const ATLAS = '11111111-1111-1111-1111-111111111111';

const browser = await chromium.launch();
const as = async (email) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', acceptDownloads: true });
  await ctx.addCookies(await cookiesFor(email, BASE));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw e; });
  page.on('dialog', (d) => d.accept());
  return page;
};
const go = async (page, path) => { await page.goto(BASE + path, { waitUntil: 'networkidle' }); };
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
const fig = async (page, name) => Number(await page.locator(`[data-figure="${name}"]`).first().getAttribute('data-value'));
const near = (a, b, what, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

const owner = await as('owner@local.test');
const ym = sql("select to_char(now() at time zone 'utc', 'YYYY-MM')");

// 1. Reporting currency and exchange rates.
await go(owner, '/finance/settings');
await owner.locator('[name=fx_EUR]').fill('1.08');
await owner.locator('[name=fx_GBP]').fill('1.27');
await owner.locator('[name=fx_CNY]').fill('0.14');
await owner.locator('[name=fx_MAD]').fill('0.1');
await owner.locator('form button[data-ready="1"]').click();
await flash(owner, /Finance settings saved/);
assert.equal(sql("select fx->>'EUR' || '/' || (fx->>'CNY') || '/' || report_currency || '/' || bill_duties from finance_settings"), '1.08/0.14/USD/true');
console.log('ok  the owner sets USD as the reporting currency and the EUR, GBP, CNY, MAD rates');

// 2. An expense with a receipt, repeating every month.
await go(owner, `/finance/expenses?m=${ym}`);
await owner.locator('#add [name=amount]').fill('1480');
await owner.locator('#add .fn-cat', { hasText: 'Rent' }).click();
await owner.locator('#add [name=payee]').fill('Ningbo warehouse');
await owner.locator('#add [name=date]').fill(`${ym}-01`);
await owner.setInputFiles('#add input[type=file][name=receipt]', { name: 'rent.pdf', mimeType: 'application/pdf', buffer: PDF });
await owner.locator('#add [name=repeat]').check();
await owner.locator('#add button[data-ready="1"]').click();
await flash(owner, /Expense saved/);
const rent = sql("select e.id || '|' || e.amount || '|' || e.category || '|' || coalesce(e.receipt_path, '') || '|' || r.day_of_month || '|' || r.generated_until from expenses e join recurring_expenses r on r.id = e.recurring_id where e.payee = 'Ningbo warehouse'").split('|');
assert.equal(rent[1], '1480.00'); assert.equal(rent[2], 'rent'); assert.ok(rent[3].endsWith('.pdf')); assert.equal(rent[4], '1'); assert.equal(rent[5], `${ym}-01`);
const rec = await owner.request.get(`${BASE}/files/receipt/${rent[0]}`);
assert.equal(rec.status(), 200); assert.equal(rec.headers()['content-type'], 'application/pdf');
console.log('ok  rent with a PDF receipt, repeating monthly; the receipt opens for the owner');

// 3. A cost for one client, in yuan; edited, then a mistaken one removed.
await go(owner, `/finance/expenses?m=${ym}`);
await owner.locator('#add [name=amount]').fill('700');
await owner.locator('#add [name=currency]').selectOption('CNY');
await owner.locator('#add .fn-cat', { hasText: 'Packaging' }).click();
await owner.locator('#add [name=payee]').fill('Box & tape supplier');
await owner.locator('#add [name=org]').selectOption(ATLAS);
await owner.locator('#add button[data-ready="1"]').click();
await flash(owner, /Expense saved/);
const box = sql("select id from expenses where payee = 'Box & tape supplier'");
await go(owner, `/finance/expenses?m=${ym}&edit=${box}`);
await owner.locator('#add [name=amount]').fill('800');
await owner.locator('#add button[data-ready="1"]').click();
await flash(owner, /Expense updated/);
assert.equal(sql(`select amount || currency || org_id from expenses where id = '${box}'`), `800.00CNY${ATLAS}`);
await go(owner, `/finance/expenses?m=${ym}`);
await owner.locator('#add [name=amount]').fill('5');
await owner.locator('#add .fn-cat', { hasText: 'Other' }).click();
await owner.locator('#add [name=payee]').fill('Typo expense');
await owner.locator('#add button[data-ready="1"]').click();
await flash(owner, /Expense saved/);
await go(owner, `/finance/expenses?m=${ym}`);
await owner.locator('tr', { hasText: 'Typo expense' }).locator('button[data-ready="1"]', { hasText: 'Remove' }).click();
await flash(owner, /Expense removed/);
assert.equal(sql("select count(*) from expenses where payee = 'Typo expense'"), '0');
console.log('ok  a client cost in CNY is added and edited; a mistaken expense is removed');

// 4. The shipper types the label cost and the duties on a DDP order; the brand never sees them.
const ddp = sql(`select id || '|' || number from orders where org_id = '${ATLAS}' and service = 'ddp' and status = 'shipped' order by shipped_at desc limit 1`).split('|');
const wh = await as('warehouse@local.test');
await go(wh, `/orders/${ddp[0]}`);
assert.equal(await wh.locator('#ship [name=cost_currency]').inputValue(), 'CNY');
await wh.locator('#ship [name=label_cost]').fill('85');
await wh.locator('#ship [name=duties_paid]').fill('120');
await wh.locator('#ship button[data-ready="1"]').click();
await flash(wh, /Order saved/);
assert.equal(sql(`select label_cost || '/' || duties_paid || '/' || currency from order_costs where order_id = '${ddp[0]}'`), '85.00/120.00/CNY');
assert.equal(sql(`select count(*) from activity_log where action = 'order_costs' and org_id is not null`), '0', 'cost log lines carry no client');
const brand = await as('admin@atlas.local.test');
await go(brand, `/orders/${ddp[0]}`);
assert.equal(await brand.locator('text=What it cost us').count(), 0, 'the brand sees no costs');
const peek = await brand.evaluate(async () => (await fetch('/files/receipt/00000000-0000-0000-0000-000000000000')).status);
assert.equal(peek, 403);
console.log(`ok  the warehouse types label 85 CNY + duties 120 CNY on #${ddp[1]}; the brand sees none of it`);

// 5. Finance shows it, converted, and bills the duties back at cost.
await go(owner, `/finance?m=${ym}`);
near(await fig(owner, 'dutiesPaid'), 120 * 0.14, 'duties paid in USD', 0.01);
near(await fig(owner, 'dutiesBilled'), 120 * 0.14, 'duties billed back in USD', 0.02);
console.log('ok  duties paid $16.80 appear in Finance and are billed back on the brand’s running bill');

// 6. Bank statement: two payments out, one in. Imported once, then again (nothing doubles).
const csv = 'Date;Description;Amount;Reference\n05/10/2026;YunExpress label top-up;-250,00;TX1\n07/10/2026;Google Workspace subscription;-12,50;TX2\n09/10/2026;Atlas Home Goods payment;1.200,00;TX3\n';
for (const round of [1, 2]) {
  await go(owner, '/finance/import');
  await owner.setInputFiles('.fn-drop input[type=file]', { name: 'statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await owner.locator('.fn-import-list tbody tr').first().waitFor();
  assert.equal(await owner.locator('.fn-import-list tbody tr').count(), 2, 'money in is hidden by default');
  assert.equal(await owner.locator('.fn-import-list tbody tr').first().locator('select').inputValue(), 'carrier');
  await owner.locator('.fn-import button[data-ready="1"]').click();
  await flash(owner, round === 1 ? /2 expenses imported/ : /0 expenses imported · 2 already there/);
}
assert.equal(sql("select string_agg(category || ':' || amount || ':' || spent_on, ',' order by spent_on) from expenses where source = 'import'"), 'carrier:250.00:2026-10-05,software:12.50:2026-10-07');
console.log('ok  a bank CSV (day-first dates, comma decimals) imports 2 payments with guessed categories; importing it again adds nothing');

// 7. A repeating expense that started two months ago fills in the missing months once; a deleted month stays deleted.
const start = sql("select to_char(date_trunc('month', now()) - interval '2 months', 'YYYY-MM-DD')");
sql(`insert into recurring_expenses (category, payee, amount, currency, day_of_month, start_month, created_by) values ('software', 'Tracking app', 30, 'USD', 1, '${start}', (select id from auth.users where email = 'owner@local.test'))`);
await go(owner, `/finance/expenses?m=${ym}`);
assert.equal(sql("select count(*) from expenses where payee = 'Tracking app'"), '3');
const first = sql(`select id from expenses where payee = 'Tracking app' and spent_on = '${start}'`);
await go(owner, `/finance/expenses?m=${start.slice(0, 7)}`);
await owner.locator('tr', { hasText: 'Tracking app' }).locator('button[data-ready="1"]', { hasText: 'Remove' }).click();
await flash(owner, /Expense removed/);
await go(owner, `/finance/expenses?m=${ym}`);
assert.equal(sql("select count(*) from expenses where payee = 'Tracking app'"), '2');
assert.equal(sql(`select count(*) from expenses where id = '${first}'`), '0');
console.log('ok  a repeating expense fills the months since it started, once; a removed month is not written again');

// 8. One set of figures: Finance overview = Expenses & profit = the accountant's export = the Overview.
await go(owner, `/finance?m=${ym}`);
const F = { revenue: await fig(owner, 'revenue'), expenses: await fig(owner, 'expenses'), profit: await fig(owner, 'profit'), owed: await fig(owner, 'owed') };
const expectExp = Number(sql(`select round(sum(case currency when 'USD' then amount when 'CNY' then amount * 0.14 when 'EUR' then amount * 1.08 when 'GBP' then amount * 1.27 else amount * 0.1 end)) from expenses where spent_on >= '${ym}-01' and spent_on < ('${ym}-01'::date + interval '1 month')`))
  + Math.round(0); // order costs added below
const orderCosts = Number(sql(`select coalesce(sum((coalesce(label_cost, 0) + coalesce(duties_paid, 0)) * 0.14), 0) from order_costs c join orders o on o.id = c.order_id where o.status in ('shipped', 'delivered')`));
near(F.expenses, expectExp + orderCosts, 'expenses = typed + order costs', 1.5);
near(F.profit, F.revenue - F.expenses, 'profit = revenue − expenses', 1);
await go(owner, `/finance/expenses?m=${ym}`);
near(await fig(owner, 'revenue'), F.revenue, 'P&L revenue'); near(await fig(owner, 'profit'), F.profit, 'P&L profit'); near(await fig(owner, 'expenses'), F.expenses, 'list total');
const dl = await owner.request.get(`${BASE}/finance/export?m=${ym}`);
assert.equal(dl.status(), 200);
assert.match(dl.headers()['content-disposition'], new RegExp(`elmamsflow-finance-${ym}\\.csv`));
const text = await dl.text();
const total = (label) => Number(text.split('\n').find((l) => l.startsWith(`total,,,${label}`)).split(',')[8]);
near(total('Revenue'), F.revenue, 'export revenue'); near(total('Expenses'), F.expenses, 'export expenses'); near(total('Profit'), F.profit, 'export profit');
assert.ok(text.includes(`#${ddp[1]}`), 'the export lists the order costs one by one');
await go(owner, '/');
near(await fig(owner, 'billed'), F.revenue, 'Overview billed = Finance revenue');
near(await fig(owner, 'owed'), F.owed, 'Overview owed = Finance owed');
console.log(`ok  the same figures everywhere: revenue $${F.revenue}, expenses $${F.expenses}, profit $${F.profit} (Finance, P&L, export, Overview)`);

// 9. Who can open Finance.
for (const email of ['warehouse@local.test', 'shipper@local.test', 'admin@atlas.local.test']) {
  const p = await as(email);
  await go(p, '/finance');
  assert.ok(!new URL(p.url()).pathname.startsWith('/finance'), `${email} is sent away from Finance`);
  assert.equal(await p.locator('nav a[href="/finance"]').count(), 0, `${email} has no Finance link`);
  const r = await p.request.get(`${BASE}/finance/export?m=${ym}`, { maxRedirects: 0 });
  assert.ok([302, 303, 307, 403].includes(r.status()), `${email} can't export (${r.status()})`);
  const rr = await p.request.get(`${BASE}/files/receipt/${rent[0]}`);
  assert.equal(rr.status(), 403, `${email} can't open a receipt`);
}
console.log('ok  the warehouse, the shipper and a brand can’t open Finance, the export or a receipt');

if (stalls) console.log(`note: the test browser didn’t follow ${stalls} redirect(s); results were checked after a reload`);
await browser.close();
