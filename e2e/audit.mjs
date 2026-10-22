// Responsive + accessibility audit of every signed-in screen, against the LOCAL test stack only.
// For each role × page × width: full-page screenshot, horizontal overflow, small touch targets,
// axe-core WCAG 2.2 AA checks, console errors and failed requests.
// Usage: BASE_URL=http://127.0.0.1:3000 OUT=/tmp/e2e node e2e/audit.mjs [--only=orders]
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cookiesFor } from './session.mjs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error('This audit only runs against a local test stack.');
const OUT = process.env.OUT ?? '/tmp/e2e';
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const ORDER = '0a000000-0000-0000-0000-000000000020';
const HELD = '0a000000-0000-0000-0000-000000000010';
const PRODUCT = 'a0000000-0000-0000-0000-000000000003';
const INBOUND = '1c000000-0000-0000-0000-000000000005';
const ATLAS = '11111111-1111-1111-1111-111111111111';

const STAFF_PAGES = ['/', '/clients', `/clients/${ATLAS}`, '/orders', '/orders?t=attention', `/orders/${ORDER}`, `/orders/${HELD}`, '/orders/new', '/inventory', `/inventory/${PRODUCT}`, '/inventory/new', '/inventory/import', '/inbounds', `/inbounds/${INBOUND}`, '/inbounds/new', '/tracking', '/support', '/support/7a000000-0000-0000-0000-000000000002', '/support/new', '/invoices', '/invoices/1a000000-0000-0000-0000-000000000002', '/integrations', '/integrations/1e000000-0000-0000-0000-000000000001', '/integrations/new', '/warehouses', '/transfers', '/transfers/new', '/transfers/new?kind=allocation', '/transfers/:first', '/team', '/activity', '/settings', '/settings/billing'];
const CLIENT_PAGES = ['/', '/orders', `/orders/${ORDER}`, '/orders/new', '/inventory', `/inventory/${PRODUCT}`, '/inbounds', '/inbounds/new', '/tracking', '/support', '/support/new', '/invoices', '/invoices/1a000000-0000-0000-0000-000000000002', '/integrations', '/team', '/settings'];
const ROLES = [
  { key: 'owner', email: 'owner@local.test', pages: STAFF_PAGES },
  { key: 'warehouse', email: 'warehouse@local.test', pages: ['/', '/orders', `/orders/${ORDER}`, '/inventory', `/inventory/${PRODUCT}`, `/inbounds/${INBOUND}`] },
  { key: 'client-admin', email: 'admin@atlas.local.test', pages: CLIENT_PAGES },
  { key: 'client-ops', email: 'ops@atlas.local.test', pages: ['/', '/orders', '/inventory', '/team'] },
];
const WIDTHS = [{ name: '375', width: 375, height: 812, mobile: true }, { name: '768', width: 768, height: 1024, mobile: true }, { name: 'desktop', width: 1440, height: 900, mobile: false }];

const slug = (p) => (p === '/' ? 'home' : p.replace(/^\//, '').replace(/[/?=&]/g, '_'));
const report = [];
const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });

for (const role of ROLES) {
  const cookies = await cookiesFor(role.email, BASE);
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height }, isMobile: w.mobile, hasTouch: w.mobile, deviceScaleFactor: 1 });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    for (const path of role.pages) {
      if (only && !path.includes(only)) continue;
      const errors = [];
      const failed = [];
      const onConsole = (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); };
      const onPageError = (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`);
      const onFail = (r) => failed.push(`${r.failure()?.errorText} ${r.url().replace(BASE, '')}`);
      const onResp = (r) => { if (r.status() >= 500) failed.push(`${r.status()} ${r.url().replace(BASE, '')}`); };
      page.on('console', onConsole); page.on('pageerror', onPageError); page.on('requestfailed', onFail); page.on('response', onResp);
      let target = path;
      if (path === '/transfers/:first') {
        await page.goto(BASE + '/transfers', { waitUntil: 'networkidle' });
        target = (await page.locator('a[href^="/transfers/"]:not([href="/transfers/new"])').first().getAttribute('href')) ?? '/transfers';
      }
      const res = await page.goto(BASE + target, { waitUntil: 'networkidle' });
      const status = res?.status();
      const finalPath = new URL(page.url()).pathname;
      const dir = `${OUT}/${role.key}/${w.name}`;
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: `${dir}/${slug(path)}.png`, fullPage: true });
      const metrics = await page.evaluate(() => {
        const vw = window.innerWidth;
        const scrollW = document.documentElement.scrollWidth;
        const insideScroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (['auto', 'scroll'].includes(s.overflowX) && p.scrollWidth > p.clientWidth) return true; } return false; };
        const overflow = [];
        if (scrollW > vw + 1) {
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width && r.right > vw + 1 && !insideScroller(el)) overflow.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} (right ${Math.round(r.right)})`);
            if (overflow.length > 6) break;
          }
        }
        const small = [];
        const tiny = [];
        for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button]')) {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') continue;
          if (el.closest('table') && el.tagName === 'A' && !el.className) continue; // inline text links in cells
          // WCAG 2.5.8 "inline" exception: a link inside a sentence is sized by the line of text.
          if (el.tagName === 'A' && s.display === 'inline' && el.parentElement && /[A-Za-z]{3}/.test((el.parentElement.textContent || '').replace(el.textContent || '', ''))) continue;
          const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
          const id = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "${label}" ${Math.round(r.width)}×${Math.round(r.height)}`;
          if (r.width < 24 || r.height < 24) tiny.push(id); else if (r.width < 44 || r.height < 44) small.push(id);
        }
        return { vw, scrollW, overflow, tiny: [...new Set(tiny)], small: [...new Set(small)] };
      });
      await page.addScriptTag({ content: axeSource });
      const axe = await page.evaluate(async () => {
        const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
      });
      page.off('console', onConsole); page.off('pageerror', onPageError); page.off('requestfailed', onFail); page.off('response', onResp);
      report.push({ role: role.key, width: w.name, path, status, finalPath, ...metrics, axe, errors, failed });
      process.stdout.write('.');
    }
    await ctx.close();
  }
}
await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

const sum = { screens: report.length, overflow: report.filter((r) => r.overflow.length || r.scrollW > r.vw + 1).length, withTiny: report.filter((r) => r.tiny.length && r.width !== 'desktop').length,
  axeViolations: report.reduce((a, r) => a + r.axe.reduce((b, v) => b + v.count, 0), 0), consoleErrors: report.reduce((a, r) => a + r.errors.length, 0), failed: report.reduce((a, r) => a + r.failed.length, 0),
  notOk: report.filter((r) => !r.status || r.status >= 400).length };
console.log('\n' + JSON.stringify(sum));
// Fail (for CI) on anything that breaks the layout or WCAG 2.2 AA, a console error, a broken page, or a control under 24 px.
const tinyTotal = report.filter((r) => r.width !== 'desktop').reduce((a, r) => a + r.tiny.length, 0);
if (sum.overflow || sum.axeViolations || sum.consoleErrors || sum.notOk || tinyTotal) {
  console.error(`audit failed: overflow ${sum.overflow}, WCAG ${sum.axeViolations}, console ${sum.consoleErrors}, broken ${sum.notOk}, controls under 24px ${tinyTotal}`);
  process.exitCode = 1;
}
