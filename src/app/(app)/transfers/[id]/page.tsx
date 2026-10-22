import { redirect } from 'next/navigation';
import { shippingOnly } from '@/lib/session';
import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtDate, TRANSFER_STATUS } from '@/lib/format';
import { getWarehouses, whLabel } from '@/lib/warehouses';
import { Back, Badge, TeamOnly } from '@/components/ui';
import { Submit } from '@/components/client';
import { cancelTransfer, dispatchTransfer, receiveTransfer } from '../actions';

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  if (shippingOnly(ctx)) redirect('/shipping');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const sb = await supabaseServer();
  let q = sb.from('transfers').select('*, organizations(name), transfer_items(id, qty, received, products(sku, name))').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const [{ data: t }, whs] = await Promise.all([q.maybeSingle(), getWarehouses()]);
  if (!t) notFound();
  const wh = new Map(whs.map((w) => [w.id, w]));
  const items = t.transfer_items as { id: string; qty: number; received: number; products: { sku: string; name: string } | null }[];
  const staff = !!ctx.staffRole && ctx.can('stock.adjust');
  const receiver = !!ctx.staffRole && ctx.can('inbounds.receive');
  const sent = items.reduce((a, i) => a + i.qty, 0);
  const got = items.reduce((a, i) => a + i.received, 0);
  return (
    <>
      <Back href="/transfers">Transfers</Back>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">{ctx.backOffice ? `${(t.organizations as { name: string } | null)?.name ?? ''} · ` : ''}{t.kind === 'allocation' ? 'Allocation' : 'Transfer'}</p>
          <h1><span className="ep-mono">{t.ref}</span> <Badge map={TRANSFER_STATUS} value={t.status} /></h1>
          <p>{whLabel(wh.get(t.from_warehouse_id))} → {whLabel(wh.get(t.to_warehouse_id))} · {t.reason}</p>
        </div>
      </div>
      <div className="ep-grid2 ep-grid2--wide">
        <section className="ep-card ep-card--flush">
          <div className="ep-card-head ep-pad"><h2>{t.status === 'in_transit' && receiver ? 'Count what arrived' : 'Items'}</h2>{t.status === 'in_transit' && receiver && <TeamOnly />}</div>
          <form action={receiveTransfer}>
            <input type="hidden" name="id" value={t.id} />
            <div className="ep-tablewrap">
              <table className="ep-table">
                <thead><tr><th>SKU</th><th>Product</th><th className="ep-right">Sent</th><th className="ep-right">Received</th></tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td><b>{i.products?.sku}</b></td><td>{i.products?.name}</td><td className="ep-right">{i.qty}</td>
                      <td className="ep-right">{t.status === 'in_transit' && receiver ? <input className="ep-qty" type="number" min={0} max={i.qty} name={`rcv_${i.id}`} defaultValue={i.qty} aria-label={`Units of ${i.products?.sku} received`} /> : t.status === 'received' ? <b className={i.received < i.qty ? 'ep-neg' : ''}>{i.received}</b> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {t.status === 'in_transit' && receiver && <div className="ep-pad" style={{ paddingBottom: '1.1rem' }}><Submit className="ep-btn ep-btn--full">Confirm arrival</Submit><p className="ep-small ep-muted" style={{ marginTop: '.5rem' }}>Units not counted are recorded as missing on arrival.</p></div>}
          </form>
        </section>
        <div>
          <section className="ep-card">
            <h2>History</h2>
            <dl className="ep-dl ep-dl--tight">
              <dt>Requested</dt><dd>{fmtDate(t.created_at, true)}</dd>
              <dt>Sent</dt><dd>{t.dispatched_at ? fmtDate(t.dispatched_at, true) : '—'}{t.carrier ? ` · ${t.carrier}` : ''}{t.tracking ? ` · ${t.tracking}` : ''}</dd>
              <dt>Received</dt><dd>{t.received_at ? `${fmtDate(t.received_at, true)} · ${got} of ${sent}` : '—'}</dd>
              {t.evidence && <><dt>Evidence</dt><dd>{t.evidence}</dd></>}
            </dl>
          </section>
          {t.status === 'requested' && staff && (
            <section className="ep-card ep-card--team">
              <h2>Send it</h2>
              <TeamOnly />
              <form action={dispatchTransfer} className="ep-form">
                <input type="hidden" name="id" value={t.id} />
                <div className="ep-row2"><label>Carrier<input name="carrier" placeholder="e.g. SF Express" /></label><label>Tracking<input name="tracking" /></label></div>
                <Submit className="ep-btn ep-btn--full">Mark as sent</Submit>
              </form>
              <form action={cancelTransfer} className="ep-form" style={{ marginTop: '.8rem' }}>
                <input type="hidden" name="id" value={t.id} />
                <label>Cancel reason<input name="reason" placeholder="Optional" /></label>
                <Submit className="ep-btn ep-btn--ghost ep-btn--full" confirm="Cancel this transfer? Nothing has moved yet.">Cancel transfer</Submit>
              </form>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
