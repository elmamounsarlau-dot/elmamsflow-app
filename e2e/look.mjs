// Quick look at a few screens (local stack only): node e2e/look.mjs <email> <width> <out> <path>...
import { chromium } from 'playwright-core';
import { cookiesFor } from './session.mjs';
const [email, width, out, ...paths] = process.argv.slice(2);
const BASE = 'http://127.0.0.1:3000';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: +width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
await ctx.addCookies(await cookiesFor(email, BASE));
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 200)); });
for (const p of paths) {
  const r = await page.goto(BASE + p, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const name = (p === '/' ? 'home' : p.slice(1).replace(/[/?=&]/g, '_')) + `-${width}.png`;
  await page.screenshot({ path: `${out}/${name}`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(p, r?.status(), new URL(page.url()).pathname, overflow > 1 ? `OVERFLOW ${overflow}px` : '');
}
await b.close();
