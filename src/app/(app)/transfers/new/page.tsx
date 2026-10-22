import { requirePerm } from '@/lib/guard';
import { getClients, getProducts, orgNames, productOptions } from '@/lib/data';
import { getWarehouses, shippingWarehouses } from '@/lib/warehouses';
import { Arrow, Back, PageHead } from '@/components/ui';
import { ItemRows, Submit } from '@/components/client';
import { createTransfer } from '../actions';

export const metadata = { title: 'New transfer' };

export default async function NewTransfer({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requirePerm('stock.adjust');
  const sp = await searchParams;
  const allocation = sp.kind === 'allocation' && ctx.staffRole === 'owner';
  const [products, clients, names, whs] = await Promise.all([getProducts(ctx), ctx.org ? Promise.resolve([]) : getClients(), ctx.org ? Promise.resolve(undefined) : orgNames(), getWarehouses()]);
  const real = shippingWarehouses(whs);
  const pool = whs.find((w) => w.kind === 'holding');
  const options = productOptions(allocation ? products.filter((p) => (p.unallocated ?? 0) > 0) : products, names).map((o) => {
    const p = products.find((x) => x.id === o.id);
    return allocation && p ? { ...o, label: `${o.label.replace(/ \(\d+ available\)$/, '')} — ${p.unallocated} unallocated` } : o;
  });
  return (
    <>
      <Back href="/transfers">Transfers</Back>
      <PageHead crumb="Inventory" title={allocation ? 'Allocate unallocated stock' : 'New transfer'}
        sub={allocation ? 'Stock recorded before warehouses existed sits in one pool. Put it where it physically is — with the evidence (count sheet, warehouse message).' : 'Move units from one warehouse to another. Stock leaves when you mark it sent, and arrives when the other side counts it.'} />
      <section className="ep-card ep-card--narrow">
        <form action={createTransfer} className="ep-form">
          <input type="hidden" name="kind" value={allocation ? 'allocation' : 'transfer'} />
          <input type="hidden" name="back" value={allocation ? '/transfers/new?kind=allocation' : '/transfers/new'} />
          <div className="ep-row2">
            {allocation && pool ? (
              <label>From<select name="from" defaultValue={pool.id}><option value={pool.id}>Unallocated (before warehouses)</option></select></label>
            ) : (
              <label>From<select name="from" required defaultValue=""><option value="" disabled>Sending warehouse</option>{real.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
            )}
            <label>To<select name="to" required defaultValue=""><option value="" disabled>Receiving warehouse</option>{real.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
          </div>
          <ItemRows products={options} clients={ctx.org ? undefined : clients.map((c) => ({ id: c.id, name: c.name }))} />
          <label>Reason<input name="reason" required maxLength={300} placeholder={allocation ? 'e.g. Physical count at Guangzhou' : 'e.g. Rebalance stock for EU orders'} /></label>
          {allocation && <label>Evidence<input name="evidence" required maxLength={500} placeholder="e.g. GZ count sheet 22 Oct, WeChat message from warehouse" /></label>}
          <div><Submit>{allocation ? 'Allocate' : 'Request transfer'} <Arrow /></Submit></div>
        </form>
      </section>
    </>
  );
}
