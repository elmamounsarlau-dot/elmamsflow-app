import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { orgNames } from '@/lib/data';
import { fmtDate, ORDER_STATUS } from '@/lib/format';
import { applyScope, applyTab, CHANNELS, flag, HOLD_KIND, ordersHref, parseFilters, PER_PAGE, SEARCH_FIELDS, storeAdminUrl } from '@/lib/orders-query';
import { Arrow, Empty } from '@/components/ui';
import { Act, AutoSubmit, BulkBar, ColumnsMenu } from '@/components/orders';
import { ordersListAction } from './actions';

export const metadata = { title: 'Orders' };

const STATUS_HELP: Record<string, string> = {
  new: 'Received and waiting for the warehouse',
  on_hold: 'Stopped until a problem is fixed or someone releases it',
  packed: 'Picked and packed, waiting for the carrier',
  shipped: 'Handed to the carrier and on its way',
  delivered: 'Delivered to the customer',
  cancelled: 'Cancelled before it shipped',
};

type Row = {
  id: string; number: string; store_ref: string | null; customer: string; email: string | null; city: string | null; country: string;
  created_at: string; status: string; org_id: string; carrier: string | null; tracking: string | null; service: string; source: string | null;
  integration_id: string | null; external_id: string | null; hold_kind: string | null; hold_reason: string | null; held_at: string | null;
  order_items: { qty: number }[];
};

const I = {
  open: <path d="M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z M10 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z" />,
  store: <path d="M4 7h12l-1 10H5L4 7z M7.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />,
  hold: <path d="M7.5 5v10 M12.5 5v10" />,
  release: <path d="M7 5l8 5-8 5V5z" />,
  cancel: <path d="M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z M7.5 7.5l5 5 M12.5 7.5l-5 5" />,
  ticket: <path d="M3.5 5.5h13v8h-7l-3.5 3v-3H3.5v-8z" />,
  track: <path d="M2.5 6h9v7h-9z M11.5 9h3.5l2.5 2.5V13h-6 M5.5 15.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z M14.5 15.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z" />,
  filter: <path d="M3 4.5h14l-5.5 6.5v5l-3-1.5v-3.5L3 4.5z" />,
  down: <path d="M10 3v10 M6 9l4 4 4-4 M4 16.5h12" />,
  plus: <path d="M10 4v12 M4 10h12" />,
  orders: <path d="M3 6l7-3.5L17 6v8l-7 3.5L3 14V6z M3 6l7 3.5L17 6 M10 9.5v8" />,
};
const Ico = ({ d, s = 16 }: { d: keyof typeof I; s?: number }) => (
  <svg viewBox="0 0 20 20" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{I[d]}</svg>
);

