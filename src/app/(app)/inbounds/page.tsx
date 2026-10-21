import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { orgNames } from '@/lib/data';
import { fmtDate, INBOUND_STATUS } from '@/lib/format';
import { Arrow, Badge, Empty } from '@/components/ui';

export const metadata = { title: 'Stock inbounds' };

export default async function Inbounds() {
  const ctx = await requireCtx();
  const sb = await supabaseServer();
  let q = sb.from('inbounds').select('id, ref, supplier, eta, status, org_id, created_at, inbound_items(expected)').order('created_at', { ascending: false }).limit(200);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const [{ data }, names] = await Promise.all([q, ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  const list = data ?? [];
  return (
    <>
      <h1 className="ep-page-title">Stock inbounds</h1>
      <div className="ep-bar"><p className="ep-muted">Every restock from the factory to our shelves.</p>{ctx.can('inbounds.create') && <Link className="ep-btn" href="/inbounds/new">Announce an inbound <Arrow /></Link>}</div>
      <section className="ep-card">
        {list.length === 0 ? <Empty title="No inbounds yet" text="Announce a shipment and follow it until the stock is available." /> : (
          <table className="ep-table">
            <thead><tr><th>Reference</th>{ctx.backOffice && <th>Client</th>}<th>Supplier</th><th className="ep-right">Units</th><th>ETA</th><th>Status</th></tr></thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id} data-href={`/inbounds/${b.id}`}>
                  <td><b>{b.ref}</b><small>{fmtDate(b.created_at)}</small></td>
                  {ctx.backOffice && <td>{names[b.org_id]}</td>}
                  <td>{b.supplier || '—'}</td>
                  <td className="ep-right">{(b.inbound_items as { expected: number }[]).reduce((a, i) => a + i.expected, 0)}</td>
                  <td>{b.eta ? fmtDate(b.eta) : '—'}</td>
                  <td><Badge map={INBOUND_STATUS} value={b.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
