'use client';

import { useMemo, useState } from 'react';
import { parseCsv } from '@/lib/csv';
import { Submit } from './client';

const CATS: [string, string][] = [['carrier', 'Carrier'], ['duties', 'Duties (DDP)'], ['rent', 'Rent'], ['salaries', 'Salaries'], ['packaging', 'Packaging'], ['software', 'Software'], ['other', 'Other']];
const GUESS: [string, RegExp][] = [
  ['carrier', /yun|dhl|fedex|ups\b|4px|cainiao|yanwen|sf express|express|postal|post\b|courier|freight|logistic|shipping|label/i],
  ['duties', /custom|duty|duties|tariff|vat|tax|ior/i],
  ['rent', /rent|lease|loyer|warehouse/i],
  ['salaries', /salar|payroll|wage|staff|team/i],
  ['packaging', /box|carton|tape|packag|mailer|bubble/i],
  ['software', /software|subscription|saas|google|microsoft|shopify|aws|vercel|supabase|notion|adobe|17track|stripe fee/i],
];
const guess = (t: string) => GUESS.find(([, r]) => r.test(t))?.[0] ?? 'other';

function num(v: string) {
  let s = (v ?? '').replace(/[^\d,.\-()]/g, '');
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()-]/g, '');
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > ld) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
  else s = s.replace(/,/g, ''); // 1,234.56
  const n = parseFloat(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

function date(v: string, dayFirst: boolean) {
  const t = (v ?? '').trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const [a, b] = dayFirst ? [m[2], m[1]] : [m[1], m[2]];
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (Number(a) > 12 || Number(b) > 31) return '';
    return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  }
  return '';
}

const find = (headers: string[], re: RegExp) => headers.find((h) => re.test(h)) ?? '';

/** Read a bank statement in the browser, pick the lines that are expenses, send only those. */
export function BankImport({ currency, currencies, action }: { currency: string; currencies: readonly string[]; action: (fd: FormData) => Promise<void> }) {
  const [csv, setCsv] = useState<{ headers: string[]; rows: Record<string, string>[] } | null>(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [cols, setCols] = useState({ date: '', text: '', amount: '', out: '', ref: '' });
  const [dayFirst, setDayFirst] = useState(true);
  const [cur, setCur] = useState(currency);
  const [showIn, setShowIn] = useState(false);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [cat, setCat] = useState<Record<number, string>>({});

  const read = async (f: File | undefined) => {
    setErr('');
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { setErr('The file is larger than 5 MB.'); return; }
    const p = parseCsv(await f.text());
    if (!p.rows.length) { setErr('No lines found. Export the statement from your bank as CSV.'); return; }
    const h = p.headers;
    const out = find(h, /debit|withdraw|money_out|paid_out|outflow|d[ée]bit/);
    setCols({
      date: find(h, /date|booking|posted|value_?date/),
      text: find(h, /desc|detail|narrat|libell|memo|payee|beneficiary|counterparty|name|merchant/),
      amount: out ? '' : find(h, /amount|montant|value|sum|total/),
      out,
      ref: find(h, /^ref|reference|transaction_?id|id$/),
    });
    setCsv(p); setName(f.name); setSkip(new Set()); setCat({});
  };

  const lines = useMemo(() => {
    if (!csv) return [];
    return csv.rows.map((r, i) => {
      const raw = cols.out ? num(r[cols.out]) : num(r[cols.amount]);
      const outflow = cols.out ? raw > 0 : raw < 0;
      const amount = Math.abs(raw);
      const text = (r[cols.text] ?? '').trim();
      return { i, date: date(r[cols.date], dayFirst), text, amount, outflow, ref: cols.ref ? r[cols.ref] ?? '' : '' };
    }).filter((l) => l.amount > 0 && (showIn || l.outflow));
  }, [csv, cols, dayFirst, showIn]);

  const chosen = lines.filter((l) => !skip.has(l.i) && l.date && l.text);
  const payload = JSON.stringify(chosen.map((l) => ({ date: l.date, amount: l.amount, payee: l.text, category: cat[l.i] ?? guess(l.text), currency: cur, ref: l.ref })));
  const total = chosen.reduce((a, l) => a + l.amount, 0);
  const col = (k: keyof typeof cols, label: string, optional = false) => (
    <label>{label}
      <select value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: e.target.value })}>
        <option value="">{optional ? 'None' : 'Choose…'}</option>
        {csv!.headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </label>
  );

  return (
    <div className="fn-import">
      <label className="fn-drop">
        <input type="file" accept=".csv,text/csv" onChange={(e) => read(e.target.files?.[0])} />
        <b>{name || 'Choose the bank statement (CSV)'}</b>
        <small>Read in your browser: only the lines you tick are sent.</small>
      </label>
      {err && <p className="ep-warn" role="alert">{err}</p>}
      {csv && (
        <form action={action} className="ep-form">
          <input type="hidden" name="lines" value={payload} />
          <div className="fn-import-map">
            {col('date', 'Date')}
            {col('text', 'Description')}
            {col('amount', 'Amount (money out is negative)', true)}
            {col('out', 'Or: a separate money-out column', true)}
            {col('ref', 'Reference', true)}
            <label>Dates are written
              <select value={dayFirst ? 'd' : 'm'} onChange={(e) => setDayFirst(e.target.value === 'd')}><option value="d">Day first (31/10/2026)</option><option value="m">Month first (10/31/2026)</option></select>
            </label>
            <label>Currency of the account
              <select value={cur} onChange={(e) => setCur(e.target.value)}>{currencies.map((c) => <option key={c}>{c}</option>)}</select>
            </label>
          </div>
          <div className="fn-import-bar">
            <label className="ep-check"><input type="checkbox" checked={showIn} onChange={(e) => setShowIn(e.target.checked)} /> Show money coming in too</label>
            <span className="fn-sub fn-mu">{lines.length} line{lines.length === 1 ? '' : 's'} · {chosen.length} ticked · {new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(total)}</span>
          </div>
          {lines.length ? (
            <div className="ep-tablewrap fn-import-list"><table className="fn-table">
              <thead><tr><th><span className="ep-sr">Import</span></th><th>Date</th><th>Description</th><th className="ep-right">Amount</th><th>Category</th></tr></thead>
              <tbody>
                {lines.slice(0, 500).map((l) => (
                  <tr key={l.i} className={skip.has(l.i) ? 'is-off' : ''}>
                    <td><input type="checkbox" aria-label={`Import ${l.text}`} checked={!skip.has(l.i)} onChange={(e) => { const s = new Set(skip); if (e.target.checked) s.delete(l.i); else s.add(l.i); setSkip(s); }} /></td>
                    <td>{l.date || <span className="fn-dn">date?</span>}</td>
                    <td>{l.text || <span className="fn-dn">no description</span>}{!l.outflow && <small>money in</small>}</td>
                    <td className="ep-right">{l.amount.toFixed(2)}</td>
                    <td><select aria-label="Category" value={cat[l.i] ?? guess(l.text)} onChange={(e) => setCat({ ...cat, [l.i]: e.target.value })}>{CATS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <p className="fn-sub fn-mu">No money-out lines with these columns. Check the columns above.</p>}
          {lines.length > 500 && <p className="fn-sub fn-mu">Showing the first 500 lines; all ticked lines are imported.</p>}
          <div className="fn-xform-foot"><Submit>Import {chosen.length} expense{chosen.length === 1 ? '' : 's'}</Submit></div>
        </form>
      )}
    </div>
  );
}
