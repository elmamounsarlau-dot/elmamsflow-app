import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CARRIER_PROBLEM, CARRIER_STATUS, COUNTRIES, countryList, fmtDate, ORDER_STATUS } from '@/lib/format';
import { Arrow, Back, Badge, TeamOnly, Thumb } from '@/components/ui';
import { Submit } from '@/components/client';
import { cancelOrder, editOrderShipTo, reverseShipment, updateOrder } from '../actions';
import { trackingLink } from '@/lib/carriers';
import { rematchProducts, resendTracking } from '../../integrations/actions';
import { getWarehouses, shippingWarehouses, whLabel } from '@/lib/warehouses';
import { financeSettings, MONEY_CURRENCIES } from '@/lib/fx';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('orders').select('*, organizations(name)').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: o } = await q.maybeSingle();
  if (!o) notFound();
  // What this parcel cost us (label, duties): our team only, never clients, and not in "view as client".
  const seesCosts = !!ctx.staffRole && !ctx.viewingAs && (ctx.can('orders.warehouse') || ctx.can('billing.manage'));
  const [{ data: items }, whs, { data: cost }, fin] = await Promise.all([
    sb.from('order_items').select('qty, products(id, sku, name, weight_g, hs_code, customs_value, photo_path)').eq('order_id', id),
    getWarehouses(),
    seesCosts ? sb.from('order_costs').select('label_cost, duties_paid, currency').eq('order_id', id).maybeSingle() : Promise.resolve({ data: null as { label_cost: number | null; duties_paid: number | null; currency: string } | null }),
    seesCosts ? financeSettings() : Promise.resolve(null),
  ]);
  const costCur = cost?.currency ?? fin?.cost_currency ?? 'CNY';
  const wh = whs.find((w) => w.id === o.warehouse_id);
  const canMove = ['new', 'on_hold'].includes(o.status);
  const steps: [string, string | null, boolean][] = [
    ['Received', o.created_at, true],
    ['Packed', null, ['packed', 'shipped', 'delivered'].includes(o.status)],
    ['Shipped', o.shipped_at, ['shipped', 'delivered'].includes(o.status)],
    ['Delivered', o.delivered_at, o.status === 'delivered'],
  ];
  const staffView = !!ctx.staffRole && (ctx.can('orders.hold') || ctx.can('orders.warehouse'));
  const canHoldIt = ctx.can('orders.hold');
  const statuses = ctx.can('orders.warehouse') ? Object.keys(ORDER_STATUS).filter((k) => canHoldIt || !['on_hold', 'cancelled'].includes(k)) : ['new', 'on_hold'];
  // When cancelling: does this client usually want its customer refunded in the store?
  const refundDefault = o.integration_id ? !!(await supabaseAdmin().from('organizations').select('cancel_refund').eq('id', o.org_id).maybeSingle()).data?.cancel_refund : false;
  const isPdf = (o.label_path ?? '').endsWith('.pdf');
  const canEdit = ['new', 'on_hold'].includes(o.status) && (ctx.can('orders.create') || (!!ctx.staffRole && ctx.can('orders.hold')));
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
          <span><b>On hold:</b> {o.hold_reason}{o.hold_kind === 'address' && o.integration_id ? <> — fix it in {o.source === 'shopify' ? 'Shopify' : 'WooCommerce'} and this order updates by itself.</> : null}{o.hold_kind === 'balance' ? <> <Link className="ep-link" href="/invoices/topup">Top up now</Link></> : null}</span>
          {o.external_lines && <form action={rematchProducts}><input type="hidden" name="order" value={o.id} /><Submit className="ep-btn ep-btn--sm">{o.hold_kind === 'address' ? 'Check the store again' : 'Match products again'}</Submit></form>}
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
            <div><small>Service</small><b>{o.service === 'ddp' ? 'DDP · duties paid' : 'Express'}</b></div>
          </div>
          <section className="ep-card">
            <h2>Journey</h2>
            <ol className="ep-steps">
              {steps.map(([l, d, done]) => <li key={l} className={done ? 'done' : ''}><b>{l}</b><span>{d && done ? fmtDate(d, true) : done ? 'Done' : 'Waiting'}</span></li>)}
            </ol>
            {o.tracking && <p className="ep-track">{o.carrier ? `${o.carrier} · ` : ''}<b>{o.tracking}</b> <a className="ep-link" target="_blank" rel="noopener noreferrer" href={trackingLink(o.carrier, o.tracking, o.tracking_url) ?? '#'}>Track parcel <Arrow /></a></p>}
            {o.shipment_status && ['shipped', 'delivered'].includes(o.status) && (
              <p className="ep-small" style={{ marginTop: '.5rem' }}>Carrier: <Badge map={CARRIER_STATUS} value={o.shipment_status} />{CARRIER_PROBLEM.includes(o.shipment_status) && <span className="ep-warn"> · {ctx.backOffice ? 'check with the carrier' : 'our team is on it'}</span>}</p>
            )}
          </section>
          {ctx.backOffice && (o.bridge_id || o.bridge_error || o.store_error) && (
            <section className="ep-card ep-card--team" id="links">
              <h2>Warehouse &amp; store links</h2>
              <TeamOnly />
              {o.bridge_name && <p className="ep-small">At the warehouse (bridge store) as <b>{o.bridge_name}</b>{o.bridge_sent_at ? ` · sent ${fmtDate(o.bridge_sent_at, true)}` : ''}.</p>}
              {o.bridge_error && <p className="ep-note ep-note--warn">Not at the warehouse yet: {o.bridge_error}. It is retried automatically; fix the cause (often a product SKU) if it stays.</p>}
              {o.store_error && <p className="ep-note ep-note--warn">The client’s store wasn’t updated: {o.store_error}</p>}
            </section>
          )}
          {o.label_path && (
            <section className="ep-card" id="label">
              <div className="ep-card-head"><h2>Shipping label</h2><a className="ep-link ep-small" href={`/orders/${o.id}/label`} target="_blank" rel="noopener">Open full size ↗</a></div>
              {isPdf ? <p className="ep-small">PDF label · <a className="ep-link" href={`/orders/${o.id}/label`} target="_blank" rel="noopener">open it</a></p>
                : <a href={`/orders/${o.id}/label`} target="_blank" rel="noopener" className="ep-label-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element -- private file behind sign-in, not optimisable */}
                    <img src={`/orders/${o.id}/label`} alt={`Shipping label for #${o.number}`} loading="lazy" /></a>}
              <p className="ep-small ep-muted" style={{ marginTop: '.5rem' }}>Added {fmtDate(o.label_uploaded_at, true)}.</p>
            </section>
          )}
          <section className="ep-card">
            <h2>Items</h2>
            <table className="ep-table">
              <thead><tr><th>SKU</th><th>Product</th>{ctx.staffRole && <><th>HS code</th><th className="ep-right">Value (USD)</th><th className="ep-right">Weight</th></>}<th className="ep-right">Qty</th></tr></thead>
              <tbody>{(items ?? []).map((it, i) => {
                const p = it.products as unknown as { id: string; sku: string; name: string; weight_g: number; hs_code: string | null; customs_value: number; photo_path: string | null };
                return (
                  <tr key={i}>
                    <td><div className="ep-prod">{p && <Thumb id={p.id} photo={p.photo_path} name={p.name} size={34} />}<b>{p?.sku}</b></div></td><td>{p?.name}</td>
                    {ctx.staffRole && <><td>{p?.hs_code || <span className="ep-warn">missing</span>}</td><td className="ep-right">{Number(p?.customs_value) ? Number(p.customs_value).toFixed(2) : '—'}</td><td className="ep-right">{p?.weight_g ? `${p.weight_g} g` : '—'}</td></>}
                    <td className="ep-right">{it.qty}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </section>
        </div>
        <div className="ep-card--side">
          <section className="ep-card">
            <h2>Ship to</h2>
            <p className="ep-address"><b>{o.customer}</b><br />{o.address}<br />{[o.zip, o.city].filter(Boolean).join(' ')}<br />{COUNTRIES[o.country] ?? o.country}{o.email && <><br /><span className="ep-muted">{o.email}</span></>}</p>
            <p className="ep-muted ep-small">Service: {o.service === 'ddp' ? 'DDP, duties paid' : 'Express'}{o.weight_g ? ` · ${(o.weight_g / 1000).toFixed(2)} kg` : ''}</p>
            {canEdit && (
              <details className="ep-edit" id="edit" open={o.hold_kind === 'address' || undefined}>
                <summary><span>Edit customer &amp; address</span><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5.5 8l4.5 4.5L14.5 8" /></svg></summary>
                <form action={editOrderShipTo} className="ep-form">
                  <input type="hidden" name="id" value={o.id} />
                  <label>Customer name<input name="customer" defaultValue={o.customer} required maxLength={120} autoComplete="off" /></label>
                  <label>Street address<input name="address" defaultValue={o.address === '—' ? '' : o.address} required maxLength={240} autoComplete="off" /></label>
                  <div className="ep-row2"><label>Postcode<input name="zip" defaultValue={o.zip ?? ''} maxLength={20} /></label><label>City<input name="city" defaultValue={o.city ?? ''} maxLength={80} /></label></div>
                  <label>Country<select name="country" defaultValue={/^[A-Z]{2}$/.test(o.country) && o.country !== 'XX' ? o.country : ''} required><option value="" disabled>Choose…</option>{countryList(o.country).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                  <div className="ep-row2"><label>Phone<input name="phone" defaultValue={o.phone ?? ''} maxLength={40} /></label><label>Email<input type="email" name="email" defaultValue={o.email ?? ''} maxLength={160} /></label></div>
                  {o.integration_id && <p className="ep-small ep-muted">From your store: if the address changes there later, the store’s version replaces this one until the parcel is packed.</p>}
                  <Submit className="ep-btn ep-btn--full">Save changes</Submit>
                </form>
              </details>
            )}
          </section>
          {staffView && !canHoldIt && o.status === 'on_hold' && (
            <section className="ep-card ep-card--team" id="ship"><h2>Ship this order</h2><p className="ep-small">On hold: {o.hold_reason ?? 'waiting for a fix'}. It appears in your shipping queue as soon as the team releases it.</p></section>
          )}
          {staffView && !['cancelled'].includes(o.status) && (canHoldIt || o.status !== 'on_hold') && (
            <section className="ep-card ep-card--team" id="ship">
              <h2>{canHoldIt ? 'Warehouse update' : 'Ship this order'}</h2>
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
                {canHoldIt && <label>Hold reason<input name="hold_reason" defaultValue={o.hold_reason ?? ''} placeholder="Only when on hold" /></label>}
                {ctx.can('orders.warehouse') && (
                  <>
                    <div className="ep-row2"><label>Carrier<input name="carrier" defaultValue={o.carrier ?? ''} placeholder="e.g. YunExpress" /></label><label>Weight (g)<input type="number" name="weight_g" defaultValue={o.weight_g || ''} /></label></div>
                    <label>Tracking number<input name="tracking" defaultValue={o.tracking ?? ''} autoComplete="off" /></label>
                    {seesCosts && (
                      <fieldset className="ep-costs">
                        <legend>What it cost us <small>team only · goes to Finance, never shown to the client</small></legend>
                        <input type="hidden" name="costs" value="1" />
                        <div className={o.service === 'ddp' ? 'ep-row3' : 'ep-row2'}>
                          <label>Label cost<input type="number" name="label_cost" step="0.01" min="0" max="100000" inputMode="decimal" defaultValue={cost?.label_cost ?? ''} placeholder="0.00" /></label>
                          {o.service === 'ddp' && <label>Duties paid<input type="number" name="duties_paid" step="0.01" min="0" max="100000" inputMode="decimal" defaultValue={cost?.duties_paid ?? ''} placeholder="0.00" /></label>}
                          <label>Currency<select name="cost_currency" defaultValue={costCur}>{MONEY_CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></label>
                        </div>
                      </fieldset>
                    )}
                    <label>{o.label_path ? 'Replace the label (photo or PDF)' : 'Label (photo or PDF)'}
                      <input type="file" name="label" accept="image/*,application/pdf" capture="environment" />
                      <small className="ep-muted">{o.label_path ? 'A label is already saved.' : 'Optional.'}</small>
                    </label>
                  </>
                )}
                <Submit className="ep-btn ep-btn--full">Save</Submit>
                <p className="ep-small ep-muted">In transit needs the tracking number. It takes the items out of stock and updates the client’s store (and the warehouse copy).</p>
              </form>
            </section>
          )}
          {['new', 'on_hold'].includes(o.status) && ctx.can('orders.create') && (
            <section className="ep-card">
              <form action={cancelOrder} className="ep-form">
                <input type="hidden" name="id" value={o.id} />
                {o.integration_id && (
                  <label>In {o.source === 'woocommerce' ? 'the WooCommerce store' : 'the Shopify store'}
                    <select name="refund" defaultValue={refundDefault ? 'yes' : 'no'}>
                      <option value="no">Cancel only (refund the customer yourself)</option>
                      {o.source !== 'woocommerce' && <option value="yes">Cancel and refund the customer</option>}
                    </select>
                  </label>
                )}
                <Submit className="ep-btn ep-btn--ghost ep-btn--full" confirm="Cancel this order?">Cancel order</Submit>
              </form>
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
