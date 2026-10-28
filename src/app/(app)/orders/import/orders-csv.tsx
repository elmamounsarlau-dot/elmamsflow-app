'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { groupOrders, ORDER_COLS, parseCsv } from '@/lib/csv';
import { importOrdersCsv } from './actions';

type P = { sku: string; name: string; org: string; customs: boolean };
type Org = { id: string; name: string };

const TEMPLATE = 'order,customer,address,city,zip,country,email,phone,sku,qty\n1042,Camille Durand,12 Rue de Rivoli,Paris,75001,FR,camille@example.com,+33 6 12 34 56 78,LEMON-LIME,2\n1042,Camille Durand,12 Rue de Rivoli,Paris,75001,FR,camille@example.com,+33 6 12 34 56 78,BERRY,1\n1043,Jonas Becker,Hauptstraße 5,Berlin,10115,Germany,,,LEMON-LIME,1\n';

export function OrdersCsv({ fixedOrg, clients, products }: { fixedOrg: Org | null; clients: Org[]; products: P[] }) {
  const router = useRouter();
  const [orgId, setOrgId] = useState(fixedOrg?.id ?? '');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();

  const mine = useMemo(() => products.filter((p) => p.org === orgId), [products, orgId]);
  const preview = useMemo(() => {
    if (!file || !orgId) return null;
    const parsed = parseCsv(file.text);
    const has = (keys: string[]) => keys.some((k) => parsed.headers.includes(k));
    const missing = [
      ['order', ['order', 'order_number', 'order_no', 'order_id', 'reference', 'ref', 'name']],
      ['customer', ['customer', 'name_on_parcel', 'full_name', 'shipping_name', 'recipient']],
      ['address', ['address', 'address1', 'address_1', 'street']],
      ['country', ['country', 'country_code', 'shipping_country']],
      ['sku', ['sku', 'product_sku', 'item_sku']],
    ].filter(([, keys]) => !has(keys as string[])).map(([c]) => c as string);
    const orders = missing.length ? [] : groupOrders(parsed.rows, new Set(mine.map((p) => p.sku.toUpperCase())));
    const customs = new Map(mine.map((p) => [p.sku.toUpperCase(), p.customs]));
    const errors = orders.filter((o) => o.errors.length).length;
    const held = orders.filter((o) => !o.errors.length && o.lines.some((l) => customs.get(l.sku) === false)).length;
    return { missing, orders, errors, held, customs, units: orders.reduce((a, o) => a + o.lines.reduce((b, l) => b + l.qty, 0), 0) };
  }, [file, orgId, mine]);

  const blocked = !preview || !!preview.missing.length || !preview.orders.length || preview.errors > 0;
  const commit = () => start(async () => {
    const r = await importOrdersCsv(JSON.stringify({ orgId, text: file!.text, file: file!.name }));
    setResult(r);
    if (r.ok) { setFile(null); router.refresh(); }
  });

  return (
    <div className="ep-split">
      <div className="ep-card--grow">
        <section className="ep-card">
          <form className="ep-form" onSubmit={(e) => e.preventDefault()}>
            {!fixedOrg && (
              <label>Client<select value={orgId} onChange={(e) => { setOrgId(e.target.value); setResult(null); }} required><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            )}
            <label className={`ep-drop${file ? ' has-file' : ''}`}>
              <input type="file" accept=".csv,text/csv" disabled={!orgId} onChange={async (e) => { setResult(null); const f = e.target.files?.[0]; setFile(f ? { name: f.name, text: await f.text() } : null); e.target.value = ''; }} />
              <span className="ep-drop-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
              </span>
              <b>{file ? file.name : orgId ? 'Choose a CSV file' : 'Choose the client first'}</b>
              <small>{file ? 'Click to choose another file' : 'Excel or Google Sheets: File → Download / Save as → CSV'}</small>
            </label>
          </form>
          {result && <p className={`ep-note ep-note--${result.ok ? 'ok' : 'err'}`} style={{ marginTop: '1rem' }}>{result.message}{result.ok && <> <Link className="ep-link" href="/orders">See orders</Link></>}</p>}
        </section>

        {preview && (
          <section className="ep-card ep-card--flush">
            <div className="ep-card-head ep-pad">
              <h2>Preview</h2>
              <span className="ep-muted ep-small">{preview.orders.length} order{preview.orders.length === 1 ? '' : 's'} · {preview.units.toLocaleString('en')} units{preview.held ? ` · ${preview.held} will go on hold` : ''} · {preview.errors ? <b className="ep-warn">{preview.errors} with errors</b> : 'no errors'}</span>
            </div>
            {preview.missing.length > 0 ? <p className="ep-note ep-note--err" style={{ margin: '0 1.3rem 1.3rem' }}>Missing column{preview.missing.length > 1 ? 's' : ''}: {preview.missing.join(', ')}. Download the template to see the format.</p> : (
              <div className="ep-tablewrap">
                <table className="ep-table">
                  <thead><tr><th>Order</th><th>Customer</th><th>Destination</th><th>Products</th><th>Check</th></tr></thead>
                  <tbody>
                    {preview.orders.map((o, k) => {
                      const hold = !o.errors.length && o.lines.some((l) => preview.customs.get(l.sku) === false);
                      return (
                        <tr key={k}>
                          <td><b>{o.ref ? `#${o.ref}` : '—'}</b><small>line{o.lineNos.length > 1 ? 's' : ''} {o.lineNos.join(', ')}</small></td>
                          <td>{o.customer || '—'}<small>{o.email}</small></td>
                          <td>{[o.city, o.country].filter(Boolean).join(', ') || '—'}<small>DDP</small></td>
                          <td>{o.lines.map((l) => `${l.qty} × ${l.sku}`).join(', ') || '—'}</td>
                          <td>{o.errors.length ? <span className="ep-st ep-st--warn" title={o.errors.join(' · ')}>{o.errors[0]}{o.errors.length > 1 ? ` (+${o.errors.length - 1})` : ''}</span> : hold ? <span className="ep-st ep-st--pk">On hold: customs info</span> : <span className="ep-st ep-st--ok">Ready</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {preview && (
          <div className="ep-form-foot" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <span className="ep-muted ep-small">{blocked ? (preview.errors ? 'Fix the orders marked in orange in your file, then upload it again.' : 'Nothing to import.') : 'Nothing is created until you confirm. Order numbers already imported are skipped.'}</span>
            <button type="button" className="ep-btn" disabled={blocked || pending} onClick={commit}>{pending ? 'Importing…' : `Confirm and create ${preview.orders.length} order${preview.orders.length === 1 ? '' : 's'}`}</button>
          </div>
        )}
      </div>

      <section className="ep-card ep-card--side">
        <h2>Orders file</h2>
        <p className="ep-small ep-muted" style={{ margin: '.4rem 0 1rem' }}>One row per product. Rows with the same order number become one order with several products.</p>
        <p className="ep-eyebrow" style={{ marginBottom: '.5rem' }}><i />Columns</p>
        <ul className="ep-cols">
          {ORDER_COLS.map(([c, req, ex]) => <li key={c}><code>{c}</code>{req && <span className="ep-req">Required</span>}<small>{ex}</small></li>)}
        </ul>
        <a className="ep-btn ep-btn--ghost ep-btn--full" download="orders-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`}>Download the template</a>
        <ul className="ep-ticks ep-small" style={{ marginTop: '1rem' }}>
          <li>Nothing is created until you check the preview and confirm.</li>
          <li>All orders are created together, or none are.</li>
          <li>Uploading the same file twice never creates duplicates.</li>
          <li>Products missing customs info put that order on hold until it’s added.</li>
        </ul>
      </section>
    </div>
  );
}
