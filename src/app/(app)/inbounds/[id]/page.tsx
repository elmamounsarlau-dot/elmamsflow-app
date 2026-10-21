import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtDate, INBOUND_STATUS } from '@/lib/format';
import { Arrow, Back, Badge, TeamOnly } from '@/components/ui';
import { Submit } from '@/components/client';
import { receiveInbound, setInboundStatus } from '../actions';

export default async function InboundPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('inbounds').select('*, organizations(name)').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: b } = await q.maybeSingle();
  if (!b) notFound();
  const { data: items } = await sb.from('inbound_items').select('id, expected, received, products(sku, name)').eq('inbound_id', id);
  const order = Object.keys(INBOUND_STATUS);
  const pos = order.indexOf(b.status);
  const receiving = ctx.can('inbounds.receive') && b.status !== 'received';
  return (
    <>
      <Back href="/inbounds">Stock inbounds</Back>
      <div className="ep-client-head"><div><h2>{b.ref} <Badge map={INBOUND_STATUS} value={b.status} /></h2><p className="ep-muted">{ctx.backOffice ? `${(b.organizations as unknown as { name: string })?.name} · ` : ''}{b.supplier ? `${b.supplier} · ` : ''}{b.cartons} cartons{b.eta ? ` · ETA ${fmtDate(b.eta)}` : ''}</p></div></div>
      <section className="ep-card">
        <div className="ep-inbound-steps ep-inbound-steps--big">
          {['Booked', 'Picked up', 'Receiving', 'Counted', 'Available'].map((l, i) => {
            const step = b.status === 'received' ? 5 : pos;
            return <i key={l} className={i < step || step === 5 ? 'done' : i === step ? 'now' : ''}>{l}</i>;
          })}
        </div>
        {b.notes && <p className="ep-muted" style={{ marginTop: '1rem' }}>{b.notes}</p>}
      </section>
      <section className={`ep-card${receiving ? ' ep-card--team' : ''}`}>
        <h2>{receiving ? 'Count what arrived' : 'Items'}</h2>
        {receiving && <TeamOnly />}
        <form action={receiveInbound}>
          <input type="hidden" name="id" value={b.id} />
          <table className="ep-table">
            <thead><tr><th>SKU</th><th>Product</th><th className="ep-right">Expected</th><th className="ep-right">Received</th></tr></thead>
            <tbody>
              {(items ?? []).map((it) => {
                const p = it.products as unknown as { sku: string; name: string };
                return (
                  <tr key={it.id}>
                    <td><b>{p?.sku}</b></td><td>{p?.name}</td><td className="ep-right">{it.expected}</td>
                    <td className="ep-right">{receiving ? <input className="ep-qty" type="number" min={0} name={`rcv_${it.id}`} defaultValue={it.expected} /> : b.status === 'received' ? <b className={it.received !== it.expected ? 'ep-warn' : ''}>{it.received}</b> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {receiving && <div className="ep-form-foot"><Submit confirm="Confirm these counts? The units become available right away.">Confirm received <Arrow /></Submit></div>}
        </form>
      </section>
      {receiving && (
        <section className="ep-card ep-card--narrow ep-card--team">
          <h2>Status</h2>
          <form action={setInboundStatus} className="ep-inline">
            <input type="hidden" name="id" value={b.id} />
            <select name="status" defaultValue={b.status}>{['announced', 'in_transit', 'receiving'].map((k) => <option key={k} value={k}>{INBOUND_STATUS[k][0]}</option>)}</select>
            <Submit className="ep-btn ep-btn--ghost">Update</Submit>
          </form>
        </section>
      )}
    </>
  );
}
