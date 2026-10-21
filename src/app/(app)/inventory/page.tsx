import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { available, getClients, getProducts, orgNames } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { Empty, TeamOnly } from '@/components/ui';
import { Submit } from '@/components/client';
import { addProduct, adjustStock, quarantineStock, releaseStock } from './actions';

export const metadata = { title: 'Inventory' };

export default async function Inventory({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const [products, clients, names] = await Promise.all([getProducts(ctx), ctx.org ? Promise.resolve([]) : getClients(), ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  const quarantined = products.filter((p) => p.quarantined > 0);
  const label = (p: (typeof products)[number]) => `${ctx.backOffice ? `${names[p.org_id]} — ` : ''}${p.sku} · ${p.name}`;
  return (
    <>
      <div className="ep-title-row">
        <h1 className="ep-page-title">Inventory</h1>
        <div className="ep-actions">
          {(ctx.can('stock.adjust') || ctx.can('products.edit')) && <Link className="ep-btn ep-btn--ghost" href="/inventory/import">Import CSV</Link>}
        </div>
      </div>
      <p className="ep-muted ep-small" style={{ marginTop: '-6px', marginBottom: '14px' }}>
        Balances are kept from receipts, shipments and corrections recorded here. The China warehouse confirms counts by WeChat, so they are entered or imported by our team, not synchronised automatically.
      </p>
      <div className="ep-split">
        <div className="ep-card--grow">
        <section className="ep-card">
          <div className="ep-card-head"><h2>Products</h2><span className="ep-legend"><i className="a" />Available <i className="r" />Reserved <i className="q" />Quarantine <i className="n" />Incoming</span></div>
          {products.length === 0 ? <Empty title="No products yet" text="Add the first product: SKU, weight and customs details." /> : (
            <table className="ep-table">
              <thead><tr><th>Product</th>{ctx.backOffice && <th>Client</th>}<th className="ep-w40">Stock</th><th className="ep-right">Available</th><th className="ep-right">On hand</th><th className="ep-right">Reserved</th><th className="ep-right">Quarantine</th><th className="ep-right">Incoming</th><th>Updated</th></tr></thead>
              <tbody>
                {products.map((p) => {
                  const av = available(p);
                  const max = Math.max(1, av + p.reserved + p.quarantined + p.incoming);
                  return (
                    <tr key={p.id} data-href={`/inventory/${p.id}`}>
                      <td><b>{p.sku}</b><small>{p.name}{!p.hs_code && <em className="ep-warn"> · HS code missing</em>}</small></td>
                      {ctx.backOffice && <td>{names[p.org_id]}</td>}
                      <td><div className="ep-bar3"><i className="a" style={{ width: `${(av / max) * 100}%` }} /><i className="r" style={{ width: `${(p.reserved / max) * 100}%` }} /><i className="q" style={{ width: `${(p.quarantined / max) * 100}%` }} /><i className="n" style={{ width: `${(p.incoming / max) * 100}%` }} /></div></td>
                      <td className="ep-right"><b className={av <= p.low_stock ? 'ep-warn' : ''}>{av}</b></td>
                      <td className="ep-right">{p.on_hand}</td>
                      <td className="ep-right">{p.reserved}</td>
                      <td className="ep-right">{p.quarantined ? <span className="ep-st ep-st--warn">{p.quarantined}</span> : 0}</td>
                      <td className="ep-right">{p.incoming}</td>
                      <td><small>{p.last_movement_at ? fmtDate(p.last_movement_at, true) : '—'}</small></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
          {ctx.can('stock.adjust') && products.length > 0 && (
            <div className="ep-tools">
              <section className="ep-card ep-card--team">
                <h2>Quarantine</h2>
                <TeamOnly />
                <p className="ep-small ep-muted" style={{ marginBottom: '.8rem' }}>Set aside damaged or doubtful units. They stay on hand but can’t be sold.</p>
                <form action={quarantineStock} className="ep-form">
                  <label>Product<select name="product" required defaultValue=""><option value="">Choose…</option>{products.map((p) => <option key={p.id} value={p.id}>{label(p)} ({available(p) + p.reserved} sellable)</option>)}</select></label>
                  <div className="ep-row2"><label>Units<input type="number" name="qty" min={1} required /></label><label>Reason<input name="reason" required placeholder="e.g. Crushed boxes" /></label></div>
                  <Submit className="ep-btn ep-btn--ghost ep-btn--full">Move to quarantine</Submit>
                </form>
              </section>
              {quarantined.length > 0 && (
                <section className="ep-card ep-card--team">
                  <h2>Release from quarantine</h2>
                  <TeamOnly />
                  <form action={releaseStock} className="ep-form">
                    <label>Product<select name="product" required defaultValue=""><option value="">Choose…</option>{quarantined.map((p) => <option key={p.id} value={p.id}>{label(p)} ({p.quarantined} in quarantine)</option>)}</select></label>
                    <div className="ep-row2"><label>Units<input type="number" name="qty" min={1} required /></label><label>Decision<select name="mode"><option value="release">Back to available</option><option value="writeoff">Write off (remove)</option></select></label></div>
                    <label>Reason<input name="reason" required placeholder="e.g. Checked OK / Unsellable" /></label>
                    <Submit className="ep-btn ep-btn--ghost ep-btn--full">Confirm</Submit>
                  </form>
                </section>
              )}
              <section className="ep-card ep-card--team">
                <h2>Correct stock</h2>
                <TeamOnly />
                <form action={adjustStock} className="ep-form">
                  <label>Product<select name="product" required defaultValue=""><option value="">Choose…</option>{products.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}</select></label>
                  <div className="ep-row2"><label>Units (+ or −)<input type="number" name="qty" required placeholder="-2" /></label><label>Reason<select name="reason"><option>Cycle count</option><option>Damaged</option><option>Found</option><option>Opening stock</option><option>Other</option></select></label></div>
                  <Submit className="ep-btn ep-btn--ghost ep-btn--full">Save correction</Submit>
                </form>
              </section>
            </div>
          )}
        </div>
        <div className="ep-card--side">
          {ctx.can('products.edit') && (
            <section className={`ep-card${sp.new ? ' ep-card--hl' : ''}`}>
              <h2>Add a product</h2>
              <form action={addProduct} className="ep-form">
                {!ctx.org && <label>Client<select name="org_id" required defaultValue=""><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
                <div className="ep-row2"><label>SKU<input name="sku" required placeholder="MASK-BLK" /></label><label>Barcode<input name="barcode" placeholder="EAN / UPC" /></label></div>
                <label>Product name<input name="name" required placeholder="Silk sleep mask · Black" /></label>
                <div className="ep-row2"><label>Weight (g)<input type="number" name="weight_g" min={0} /></label><label>Low-stock alert at<input type="number" name="low_stock" min={0} defaultValue={10} /></label></div>
                <div className="ep-row2"><label>HS code<input name="hs_code" placeholder="e.g. 6307.90" /></label><label>Customs value (USD)<input type="number" step="0.01" min={0} name="customs_value" /></label></div>
                <Submit className="ep-btn ep-btn--full">Add product</Submit>
                <p className="ep-small ep-muted">HS code and customs value are needed to ship; orders without them go on hold.</p>
              </form>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