export default async function Orders({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const f = parseFilters(await searchParams, ctx.backOffice);
  const sb = await supabaseServer();
  const orgId = ctx.org?.id ?? null;
  const scopeOnly = { ...f, q: '', src: '', country: '', from: '', to: '', svc: '' };

  const count = (fn: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => fn(base()).then((r) => r.count ?? 0);
  const base = () => applyScope(sb.from('orders').select('id', { count: 'exact', head: true }), scopeOnly, orgId);

  const from = (f.p - 1) * f.per;
  const listQ = applyTab(applyScope(
    sb.from('orders').select('id, number, store_ref, customer, email, city, country, created_at, status, org_id, carrier, tracking, service, source, integration_id, external_id, hold_kind, hold_reason, held_at, order_items(qty)', { count: 'exact' }),
    f, orgId,
  ), f).order(f.t ? 'held_at' : 'created_at', { ascending: false, nullsFirst: false }).range(from, from + f.per - 1);

  const statusKeys = Object.keys(ORDER_STATUS);
  const kindKeys = Object.keys(HOLD_KIND);
  const [list, statusCounts, kindCounts, allCount, names, countriesRes] = await Promise.all([
    listQ,
    Promise.all(statusKeys.map((k) => count((q) => q.eq('status', k)))),
    Promise.all(kindKeys.map((k) => count((q) => q.eq('status', 'on_hold').eq('hold_kind', k)))),
    count((q) => q),
    ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>),
    applyScope(sb.from('orders').select('country'), scopeOnly, orgId).order('created_at', { ascending: false }).limit(2000),
  ]);
  const rows = (list.data ?? []) as unknown as Row[];
  const total = list.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / f.per));
  const held = statusCounts[statusKeys.indexOf('on_hold')];
  const countries = [...new Set((countriesRes.data ?? []).map((r) => r.country as string))].filter((c) => c && c !== 'XX').sort();

  // Store links ("view in Shopify") for the rows on this page.
  const integ = [...new Set(rows.map((r) => r.integration_id).filter(Boolean))] as string[];
  const { data: stores } = integ.length ? await supabaseAdmin().from('integrations').select('id, kind, store_url').in('id', integ) : { data: [] };
  const storeOf = new Map((stores ?? []).map((s) => [s.id, s]));

  const canCreate = ctx.can('orders.create');
  const canHold = canCreate || ctx.can('orders.hold');
  const staffHold = !!ctx.staffRole && ctx.can('orders.hold');
  const here = ordersHref(f);
  const issueTab = !!f.t;
  const activeFilters = [f.src && CHANNELS[f.src], f.country, f.svc && (f.svc === 'ddp' ? 'DDP' : 'Express'), (f.from || f.to) && `${f.from || '…'} → ${f.to || '…'}`, f.c && names[f.c]].filter(Boolean) as string[];
  const exportHref = `/orders/export${here.replace(/^\/orders/, '')}`;

  return (
    <>
      <div className="ep-head ep-head--orders">
        <div>
          <p className="ep-crumb ep-crumb--icon"><Ico d="orders" s={14} />Orders</p>
          <h1>Manage your orders</h1>
          <p>Every order from your stores and from us, where it is right now, and what needs a fix before it can ship.</p>
        </div>
        {canCreate && (
          <div className="ep-actions">
            <Link className="ep-btn" href="/orders/new">New order <Arrow /></Link>
          </div>
        )}
      </div>

      <nav className="ep-statstrip" aria-label="Orders by status">
        {statusKeys.map((k, i) => (
          <Link key={k} href={ordersHref(f, { s: f.s === k ? '' : k, t: '', p: 1 })} className={`ep-statchip ep-statchip--${ORDER_STATUS[k][1]}${f.s === k ? ' is-on' : ''}`} title={STATUS_HELP[k]}>
            <span>{ORDER_STATUS[k][0]}<i aria-hidden="true">i</i></span>
            <b>{statusCounts[i].toLocaleString('en')}</b>
          </Link>
        ))}
      </nav>

      <section className="ep-card ep-card--flush ep-orders" id="orders-table" data-hide="carrier">
        <div className="ep-orders-top">
          <div className="ep-segs" role="tablist">
            <Link role="tab" aria-selected={!f.t} href={ordersHref(f, { t: '', p: 1 })} className={!f.t ? 'is-on' : ''}>All orders <em className="ep-segs-n">{allCount.toLocaleString('en')}</em></Link>
            {held > 0 && <Link role="tab" aria-selected={f.t === 'attention'} href={ordersHref(f, { t: 'attention', s: '', p: 1 })} className={f.t === 'attention' ? 'is-on' : ''}>Needs attention <em className="ep-segs-n is-hot">{held}</em></Link>}
            {kindKeys.map((k, i) => (
              <Link key={k} role="tab" aria-selected={f.t === k} href={ordersHref(f, { t: k, s: '', p: 1 })} className={f.t === k ? 'is-on' : ''} title={HOLD_KIND[k][2]}>
                {HOLD_KIND[k][0]}{kindCounts[i] > 0 && <em className="ep-segs-n is-hot">{kindCounts[i]}</em>}
              </Link>
            ))}
          </div>

          <div className="ep-orders-tools">
            <form action="/orders" className="ep-searchbox">
              {['t', 's', 'src', 'country', 'from', 'to', 'c', 'svc'].map((k) => (f as unknown as Record<string, string>)[k] ? <input key={k} type="hidden" name={k} value={(f as unknown as Record<string, string>)[k]} /> : null)}
              {f.per !== 25 && <input type="hidden" name="per" value={f.per} />}
              <select name="field" defaultValue={f.field} aria-label="Search in">{SEARCH_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <label className="ep-searchbox-in">
                <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                <input name="q" defaultValue={f.q} placeholder="Search" aria-label="Search orders" />
              </label>
            </form>

            <details className="ep-pop">
              <summary className={`ep-tool${activeFilters.length ? ' is-on' : ''}`} title="Filters"><Ico d="filter" s={15} />{activeFilters.length ? <em>{activeFilters.length}</em> : null}<span className="ep-sr">Filters</span></summary>
              <form action="/orders" className="ep-pop-panel ep-form">
                <p className="ep-pop-title">Filters</p>
                {f.t && <input type="hidden" name="t" value={f.t} />}
                {f.s && <input type="hidden" name="s" value={f.s} />}
                {f.q && <><input type="hidden" name="q" value={f.q} /><input type="hidden" name="field" value={f.field} /></>}
                {ctx.backOffice && (
                  <label>Client<select name="c" defaultValue={f.c}><option value="">All clients</option>{Object.entries(names).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
                )}
                <label>Channel<select name="src" defaultValue={f.src}><option value="">All channels</option>{Object.entries(CHANNELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                <label>Country<select name="country" defaultValue={f.country}><option value="">All countries</option>{countries.map((c) => <option key={c} value={c}>{flag(c)} {c}</option>)}</select></label>
                <label>Service<select name="svc" defaultValue={f.svc}><option value="">Express and DDP</option><option value="express">Express</option><option value="ddp">DDP</option></select></label>
                <div className="ep-row2">
                  <label>From<input type="date" name="from" defaultValue={f.from} /></label>
                  <label>To<input type="date" name="to" defaultValue={f.to} /></label>
                </div>
                <div className="ep-pop-foot">
                  <Link href={ordersHref({ ...f, src: '', country: '', svc: '', from: '', to: '', c: '' }, { p: 1 })} className="ep-link">Reset all</Link>
                  <button className="ep-btn ep-btn--sm">Apply filters</button>
                </div>
              </form>
            </details>

            <a className="ep-tool" href={exportHref} title="Export CSV"><Ico d="down" s={15} /><span className="ep-sr">Export CSV</span></a>
            <ColumnsMenu target="orders-table" />
            {canCreate && <Link className="ep-tool ep-tool--go" href="/orders/new" title="Create new order"><Ico d="plus" s={15} /><span className="ep-sr">Create new order</span></Link>}
          </div>
        </div>

        {activeFilters.length > 0 && (
          <div className="ep-chips-active">
            {activeFilters.map((a) => <span key={a}>{a}</span>)}
            <Link href={ordersHref({ ...f, src: '', country: '', svc: '', from: '', to: '', c: '' }, { p: 1 })} className="ep-link">Clear filters</Link>
          </div>
        )}
        {issueTab && f.t !== 'attention' && <p className="ep-orders-hint">{HOLD_KIND[f.t][2]}. {f.t === 'manual' ? 'Release them when they’re ready to ship.' : f.t === 'products' ? 'Import or add the products, then open the order and press “Match products again”.' : f.t === 'customs' ? 'Add the HS code and customs value on the product — the order releases by itself.' : f.t === 'address' ? 'Open the order to see the address, then fix it in your store or tell us in Support.' : 'They ship as soon as stock arrives.'}</p>}

        <form id="orders-bulk" action={ordersListAction}>
          <input type="hidden" name="back" value={here} />
          <BulkBar formId="orders-bulk">
            {canHold && <Act className="ep-bulk-btn" value="hold" confirm="Put the selected orders on hold?"><Ico d="hold" s={13} />Hold</Act>}
            {canHold && <Act className="ep-bulk-btn" value="release"><Ico d="release" s={13} />Release</Act>}
            <Act className="ep-bulk-btn" formAction="/orders/export" formMethod="get" value="export"><Ico d="down" s={13} />Export</Act>
            {canCreate && <Act className="ep-bulk-btn ep-bulk-btn--err" value="cancel" confirm="Cancel the selected orders? Only orders not packed yet can be cancelled."><Ico d="cancel" s={13} />Cancel</Act>}
          </BulkBar>

          {rows.length === 0 ? (
            <Empty
              title={total === 0 && !f.q && !activeFilters.length && !f.s && !f.t ? 'No orders yet' : 'Nothing here'}
              text={f.t ? 'No orders are held for this reason. 🎉' : f.q || activeFilters.length || f.s ? 'Try another search or clear the filters.' : 'Orders from your connected store arrive here by themselves. You can also create one by hand.'}
            />
          ) : (
            <div className="ep-tablewrap">
              <table className="ep-table ep-otable">
                <thead>
                  <tr>
                    <th className="ep-ock"><input type="checkbox" data-all aria-label="Select all on this page" /></th>
                    <th>Order ID</th>
                    {ctx.backOffice && <th>Client</th>}
                    <th>{issueTab ? 'Hold type' : 'Status'}</th>
                    <th className="col-items">Items</th>
                    <th>Customer name</th>
                    {issueTab ? <th>Issue</th> : <th className="col-email">Customer email</th>}
                    <th className="col-dest">Destination</th>
                    <th className="col-channel">Channel</th>
                    <th className="col-carrier">Carrier</th>
                    <th className="col-date">Order date</th>
                    {issueTab && <th>On hold since</th>}
                    <th className="ep-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => {
                    const items = o.order_items.reduce((a, i) => a + i.qty, 0);
                    const st = o.integration_id ? storeOf.get(o.integration_id) : undefined;
                    const storeUrl = st ? storeAdminUrl(st.kind, st.store_url, o.external_id) : null;
                    const canRelease = o.status === 'on_hold' && (staffHold || (canCreate && (o.hold_kind ?? 'manual') === 'manual'));
                    const [statusLabel, tone] = ORDER_STATUS[o.status] ?? [o.status, 'mute'];
                    const kind = o.hold_kind ? HOLD_KIND[o.hold_kind] : null;
                    return (
                      <tr key={o.id} data-href={`/orders/${o.id}`}>
                        <td className="ep-ock"><input type="checkbox" name="ids" value={o.id} aria-label={`Select order #${o.number}`} /></td>
                        <td className="ep-oid">
                          <Link href={`/orders/${o.id}`}>#{o.number}</Link>
                          {o.store_ref && <small>{o.store_ref}</small>}
                        </td>
                        {ctx.backOffice && <td className="ep-muted">{names[o.org_id] ?? '—'}</td>}
                        <td>
                          {issueTab
                            ? <span className={`ep-st ep-st--${o.hold_kind === 'manual' ? 'pk' : 'warn'}`}>{kind?.[1] ?? 'On hold'}</span>
                            : <span className={`ep-st ep-st--${tone}`} title={o.status === 'on_hold' && o.hold_reason ? o.hold_reason : undefined}>{o.status === 'on_hold' && kind ? kind[1] : statusLabel}</span>}
                        </td>
                        <td className="col-items">{items} item{items === 1 ? '' : 's'}</td>
                        <td className="ep-ocust">{o.customer}</td>
                        {issueTab
                          ? <td className="ep-oissue" title={o.hold_reason ?? ''}>{o.hold_reason ?? '—'}</td>
                          : <td className="col-email ep-muted">{o.email ?? '—'}</td>}
                        <td className="col-dest"><span className="ep-flag" aria-hidden="true">{flag(o.country)}</span>{[o.city, o.country !== 'XX' ? o.country : null].filter(Boolean).join(', ') || '—'}</td>
                        <td className="col-channel">{o.source && o.source !== 'manual' ? <span className={`ep-store-chip ep-store-chip--${o.source}`}>{CHANNELS[o.source] ?? o.source}</span> : <span className="ep-muted">Manual</span>}</td>
                        <td className="col-carrier ep-muted">{o.carrier || (o.service === 'ddp' ? 'DDP' : 'Express')}</td>
                        <td className="col-date">{fmtDate(o.created_at)}</td>
                        {issueTab && <td className="ep-muted">{fmtDate(o.held_at, true)}</td>}
                        <td>
                          <div className="ep-oacts">
                            <Link className="ep-oact" href={`/orders/${o.id}`} title={`Open order #${o.number}`}><Ico d="open" s={15} /></Link>
                            {storeUrl && st && <a className="ep-oact ep-oact--go" href={storeUrl} target="_blank" rel="noreferrer" title={`View in ${CHANNELS[st.kind]}`}><Ico d="store" s={15} /></a>}
                            {o.tracking && <a className="ep-oact ep-oact--go" href={`https://t.17track.net/en#nums=${encodeURIComponent(o.tracking)}`} target="_blank" rel="noreferrer" title={`Track ${o.tracking}`}><Ico d="track" s={15} /></a>}
                            {canHold && o.status === 'new' && <Act className="ep-oact ep-oact--warn" value={`hold:${o.id}`} title={`Hold order #${o.number}`} confirm={`Put #${o.number} on hold? The warehouse won’t pack it until it’s released.`}><Ico d="hold" s={15} /></Act>}
                            {canRelease && <Act className="ep-oact ep-oact--ok" value={`release:${o.id}`} title={`Release order #${o.number}`}><Ico d="release" s={15} /></Act>}
                            {canCreate && ['new', 'on_hold'].includes(o.status) && <Act className="ep-oact ep-oact--err" value={`cancel:${o.id}`} title={`Cancel order #${o.number}`} confirm={`Cancel #${o.number}?`}><Ico d="cancel" s={15} /></Act>}
                            <Link className="ep-oact" href={`/support/new?ref=${encodeURIComponent(o.number)}`} title={`Create ticket about #${o.number}`}><Ico d="ticket" s={15} /></Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </form>

        <div className="ep-pager">
          <span className="ep-muted">{total.toLocaleString('en')} order{total === 1 ? '' : 's'}</span>
          <form action="/orders" className="ep-pager-per">
            {Object.entries({ t: f.t, s: f.s, q: f.q, field: f.q ? f.field : '', src: f.src, country: f.country, from: f.from, to: f.to, c: f.c, svc: f.svc }).map(([k, v]) => v ? <input key={k} type="hidden" name={k} value={v} /> : null)}
            <label>Rows per page
              <select name="per" defaultValue={String(f.per)} data-autosubmit>{PER_PAGE.map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </label>
            <noscript><button className="ep-btn ep-btn--sm ep-btn--ghost">Go</button></noscript>
          </form>
          <span>Page {Math.min(f.p, pages)} of {pages}</span>
          <div className="ep-pager-nav">
            <PageLink href={ordersHref(f, { p: 1 })} off={f.p <= 1} label="First page">«</PageLink>
            <PageLink href={ordersHref(f, { p: f.p - 1 })} off={f.p <= 1} label="Previous page">‹</PageLink>
            <PageLink href={ordersHref(f, { p: f.p + 1 })} off={f.p >= pages} label="Next page">›</PageLink>
            <PageLink href={ordersHref(f, { p: pages })} off={f.p >= pages} label="Last page">»</PageLink>
          </div>
        </div>
      </section>
      <AutoSubmit />
    </>
  );
}

function PageLink({ href, off, label, children }: { href: string; off: boolean; label: string; children: React.ReactNode }) {
  return off ? <span className="ep-pg is-off" aria-hidden="true">{children}</span> : <Link className="ep-pg" href={href} aria-label={label}>{children}</Link>;
}
