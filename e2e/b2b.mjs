// B2B in the real UI (LOCAL stack only): a new client and order, priced lines in other currencies and as %,
// TVA, stages, costs, payments, the Moroccan Devis and Facture, the international invoice, Finance's
// Fulfillment / B2B / Everything switch, and who can see what.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cookiesFor } from './session.mjs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error('local only');
const sql = (q) => execFileSync('psql', ['-X', '-At', '-d', process.env.LOCAL_DB ?? 'elm_local', '-c', q], { encoding: 'utf8' }).trim();

const browser = await chromium.launch();
const as = async (email) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  await ctx.addCookies(await cookiesFor(email, BASE));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw e; });
  page.on('dialog', (d) => d.accept());
  return page;
};
const go = async (page, path) => { await page.goto(BASE + path, { waitUntil: 'networkidle' }); };
const flash = async (page, re) => {
  await page.locator('.ep-note').filter({ hasText: re }).first().waitFor({ timeout: 15000 }).catch(async () => {
    const err = await page.locator('.ep-note--err').allInnerTexts();
    throw new Error(`expected “${re}”, got: ${err.join(' | ') || 'nothing'} at ${page.url()}`);
  });
};
const fig = async (page, name) => Number(await page.locator(`[data-figure="${name}"]`).first().getAttribute('data-value'));
const step = (s) => console.log(`✓ ${s}`);

sql(`update public.finance_settings set report_currency = 'USD', fx = '{"MAD": 0.1, "CNY": 0.14, "EUR": 1.08, "GBP": 1.27}' where id = 1`);
const ym = sql("select to_char(now() at time zone 'utc', 'YYYY-MM')");
const mm = ym.slice(5, 7), yyyy = ym.slice(0, 4);

const owner = await as('owner@local.test');

// 1. New order for a new Moroccan client
await go(owner, '/b2b/new');
await owner.selectOption('select[name="client"]', '');
await owner.locator('summary', { hasText: 'Client not in the list' }).click();
await owner.fill('input[name="name"]', 'Test Négoce SARL');
await owner.selectOption('select[name="country"]', 'MA');
await owner.fill('input[name="ice"]', '009876543000012');
await owner.fill('input[name="title"]', 'Stores vénitiens, 1 palette');
await owner.click('button:has-text("Create the order")');
await flash(owner, /B2B-0003 created/);
const orderUrl = owner.url().split('?')[0].split('#')[0];
const orderId = orderUrl.split('/').pop();
assert.equal(sql(`select currency || '|' || stage from public.b2b_orders where id = '${orderId}'`), 'MAD|Quote');
step('order created for a new Moroccan client, in MAD, at the first stage');

// 2. Lines: goods in Yuan (rate from Finance settings), freight in $ with a typed rate, customs as %, flat forwarder
const addLine = async (f) => {
  const before = await owner.locator('.bb-lines tbody tr').count();
  await owner.selectOption('#line-form select[name="kind"]', f.kind);
  await owner.fill('#line-form input[name="description"]', f.d);
  await owner.fill('#line-form input[name="qty"]', f.qty ?? '');
  await owner.fill('#line-form input[name="unit"]', f.unit ?? '');
  await owner.fill('#line-form input[name="price"]', f.price);
  await owner.selectOption('#line-form select[name="price_as"]', f.as);
  await owner.fill('#line-form input[name="rate"]', f.rate ?? '');
  await owner.click('#line-form button:has-text("Add the line")');
  await owner.waitForFunction((n) => document.querySelectorAll('.bb-lines tbody tr').length === n, before + 1, { timeout: 15000 });
  await flash(owner, /Line added/);
};
await addLine({ kind: 'goods', d: 'Échantillon stores vénitiens', qty: '10', unit: 'm²', price: '200', as: 'CNY' });   // 200 CNY = 0.14/0.1 = 1.4 MAD → 2 800
await addLine({ kind: 'freight', d: 'Fret aérien', qty: '4', unit: 'KGs', price: '39', as: 'USD', rate: '10' });        // 1 560
await addLine({ kind: 'customs', d: 'Frais de douanes', price: '50', as: '%' });                                          // 50% × 4 360 = 2 180
await addLine({ kind: 'forwarder', d: 'Transitaire', price: '1500', as: 'MAD' });                                         // 1 500
assert.equal(await fig(owner, 'b2b-ht'), 8040);
step('lines in Yuan, $ (typed rate), % and MAD add up: 8 040 MAD');

