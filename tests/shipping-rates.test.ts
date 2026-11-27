// Shipping rates against the LOCAL test stack (npm run test:stack): a pasted sheet becomes the client's price.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseAdmin } from '../src/lib/supabase/admin';
import { marginFor, sheetsFor, shipSettings, shippedCountries } from '../src/lib/shipping-db';
import { parseSheet, quoteAll } from '../src/lib/shipping-rates';

if (!/^http:\/\/127\.0\.0\.1/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')) throw new Error('local stack only');
const db = () => supabaseAdmin();
const ATLAS = '11111111-1111-1111-1111-111111111111';
const sheet = (k: number) => [
  `\t\t2026.11.${k}`,
  'Country/Region\tReference Timeframe\tWeight(KG)\tMinimum Billing Weight\tShipping Fee(USD/KG)\tProcessing fee (USD/Package)',
  `United States\t6-12 work days\t0.2<W≤0.3\t0.03\t${19 + k / 100}\t4.45`,
  'United Kingdom\t6-10 work days\t0<W≤0.3\t\t8.59\t3.99',
].join('\n');

before(async () => { await db().from('shipping_sheets').delete().neq('id', '00000000-0000-0000-0000-000000000000'); });

after(async () => {
  await db().from('shipping_sheets').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await db().from('organizations').update({ shipping_margin_pct: null, shipping_margin_fixed: null }).eq('id', ATLAS);
});

test('a pasted sheet is saved and quoted with the default margin, then a client’s own margin', async () => {
  const p = parseSheet(sheet(9));
  const { error } = await db().rpc('shipping_sheet_replace', { p_service: 'economic', p_type: 'general', p_source: 'test', p_dated: p.dated, p_user: null, p_rows: p.rows });
  assert.ifError(error);
  const s = await shipSettings();
  assert.equal(s.margin_pct, 20);
  const sheets = await sheetsFor('general', 'GB');
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].dated, '2026-11-09');
  const q = quoteAll(sheets, 'GB', { weight_g: 150 }, s, await marginFor(ATLAS, s));
  assert.equal(q[0].price, 6.33); // (0.15 × 8.59 + 3.99) × 1.2 — packed weight as typed, nothing added
  await db().from('organizations').update({ shipping_margin_pct: 10, shipping_margin_fixed: 1 }).eq('id', ATLAS);
  assert.equal(quoteAll(sheets, 'GB', { weight_g: 150 }, s, await marginFor(ATLAS, s))[0].price, 6.81); // 5.2785 × 1.1 + 1
  assert.deepEqual((await shippedCountries()).sort(), ['GB', 'US']);
  assert.equal((await sheetsFor('cosmetics', 'GB')).length, 0, 'a product type without a sheet has no price');
});

test('a newer sheet replaces the prices right away', async () => {
  const p = parseSheet(sheet(16));
  await db().rpc('shipping_sheet_replace', { p_service: 'economic', p_type: 'general', p_source: 'test', p_dated: p.dated, p_user: null, p_rows: p.rows });
  const sheets = await sheetsFor('general', 'US');
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].dated, '2026-11-16');
  assert.equal(Number(sheets[0].rows[0].per_kg), 19.16);
});

test('lines: every line offered shows with its carrier; a hidden line disappears for clients but not for the team', async () => {
  const { data: lines } = await db().from('shipping_lines').select('id, key').in('key', ['standard', 'express']);
  const id = (k: string) => lines!.find((l) => l.key === k)!.id;
  const express = ['Country/Region\tReference Timeframe\tLast-mile service provider\tWeight(KG)\tShipping Fee(USD/KG)\tProcessing fee (USD/Package)', 'United Kingdom\t3-5 work days\tEvri\t0<W≤0.3\t10.28\t3.99'].join('\n');
  const { error } = await db().rpc('shipping_line_sheet_replace', { p_line: id('express'), p_type: 'general', p_source: 'tab 13', p_dated: '2026-11-16', p_user: null, p_rows: parseSheet(express).rows });
  assert.ifError(error);
  const s = await shipSettings();
  const q = quoteAll(await sheetsFor('general', 'GB'), 'GB', { weight_g: 150 }, s, { pct: 0, fixed: 0 });
  assert.deepEqual(q.map((l) => [l.label, l.carrier]), [['Standard', null], ['Express', 'Evri']]);
  await db().from('shipping_lines').update({ active: false }).eq('id', id('express'));
  try {
    assert.deepEqual((await sheetsFor('general', 'GB')).map((x) => x.line.name), ['Standard']);
    assert.equal((await sheetsFor('general', 'GB', { includeOff: true })).length, 2);
  } finally {
    await db().from('shipping_lines').update({ active: true }).eq('id', id('express'));
  }
});
