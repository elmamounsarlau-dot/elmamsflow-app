import { redirect } from 'next/navigation';
import { shippingOnly } from '@/lib/session';
import { requirePerm } from '@/lib/guard';
import { getClients } from '@/lib/data';
import { Back } from '@/components/ui';
import { Submit } from '@/components/client';
import { ImagePick } from '@/components/media';
import { addProduct } from '../actions';

export const metadata = { title: 'Add product' };

export default async function NewProduct() {
  const ctx = await requirePerm('products.edit');
  if (shippingOnly(ctx)) redirect('/shipping');
  const clients = ctx.org ? [] : await getClients();
  return (
    <>
      <Back href="/inventory">Inventory</Back>
      <div className="ep-head"><div><h1>Add a product</h1><p>One SKU at a time. To add many at once, use Import CSV.</p></div></div>
      <div className="ep-split">
        <section className="ep-card">
          <form action={addProduct} className="ep-form ep-newp">
            <div className="ep-seg" role="radiogroup" aria-label="What are you adding?">
              <label><input type="radio" name="kind" value="item" defaultChecked /><span><b>Single product</b><small>One SKU we store and ship</small></span></label>
              <label><input type="radio" name="kind" value="bundle" /><span><b>Kit or bundle</b><small>Several of your products sold as one</small></span></label>
            </div>
            {!ctx.org && <label>Client<select name="org_id" required defaultValue=""><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
            <div className="ep-newp-top">
              <div className="ep-only-item"><ImagePick name="photo" label="Photo" hint="Optional" size={104} /></div>
              <div className="ep-newp-fields">
                <div className="ep-row2"><label>SKU<input name="sku" required placeholder="MASK-BLK" /></label><label className="ep-only-item">Barcode<input name="barcode" placeholder="EAN / UPC" /></label></div>
                <label>Product name<input name="name" required placeholder="Silk sleep mask · Black" /></label>
              </div>
            </div>
            <div className="ep-row2 ep-only-item"><label>Weight (g)<input type="number" name="weight_g" min={0} /></label><label>Low-stock alert at<input type="number" name="low_stock" min={0} defaultValue={10} /></label></div>
            <div className="ep-row2 ep-only-item"><label>HS code<input name="hs_code" placeholder="e.g. 6307.90" /></label><label>Customs value (USD)<input type="number" step="0.01" min={0} name="customs_value" /></label></div>
            <p className="ep-note ep-only-kit">Next you choose the products inside the kit. A kit has no stock of its own: when it’s ordered we pick its products, and its availability follows theirs.</p>
            <div className="ep-form-foot"><Submit>Add</Submit></div>
          </form>
        </section>
        <section className="ep-card ep-card--side">
          <h2>Why these fields</h2>
          <ul className="ep-ticks ep-small" style={{ marginTop: '.8rem' }}>
            <li><b>Weight</b> sets the shipping cost of each parcel.</li>
            <li><b>HS code and customs value</b> go on the customs declaration. Orders without them are held.</li>
            <li><b>Low-stock alert</b> warns you before you run out, even if the product isn’t selling yet.</li>
            <li><b>Kits</b> (a gift box, a bundle deal) ship their products together. Use the kit’s SKU in your store.</li>
          </ul>
        </section>
      </div>
    </>
  );
}
