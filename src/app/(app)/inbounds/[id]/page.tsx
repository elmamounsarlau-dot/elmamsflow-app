import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtDate, INBOUND_STATUS } from '@/lib/format';
import { Arrow, Back, Badge, TeamOnly } from '@/components/ui';
import { Submit } from '@/components/client';
import { updateInbound } from '../actions';

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
        <h2>{receiving ? (b.status === 'counted' ? 'Check the count' : 'Count what arrived') : 'Items'}</h2>
        {receiving && <TeamOnly />}
        <form action={updateInbound}>
          <input type="hidden" name="id" value={b.id} />
          <table className="ep-table">
            <thead><tr><th>SKU</th><th>Product</th><th className="ep-right">Expected</th><th className="ep-right">{b.status === 'received' || b.status === 'counted' ? 'Counted' : 'Received'}</th></tr></thead>
            <tbody>
              {(items ?? []).map((it) => {
                const p = it.products as unknown as { sku: string; name: string };
                const counted = b.status === 'counted' || b.status === 'received';
                return (
                  <tr key={it.id}>
                    <td><b>{p?.sku}</b></td><td>{p?.name}</td><td className="ep-right">{it.expected}</td>
                    <td className="ep-right">{receiving ? <input className="ep-qty" type="number" min={0} name={`rcv_${it.id}`} defaultValue={counted ? it.received : it.expected} /> : counted ? <b className={it.received !== it.expected ? 'ep-warn' : ''}>{it.received}</b> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {receiving && (
            <div className="ep-inbound-actions">
              <label className="ep-inbound-status">
                <span>Move to</span>
                <select name="status" defaultValue={b.status === 'counted' ? 'received' : order[Math.min(pos + 1, order.length - 1)]}>
                  {order.map((k) => <option key={k} value={k}>{INBOUND_STATUS[k][0]}{k === 'counted' ? ' — save the count' : k === 'received' ? ' — add to stock' : ''}</option>)}
                </select>
              </label>
              <Submit>Update <Arrow /></Submit>
            </div>
          )}
          {receiving && <p className="ep-small ep-muted" style={{ marginTop: '.6rem' }}>“Counted” saves the quantities without touching stock. “Available” adds them to stock straight away.</p>}
        </form>
      </section>
    </>
  );
}
