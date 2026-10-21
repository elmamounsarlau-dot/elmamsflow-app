import { requireCtx } from '@/lib/session';
import { getClients, getProducts, orgNames } from '@/lib/data';
import { Empty, TeamOnly } from '@/components/ui';
import { Submit } from '@/components/client';
import { addProduct, adjustStock } from './actions';

export const metadata = { title: 'Inventory' };

export default async function Inventory({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const [products, clients, names] = await Promise.all([getProducts(ctx), ctx.org ? Promise.resolve([]) : getClients(), ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  return (
    <>
      <h1 className="ep-page-title">Inventory</h1>
      <div className="ep-split">
        <section className="ep-card ep-card--grow">
          <div className="ep-card-head"><h2>Products</h2><span className="ep-legend"><i className="a" />Available <i className="r" />Reserved <i className="n" />Incoming</span></div>
          {products.length === 0 ? <Empty title="No products yet" text="Add the first product: SKU, weight and customs details." /> : (
            <table className="ep-table">
              <thead><tr><th>Product</th>{ctx.backOffice && <th>Client</th>}<th className="ep-w40">Stock</th><th className="ep-right">Available</th><th className="ep-right">Reserved</th><th className="ep-right">Incoming</th></tr></thead>
              <tbody>
                {products.map((p) => {
                  const av = Math.max(0, p.on_hand - p.reserved);
                  const max = Math.max(1, av + p.reserved + p.incoming);
                  return (
                    <tr key={p.id} data-href={`/inventory/${p.id}`}>
                      <td><b>{p.sku}</b><small>{p.name}{!p.hs_code && <em className="ep-warn"> · HS code missing</em>}</small></td>
                      {ctx.backOffice && <td>{names[p.org_id]}</td>}
                      <td><div className="ep-bar3"><i className="a" style={{ width: `${(av / max) * 100}%` }} /><i className="r" style={{ width: `${(p.reserved / max) * 100}%` }} /><i className="n" style={{ width: `${(p.incoming / max) * 100}%` }} /></div></td>
                      <td className="ep-right"><b className={av <= p.low_stock ? 'ep-warn' : ''}>{av}</b></td>
                      <td className="ep-right">{p.reserved}</td>
                      <td className="ep-right">{p.incoming}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
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
          {ctx.can('stock.adjust') && products.length > 0 && (
            <section className="ep-card ep-card--team">
              <h2>Adjust stock</h2>
              <TeamOnly />
              <form action={adjustStock} className="ep-form">
                <label>Product<select name="product" required defaultValue=""><option value="">Choose…</option>{products.map((p) => <option key={p.id} value={p.id}>{ctx.backOffice ? `${names[p.org_id]} — ` : ''}{p.sku} · {p.name}</option>)}</select></label>
                <div className="ep-row2"><label>Units (+ or −)<input type="number" name="qty" required placeholder="-2" /></label><label>Reason<select name="reason"><option>Cycle count</option><option>Damaged</option><option>Found</option><option>Opening stock</option><option>Other</option></select></label></div>
                <Submit className="ep-btn ep-btn--ghost ep-btn--full">Save adjustment</Submit>
              </form>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
