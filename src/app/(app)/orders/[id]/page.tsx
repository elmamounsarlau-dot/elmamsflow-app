import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { CARRIER_PROBLEM, CARRIER_STATUS, COUNTRIES, fmtDate, ORDER_STATUS } from '@/lib/format';
import { Arrow, Back, Badge, TeamOnly } from '@/components/ui';
import { Submit } from '@/components/client';
import { cancelOrder, refreshTracking, reverseShipment, updateOrder } from '../actions';
import { rematchProducts, resendTracking } from '../../integrations/actions';
import { getWarehouses, shippingWarehouses, whLabel } from '@/lib/warehouses';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('orders').select('*, organizations(name)').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: o } = await q.maybeSingle();
  if (!o) notFound();
  const [{ data: items }, whs, { data: events }] = await Promise.all([
    sb.from('order_items').select('qty, products(sku, name)').eq('order_id', id),
    getWarehouses(),
    o.tracking ? sb.from('tracking_events').select('at, description, location').eq('order_id', id).eq('tracking', o.tracking).order('at', { ascending: false }).limit(60) : Promise.resolve({ data: [] as { at: string | null; description: string; location: string | null }[] }),
  ]);
  const wh = whs.find((w) => w.id === o.warehouse_id);
  const canMove = ['new', 'on_hold'].includes(o.status);
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
      {o.status === 'on_hold' && o.hold_reason && (
        <div className="ep-fixbar" style={{ cursor: 'default' }}>
          <span><b>On hold:</b> {o.hold_reason}</span>
          {o.external_lines && <form action={rematchProducts}><input type="hidden" name="order" value={o.id} /><Submit className="ep-btn ep-btn--sm">Match products again</Submit></form>}
        </div>
      )}
      {o.source !== 'manual' && (
        <p className="ep-note" style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center' }}>
          <span>From your {o.source === 'shopify' ? 'Shopify' : 'WooCommerce'} store{o.store_ref ? ` · ${o.store_ref}` : ''}.{' '}
            {o.pushed_at ? `Tracking sent to the store on ${fmtDate(o.pushed_at, true)}.` : o.push_error ? `Tracking couldn’t be sent: ${o.push_error}` : ['shipped', 'delivered'].includes(o.status) ? 'Tracking will be sent to the store.' : 'Tracking goes back to the store when it ships.'}
          </span>
          {o.push_error && ctx.staffRole && ctx.can('orders.warehouse') && <form action={resendTracking}><input type="hidden" name="order" value={o.id} /><Submit className="ep-btn ep-btn--sm ep-btn--ghost">Send again</Submit></form>}
        </p>
      )}
      <div className="ep-split">
        <div className="ep-card--grow">
          <div className="ep-track-head">
            <div><small>Shipment</small><b>#{o.number}</b></div>
            <div><small>Ships from</small><b>{wh ? whLabel(wh) : 'Not chosen'}</b></div>
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
          {o.tracking && ['shipped', 'delivered'].includes(o.status) && (
            <section className="ep-card" id="carrier">
              <div className="ep-card-head">
                <h2>Carrier updates</h2>
                {o.tracking_status ? <Badge map={CARRIER_STATUS} value={o.tracking_status} /> : <span className="ep-muted ep-small">{o.tracking_registered_at ? 'Waiting for the first carrier scan' : o.tracking_error ? 'Not tracked' : 'Starting live tracking…'}</span>}
              </div>
              {o.tracking_error && !o.tracking_status && <p className="ep-note ep-note--warn">17TRACK couldn’t track this number: {o.tracking_error}</p>}
              {o.tracking_status && CARRIER_PROBLEM.includes(o.tracking_status) && <p className="ep-note ep-note--warn">The carrier reports a problem. Check the latest update{ctx.backOffice ? ' and contact the carrier if needed' : '; our team is notified'}.</p>}
              {o.tracking_last_event && (
                <p className="ep-small" style={{ marginBottom: '.6rem' }}>
                  <b>{o.tracking_last_event}</b>{o.tracking_last_location ? ` · ${o.tracking_last_location}` : ''}
                  <br /><span className="ep-muted">{o.tracking_last_event_at ? fmtDate(o.tracking_last_event_at, true) : ''}{o.tracking_eta && o.status !== 'delivered' ? ` · Expected by ${fmtDate(o.tracking_eta)}` : ''}</span>
                </p>
              )}
              {(events ?? []).length > 0 && (
                <ol className="ep-events">
                  {(events ?? []).map((e, i) => (
                    <li key={i}><span className="ep-muted ep-small">{e.at ? fmtDate(e.at, true) : '—'}</span><b>{e.description}</b>{e.location && <small>{e.location}</small>}</li>
                  ))}
                </ol>
              )}
              <p className="ep-small ep-muted" style={{ marginTop: '.6rem' }}>Live from the carrier via 17TRACK{o.tracking_checked_at ? ` · last checked ${fmtDate(o.tracking_checked_at, true)}` : ''}.</p>
              {ctx.staffRole && (
                <form action={refreshTracking} style={{ marginTop: '.6rem' }}><input type="hidden" name="id" value={o.id} /><Submit className="ep-btn ep-btn--sm ep-btn--ghost">{o.tracking_registered_at ? 'Refresh now' : 'Start tracking now'}</Submit></form>
              )}
            </section>
          )}
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
                <input type="hidden" name="current_warehouse_id" value={o.warehouse_id ?? ''} />
                {ctx.can('orders.warehouse') && (
                  <label>Ships from
                    <select name="warehouse_id" defaultValue={wh?.kind === 'physical' ? wh.id : ''} disabled={!canMove}>
                      <option value="" disabled>Choose the warehouse</option>
                      {shippingWarehouses(whs).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </label>
                )}
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
          {ctx.staffRole === 'owner' && ['shipped', 'delivered'].includes(o.status) && o.stock_out && (
            <section className="ep-card ep-card--team" id="correction">
              <h2>Correction: reverse shipment</h2>
              <TeamOnly />
              <p className="ep-small ep-muted" style={{ marginBottom: '.8rem' }}>Only if no parcel physically left (e.g. a test). The units go back to stock and the order is cancelled; the original shipment stays in the history with your name, the reason and the evidence. It doesn’t change the order in the store.</p>
              <form action={reverseShipment} className="ep-form">
                <input type="hidden" name="id" value={o.id} />
                <label>Reason<input name="reason" required maxLength={300} placeholder="e.g. Test shipment, no parcel left the warehouse" /></label>
                <label>Evidence<input name="evidence" required maxLength={500} placeholder="e.g. Warehouse confirmation on WeChat, 22 Oct" /></label>
                <label>Type REVERSE to confirm<input name="confirm" required pattern="REVERSE" autoComplete="off" /></label>
                <Submit className="ep-btn ep-btn--ghost ep-btn--full">Reverse shipment</Submit>
              </form>
            </section>
          )}
          <section className="ep-card"><Link className="ep-link" href={`/support/new?ref=${o.number}`}>Ask about this order <Arrow /></Link></section>
        </div>
      </div>
    </>
  );
}
