import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { getClients, getProducts } from '@/lib/data';
import { Back, PageHead } from '@/components/ui';
import { OrdersCsv } from './orders-csv';

export const metadata = { title: 'Import orders' };

export default async function ImportOrdersPage() {
  const ctx = await requireCtx();
  if (!ctx.can('orders.create')) redirect('/orders');
  const [products, clients] = await Promise.all([getProducts(ctx), ctx.org ? Promise.resolve([]) : getClients()]);
  return (
    <>
      <Back href="/orders">Orders</Back>
      <PageHead crumb="Orders" title="Import orders from a CSV" sub="Upload many orders at once, from any shop or spreadsheet. You see every order before anything is created." />
      <OrdersCsv
        fixedOrg={ctx.org ? { id: ctx.org.id, name: ctx.org.name } : null}
        clients={clients.map((c) => ({ id: c.id, name: c.name }))}
        products={products.map((p) => ({ sku: p.sku, name: p.name, org: p.org_id, customs: !!p.hs_code && !!Number(p.customs_value) }))}
      />
    </>
  );
}
