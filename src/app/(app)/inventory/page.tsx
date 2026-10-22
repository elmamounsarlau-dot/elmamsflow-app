import Link from 'next/link';
import { requireCtx } from '@/lib/session';
import { available, getProducts, orgNames, type ProductRow } from '@/lib/data';
import { fmtDays, HEALTH, runway, salesByProduct, type Health } from '@/lib/insights';
import { fmtDate } from '@/lib/format';
import { Arrow, Empty } from '@/components/ui';
import { Submit } from '@/components/client';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { KIND_LABEL } from '@/lib/integrations/core';
import { importStoreProducts } from '../integrations/actions';

export const metadata = { title: 'Inventory' };

const FILTERS: [string, string][] = [
  ['all', 'All SKUs'],
  ['reorder', 'Reorder now'],
  ['low', 'Running low'],
  ['healthy', 'Healthy'],
  ['idle', 'Not selling'],
  ['quarantine', 'Quarantine'],
  ['incoming', 'Incoming'],
  ['customs', 'Missing customs info'],
];
const SORTS: [string, string][] = [
  ['runway', 'Days of stock left'],
  ['sales', 'Best sellers (30d)'],
  ['sellable', 'Sellable units'],
  ['sku', 'SKU A–Z'],
  ['updated', 'Recently moved'],
];

