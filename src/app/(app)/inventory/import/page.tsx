import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { getClients, getProducts } from '@/lib/data';
import { Back, PageHead } from '@/components/ui';
import { CsvImport } from './csv-import';
import { getWarehouses, shippingWarehouses, type WarehouseStock } from '@/lib/warehouses';
import { allRows } from '@/lib/data';
import { supabaseServer } from '@/lib/supabase/server';

export const metadata = { title: 'Import CSV' };

export default async function ImportPage() {
  const ctx = await requireCtx();
  const canCount = ctx.can('stock.adjust');
  const canProducts = ctx.can('products.edit');
  if (!canCount && !canProducts) redirect('/inventory');
  const sb = await supabaseServer();
  const [products, clients, whs, stock] = await Promise.all([getProducts(ctx), getClients(), getWarehouses(), allRows<WarehouseStock>(() => sb.from('warehouse_stock').select('product_id, warehouse_id, on_hand, quarantined').order('product_id').order('warehouse_id'))]);
  const atWh: Record<string, Record<string, { on_hand: number; quarantined: number }>> = {};
  for (const s of stock) (atWh[s.warehouse_id] ??= {})[s.product_id] = { on_hand: s.on_hand, quarantined: s.quarantined };
  const code = Object.fromEntries(clients.map((c) => [c.id, c.code ?? '']));
  return (
    <>
      <Back href="/inventory">Inventory</Back>
      <PageHead crumb="Inventory" title="Import CSV" sub="Add many products at once, or apply a warehouse stock count." />
      <CsvImport
        canCount={canCount}
        canProducts={canProducts}
        fixedOrg={ctx.org ? { id: ctx.org.id, name: ctx.org.name, code: ctx.org.code ?? '' } : null}
        clients={clients.map((c) => ({ id: c.id, name: c.name, code: c.code ?? '' }))}
        warehouses={shippingWarehouses(whs).map((w) => ({ id: w.id, name: w.name }))}
        atWarehouse={atWh}
        products={products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, org: p.org_id, code: code[p.org_id] ?? '', on_hand: p.on_hand, quarantined: p.quarantined }))}
      />
    </>
  );
}