// 3. TVA 20% and a 40 MAD remise
await owner.fill('aside input[name="tva_rate"]', '20');
await owner.fill('aside input[name="discount"]', '40');
await owner.click('aside button:has-text("Save")');
await flash(owner, /Order details saved/);
assert.equal(await fig(owner, 'b2b-ttc'), 9608);   // 8 040 + 1 608 − 40
step('TVA and remise: TTC 9 608 MAD');

// 4. Stage, cost, payment
await owner.click('.bb-steps button:has-text("Confirmed")');
await flash(owner, /Moved to “Confirmed”/);
assert.equal(sql(`select stage from public.b2b_orders where id = '${orderId}'`), 'Confirmed');
await owner.selectOption('form.bb-mform select[name="category"]', 'goods');
await owner.fill('form.bb-mform input[name="payee"]', 'Shaoxing factory');
await owner.fill('form.bb-mform input[name="amount"]', '3000');
await owner.selectOption('form.bb-mform select[name="currency"]', 'MAD');
await owner.click('button:has-text("Add the cost")');
await flash(owner, /Cost added/);
await owner.locator('form.bb-mform').nth(1).locator('input[name="amount"]').fill('4000');
await owner.locator('form.bb-mform').nth(1).locator('input[name="note"]').fill('Acompte');
await owner.click('button:has-text("Record the payment")');
await flash(owner, /Payment recorded/);
// profit (USD): (8 040 − 40) × 0.1 − 3 000 × 0.1 = 500
assert.equal(await fig(owner, 'b2b-profit'), 500);
assert.equal(await owner.locator('.bb-story').innerText().then((t) => /Confirmed/.test(t) && /Shaoxing factory/.test(t) && /Payment received/.test(t)), true);
step('stage moved, cost and payment recorded, profit 500 USD, story kept');

