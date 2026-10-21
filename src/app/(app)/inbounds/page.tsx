import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { orgNames } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { Arrow, Empty } from '@/components/ui';

export const metadata = { title: 'Stock inbounds' };

export default async function Inbounds() {
  const ctx = await requireCtx();
  const sb = await supabaseServer();
  let q = sb.from('inbounds').select('id, ref, supplier, eta, status, cartons, org_id, created_at, inbound_items(expected)').order('created_at', { ascending: false }).limit(200);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const [{ data }, names] = await Promise.all([q, ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  const list = data ?? [];
  return (
    <>
      <h1 className="ep-page-title">Stock inbounds</h1>
      <div className="ep-bar"><p className="ep-muted">Every restock from the factory to our shelves.{list.filter((b) => b.status !== 'received').length > 0 && <span className="ep-st ep-st--go" style={{ marginLeft: '.6rem' }}>{list.filter((b) => b.status !== 'received').length} on the way</span>}</p>{ctx.can('inbounds.create') && <Link className="ep-btn" href="/inbounds/new">Announce an inbound <Arrow /></Link>}</div>
      {list.length === 0 ? <section className="ep-card"><Empty title="No inbounds yet" text="Announce a shipment and follow it until the stock is available." /></section> : (
        <div className="ep-inbounds">
          {list.map((b) => {
            const units = (b.inbound_items as { expected: number }[]).reduce((a, i) => a + i.expected, 0);
            const step = { announced: 0, in_transit: 1, receiving: 2, counted: 3, received: 5 }[b.status as string] ?? 0;
            return (
              <Link key={b.id} href={`/inbounds/${b.id}`} className="ep-inbound">
                <div className="ep-inbound-head">
                  <b>{b.ref}</b>
                  <span>{b.supplier || 'Supplier'} → Elmamsflow, China{ctx.backOffice ? ` · ${names[b.org_id]}` : ''}</span>
                  <em>{b.cartons ? `${b.cartons} cartons · ` : ''}{units.toLocaleString('en')} units{b.eta && b.status !== 'received' ? ` · ETA ${fmtDate(b.eta)}` : ''}</em>
                </div>
                <div className="ep-inbound-steps">
                  {['Booked', 'Picked up', 'Receiving', 'Counted', 'Available'].map((l, i) => (
                    <i key={l} className={i < step || step === 5 ? 'done' : i === step ? 'now' : ''}>{l}</i>
                  ))}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
