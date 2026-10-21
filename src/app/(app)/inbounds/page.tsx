import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { orgNames } from '@/lib/data';
import { fmtDate, INBOUND_STATUS } from '@/lib/format';
import { Arrow, Badge, Empty } from '@/components/ui';
import { MiniSteps } from '@/components/steps';

export const metadata = { title: 'Stock inbounds' };

type Row = { id: string; ref: string; supplier: string | null; eta: string | null; status: string; cartons: number; org_id: string; created_at: string; received_at: string | null; inbound_items: { expected: number; received: number }[] };

const today = () => new Date().toISOString().slice(0, 10);
const lateDays = (b: Row) => (b.status !== 'received' && b.eta && b.eta < today() ? Math.round((Date.parse(today()) - Date.parse(b.eta)) / 864e5) : 0);

export default async function Inbounds({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const sb = await supabaseServer();
  let qy = sb.from('inbounds').select('id, ref, supplier, eta, status, cartons, org_id, created_at, received_at, inbound_items(expected, received)').order('created_at', { ascending: false }).limit(500);
  if (ctx.org) qy = qy.eq('org_id', ctx.org.id);
  let lg = sb.from('activity_log').select('detail, created_at').eq('action', 'inbound_status').like('detail', '%→ receiving').gte('created_at', new Date(Date.now() - 120 * 864e5).toISOString()).limit(2000);
  if (ctx.org) lg = lg.eq('org_id', ctx.org.id);
  const [{ data }, names, { data: logs }] = await Promise.all([qy, ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>), lg]);
  // When each inbound reached the dock (first time it was set to Receiving).
  const docked = new Map<string, number>();
  for (const l of (logs ?? []) as { detail: string; created_at: string }[]) {
    const ref = l.detail.split(' ')[0];
    const t = Date.parse(l.created_at);
    if (!docked.has(ref) || t < docked.get(ref)!) docked.set(ref, t);
  }
  const all = (data ?? []) as Row[];

  const units = (b: Row) => b.inbound_items.reduce((a, i) => a + i.expected, 0);
  const got = (b: Row) => b.inbound_items.reduce((a, i) => a + i.received, 0);
  const active = all.filter((b) => b.status !== 'received');
  const late = active.filter((b) => lateDays(b) > 0);
  const since90 = Date.now() - 90 * 864e5;
  const done90 = all.filter((b) => b.status === 'received' && b.received_at && Date.parse(b.received_at) >= since90);
  const times = done90.filter((b) => docked.has(b.ref)).map((b) => (Date.parse(b.received_at!) - docked.get(b.ref)!) / 864e5).filter((d) => d >= 0);
  const leadTimes = done90.map((b) => (Date.parse(b.received_at!) - Date.parse(b.created_at)) / 864e5);
  const avgDock = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  const avgLead = leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null;

  const TABS: [string, string, Row[]][] = [['all', 'All', all], ['active', 'On the way', active], ['late', 'Overdue', late], ['done', 'Available', all.filter((b) => b.status === 'received')]];
  const tab = TABS.find(([k]) => k === sp.t) ?? TABS[0];
  const q = (sp.q ?? '').trim().toLowerCase();
  const client = ctx.backOffice ? sp.c ?? '' : '';
  const list = tab[2].filter((b) => (!client || b.org_id === client) && (!q || `${b.ref} ${b.supplier ?? ''} ${names[b.org_id] ?? ''}`.toLowerCase().includes(q)));
  const href = (t: string) => `/inbounds?${new URLSearchParams({ ...(t !== 'all' ? { t } : {}), ...(q ? { q } : {}), ...(client ? { c: client } : {}) })}`;

  return (
    <>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">Stock inbounds</p>
          <h1>Stock inbounds</h1>
          <p>Announce what your factory sends and follow it from pickup until it’s sellable.</p>
        </div>
        <div className="ep-actions">{ctx.can('inbounds.create') && <Link className="ep-btn" href="/inbounds/new">New inbound <Arrow /></Link>}</div>
      </div>

      <div className="ep-sum">
        <Link href={href('active')} className="ep-sum-card">
          <small>On the way</small>
          <b>{active.length}</b>
          <span>{active.length ? `${active.reduce((a, b) => a + units(b), 0).toLocaleString('en')} units expected` : 'Nothing on the way'}</span>
        </Link>
        <Link href={href('late')} className={`ep-sum-card${late.length ? ' is-alert' : ''}`}>
          <small>Overdue</small>
          <b>{late.length}</b>
          <span>{late.length ? 'Past their expected date' : 'Everything on schedule'}</span>
        </Link>
        <div className="ep-sum-card">
          <small>Received · 90 days</small>
          <b>{done90.reduce((a, b) => a + got(b), 0).toLocaleString('en')} <i>units</i></b>
          <span>{done90.length} inbound{done90.length === 1 ? '' : 's'} made available</span>
        </div>
        <div className="ep-sum-card">
          <small>Avg. receiving time</small>
          <b className={avgDock !== null && avgDock <= 2 ? 'ep-good' : ''}>{avgDock !== null ? <>{avgDock.toFixed(1)} <i>days</i></> : '—'}</b>
          <span>{avgLead !== null ? `Arrival to sellable · ${avgLead.toFixed(0)} days from booking` : 'Arrival to sellable'}</span>
        </div>
      </div>

      <section className="ep-card ep-card--flush">
        <form className="ep-toolbar" action="/inbounds">
          {tab[0] !== 'all' && <input type="hidden" name="t" value={tab[0]} />}
          <div className="ep-search">
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            <input name="q" defaultValue={q} placeholder="Search reference or supplier" />
          </div>
          {ctx.backOffice && <select name="c" defaultValue={client}><option value="">All clients</option>{Object.entries(names).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>}
          <button className="ep-btn ep-btn--ghost">Apply</button>
        </form>
        <div className="ep-tabs">
          {TABS.map(([k, l, rows]) => <Link key={k} href={href(k)} className={tab[0] === k ? 'is-on' : ''}>{l}<em>{rows.filter((b) => !client || b.org_id === client).length}</em></Link>)}
        </div>
        {list.length === 0 ? (
          <Empty title={all.length ? 'Nothing here' : 'No inbounds yet'} text={all.length ? 'Try another tab or search.' : 'Announce a shipment and follow it until the stock is sellable.'}>
            {!all.length && ctx.can('inbounds.create') && <Link className="ep-btn" href="/inbounds/new">New inbound <Arrow /></Link>}
          </Empty>
        ) : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Inbound</th>{ctx.backOffice && <th>Client</th>}<th>Supplier</th><th>Created</th><th>Expected</th><th className="ep-right">SKUs</th><th className="ep-right">Units</th><th>Progress</th><th>Status</th></tr></thead>
              <tbody>
                {list.map((b) => {
                  const ld = lateDays(b);
                  const u = units(b);
                  return (
                    <tr key={b.id} data-href={`/inbounds/${b.id}`}>
                      <td><b className="ep-mono">{b.ref}</b>{b.cartons ? <small>{b.cartons} carton{b.cartons === 1 ? '' : 's'}</small> : null}</td>
                      {ctx.backOffice && <td><small className="ep-client">{names[b.org_id]}</small></td>}
                      <td>{b.supplier || <span className="ep-zero">—</span>}</td>
                      <td><small>{fmtDate(b.created_at)}</small></td>
                      <td>{b.status === 'received' ? <small>Arrived {b.received_at ? fmtDate(b.received_at) : ''}</small> : b.eta ? <><span>{fmtDate(b.eta)}</span>{ld > 0 && <small className="ep-late">{ld} day{ld === 1 ? '' : 's'} late</small>}</> : <span className="ep-zero">Not set</span>}</td>
                      <td className="ep-right">{b.inbound_items.length}</td>
                      <td className="ep-right">{b.status === 'received' ? <><b>{got(b).toLocaleString('en')}</b>{got(b) !== u && <small className="ep-late">of {u.toLocaleString('en')}</small>}</> : u.toLocaleString('en')}</td>
                      <td><MiniSteps status={b.status} overdue={ld > 0} /></td>
                      <td><Badge map={INBOUND_STATUS} value={b.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="ep-table-foot"><span>{list.length} inbound{list.length === 1 ? '' : 's'}</span></div>
      </section>
    </>
  );
}
