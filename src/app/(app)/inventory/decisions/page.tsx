import Link from 'next/link';
import { requirePerm } from '@/lib/guard';
import { supabaseServer } from '@/lib/supabase/server';
import { orgNames } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { getWarehouses } from '@/lib/warehouses';
import { Back, Empty, PageHead, Thumb } from '@/components/ui';
import { decideQuarantine } from '../actions';

export const metadata = { title: 'Quarantine decisions' };

const LABEL: Record<string, [string, string]> = {
  restock: ['Restock', 'Put back on sale'],
  dispose: ['Dispose', 'Throw away, remove from stock'],
  return: ['Return to supplier', 'Send back, remove from stock'],
};

type R = { id: string; org_id: string; product_id: string; warehouse_id: string; qty: number; decision: string; note: string | null; status: string; created_at: string; handled_at: string | null; handled_note: string | null; products: { sku: string; name: string; photo_path: string | null } | null };

export default async function Decisions() {
  const ctx = await requirePerm('stock.adjust', '/inventory/decisions');
  const sb = await supabaseServer();
  const [{ data }, names, whs] = await Promise.all([
    sb.from('quarantine_requests').select('id, org_id, product_id, warehouse_id, qty, decision, note, status, created_at, handled_at, handled_note, products(sku, name, photo_path)').order('created_at', { ascending: false }).limit(200),
    ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>),
    getWarehouses(),
  ]);
  const rows = (data ?? []) as unknown as R[];
  const open = rows.filter((r) => r.status === 'requested').reverse();
  const done = rows.filter((r) => r.status !== 'requested').slice(0, 30);
  const wh = new Map(whs.map((w) => [w.id, w.name]));
  return (
    <>
      <Back href="/inventory">Inventory</Back>
      <PageHead crumb="Inventory" title="Quarantine decisions" sub="What each brand decided for its set-aside units. Carry it out on the shelf, then confirm here: stock updates by itself." />
      <section className="ep-card ep-card--flush">
        {open.length === 0 ? <Empty title="Nothing to do" text="When a brand decides what to do with quarantined units, it appears here." /> : (
          <ul className="ep-qd-list ep-qd-list--big">
            {open.map((r) => (
              <li key={r.id}>
                <Thumb id={r.product_id} photo={r.products?.photo_path} name={r.products?.name ?? ''} size={44} />
                <span><b>{LABEL[r.decision]?.[0]} · {r.qty} × <Link href={`/inventory/${r.product_id}#quarantine`}>{r.products?.sku}</Link></b><small>{names[r.org_id] ?? ''} · {wh.get(r.warehouse_id) ?? ''} · {fmtDate(r.created_at, true)}{r.note ? ` · “${r.note}”` : ''}</small><small>{LABEL[r.decision]?.[1]}</small></span>
                <form action={decideQuarantine} className="ep-qd-act">
                  <input type="hidden" name="request" value={r.id} />
                  <input name="note" placeholder="Note for the brand" maxLength={300} aria-label="Note for the brand" />
                  <button className="ep-btn ep-btn--sm" name="act" value="apply">Done</button>
                  <button className="ep-btn ep-btn--sm ep-btn--ghost" name="act" value="decline">Decline</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
      {done.length > 0 && (
        <section className="ep-card ep-card--flush">
          <div className="ep-card-head ep-pad"><h2>Recently handled</h2></div>
          <ul className="ep-qd-list">
            {done.map((r) => (
              <li key={r.id}>
                <span className={`ep-qd-dot ep-qd-dot--${r.status}`} aria-hidden="true" />
                <span><b>{LABEL[r.decision]?.[0]} · {r.qty} × {r.products?.sku}</b><small>{names[r.org_id] ?? ''} · {r.status === 'done' ? 'Done' : 'Declined'} {fmtDate(r.handled_at, true)}{r.handled_note ? ` · ${r.handled_note}` : ''}</small></span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
