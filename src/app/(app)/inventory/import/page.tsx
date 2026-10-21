import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { getClients, getProducts } from '@/lib/data';
import { Back } from '@/components/ui';
import { CsvImport } from './csv-import';

export const metadata = { title: 'Import CSV' };

export default async function ImportPage() {
  const ctx = await requireCtx();
  const canCount = ctx.can('stock.adjust');
  const canProducts = ctx.can('products.edit');
  if (!canCount && !canProducts) redirect('/inventory');
  const [products, clients] = await Promise.all([getProducts(ctx), getClients()]);
  const code = Object.fromEntries(clients.map((c) => [c.id, c.code ?? '']));
  return (
    <>
      <Back href="/inventory">Inventory</Back>
      <h1 className="ep-page-title">Import CSV</h1>
      <CsvImport
        canCount={canCount}
        canProducts={canProducts}
        fixedOrg={ctx.org ? { id: ctx.org.id, name: ctx.org.name, code: ctx.org.code ?? '' } : null}
        clients={clients.map((c) => ({ id: c.id, name: c.name, code: c.code ?? '' }))}
        products={products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, org: p.org_id, code: code[p.org_id] ?? '', on_hand: p.on_hand, quarantined: p.quarantined }))}
      />
    </>
  );
}
