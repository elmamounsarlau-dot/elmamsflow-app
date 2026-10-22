import { redirect } from 'next/navigation';
import { shippingOnly } from '@/lib/session';
import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { allRows, orgNames } from '@/lib/data';
import { fmtDate, TRANSFER_STATUS } from '@/lib/format';
import { getWarehouses, whLabel } from '@/lib/warehouses';
import { Arrow, Badge, Empty, PageHead, Pager, pageOf } from '@/components/ui';

export const metadata = { title: 'Transfers' };

type T = { id: string; ref: string; org_id: string; kind: string; status: string; from_warehouse_id: string; to_warehouse_id: string; created_at: string; reason: string; transfer_items: { qty: number; received: number }[] };

export default async function Transfers({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  if (shippingOnly(ctx)) redirect('/shipping');
  const sp = await searchParams;
  const sb = await supabaseServer();
  const [all, whs, names] = await Promise.all([
    allRows<T>(() => {
      let q = sb.from('transfers').select('id, ref, org_id, kind, status, from_warehouse_id, to_warehouse_id, created_at, reason, transfer_items(qty, received)').order('created_at', { ascending: false }).order('id');
      if (ctx.org) q = q.eq('org_id', ctx.org.id);
      return q;
    }),
    getWarehouses(),
    ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>),
  ]);
  const wh = new Map(whs.map((w) => [w.id, w]));
  const TABS: [string, string][] = [['', 'All'], ['requested', 'Requested'], ['in_transit', 'On the way'], ['received', 'Received']];
  const t = TABS.some(([k]) => k === sp.t) ? sp.t : '';
  const list = all.filter((x) => !t || x.status === t);
  const PER = 25;
  const page = Math.min(pageOf(sp.p), Math.max(1, Math.ceil(list.length / PER)));
  const href = (tab: string, p = 1) => `/transfers${tab || p > 1 ? '?' : ''}${new URLSearchParams({ ...(tab ? { t: tab } : {}), ...(p > 1 ? { p: String(p) } : {}) })}`;
  return (
    <>
      <PageHead crumb="Inventory" title="Transfers" sub="Stock moved between warehouses, and unallocated stock placed in a warehouse — each with who, why and what arrived.">
        {ctx.staffRole && ctx.can('stock.adjust') && <Link className="ep-btn" href="/transfers/new">New transfer <Arrow /></Link>}
      </PageHead>
      <section className="ep-card ep-card--flush">
        <div className="ep-tabbar">
          {TABS.map(([k, l]) => <Link key={k} href={href(k)} className={t === k ? 'is-on' : ''}>{l}<em>{k ? all.filter((x) => x.status === k).length : all.length}</em></Link>)}
        </div>
        {list.length === 0 ? <Empty title="No transfers yet" text="When stock moves between Guangzhou and Ningbo it shows here." /> : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Transfer</th>{ctx.backOffice && <th>Client</th>}<th>From → to</th><th className="ep-right">Units</th><th>Status</th><th>Requested</th></tr></thead>
              <tbody>
                {list.slice((page - 1) * PER, page * PER).map((x) => {
                  const units = x.transfer_items.reduce((a, i) => a + i.qty, 0);
                  return (
                    <tr key={x.id} data-href={`/transfers/${x.id}`}>
                      <td><Link href={`/transfers/${x.id}`}><b className="ep-mono">{x.ref}</b></Link><small>{x.kind === 'allocation' ? 'Allocation of unallocated stock' : x.reason}</small></td>
                      {ctx.backOffice && <td>{names[x.org_id] ?? '—'}</td>}
                      <td>{whLabel(wh.get(x.from_warehouse_id))} → {whLabel(wh.get(x.to_warehouse_id))}</td>
                      <td className="ep-right">{units.toLocaleString('en')}</td>
                      <td><Badge map={TRANSFER_STATUS} value={x.status} /></td>
                      <td>{fmtDate(x.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager total={list.length} page={page} per={PER} href={(n) => href(t, n)} noun="transfer" />
      </section>
    </>
  );
}
