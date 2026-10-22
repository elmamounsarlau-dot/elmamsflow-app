import { shippingOnly } from '@/lib/session';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { allRows } from '@/lib/data';
import { getWarehouses, type WarehouseStock } from '@/lib/warehouses';
import { Arrow, Badge, Kpi, PageHead } from '@/components/ui';
import { Submit } from '@/components/client';
import { addWarehouse, toggleWarehouse } from './actions';

export const metadata = { title: 'Warehouses' };

const ACTIVE: Record<string, [string, string]> = { true: ['Open', 'ok'], false: ['Closed', 'mute'] };

export default async function Warehouses() {
  const ctx = await requireCtx();
  if (shippingOnly(ctx)) redirect('/shipping');
  if (!ctx.backOffice) redirect('/inventory');
  const sb = await supabaseServer();
  const [whs, stock, { data: openOrders }] = await Promise.all([
    getWarehouses(),
    allRows<WarehouseStock>(() => sb.from('warehouse_stock').select('product_id, warehouse_id, on_hand, quarantined, reserved').order('product_id').order('warehouse_id')),
    sb.from('orders').select('warehouse_id, status').in('status', ['new', 'on_hold', 'packed']).limit(5000),
  ]);
  const tot = (id: string) => {
    const rows = stock.filter((s) => s.warehouse_id === id);
    const onHand = rows.reduce((a, s) => a + s.on_hand, 0);
    const q = rows.reduce((a, s) => a + s.quarantined, 0);
    const r = rows.reduce((a, s) => a + s.reserved, 0);
    return { skus: rows.filter((s) => s.on_hand > 0).length, onHand, q, r, free: onHand - q - r };
  };
  const physical = whs.filter((w) => w.kind === 'physical');
  const holding = whs.find((w) => w.kind === 'holding');
  const un = holding ? tot(holding.id) : null;
  const unassigned = (openOrders ?? []).filter((o) => !o.warehouse_id).length;
  const isOwner = ctx.staffRole === 'owner' && !ctx.viewingAs;
  return (
    <>
      <PageHead crumb="Inventory" title="Warehouses" sub="Stock is kept per warehouse. An order ships only from stock at its own warehouse; move stock with a transfer.">
        {ctx.can('stock.adjust') && <Link className="ep-btn" href="/transfers/new">New transfer <Arrow /></Link>}
      </PageHead>

      {(un && un.onHand !== 0) || unassigned > 0 ? (
        <section className="ep-note ep-note--warn" style={{ marginBottom: "1.2rem" }}>
          <h2>Needs a warehouse</h2>
          {un && un.onHand !== 0 && (
            <p>
              <b>{un.onHand.toLocaleString('en')} units</b> across {un.skus} SKU{un.skus === 1 ? '' : 's'} were recorded before warehouses existed. They can’t ship until the owner
              allocates them to Guangzhou or Ningbo with evidence (a count or a message from the warehouse). {isOwner && <Link href="/transfers/new?kind=allocation">Allocate stock</Link>}
            </p>
          )}
          {un && un.onHand < 0 && <p className="ep-warn">The unallocated balance is negative: units were shipped that were never received. Use <b>Reconcile</b> on the product, with evidence.</p>}
          {unassigned > 0 && <p><b>{unassigned} open order{unassigned === 1 ? '' : 's'}</b> have no warehouse yet. <Link href="/orders">Choose one on the Orders page</Link>.</p>}
        </section>
      ) : null}

      <div className="ep-kpis">
        {physical.filter((w) => w.active).map((w) => { const t = tot(w.id); return <Kpi key={w.id} label={`${w.name} · free to ship`} value={t.free.toLocaleString('en')} />; })}
      </div>

      <section className="ep-card ep-card--flush">
        <div className="ep-tablewrap">
          <table className="ep-table">
            <thead><tr><th>Warehouse</th><th>Code</th><th className="ep-right">On hand</th><th className="ep-right">Quarantine</th><th className="ep-right">Reserved</th><th className="ep-right">Free to ship</th><th className="ep-right">Open orders</th><th>Status</th>{isOwner && <th><span className="ep-sr">Actions</span></th>}</tr></thead>
            <tbody>
              {physical.map((w) => {
                const t = tot(w.id);
                return (
                  <tr key={w.id}>
                    <td><b>{w.name}</b><small>{[w.city, w.province].filter(Boolean).join(', ') || '—'}</small></td>
                    <td className="ep-mono">{w.code}</td>
                    <td className="ep-right">{t.onHand.toLocaleString('en')}</td>
                    <td className="ep-right">{t.q.toLocaleString('en')}</td>
                    <td className="ep-right">{t.r.toLocaleString('en')}</td>
                    <td className="ep-right"><b>{t.free.toLocaleString('en')}</b></td>
                    <td className="ep-right">{(openOrders ?? []).filter((o) => o.warehouse_id === w.id).length}</td>
                    <td><Badge map={ACTIVE} value={String(w.active)} /></td>
                    {isOwner && (
                      <td>
                        <form action={toggleWarehouse}>
                          <input type="hidden" name="id" value={w.id} />
                          <Submit className="ep-btn ep-btn--ghost ep-btn--sm">{w.active ? 'Close' : 'Reopen'}</Submit>
                        </form>
                      </td>
                    )}
                  </tr>
                );
              })}
              {holding && un && (
                <tr>
                  <td><b>{holding.name}</b><small>Not a place — units recorded before warehouses</small></td>
                  <td className="ep-mono">{holding.code}</td>
                  <td className="ep-right">{un.onHand.toLocaleString('en')}</td>
                  <td className="ep-right">—</td>
                  <td className="ep-right">—</td>
                  <td className="ep-right">0</td>
                  <td className="ep-right">—</td>
                  <td>Can’t ship</td>
                  {isOwner && <td />}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {isOwner && (
        <section className="ep-card" style={{ marginTop: '1.2rem', maxWidth: 640 }}>
          <h2>Add a warehouse</h2>
          <form action={addWarehouse} className="ep-form">
            <div className="ep-row2">
              <label>Name<input name="name" required maxLength={80} placeholder="e.g. Yiwu" /></label>
              <label>Code<input name="code" required pattern="[A-Za-z0-9]{2,10}" maxLength={10} placeholder="e.g. YW" /></label>
            </div>
            <div className="ep-row2">
              <label>City<input name="city" maxLength={80} /></label>
              <label>Province<input name="province" maxLength={80} /></label>
            </div>
            <Submit className="ep-btn">Add warehouse</Submit>
          </form>
        </section>
      )}
    </>
  );
}
