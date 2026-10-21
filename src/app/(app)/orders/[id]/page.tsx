import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { COUNTRIES, fmtDate, ORDER_STATUS } from '@/lib/format';
import { Arrow, Back, Badge, TeamOnly } from '@/components/ui';
import { Submit } from '@/components/client';
import { cancelOrder, updateOrder } from '../actions';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('orders').select('*, organizations(name)').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: o } = await q.maybeSingle();
  if (!o) notFound();
  const { data: items } = await sb.from('order_items').select('qty, products(sku, name)').eq('order_id', id);
  const steps: [string, string | null, boolean][] = [
    ['Received', o.created_at, true],
    ['Packed', null, ['packed', 'shipped', 'delivered'].includes(o.status)],
    ['Shipped', o.shipped_at, ['shipped', 'delivered'].includes(o.status)],
    ['Delivered', o.delivered_at, o.status === 'delivered'],
  ];
  const staffView = !!ctx.staffRole && ctx.can('orders.hold');
  const statuses = ctx.can('orders.warehouse') ? Object.keys(ORDER_STATUS) : ['new', 'on_hold'];
  return (
    <>
      <Back href="/orders">Orders</Back>
      <div className="ep-client-head">
        <div>
          <h2>#{o.number} <Badge map={ORDER_STATUS} value={o.status} /></h2>
          <p className="ep-muted">{ctx.backOffice ? `${(o.organizations as unknown as { name: string })?.name} · ` : ''}Created {fmtDate(o.created_at, true)}{o.store_ref ? ` · ${o.store_ref}` : ''}</p>
        </div>
      </div>
      {o.status === 'on_hold' && o.hold_reason && <p className="ep-note ep-note--warn">On hold: {o.hold_reason}</p>}
      <div className="ep-split">
        <div className="ep-card--grow">
          <div className="ep-track-head">
            <div><small>Shipment</small><b>#{o.number}</b></div>
            <div><small>From</small><b>China</b></div>
            <div><small>To</small><b>{[o.city, COUNTRIES[o.country] ?? o.country].filter(Boolean).join(', ')}</b></div>
            <div><small>Service</small><b>{o.service === 'ddp' ? 'DDP Express' : 'Express'}</b></div>
          </div>
          <section className="ep-card">
            <h2>Journey</h2>
            <ol className="ep-steps">
              {steps.map(([l, d, done]) => <li key={l} className={done ? 'done' : ''}><b>{l}</b><span>{d && done ? fmtDate(d, true) : done ? 'Done' : 'Waiting'}</span></li>)}
            </ol>
            {o.tracking && <p className="ep-track">{o.carrier ? `${o.carrier} · ` : ''}<b>{o.tracking}</b> <a className="ep-link" target="_blank" rel="noopener noreferrer" href={`https://t.17track.net/en#nums=${encodeURIComponent(o.tracking)}`}>Track parcel <Arrow /></a></p>}
          </section>
          <section className="ep-card">
            <h2>Items</h2>
            <table className="ep-table">
              <thead><tr><th>SKU</th><th>Product</th><th className="ep-right">Qty</th></tr></thead>
              <tbody>{(items ?? []).map((it, i) => { const p = it.products as unknown as { sku: string; name: string }; return <tr key={i}><td><b>{p?.sku}</b></td><td>{p?.name}</td><td className="ep-right">{it.qty}</td></tr>; })}</tbody>
            </table>
          </section>
        </div>
        <div className="ep-card--side">
          <section className="ep-card">
            <h2>Ship to</h2>
            <p className="ep-address"><b>{o.customer}</b><br />{o.address}<br />{[o.zip, o.city].filter(Boolean).join(' ')}<br />{COUNTRIES[o.country] ?? o.country}{o.email && <><br /><span className="ep-muted">{o.email}</span></>}</p>
            <p className="ep-muted ep-small">Service: {o.service === 'ddp' ? 'DDP, duties paid' : 'Express'}{o.weight_g ? ` · ${(o.weight_g / 1000).toFixed(2)} kg` : ''}</p>
          </section>
          {staffView && !['cancelled'].includes(o.status) && (
            <section className="ep-card ep-card--team">
              <h2>Warehouse update</h2>
              <TeamOnly />
              <form action={updateOrder} className="ep-form">
                <input type="hidden" name="id" value={o.id} />
                <label>Status<select name="status" defaultValue={o.status}>{statuses.map((k) => <option key={k} value={k}>{ORDER_STATUS[k][0]}</option>)}</select></label>
                <label>Hold reason<input name="hold_reason" defaultValue={o.hold_reason ?? ''} placeholder="Only when on hold" /></label>
                {ctx.can('orders.warehouse') && (
                  <>
                    <div className="ep-row2"><label>Carrier<input name="carrier" defaultValue={o.carrier ?? ''} placeholder="e.g. YunExpress" /></label><label>Weight (g)<input type="number" name="weight_g" defaultValue={o.weight_g || ''} /></label></div>
                    <label>Tracking number<input name="tracking" defaultValue={o.tracking ?? ''} /></label>
                  </>
                )}
                <Submit className="ep-btn ep-btn--full">Save</Submit>
                <p className="ep-small ep-muted">Marking it in transit takes the items out of stock.</p>
              </form>
            </section>
          )}
          {['new', 'on_hold'].includes(o.status) && ctx.can('orders.create') && (
            <section className="ep-card">
              <form action={cancelOrder}><input type="hidden" name="id" value={o.id} /><Submit className="ep-btn ep-btn--ghost ep-btn--full" confirm="Cancel this order?">Cancel order</Submit></form>
            </section>
          )}
          <section className="ep-card"><Link className="ep-link" href={`/support/new?ref=${o.number}`}>Ask about this order <Arrow /></Link></section>
        </div>
      </div>
    </>
  );
}