export default async function Inventory({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const [products, names, sales] = await Promise.all([
    getProducts(ctx),
    ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>),
    salesByProduct(ctx, 30),
  ]);

  // Connected stores this person can import products from.
  let storesQ = supabaseAdmin().from('integrations').select('id, kind, name, org_id').neq('status', 'paused');
  if (ctx.org) storesQ = storesQ.eq('org_id', ctx.org.id);
  const { data: storeRows } = ctx.can('products.edit') ? await storesQ : { data: [] };
  const stores = ((storeRows ?? []) as { id: string; kind: 'shopify' | 'woocommerce'; name: string | null; org_id: string }[]).filter((st) => ctx.org || ctx.backOffice);
  const canConnect = ctx.can('integrations.manage') && !!ctx.org;
  const storeImport = (
    <>
      {stores.map((st) => (
        <form key={st.id} action={importStoreProducts}>
          <input type="hidden" name="id" value={st.id} />
          <input type="hidden" name="back" value="/inventory" />
          <Submit className="ep-btn ep-btn--ghost ep-btn--store" confirm={`Import every product from ${st.name ?? KIND_LABEL[st.kind]}? Products already here are not changed.`}>
            <span className={`ep-store-dot ep-store-dot--${st.kind}`} aria-hidden="true" />Import from {ctx.backOffice ? `${st.name ?? KIND_LABEL[st.kind]}` : KIND_LABEL[st.kind]}
          </Submit>
        </form>
      ))}
      {!stores.length && canConnect && <Link className="ep-btn ep-btn--ghost ep-btn--store" href="/integrations"><span className="ep-store-dot ep-store-dot--shopify" aria-hidden="true" /><span className="ep-store-dot ep-store-dot--woocommerce" aria-hidden="true" />Import from Shopify / WooCommerce</Link>}
    </>
  );

  const rows = products.map((p) => ({ p, r: runway(p, sales.get(p.id) ?? 0) }));
  const match = (f: string, x: (typeof rows)[number]) =>
    f === 'reorder' ? x.r.health === 'critical' || x.r.health === 'out'
    : f === 'low' ? x.r.health === 'warning'
    : f === 'healthy' ? x.r.health === 'healthy'
    : f === 'idle' ? x.r.health === 'idle' || x.r.health === 'new'
    : f === 'quarantine' ? x.p.quarantined > 0
    : f === 'incoming' ? x.p.incoming > 0
    : f === 'customs' ? !x.p.hs_code || !Number(x.p.customs_value)
    : true;

  const filter = FILTERS.some(([k]) => k === sp.f) ? sp.f : 'all';
  const sort = SORTS.some(([k]) => k === sp.sort) ? sp.sort : 'runway';
  const q = (sp.q ?? '').trim().toLowerCase();
  const client = ctx.backOffice ? sp.c ?? '' : '';

  const base = rows.filter((x) => (!client || x.p.org_id === client) && (!q || `${x.p.sku} ${x.p.name} ${x.p.barcode ?? ''}`.toLowerCase().includes(q)));
  const list = base.filter((x) => match(filter, x)).sort((a, b) => {
    if (sort === 'sales') return b.r.sold30 - a.r.sold30;
    if (sort === 'sellable') return b.r.available - a.r.available;
    if (sort === 'sku') return a.p.sku.localeCompare(b.p.sku);
    if (sort === 'updated') return (b.p.last_movement_at ?? '').localeCompare(a.p.last_movement_at ?? '');
    const rank: Record<Health, number> = { out: 0, critical: 1, warning: 2, healthy: 3, idle: 4, new: 5 };
    return rank[a.r.health] - rank[b.r.health] || (a.r.days ?? 1e9) - (b.r.days ?? 1e9);
  });

  const scopeRows = base;
  const sellable = scopeRows.reduce((a, x) => a + x.r.available, 0);
  const value = scopeRows.reduce((a, x) => a + x.p.on_hand * Number(x.p.customs_value || 0), 0);
  const reorder = scopeRows.filter((x) => match('reorder', x));
  const quarantined = scopeRows.reduce((a, x) => a + x.p.quarantined, 0);
  const incoming = scopeRows.reduce((a, x) => a + x.p.incoming, 0);
  const noCustoms = scopeRows.filter((x) => !x.p.hs_code || !Number(x.p.customs_value)).length;

  const link = (patch: Record<string, string>) => {
    const u = new URLSearchParams({ ...(q ? { q } : {}), ...(client ? { c: client } : {}), ...(filter !== 'all' ? { f: filter } : {}), ...(sort !== 'runway' ? { sort } : {}), ...patch });
    for (const [k, v] of [...u.entries()]) if (!v || (k === 'f' && v === 'all')) u.delete(k);
    const s = u.toString();
    return `/inventory${s ? `?${s}` : ''}`;
  };
  const exportHref = `/inventory/export?${new URLSearchParams({ ...(q ? { q } : {}), ...(client ? { c: client } : {}), f: filter }).toString()}`;

  return (
    <>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">Inventory</p>
          <h1>Inventory</h1>
          <p>Every unit we hold for {ctx.backOffice ? 'your clients' : 'you'}, what is sellable, and how long it will last.</p>
        </div>
        <div className="ep-actions">
          {storeImport}
          {(ctx.can('stock.adjust') || ctx.can('products.edit')) && <Link className="ep-btn ep-btn--ghost" href="/inventory/import">Import CSV</Link>}
          <a className="ep-btn ep-btn--ghost" href={exportHref}>Export</a>
          {ctx.can('products.edit') && <Link className="ep-btn" href="/inventory/new">Add product <Arrow /></Link>}
        </div>
      </div>

      <div className="ep-sum">
        <div className="ep-sum-card">
          <small>Sellable now</small>
          <b>{sellable.toLocaleString('en')} <i>units</i></b>
          <span>{scopeRows.length} SKU{scopeRows.length === 1 ? '' : 's'}{incoming ? ` · ${incoming.toLocaleString('en')} incoming` : ''}</span>
        </div>
        <div className="ep-sum-card">
          <small>Inventory value</small>
          <b>${value.toLocaleString('en', { maximumFractionDigits: 0 })}</b>
          <span>On hand, at declared customs value</span>
        </div>
        <Link href={link({ f: 'reorder' })} className={`ep-sum-card${reorder.length ? ' is-alert' : ''}`}>
          <small>Reorder now</small>
          <b>{reorder.length}</b>
          <span>{reorder.length ? 'Under 3 weeks of stock, or out' : 'Nothing about to run out'}</span>
        </Link>
        <Link href={link({ f: 'quarantine' })} className={`ep-sum-card${quarantined ? ' is-warn' : ''}`}>
          <small>Quarantine</small>
          <b>{quarantined.toLocaleString('en')} <i>units</i></b>
          <span>{quarantined ? 'Set aside, waiting for a decision' : 'Nothing set aside'}</span>
        </Link>
      </div>

      {noCustoms > 0 && (
        <p className="ep-note ep-note--warn" style={{ marginBottom: 14 }}>
          {noCustoms} product{noCustoms === 1 ? ' is' : 's are'} missing an HS code or customs value. Orders with them go on hold until it’s added.{' '}
          <Link href={link({ f: 'customs' })}><b>Show {noCustoms === 1 ? 'it' : 'them'} →</b></Link>
        </p>
      )}

      <section className="ep-card ep-card--flush">
        <form className="ep-toolbar" action="/inventory">
          <div className="ep-search">
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            <input name="q" defaultValue={q} placeholder="Search SKU, name or barcode" />
          </div>
          {ctx.backOffice && (
            <select name="c" defaultValue={client}>
              <option value="">All clients</option>
              {Object.entries(names).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </select>
          )}
          <select name="sort" defaultValue={sort}>{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
          {filter !== 'all' && <input type="hidden" name="f" value={filter} />}
          <button className="ep-btn ep-btn--ghost">Apply</button>
        </form>
        <div className="ep-tabbar">
          {FILTERS.map(([k, l]) => {
            const n = base.filter((x) => match(k, x)).length;
            if (k !== 'all' && n === 0 && filter !== k) return null;
            return <Link key={k} href={link({ f: k })} className={filter === k ? 'is-on' : ''}>{l}<em>{n}</em></Link>;
          })}
        </div>

        {list.length === 0 ? (
          <Empty title={products.length ? 'Nothing matches' : 'No products yet'} text={products.length ? 'Try another filter or search.' : stores.length ? 'Bring your whole catalogue in from your store in one click, or add products one by one.' : canConnect ? 'Connect your Shopify or WooCommerce store to import your catalogue in one click — or add products one by one, or from a CSV file.' : 'Add your first product, or import your list from a CSV file.'}>
            {!products.length && ctx.can('products.edit') && <div className="ep-actions" style={{ justifyContent: 'center', marginTop: '.4rem' }}>{storeImport}<Link className="ep-btn" href="/inventory/new">Add product <Arrow /></Link></div>}
          </Empty>
        ) : (
          <div className="ep-tablewrap">
            <table className="ep-table ep-inv">
              <thead>
                <tr>
                  <th>Product</th>
                  {ctx.backOffice && <th>Client</th>}
                  <th className="ep-inv-bar">Stock</th>
                  <th className="ep-right">In warehouse</th>
                  <th className="ep-right">Reserved</th>
                  <th className="ep-right">Sellable</th>
                  <th className="ep-right">Quarantine</th>
                  <th className="ep-right">Incoming</th>
                  <th className="ep-right">Sold 30d</th>
                  <th>Runway</th>
                </tr>
              </thead>
              <tbody>
                {list.map(({ p, r }) => <Row key={p.id} p={p} r={r} client={ctx.backOffice ? names[p.org_id] : null} />)}
              </tbody>
            </table>
          </div>
        )}
        <div className="ep-table-foot">
          <span>{list.length} of {base.length} SKU{base.length === 1 ? '' : 's'}</span>
          <span className="ep-legend"><i className="a" />Sellable <i className="r" />Reserved <i className="q" />Quarantine <i className="n" />Incoming</span>
        </div>
      </section>
    </>
  );
}

function Row({ p, r, client }: { p: ProductRow; r: ReturnType<typeof runway>; client: string | null }) {
  const av = available(p);
  const max = Math.max(1, av + p.reserved + p.quarantined + p.incoming);
  const [label, tone] = HEALTH[r.health];
  return (
    <tr data-href={`/inventory/${p.id}`}>
      <td>
        <div className="ep-prod">
          <span className="ep-prod-ic" aria-hidden="true">{p.sku.slice(0, 2)}</span>
          <div><b>{p.sku}</b><small>{p.name}{(!p.hs_code || !Number(p.customs_value)) && <a className="ep-fixlink" href={`/inventory/${p.id}#edit`}>{!p.hs_code ? 'Add HS code' : 'Add customs value'}</a>}</small></div>
        </div>
      </td>
      {client !== null && <td><small className="ep-client">{client}</small></td>}
      <td className="ep-inv-bar"><div className="ep-bar3"><i className="a" style={{ width: `${(av / max) * 100}%` }} /><i className="r" style={{ width: `${(p.reserved / max) * 100}%` }} /><i className="q" style={{ width: `${(p.quarantined / max) * 100}%` }} /><i className="n" style={{ width: `${(p.incoming / max) * 100}%` }} /></div></td>
      <td className="ep-right">{p.on_hand.toLocaleString('en')}</td>
      <td className="ep-right">{p.reserved || <span className="ep-zero">0</span>}</td>
      <td className="ep-right"><b>{av.toLocaleString('en')}</b></td>
      <td className="ep-right">{p.quarantined ? <span className="ep-st ep-st--warn">{p.quarantined}</span> : <span className="ep-zero">0</span>}</td>
      <td className="ep-right">{p.incoming || <span className="ep-zero">0</span>}</td>
      <td className="ep-right">{r.sold30 || <span className="ep-zero">0</span>}</td>
      <td>
        <div className="ep-runway">
          <span className={`ep-st ep-st--${tone}`}>{label}</span>
          <small>{r.days !== null ? `${fmtDays(r.days)} left` : p.last_movement_at ? `moved ${fmtDate(p.last_movement_at)}` : 'no movement'}</small>
        </div>
      </td>
    </tr>
  );
}
