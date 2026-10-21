import { requirePerm } from '@/lib/guard';
import { getClients } from '@/lib/data';
import { Back } from '@/components/ui';
import { Submit } from '@/components/client';
import { addProduct } from '../actions';

export const metadata = { title: 'Add product' };

export default async function NewProduct() {
  const ctx = await requirePerm('products.edit');
  const clients = ctx.org ? [] : await getClients();
  return (
    <>
      <Back href="/inventory">Inventory</Back>
      <div className="ep-head"><div><h1>Add a product</h1><p>One SKU at a time. To add many at once, use Import CSV.</p></div></div>
      <div className="ep-split">
        <section className="ep-card">
          <form action={addProduct} className="ep-form">
            {!ctx.org && <label>Client<select name="org_id" required defaultValue=""><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
            <div className="ep-row2"><label>SKU<input name="sku" required placeholder="MASK-BLK" /></label><label>Barcode<input name="barcode" placeholder="EAN / UPC" /></label></div>
            <label>Product name<input name="name" required placeholder="Silk sleep mask · Black" /></label>
            <div className="ep-row2"><label>Weight (g)<input type="number" name="weight_g" min={0} /></label><label>Low-stock alert at<input type="number" name="low_stock" min={0} defaultValue={10} /></label></div>
            <div className="ep-row2"><label>HS code<input name="hs_code" placeholder="e.g. 6307.90" /></label><label>Customs value (USD)<input type="number" step="0.01" min={0} name="customs_value" /></label></div>
            <div className="ep-form-foot"><Submit>Add product</Submit></div>
          </form>
        </section>
        <section className="ep-card ep-card--side">
          <h2>Why these fields</h2>
          <ul className="ep-ticks ep-small" style={{ marginTop: '.8rem' }}>
            <li><b>Weight</b> sets the shipping cost of each parcel.</li>
            <li><b>HS code and customs value</b> go on the customs declaration. Orders without them are held.</li>
            <li><b>Low-stock alert</b> warns you before you run out, even if the product isn’t selling yet.</li>
          </ul>
        </section>
      </div>
    </>
  );
}
