import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cookiesFor } from './session.mjs';
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const b = await chromium.launch(); const out = new Map();
for (const [email, theme] of [['owner@local.test','light'],['owner@local.test','dark'],['admin@atlas.local.test','light']]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  await ctx.addCookies(await cookiesFor(email, 'http://127.0.0.1:3000'));
  const p = await ctx.newPage();
  for (const path of ['/', '/orders', '/inventory', '/inbounds', '/team', '/orders/0a000000-0000-0000-0000-000000000010', '/inventory/a0000000-0000-0000-0000-000000000003', '/settings', '/clients', '/invoices']) {
    await p.goto('http://127.0.0.1:3000' + path, { waitUntil: 'networkidle' });
    await p.addScriptTag({ content: axeSource });
    const v = await p.evaluate(async () => (await axe.run(document, { runOnly: ['color-contrast'] })).violations.flatMap((x) => x.nodes.map((n) => { const d = n.any[0]?.data ?? {}; return `${d.fgColor} on ${d.bgColor} ${d.contrastRatio}:1 ${d.fontSize} ${n.target.join(' ').split(' > ').pop().slice(0,40)}`; })));
    for (const s of v) { const k = s.split(' ').slice(0, 4).join(' ') + ' ' + theme; out.set(k, (out.get(k) ?? []).concat(s.split(' ').slice(5).join(' '))); }
  }
  await ctx.close();
}
await b.close();
for (const [k, v] of [...out].sort((a, b) => b[1].length - a[1].length)) console.log(v.length, k, '|', [...new Set(v)].slice(0, 4).join(' ; '));
