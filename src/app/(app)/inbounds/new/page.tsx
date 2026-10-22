import { requirePerm } from '@/lib/guard';
import { getClients, getProducts, orgNames, productOptions } from '@/lib/data';
import { Arrow, Back } from '@/components/ui';
import { ItemRows, Submit } from '@/components/client';
import { createInbound } from '../actions';
import { getWarehouses, shippingWarehouses } from '@/lib/warehouses';

export const metadata = { title: 'Announce an inbound' };

export default async function NewInbound() {
  const ctx = await requirePerm('inbounds.create');
  const [products, clients, names, whs] = await Promise.all([getProducts(ctx), ctx.org ? Promise.resolve([]) : getClients(), ctx.org ? Promise.resolve(undefined) : orgNames(), getWarehouses()]);
  const dests = shippingWarehouses(whs);
  return (
    <>
      <Back href="/inbounds">Stock inbounds</Back>
      <section className="ep-card ep-card--narrow">
        <h2>Announce an inbound</h2>
        <p className="ep-muted ep-small" style={{ marginBottom: '1rem' }}>Tell us what the factory or supplier is sending to our warehouse.</p>
        <form action={createInbound} className="ep-form">
          <ItemRows products={productOptions(products, names)} clients={ctx.org ? undefined : clients.map((c) => ({ id: c.id, name: c.name }))} />
          <label>Deliver to warehouse
            <select name="warehouse_id" required defaultValue="">
              <option value="" disabled>Choose Guangzhou, Ningbo…</option>
              {dests.map((w) => <option key={w.id} value={w.id}>{w.name}{w.province ? ` (${w.province})` : ''}</option>)}
            </select>
          </label>
          <div className="ep-row3"><label>Supplier<input name="supplier" placeholder="Factory name" /></label><label>Cartons<input type="number" min={0} name="cartons" /></label><label>Expected arrival<input type="date" name="eta" /></label></div>
          <label>Notes<textarea name="notes" rows={2} placeholder="Fragile, mixed cartons, labels…" /></label>
          <div><Submit>Announce inbound <Arrow /></Submit></div>
        </form>
      </section>
    </>
  );
}
