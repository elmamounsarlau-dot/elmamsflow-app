'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { applyStockCount, importProducts } from './actions';

type P = { id: string; sku: string; name: string; org: string; code: string; on_hand: number; quarantined: number };
type Org = { id: string; name: string; code: string };

/** Small CSV reader: commas or semicolons, quoted values, header row. */
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const clean = text.replace(/^﻿/, '');
  const first = clean.split(/\r?\n/)[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (q) {
      if (c === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  const lines = out.filter((r) => r.some((v) => v.trim() !== ''));
  const headers = (lines.shift() ?? []).map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return { headers, rows: lines.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const pick = (r: Record<string, string>, keys: string[]) => keys.map((k) => r[k]).find((v) => v !== undefined && v !== '') ?? '';

export function CsvImport({ canCount, canProducts, fixedOrg, clients, products }: { canCount: boolean; canProducts: boolean; fixedOrg: Org | null; clients: Org[]; products: P[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<'stock_count' | 'products'>(canCount ? 'stock_count' : 'products');
  const [file, setFile] = useState<{ name: string; text: string; hash: string } | null>(null);
  const [orgId, setOrgId] = useState(fixedOrg?.id ?? '');
  const [confirmedOn, setConfirmedOn] = useState(new Date().toISOString().slice(0, 10));
  const [confirmedBy, setConfirmedBy] = useState('China warehouse (WeChat)');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();

  const parsed = useMemo(() => (file ? parseCsv(file.text) : null), [file]);

  // ---------- stock count preview ----------
  const count = useMemo(() => {
    if (!parsed || kind !== 'stock_count') return null;
    const missing = ['sku'].filter((h) => !parsed.headers.includes(h));
    if (!parsed.headers.some((h) => ['counted', 'count', 'quantity', 'qty', 'on_hand'].includes(h))) missing.push('counted');
    const needCode = !fixedOrg;
    if (needCode && !parsed.headers.some((h) => ['client', 'client_code', 'code'].includes(h))) missing.push('client_code');
    const seen = new Set<string>();
    const rows = parsed.rows.map((r, i) => {
      const sku = pick(r, ['sku']).toUpperCase();
      const code = fixedOrg ? fixedOrg.code : pick(r, ['client_code', 'client', 'code']).toUpperCase();
      const raw = pick(r, ['counted', 'count', 'quantity', 'qty', 'on_hand']);
      const counted = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
      const p = products.find((x) => x.sku.toUpperCase() === sku && (fixedOrg ? x.org === fixedOrg.id : x.code.toUpperCase() === code));
      let error = '';
      if (!sku) error = 'No SKU';
      else if (!p) error = needCode ? `No product ${sku} for client ${code || '?'}` : `Unknown SKU ${sku}`;
      else if (Number.isNaN(counted)) error = `Count must be a whole number (got “${raw}”)`;
      else if (seen.has(p.id)) error = 'Same SKU twice in this file';
      else if (counted < p.quarantined) error = `Counted ${counted} but ${p.quarantined} are in quarantine`;
      if (p) seen.add(p.id);
      return { line: i + 2, sku, code, product: p, counted, note: pick(r, ['note', 'notes', 'comment']), error, diff: p && !Number.isNaN(counted) ? counted - p.on_hand : 0 };
    });
    return { missing, rows, errors: rows.filter((r) => r.error).length, changes: rows.filter((r) => !r.error && r.diff !== 0).length };
  }, [parsed, kind, products, fixedOrg]);

  // ---------- products preview ----------
  const prods = useMemo(() => {
    if (!parsed || kind !== 'products') return null;
    const missing = ['sku', 'name'].filter((h) => !parsed.headers.includes(h));
    const target = fixedOrg?.id ?? orgId;
    const seen = new Set<string>();
    const rows = parsed.rows.map((r, i) => {
      const sku = pick(r, ['sku']).toUpperCase().replace(/[^A-Z0-9\-_.]/g, '');
      const name = pick(r, ['name', 'product', 'product_name']);
      const weight = pick(r, ['weight_g', 'weight']);
      const value = pick(r, ['customs_value', 'value']);
      let error = '';
      let status = 'new';
      if (!sku) error = 'No SKU';
      else if (!name) error = 'No name';
      else if (weight && !/^\d+(\.\d+)?$/.test(weight)) error = 'Weight must be a number (grams)';
      else if (value && !/^\d+(\.\d+)?$/.test(value)) error = 'Customs value must be a number';
      else if (seen.has(sku)) error = 'Same SKU twice in this file';
      else if (products.some((p) => p.org === target && p.sku.toUpperCase() === sku)) status = 'exists';
      seen.add(sku);
      return { line: i + 2, sku, name, barcode: pick(r, ['barcode', 'ean', 'upc']), weight_g: Number(weight) || 0, hs_code: pick(r, ['hs_code', 'hs']), customs_value: Number(value) || 0, low_stock: Number(pick(r, ['low_stock'])) || 10, error, status };
    });
    return { missing, rows, errors: rows.filter((r) => r.error).length, fresh: rows.filter((r) => !r.error && r.status === 'new').length };
  }, [parsed, kind, products, fixedOrg, orgId]);

  const blocked = !parsed || (count ? count.missing.length > 0 || count.errors > 0 || count.rows.length === 0 : false) || (prods ? prods.missing.length > 0 || prods.errors > 0 || prods.fresh === 0 || !(fixedOrg || orgId) : false);

  const commit = () =>
    start(async () => {
      if (!file) return;
      const r =
        kind === 'stock_count' && count
          ? await applyStockCount(JSON.stringify({ rows: count.rows.map((x) => ({ product_id: x.product!.id, counted: x.counted, note: x.note })), file: file.name, hash: file.hash, confirmedOn, confirmedBy }))
          : prods
            ? await importProducts(JSON.stringify({ orgId, rows: prods.rows.filter((x) => x.status === 'new'), file: file.name, hash: file.hash }))
            : { ok: false, message: 'Nothing to import.' };
      setResult(r);
      if (r.ok) {
        setFile(null);
        router.refresh();
      }
    });

  return (
    <div className="ep-split">
      <div className="ep-card--grow">
        <section className="ep-card">
          <div className="ep-pills" style={{ marginBottom: '1rem' }}>
            {canCount && <button type="button" className={kind === 'stock_count' ? 'is-on' : ''} onClick={() => { setKind('stock_count'); setResult(null); }}>Warehouse stock count</button>}
            {canProducts && <button type="button" className={kind === 'products' ? 'is-on' : ''} onClick={() => { setKind('products'); setResult(null); }}>Products</button>}
          </div>
          <form className="ep-form" onSubmit={(e) => e.preventDefault()}>
            {kind === 'products' && !fixedOrg && (
              <label>Client<select value={orgId} onChange={(e) => setOrgId(e.target.value)} required><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            )}
            {kind === 'stock_count' && (
              <div className="ep-row2">
                <label>Counted on<input type="date" value={confirmedOn} onChange={(e) => setConfirmedOn(e.target.value)} /></label>
                <label>Confirmed by<input value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)} placeholder="Who sent the count" /></label>
              </div>
            )}
            <label>
              CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  setResult(null);
                  const f = e.target.files?.[0];
                  if (!f) return setFile(null);
                  const text = await f.text();
                  setFile({ name: f.name, text, hash: await sha256(`${kind}\n${text}`) });
                }}
              />
            </label>
          </form>
          {result && <p className={`ep-note ep-note--${result.ok ? 'ok' : 'err'}`} style={{ marginTop: '1rem' }}>{result.message}</p>}
        </section>

        {count && (
          <section className="ep-card">
            <div className="ep-card-head">
              <h2>Preview</h2>
              <span className="ep-muted ep-small">{count.rows.length} rows · {count.changes} will change · {count.errors ? <b className="ep-warn">{count.errors} with errors</b> : 'no errors'}</span>
            </div>
            {count.missing.length > 0 ? <p className="ep-note ep-note--err">Missing column{count.missing.length > 1 ? 's' : ''}: {count.missing.join(', ')}</p> : (
              <table className="ep-table">
                <thead><tr><th>Line</th><th>SKU</th><th>Product</th><th className="ep-right">On hand now</th><th className="ep-right">Counted</th><th className="ep-right">Difference</th><th>Check</th></tr></thead>
                <tbody>
                  {count.rows.map((r) => (
                    <tr key={r.line}>
                      <td>{r.line}</td>
                      <td><b>{r.sku}</b>{!fixedOrg && <small>{r.code}</small>}</td>
                      <td>{r.product?.name ?? '—'}</td>
                      <td className="ep-right">{r.product?.on_hand ?? '—'}</td>
                      <td className="ep-right">{Number.isNaN(r.counted) ? '—' : r.counted}</td>
                      <td className="ep-right">{r.error ? '—' : <b className={r.diff < 0 ? 'ep-neg' : r.diff > 0 ? 'ep-pos' : ''}>{r.diff > 0 ? '+' : ''}{r.diff}</b>}</td>
                      <td>{r.error ? <span className="ep-st ep-st--warn">{r.error}</span> : r.diff === 0 ? <span className="ep-st ep-st--mute">Matches</span> : <span className="ep-st ep-st--go">Will correct</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {prods && (
          <section className="ep-card">
            <div className="ep-card-head">
              <h2>Preview</h2>
              <span className="ep-muted ep-small">{prods.rows.length} rows · {prods.fresh} new · {prods.errors ? <b className="ep-warn">{prods.errors} with errors</b> : 'no errors'}</span>
            </div>
            {prods.missing.length > 0 ? <p className="ep-note ep-note--err">Missing column{prods.missing.length > 1 ? 's' : ''}: {prods.missing.join(', ')}</p> : (
              <table className="ep-table">
                <thead><tr><th>Line</th><th>SKU</th><th>Name</th><th className="ep-right">Weight (g)</th><th>HS code</th><th className="ep-right">Customs value</th><th>Check</th></tr></thead>
                <tbody>
                  {prods.rows.map((r) => (
                    <tr key={r.line}>
                      <td>{r.line}</td><td><b>{r.sku || '—'}</b></td><td>{r.name || '—'}</td><td className="ep-right">{r.weight_g || '—'}</td><td>{r.hs_code || <em className="ep-warn">missing</em>}</td><td className="ep-right">{r.customs_value ? `$${r.customs_value.toFixed(2)}` : '—'}</td>
                      <td>{r.error ? <span className="ep-st ep-st--warn">{r.error}</span> : r.status === 'exists' ? <span className="ep-st ep-st--mute">Already exists, skipped</span> : <span className="ep-st ep-st--ok">New</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {parsed && (
          <div className="ep-form-foot" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="ep-muted ep-small">{blocked ? 'Fix the rows marked in orange, then upload the file again.' : 'Nothing is saved until you confirm.'}</span>
            <button type="button" className="ep-btn" disabled={blocked || pending} onClick={commit}>
              {pending ? 'Importing…' : kind === 'stock_count' ? `Confirm and apply ${count?.changes ?? 0} correction${count?.changes === 1 ? '' : 's'}` : `Confirm and add ${prods?.fresh ?? 0} product${prods?.fresh === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
      </div>

      <section className="ep-card ep-card--side">
        <h2>{kind === 'stock_count' ? 'Stock count file' : 'Products file'}</h2>
        {kind === 'stock_count' ? (
          <>
            <p className="ep-small ep-muted" style={{ marginBottom: '.8rem' }}>Use this when the warehouse sends a count (for example on WeChat). Each row sets the counted quantity on hand for one SKU; the difference is recorded as a correction from this file.</p>
            <pre className="ep-code">{fixedOrg ? 'sku,counted,note\nLEMON-LIME,480,\nBERRY,120,2 boxes crushed' : 'client_code,sku,counted,note\nEMF-1001,LEMON-LIME,480,\nEMF-1001,BERRY,120,2 boxes crushed'}</pre>
            <ul className="ep-ticks ep-small">
              <li>The same file can never be applied twice.</li>
              <li>All rows apply together, or none do.</li>
              <li>Rows are marked as “CSV import” in each product’s history, with the date and who confirmed.</li>
            </ul>
          </>
        ) : (
          <>
            <p className="ep-small ep-muted" style={{ marginBottom: '.8rem' }}>Add many products at once. Existing SKUs are skipped, never overwritten.</p>
            <pre className="ep-code">sku,name,weight_g,hs_code,customs_value,barcode,low_stock{'\n'}LEMON-LIME,Hydration mix · Lemon lime,200,2106.90,4.50,,20</pre>
            <ul className="ep-ticks ep-small">
              <li>Only sku and name are required.</li>
              <li>Add HS code and customs value so orders don’t go on hold.</li>
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
