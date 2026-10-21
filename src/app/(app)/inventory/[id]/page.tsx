import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { available, type ProductRow } from '@/lib/data';
import { fmtDays, HEALTH, runway, salesByProduct } from '@/lib/insights';
import { fmtDate } from '@/lib/format';
import { Back, Empty, TeamOnly } from '@/components/ui';
import { Submit } from '@/components/client';
import { adjustStock, quarantineStock, releaseStock, updateProduct } from '../actions';

const TYPES: Record<string, string> = { inbound: 'Received', order: 'Shipped', adjust: 'Correction', count: 'Warehouse count', quarantine: 'To quarantine', release: 'Out of quarantine' };
const SOURCE: Record<string, string> = { manual: 'Entered in app', csv: 'CSV import', warehouse: 'Warehouse confirmed' };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('product_stock').select('*').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data } = await q.maybeSingle();
  if (!data) notFound();
  const p = data as ProductRow;
  const [{ data: moves }, sales, { data: org }] = await Promise.all([
    sb.from('stock_moves').select('*').eq('product_id', id).order('created_at', { ascending: false }).limit(100),
    salesByProduct(ctx, 30),
    ctx.backOffice ? sb.from('organizations').select('name').eq('id', p.org_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const r = runway(p, sales.get(p.id) ?? 0);
  const [hl, tone] = HEALTH[r.health];
  const av = available(p);
  const max = Math.max(1, av + p.reserved + p.quarantined + p.incoming);
  const back = `/inventory/${p.id}`;
  const tools = ctx.can('stock.adjust');
  const missing = !p.hs_code || !Number(p.customs_value);
  return (
    <>
      <Back href="/inventory">Inventory</Back>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">{org?.name ? `${org.name} · ` : ''}Product</p>
          <h1>{p.sku} <span className={`ep-st ep-st--${tone}`}>{hl}</span></h1>
          <p>{p.name} · {p.hs_code ? `HS ${p.hs_code}` : <em className="ep-warn">HS code missing</em>} · customs value ${Number(p.customs_value).toFixed(2)}{p.weight_g ? ` · ${p.weight_g} g` : ''}</p>
        </div>
        {ctx.can('products.edit') && <div className="ep-actions"><a className="ep-btn ep-btn--ghost" href="#edit">Edit details</a></div>}
      </div>

      {missing && ctx.can('products.edit') && (
        <a href="#edit" className="ep-fixbar">
          <span><b>Customs info missing.</b> Add the {!p.hs_code && 'HS code'}{!p.hs_code && !Number(p.customs_value) && ' and '}{!Number(p.customs_value) && 'customs value'} so orders with this product aren’t held.</span>
          <em>Fix now →</em>
        </a>
      )}

      <div className="ep-sum ep-sum--5">
        <div className="ep-sum-card"><small>Sellable</small><b>{av.toLocaleString('en')}</b><span>Ready to ship today</span></div>
        <div className="ep-sum-card"><small>In warehouse</small><b>{p.on_hand.toLocaleString('en')}</b><span>{p.reserved} reserved · {p.quarantined} quarantine</span></div>
        <div className="ep-sum-card"><small>Incoming</small><b>{p.incoming.toLocaleString('en')}</b><span>On open inbounds</span></div>
        <div className="ep-sum-card"><small>Sold · 30 days</small><b>{r.sold30.toLocaleString('en')}</b><span>{r.daily ? `${r.daily.toFixed(1)} a day` : 'No sales yet'}</span></div>
        <div className={`ep-sum-card${r.health === 'critical' || r.health === 'out' ? ' is-alert' : r.health === 'warning' ? ' is-warn' : ''}`}><small>Runway</small><b>{fmtDays(r.days)}</b><span>{r.reorder ? `Reorder about ${r.reorder.toLocaleString('en')} units` : 'No reorder needed'}</span></div>
      </div>

      <section className="ep-card">
        <div className="ep-card-head"><h2>Where the units are</h2><span className="ep-legend"><i className="a" />Sellable <i className="r" />Reserved <i className="q" />Quarantine <i className="n" />Incoming</span></div>
        <div className="ep-bar3 ep-bar3--big"><i className="a" style={{ width: `${(av / max) * 100}%` }} /><i className="r" style={{ width: `${(p.reserved / max) * 100}%` }} /><i className="q" style={{ width: `${(p.quarantined / max) * 100}%` }} /><i className="n" style={{ width: `${(p.incoming / max) * 100}%` }} /></div>
      </section>

      {tools && (
        <div className="ep-tools">
          <section className="ep-card ep-card--team">
            <h2>Quarantine</h2>
            <TeamOnly />
            <p className="ep-small ep-muted" style={{ marginBottom: '.8rem' }}>Set aside damaged or doubtful units. They stay in the warehouse but can’t be sold.</p>
            <form action={quarantineStock} className="ep-form">
              <input type="hidden" name="product" value={p.id} /><input type="hidden" name="back" value={back} />
              <div className="ep-row2"><label>Units<input type="number" name="qty" min={1} max={av + p.reserved} required /></label><label>Reason<input name="reason" required placeholder="e.g. Crushed boxes" /></label></div>
              <Submit className="ep-btn ep-btn--ghost ep-btn--full">Move to quarantine</Submit>
            </form>
          </section>
          {p.quarantined > 0 && (
            <section className="ep-card ep-card--team">
              <h2>Release from quarantine</h2>
              <TeamOnly />
              <form action={releaseStock} className="ep-form">
                <input type="hidden" name="product" value={p.id} /><input type="hidden" name="back" value={back} />
                <div className="ep-row2"><label>Units<input type="number" name="qty" min={1} max={p.quarantined} required /></label><label>Decision<select name="mode"><option value="release">Back to sellable</option><option value="writeoff">Write off (remove)</option></select></label></div>
                <label>Reason<input name="reason" required placeholder="e.g. Checked OK / Unsellable" /></label>
                <Submit className="ep-btn ep-btn--ghost ep-btn--full">Confirm</Submit>
              </form>
            </section>
          )}
          <section className="ep-card ep-card--team">
            <h2>Correct stock</h2>
            <TeamOnly />
            <form action={adjustStock} className="ep-form">
              <input type="hidden" name="product" value={p.id} /><input type="hidden" name="back" value={back} />
              <div className="ep-row2"><label>Units (+ or −)<input type="number" name="qty" required placeholder="-2" /></label><label>Reason<select name="reason"><option>Cycle count</option><option>Damaged</option><option>Found</option><option>Opening stock</option><option>Other</option></select></label></div>
              <Submit className="ep-btn ep-btn--ghost ep-btn--full">Save correction</Submit>
            </form>
          </section>
        </div>
      )}

      {ctx.can('products.edit') && (
        <section className={`ep-card${missing ? ' ep-card--hl' : ''}`} id="edit">
          <div className="ep-card-head"><h2>Product details</h2><span className="ep-muted ep-small">SKU {p.sku} can’t be changed. Stock changes only through inbounds, orders and the warehouse.</span></div>
          <form action={updateProduct} className="ep-form">
            <input type="hidden" name="product" value={p.id} />
            <div className="ep-row2"><label>Product name<input name="name" defaultValue={p.name} required /></label><label>Barcode<input name="barcode" defaultValue={p.barcode ?? ''} placeholder="EAN / UPC" /></label></div>
            <div className="ep-row4">
              <label>HS code<input name="hs_code" defaultValue={p.hs_code ?? ''} placeholder="e.g. 6307.90" autoFocus={missing && !p.hs_code} className={!p.hs_code ? 'is-missing' : ''} /></label>
              <label>Customs value (USD)<input type="number" step="0.01" min={0} name="customs_value" defaultValue={Number(p.customs_value) || ''} className={!Number(p.customs_value) ? 'is-missing' : ''} /></label>
              <label>Weight (g)<input type="number" min={0} name="weight_g" defaultValue={p.weight_g || ''} /></label>
              <label>Low-stock alert at<input type="number" min={0} name="low_stock" defaultValue={p.low_stock} /></label>
            </div>
            <div className="ep-form-foot" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
              <span className="ep-small ep-muted">Not sure of the HS code? Search the product on <a href="https://www.tariffnumber.com" target="_blank" rel="noreferrer">tariffnumber.com</a> or ask us in Support.</span>
              <Submit>Save details</Submit>
            </div>
          </form>
        </section>
      )}

      <section className="ep-card ep-card--flush">
        <div className="ep-card-head ep-pad"><h2>Stock history</h2><span className="ep-muted ep-small">Every unit in and out, with its source</span></div>
        {(moves ?? []).length === 0 ? <Empty title="No movement yet" text="Stock arrives through inbounds and leaves with orders." /> : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Date</th><th>Movement</th><th>Reference</th><th>Note</th><th>Source</th><th className="ep-right">Units</th></tr></thead>
              <tbody>{(moves ?? []).map((m) => <tr key={m.id}><td><small>{fmtDate(m.created_at, true)}</small></td><td>{TYPES[m.type] ?? m.type}</td><td>{m.ref || '—'}</td><td><small>{m.note || '—'}</small></td><td><small>{SOURCE[m.source] ?? m.source}</small></td><td className="ep-right"><b className={['quarantine', 'release'].includes(m.type) ? 'ep-q' : m.qty < 0 ? 'ep-neg' : 'ep-pos'}>{m.qty > 0 ? '+' : ''}{m.qty}</b></td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
