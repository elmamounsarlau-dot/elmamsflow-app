import { requirePerm } from '@/lib/guard';
import { getClients, getProducts, orgNames, productOptions } from '@/lib/data';
import { COUNTRIES } from '@/lib/format';
import { Arrow, Back } from '@/components/ui';
import { ItemRows, Submit } from '@/components/client';
import { createOrder } from '../actions';

export const metadata = { title: 'New order' };

export default async function NewOrder() {
  const ctx = await requirePerm('orders.create');
  const [products, clients, names] = await Promise.all([getProducts(ctx), ctx.org ? Promise.resolve([]) : getClients(), ctx.org ? Promise.resolve(undefined) : orgNames()]);
  return (
    <>
      <Back href="/orders">Orders</Back>
      <section className="ep-card ep-card--narrow">
        <h2>New order</h2>
        <p className="ep-muted ep-small" style={{ marginBottom: '1rem' }}>One order at a time. Store connections come in a later step.</p>
        <form action={createOrder} className="ep-form">
          <ItemRows products={productOptions(products, names)} clients={ctx.org ? undefined : clients.map((c) => ({ id: c.id, name: c.name }))} />
          <div className="ep-row2"><label>Customer name<input name="customer" required /></label><label>Your order reference<input name="store_ref" placeholder="e.g. #1042 from your store" /></label></div>
          <div className="ep-row2"><label>Email<input type="email" name="email" /></label><label>Phone<input name="phone" /></label></div>
          <label>Address<input name="address" required placeholder="Street and number" /></label>
          <div className="ep-row3">
            <label>City<input name="city" required /></label>
            <label>Postcode<input name="zip" /></label>
            <label>Country<select name="country" required defaultValue=""><option value="">Choose…</option>{Object.entries(COUNTRIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          </div>
          <label>Service<select name="service"><option value="express">Express · duties paid by the customer</option><option value="ddp">DDP · duties paid by you</option></select></label>
          <div><Submit>Create order <Arrow /></Submit></div>
        </form>
      </section>
    </>
  );
}