// 5. Devis (Morocco layout)
await owner.selectOption('#docs select[name="kind"]', 'devis');
await owner.click('#docs button:has-text("Make it")');
await owner.waitForURL(/\/print\/b2b\//);
await flash(owner, /Devis 0002\/\d\d\/\d{4} is ready/);
let text = await owner.locator('.pb-page').innerText();
assert.match(text, new RegExp(`0002/${mm}/${yyyy}`));
assert.match(text, /D E V I S/);
assert.match(text, /Arrêté le présent DEVIS à la somme de/);
assert.match(text, /Neuf mille six cent huit dirhams/);
assert.match(text, /TOTAL T\.T\.C\.\s+DU PRESENT DEVIS/);
assert.match(text, /Client:\s+Test Négoce SARL/);
assert.match(text, /009876543000012/);
assert.match(text, /200 Yuan/);
assert.match(text, /50 %/);
assert.ok(await owner.locator('img.pm-letterhead').evaluate((i) => i.naturalWidth > 0), 'letterhead image loads');
step('Devis printed in your layout: number, letterhead, words, totals');

// 6. Facture continues the paper numbering (0114)
await go(owner, `/b2b/${orderId}#docs`);
await owner.selectOption('#docs select[name="kind"]', 'final');
await owner.click('#docs button:has-text("Make it")');
await owner.waitForURL(/\/print\/b2b\//);
text = await owner.locator('.pb-page').innerText();
assert.match(text, new RegExp(`0114/${mm}/${yyyy}`));
assert.match(text, /Arrêté la présente FACTURE/);
assert.match(text, /9 608\.00 DHs/);
const factureId = owner.url().split('/').pop().split('?')[0];
step('Facture 0114 printed');

// 7. International invoice, design B, with the deposit already paid
await go(owner, '/b2b/b2b00000-0000-0000-0000-0000000000a2');
await owner.locator('form.bb-mform').nth(1).locator('input[name="amount"]').fill('7605');
await owner.click('button:has-text("Record the payment")');
await flash(owner, /Payment recorded/);
await owner.selectOption('#docs select[name="kind"]', 'final');
await owner.selectOption('#docs select[name="template"]', 'b');
await owner.click('#docs button:has-text("Make it")');
await owner.waitForURL(/\/print\/b2b\//);
text = await owner.locator('.pb-page').innerText();
assert.match(text, /B2B-INV-0057/);
assert.match(text, /BALANCE INVOICE · 70%/);
assert.match(text, /\$17,745\.00/);
assert.match(text, /Seventeen thousand seven hundred forty-five US dollars/);
assert.match(text, /VAT FR 12 345678901/);
step('International invoice (design B): number, balance after deposit, English words');

// 8. Finance: B2B and Everything
await go(owner, `/finance?scope=b2b&m=${ym}`);
// invoiced before TVA this month: facture (8 000 MAD = 800 USD) + invoice 25 350 USD
assert.equal(await fig(owner, 'b2b-revenue'), 26150);
const costs = Math.round(Number(sql(`select coalesce(sum(case currency when 'USD' then amount when 'MAD' then amount * 0.1 when 'CNY' then amount * 0.14 end), 0) from public.b2b_costs where to_char(paid_on, 'YYYY-MM') = '${ym}'`)));
assert.equal(await fig(owner, 'b2b-costs'), costs);
assert.equal(await fig(owner, 'b2b-profit'), 26150 - costs);
const b2bOwed = await fig(owner, 'b2b-owed');
await go(owner, `/finance?m=${ym}`);
assert.equal(await owner.locator('.fn-scope a.is-on').innerText(), 'Fulfillment');
await go(owner, `/finance?scope=all&m=${ym}`);
const allRev = await fig(owner, 'all-revenue');
assert.ok(allRev >= 26150, `everything includes B2B revenue (${allRev})`);
await go(owner, '/b2b');
assert.equal(await fig(owner, 'b2b-owed'), b2bOwed);
assert.equal(await fig(owner, 'b2b-revenue'), 26150);
step('Finance switch: B2B figures match the B2B page; Everything includes B2B');

// 9. Cancelling a facture keeps its number
await go(owner, `/b2b/${orderId}#docs`);
await owner.locator('.bb-docs li', { hasText: '0114/' }).locator('button:has-text("Cancel")').click();
await flash(owner, /Document cancelled/);
assert.equal(sql(`select status from public.b2b_docs where id = '${factureId}'`), 'void');
await go(owner, `/print/b2b/${factureId}`);
assert.match(await owner.locator('.pb-void').innerText(), /ANNULÉ/);
step('a cancelled facture stays, stamped ANNULÉ');

// 10. Settings: stages and numbers
await go(owner, '/b2b/settings');
await owner.fill('textarea[name="stages"]', 'Devis envoyé\nAcompte reçu\nProduction\nExpédié\nDédouané\nLivré & payé');
await owner.click('button:has-text("Save settings")');
await flash(owner, /B2B settings saved/);
await go(owner, '/b2b');
assert.ok(await owner.locator('.bb-pipe-step', { hasText: 'Acompte reçu' }).count());
sql(`update public.b2b_settings set stages = '["Quote", "Confirmed", "Deposit paid", "In production", "Quality check", "Shipped", "Customs", "Delivered", "Paid & closed"]' where id = 1`);
step('stages are yours to rename');

// 11. Who can see it
for (const email of ['warehouse@local.test', 'shipper@local.test', 'admin@atlas.local.test']) {
  const p = await as(email);
  await go(p, '/b2b');
  assert.ok(!p.url().includes('/b2b'), `${email} is sent away from B2B`);
  assert.equal(await p.locator('nav a[href="/b2b"]').count(), 0, `${email} has no B2B menu`);
  const r = await p.goto(`${BASE}/print/b2b/${factureId}`);
  assert.equal(r.status(), 404, `${email} cannot open a B2B document`);
  await p.context().close();
}
const mgr = await as('manager@local.test');
await go(mgr, '/b2b');
assert.ok(mgr.url().endsWith('/b2b'), 'a manager opens B2B');
step('only the owner, managers and finance see B2B');

await browser.close();
console.log('B2B: all checks passed');
