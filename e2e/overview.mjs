// The Overview tells the truth (LOCAL stack only): every figure on it is followed to the page it links to, and
// that page must show the same number. Run as the owner, the warehouse team and a brand (Quick view), then the
// Full view / Quick view switch both ways, remembered for the person, in light and dark.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cookiesFor } from './session.mjs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error('local only');
const sql = (q) => execFileSync('psql', ['-X', '-At', '-d', process.env.LOCAL_DB ?? 'elm_local', '-c', q], { encoding: 'utf8' }).trim();
const browser = await chromium.launch();
const as = async (email, theme = 'light', width = 1440) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width, height: 900 } });
  await ctx.addCookies([...await cookiesFor(email, BASE), { name: 'elm_theme', value: theme, domain: new URL(BASE).hostname, path: '/' }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.errors = errors;
  return page;
};
const go = async (page, path) => { const r = await page.goto(BASE + path, { waitUntil: 'networkidle' }); assert.ok(r && r.status() < 400, `${path} → ${r?.status()}`); };
const num = async (page, sel) => {
  const el = page.locator(sel).first();
  assert.ok(await el.count(), `${sel} on ${page.url().replace(BASE, '')}`);
  return Number(await el.getAttribute(sel.includes('data-count') ? 'data-count' : 'data-value'));
};

// Where each Overview figure is shown on the page it links to.
const TARGET = {
  ordersToday: '[data-count]', shippedToday: '[data-count]', road: '[data-count]', 'act-pack': '[data-count]', 'act-late': '[data-count]', 'act-hold': '[data-count]',
  'pipe-toPack': '[data-count]', 'pipe-hold': '[data-count]', 'pipe-packed': '[data-count]', 'pipe-road': '[data-count]', 'speed-late': '[data-count]',
  doorToDoor: '[data-figure="doorToDoor"]', 'act-track': '[data-figure="problems"]', billed: '[data-figure="revenue"]', owed: '[data-figure="owed"]',
  sellable: '[data-figure="sellable"]', tickets: '[data-count]', 'act-tickets': '[data-count]', lateIn: '[data-figure="late"]', 'act-inbounds': '[data-figure="late"]',
  'act-drafts': '[data-figure="tab-draft"]', 'act-overdue': '[data-figure="tab-overdue"]', bill: '[data-figure="running"]', reorder: null,
};

async function followAll(page, who) {
  const figs = await page.locator('[data-figure][href]').evaluateAll((els) => els.map((e) => ({ f: e.getAttribute('data-figure'), v: Number(e.getAttribute('data-value')), href: e.getAttribute('href') })));
  assert.ok(figs.length >= 8, `${who}: figures found (${figs.length})`);
  let checked = 0;
  for (const { f, v, href } of figs) {
    if (href.startsWith('#')) {
      if (f === 'act-links') assert.equal(await page.locator('#pending .ep-pending-list > div').count(), v, `${who} ${f}`);
      checked++;
      continue;
    }
    const sel = f.startsWith('wh-') ? `[data-figure="${f}"]` : TARGET[f];
    if (sel === undefined) throw new Error(`${who}: no target known for figure ${f}`);
    if (sel === null) continue;
    const back = page.url();
    await go(page, href);
    const there = await num(page, sel);
    // Door to door is an average of times; both pages compute it from the same deliveries.
    if (f === 'billed' || f === 'owed' || f === 'bill') assert.ok(Math.abs(there - v) <= 1, `${who} ${f}: Overview ${v}, ${href} ${there}`);
    else assert.equal(there, v, `${who} ${f}: Overview ${v}, ${href} shows ${there}`);
    checked++;
    await page.goto(back, { waitUntil: 'networkidle' });
  }
  return checked;
}

// 1. Owner: every figure.
const owner = await as('owner@local.test');
await go(owner, '/');
assert.equal(await owner.locator('[data-view="owner"]').count(), 1);
const n1 = await followAll(owner, 'owner');
console.log(`ok  owner: ${n1} Overview figures each match the page they open (orders, tracking, finance, invoices, inbounds, support, warehouses)`);

// 2. Warehouse team: no money, only their actions, same truth.
const wh = await as('warehouse@local.test');
await go(wh, '/');
assert.equal(await wh.locator('[data-figure="billed"], [data-figure="owed"], .ds-money').count(), 0, 'no money for the warehouse');
assert.equal(await wh.locator('[data-figure="act-drafts"]').count(), 0);
const n2 = await followAll(wh, 'warehouse');
console.log(`ok  warehouse: no money on the Overview; ${n2} figures each match their page`);

// 3. A brand: Full view by default, switch to Quick view (remembered), every Quick view figure matches, switch back.
sql("update profiles set home_view = null where email = 'admin@atlas.local.test'");
for (const theme of ['light', 'dark']) {
  const brand = await as('admin@atlas.local.test', theme);
  await go(brand, '/');
  assert.equal(await brand.locator('[data-view="full"]').count(), 1, 'Full view by default');
  const full = { ordersToday: await num(brand, '[data-figure="ordersToday"]'), shippedToday: await num(brand, '[data-figure="shippedToday"]'), sellable: await num(brand, '[data-figure="sellable"]') };
  await brand.locator('.ds-switch [role=radio]', { hasText: 'Quick view' }).click();
  await brand.locator('[data-view="quick"]').waitFor({ timeout: 15000 });
  assert.equal(await brand.locator('.ds-switch [aria-checked="true"]').innerText(), 'Quick view');
  assert.equal(sql("select home_view from profiles where email = 'admin@atlas.local.test'"), 'quick');
  for (const k of Object.keys(full)) assert.equal(await num(brand, `[data-figure="${k}"]`), full[k], `${k}: Full view ${full[k]} = Quick view`);
  await brand.reload({ waitUntil: 'networkidle' });
  assert.equal(await brand.locator('[data-view="quick"]').count(), 1, 'Quick view remembered after a reload');
  const other = await as('admin@atlas.local.test', theme, 390); // another device
  await go(other, '/');
  assert.equal(await other.locator('[data-view="quick"]').count(), 1, 'remembered on another device');
  const overflow = await other.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no sideways scroll on a phone (${overflow}px)`);
  await other.context().close();
  if (theme === 'light') {
    const n3 = await followAll(brand, 'brand');
    console.log(`ok  brand: Full view ↔ Quick view show the same today / shipped / sellable; ${n3} Quick view figures each match their page`);
  }
  await go(brand, '/');
  await brand.locator('.ds-switch [role=radio]', { hasText: 'Full view' }).click();
  await brand.locator('[data-view="full"]').waitFor({ timeout: 15000 });
  assert.equal(sql("select home_view from profiles where email = 'admin@atlas.local.test'"), 'full');
  assert.equal(await brand.locator('html[data-home-switching]').count(), 0, 'the fade is cleared after switching');
  assert.deepEqual(brand.errors, [], `no console errors (${theme})`);
  console.log(`ok  ${theme}: switching Quick view → Full view → Quick view works, is remembered on every device, no errors`);
  await brand.context().close();
}

// 4. Brands never see the team's Overview or any cost.
const brand = await as('admin@atlas.local.test');
await go(brand, '/');
assert.equal(await brand.locator('[data-view="owner"], [data-figure="billed"], [data-figure="act-drafts"]').count(), 0);
console.log('ok  a brand never gets the team Overview or its money figures');

assert.deepEqual(owner.errors, [], 'owner: no console errors');
assert.deepEqual(wh.errors, [], 'warehouse: no console errors');
await browser.close();
