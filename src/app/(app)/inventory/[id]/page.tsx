import { redirect } from 'next/navigation';
import { shippingOnly } from '@/lib/session';
import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { available, getProducts, kitStock, productOptions, type ProductRow } from '@/lib/data';
import { fmtDays, HEALTH, runway, salesByProduct } from '@/lib/insights';
import { fmtDate } from '@/lib/format';
import { Back, Empty, TeamOnly, Thumb } from '@/components/ui';
import { ItemRows, Submit } from '@/components/client';
import { ImagePick } from '@/components/media';
import { adjustStock, decideQuarantine, quarantineStock, reconcileStock, releaseStock, requestQuarantine, saveBundle, saveProductPhoto, updateProduct } from '../actions';
import Link from 'next/link';
import { getWarehouses, shippingWarehouses, type WarehouseStock } from '@/lib/warehouses';

const QD: Record<string, string> = { restock: 'Restock', dispose: 'Dispose', return: 'Return to supplier' };
const TYPES: Record<string, string> = { inbound: 'Received', order: 'Shipped', adjust: 'Correction', count: 'Warehouse count', quarantine: 'To quarantine', release: 'Out of quarantine', transfer_out: 'Transfer out', transfer_in: 'Transfer in' };
const SOURCE: Record<string, string> = { manual: 'Entered in app', csv: 'CSV import', warehouse: 'Warehouse confirmed', reconciliation: 'Reconciliation (owner)' };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  if (shippingOnly(ctx)) redirect('/shipping');
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('product_stock').select('*').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data } = await q.maybeSingle();
  if (!data) notFound();
  const p = data as ProductRow;
  const [{ data: moves }, sales, { data: org }, whs, { data: perWh }] = await Promise.all([
    sb.from('stock_moves').select('*').eq('product_id', id).order('created_at', { ascending: false }).limit(100),
    salesByProduct(ctx, 30),
    ctx.backOffice ? sb.from('organizations').select('name').eq('id', p.org_id).maybeSingle() : Promise.resolve({ data: null }),
    getWarehouses(),
    sb.from('warehouse_stock').select('*').eq('product_id', id),
  ]);
  const kit = p.kind === 'bundle';
  const [{ data: parts }, { data: qreqs }, siblings] = await Promise.all([
    kit ? sb.from('bundle_items').select('component_id, qty').eq('bundle_id', id) : Promise.resolve({ data: [] as { component_id: string; qty: number }[] }),
    sb.from('quarantine_requests').select('id, warehouse_id, qty, decision, note, status, created_at, handled_at, handled_note').eq('product_id', id).order('created_at', { ascending: false }).limit(20),
    kit ? getProducts({ ...ctx, org: { id: p.org_id } as typeof ctx.org }) : Promise.resolve([] as ProductRow[]),
  ]);
  const comps = (parts ?? []).map((x) => ({ ...x, p: siblings.find((s) => s.id === x.component_id) })).filter((x) => x.p);
  const kits = kit ? kitStock(comps.map((x) => ({ qty: x.qty, p: x.p! }))) : 0;
  type QR = { id: string; warehouse_id: string; qty: number; decision: string; note: string | null; status: string; created_at: string; handled_at: string | null; handled_note: string | null };
  const requests = (qreqs ?? []) as QR[];
  const openReq = requests.filter((r) => r.status === 'requested');
  const undecided = Math.max(0, p.quarantined - openReq.reduce((a, r) => a + r.qty, 0));
  const decide = !ctx.backOffice && ctx.can('products.edit');
  const byWh = (perWh ?? []) as WarehouseStock[];
  const whName = new Map(whs.map((w) => [w.id, w]));
  const real = shippingWarehouses(whs);
  const stocked = byWh.filter((w) => w.on_hand !== 0 || w.quarantined !== 0 || w.reserved !== 0);
  const unalloc = p.unallocated ?? 0;
  const whSelect = (opts: { holding?: boolean; name?: string } = {}) => (
    <label>Warehouse
      <select name={opts.name ?? 'warehouse_id'} required defaultValue={stocked.find((w) => w.warehouse_kind === 'physical')?.warehouse_id ?? ''}>
        <option value="" disabled>Choose</option>
        {real.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        {opts.holding && unalloc !== 0 && whs.filter((w) => w.kind === 'holding').map((w) => <option key={w.id} value={w.id}>Unallocated pool</option>)}
      </select>
    </label>
  );
  const r = runway(p, sales.get(p.id) ?? 0);
  const [hl, tone] = HEALTH[r.health];
  const av = available(p);
  const max = Math.max(1, av + p.reserved + p.quarantined + p.incoming);
  const back = `/inventory/${p.id}`;
  const tools = ctx.can('stock.adjust');
  const missing = !p.hs_code || !Number(p.customs_value);
  return (
    <>
      <Back href="/inventory">Inventory</Back>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">{org?.name ? `${org.name} · ` : ''}Product</p>
          <div className="ep-ptitle">
            <Thumb id={p.id} photo={p.photo_path} name={p.name} size={64} kit={kit} />
            <div>
              <h1>{p.sku} {kit ? <span className="ep-st ep-st--pk">Kit</span> : <span className={`ep-st ep-st--${tone}`}>{hl}</span>}</h1>
              <p>{p.name}{kit ? ` · ${comps.length} product${comps.length === 1 ? '' : 's'} inside` : <> · {p.hs_code ? `HS ${p.hs_code}` : <em className="ep-warn">HS code missing</em>} · customs value ${Number(p.customs_value).toFixed(2)}{p.weight_g ? ` · ${p.weight_g} g` : ''}</>}</p>
            </div>
          </div>
        </div>
        {ctx.can('products.edit') && <div className="ep-actions"><a className="ep-btn ep-btn--ghost" href="#edit">Edit details</a></div>}
      </div>

      {kit ? (
        <>
          <div className="ep-sum ep-sum--3">
            <div className={`ep-sum-card${kits === 0 ? ' is-alert' : ''}`}><small>Kits ready to ship</small><b>{kits.toLocaleString('en')}</b><span>Limited by the product with the least stock</span></div>
            <div className="ep-sum-card"><small>Products inside</small><b>{comps.reduce((a, x) => a + x.qty, 0)}</b><span>{comps.length} different SKU{comps.length === 1 ? '' : 's'}</span></div>
            <div className="ep-sum-card"><small>Weight</small><b>{(comps.reduce((a, x) => a + x.qty * (x.p!.weight_g || 0), 0) / 1000).toFixed(2)} <i>kg</i></b><span>From its products</span></div>
          </div>
          <section className={`ep-card${comps.length ? '' : ' ep-card--hl'}`} id="kit">
            <div className="ep-card-head"><h2>Inside this kit</h2><span className="ep-muted ep-small">Use the kit SKU {p.sku} in your store: we pick these products for every kit ordered.</span></div>
            {comps.length > 0 && (
              <ul className="ep-kit">
                {comps.map((x) => {
                  const can = Math.floor(available(x.p!) / x.qty);
                  return (
                    <li key={x.component_id} className={can === kits ? 'is-limit' : ''}>
                      <Thumb id={x.p!.id} photo={x.p!.photo_path} name={x.p!.name} size={44} />
                      <Link href={`/inventory/${x.p!.id}`}><b>{x.p!.name}</b><small>{x.p!.sku}</small></Link>
                      <span className="ep-kit-qty">× {x.qty}</span>
                      <span className="ep-kit-av"><b>{available(x.p!).toLocaleString('en')}</b><small>sellable · enough for {can.toLocaleString('en')}</small></span>
                    </li>
                  );
                })}
              </ul>
            )}
            {ctx.can('products.edit') && (
              <details className="ep-edit" open={!comps.length || undefined}>
                <summary><span>{comps.length ? 'Change the products in this kit' : 'Choose the products in this kit'}</span><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5.5 8l4.5 4.5L14.5 8" /></svg></summary>
                <form action={saveBundle} className="ep-form">
                  <input type="hidden" name="product" value={p.id} />
                  <ItemRows products={productOptions(siblings.filter((s) => s.kind !== 'bundle'))} initial={comps.map((x) => ({ id: x.component_id, qty: x.qty }))} qtyLabel="Per kit" />
                  <div className="ep-form-foot" style={{ margin: 0 }}><Submit>Save kit</Submit></div>
                </form>
              </details>
            )}
          </section>
        </>
      ) : <>
      {missing && ctx.can('products.edit') && (
        <a href="#edit" className="ep-fixbar">
          <span><b>Customs info missing.</b> Add the {!p.hs_code && 'HS code'}{!p.hs_code && !Number(p.customs_value) && ' and '}{!Number(p.customs_value) && 'customs value'} so orders with this product aren’t held.</span>
          <em>Fix now →</em>
        </a>
      )}

      <div className="ep-sum ep-sum--5">
        <div className="ep-sum-card"><small>Sellable</small><b>{av.toLocaleString('en')}</b><span>Ready to ship today</span></div>
        <div className="ep-sum-card"><small>In warehouse</small><b>{p.on_hand.toLocaleString('en')}</b><span>{p.reserved} reserved · {p.quarantined} quarantine</span></div>
        <div className="ep-sum-card"><small>Incoming</small><b>{p.incoming.toLocaleString('en')}</b><span>On open inbounds</span></div>
        <div className="ep-sum-card"><small>Sold · 30 days</small><b>{r.sold30.toLocaleString('en')}</b><span>{r.daily ? `${r.daily.toFixed(1)} a day` : 'No sales yet'}</span></div>
        <div className={`ep-sum-card${r.health === 'critical' || r.health === 'out' ? ' is-alert' : r.health === 'warning' ? ' is-warn' : ''}`}><small>Runway</small><b>{fmtDays(r.days)}</b><span>{r.reorder ? `Reorder about ${r.reorder.toLocaleString('en')} units` : 'No reorder needed'}</span></div>
      </div>

      <section className="ep-card">
        <div className="ep-card-head"><h2>Where the units are</h2><span className="ep-legend"><i className="a" />Sellable <i className="r" />Reserved <i className="q" />Quarantine <i className="n" />Incoming</span></div>
        <div className="ep-bar3 ep-bar3--big"><i className="a" style={{ width: `${(av / max) * 100}%` }} /><i className="r" style={{ width: `${(p.reserved / max) * 100}%` }} /><i className="q" style={{ width: `${(p.quarantined / max) * 100}%` }} /><i className="n" style={{ width: `${(p.incoming / max) * 100}%` }} /></div>
      </section>

      <section className="ep-card ep-card--flush">
        <div className="ep-card-head ep-pad"><h2>By warehouse</h2><span className="ep-muted ep-small">{(p.in_transfer ?? 0) > 0 ? `${p.in_transfer} units on the way between warehouses` : 'Sellable = in warehouse − quarantine − reserved'}</span></div>
        {stocked.length === 0 ? <p className="ep-pad ep-muted ep-small" style={{ paddingBottom: '1.1rem' }}>No stock in any warehouse yet.</p> : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Warehouse</th><th className="ep-right">In warehouse</th><th className="ep-right">Quarantine</th><th className="ep-right">Reserved</th><th className="ep-right">Sellable</th></tr></thead>
              <tbody>{stocked.map((w) => (
                <tr key={w.warehouse_id}>
                  <td><b>{w.warehouse_kind === 'holding' ? 'Unallocated pool' : w.warehouse_name}</b>{w.warehouse_kind === 'holding' && <small>Recorded before warehouses — can’t ship until allocated</small>}</td>
                  <td className="ep-right">{w.on_hand.toLocaleString('en')}</td><td className="ep-right">{w.quarantined}</td><td className="ep-right">{w.reserved}</td>
                  <td className="ep-right"><b>{w.warehouse_kind === 'holding' ? '—' : Math.max(0, w.on_hand - w.quarantined - w.reserved).toLocaleString('en')}</b></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {unalloc !== 0 && ctx.staffRole === 'owner' && <p className="ep-pad" style={{ paddingBottom: '1.1rem' }}><Link className="ep-btn ep-btn--ghost ep-btn--sm" href="/transfers/new?kind=allocation">Allocate the {unalloc} unallocated units</Link></p>}
      </section>

      {tools && (
        <div className="ep-tools">
          <section className="ep-card ep-card--team">
            <h2>Quarantine</h2>
            <TeamOnly />
            <p className="ep-small ep-muted" style={{ marginBottom: '.8rem' }}>Set aside damaged or doubtful units. They stay in the warehouse but can’t be sold.</p>
            <form action={quarantineStock} className="ep-form">
              <input type="hidden" name="product" value={p.id} /><input type="hidden" name="back" value={back} />
              {whSelect()}
              <div className="ep-row2"><label>Units<input type="number" name="qty" min={1} max={av + p.reserved} required /></label><label>Reason<input name="reason" required placeholder="e.g. Crushed boxes" /></label></div>
              <Submit className="ep-btn ep-btn--ghost ep-btn--full">Move to quarantine</Submit>
            </form>
          </section>
          {p.quarantined > 0 && (
            <section className="ep-card ep-card--team">
              <h2>Release from quarantine</h2>
              <TeamOnly />
              <form action={releaseStock} className="ep-form">
                <input type="hidden" name="product" value={p.id} /><input type="hidden" name="back" value={back} />
                {whSelect()}
                <div className="ep-row2"><label>Units<input type="number" name="qty" min={1} max={p.quarantined} required /></label><label>Decision<select name="mode"><option value="release">Back to sellable</option><option value="writeoff">Write off (remove)</option></select></label></div>
                <label>Reason<input name="reason" required placeholder="e.g. Checked OK / Unsellable" /></label>
                <Submit className="ep-btn ep-btn--ghost ep-btn--full">Confirm</Submit>
              </form>
            </section>
          )}
          <section className="ep-card ep-card--team">
            <h2>Correct stock</h2>
            <TeamOnly />
            <form action={adjustStock} className="ep-form">
              <input type="hidden" name="product" value={p.id} /><input type="hidden" name="back" value={back} />
              {whSelect({ holding: true })}
              <div className="ep-row2"><label>Units (+ or −)<input type="number" name="qty" required placeholder="-2" /></label><label>Reason<select name="reason"><option>Cycle count</option><option>Damaged</option><option>Found</option><option>Opening stock</option><option>Other</option></select></label></div>
              <Submit className="ep-btn ep-btn--ghost ep-btn--full">Save correction</Submit>
            </form>
          </section>
          {ctx.staffRole === 'owner' && (
            <section className="ep-card ep-card--team">
              <h2>Reconcile (owner)</h2>
              <TeamOnly />
              <p className="ep-small ep-muted" style={{ marginBottom: '.8rem' }}>For differences you’ve investigated. Your approval, the reason and the evidence are stored with the movement.</p>
              <form action={reconcileStock} className="ep-form">
                <input type="hidden" name="product" value={p.id} /><input type="hidden" name="back" value={back} />
                {whSelect({ holding: true })}
                <div className="ep-row2"><label>Units (+ or −)<input type="number" name="qty" required /></label><label>Reference<input name="ref" maxLength={60} placeholder="e.g. EM-20005" /></label></div>
                <label>Reason<input name="reason" required maxLength={300} /></label>
                <label>Evidence<input name="evidence" required maxLength={500} placeholder="What proves it: count sheet, photo, message" /></label>
                <Submit className="ep-btn ep-btn--ghost ep-btn--full">Record reconciliation</Submit>
              </form>
            </section>
          )}
        </div>
      )}

      {(decide || openReq.length > 0 || requests.length > 0) && (p.quarantined > 0 || requests.length > 0) && (
        <section className={`ep-card ep-qd${decide && undecided > 0 ? ' ep-card--hl' : ''}`} id="quarantine">
          <div className="ep-card-head"><h2>Quarantine decisions</h2><span className="ep-muted ep-small">{p.quarantined ? `${p.quarantined} unit${p.quarantined === 1 ? '' : 's'} set aside${undecided ? ` · ${undecided} waiting for your decision` : ''}` : 'Nothing in quarantine now'}</span></div>
          {decide && undecided > 0 && (
            <form action={requestQuarantine} className="ep-form">
              <input type="hidden" name="product" value={p.id} /><input type="hidden" name="back" value={`${back}#quarantine`} />
              <p className="ep-small">These units were set aside by the warehouse (damaged, wrong item, doubtful). Tell us what to do with them:</p>
              <div className="ep-qd-choices" role="radiogroup" aria-label="Decision">
                <label><input type="radio" name="decision" value="restock" required /><span><b>Restock</b><small>They’re fine: put them back on sale.</small></span></label>
                <label><input type="radio" name="decision" value="dispose" /><span><b>Dispose</b><small>Throw them away. They leave your stock.</small></span></label>
                <label><input type="radio" name="decision" value="return" /><span><b>Return to supplier</b><small>We send them back; add the address in the note.</small></span></label>
              </div>
              <div className="ep-row3">
                <label>Warehouse
                  <select name="warehouse_id" required defaultValue={byWh.find((w) => w.quarantined > 0)?.warehouse_id ?? ''}>
                    <option value="" disabled>Choose</option>
                    {byWh.filter((w) => w.quarantined > 0).map((w) => <option key={w.warehouse_id} value={w.warehouse_id}>{w.warehouse_name} · {w.quarantined} in quarantine</option>)}
                  </select>
                </label>
                <label>Units<input type="number" name="qty" min={1} max={undecided} defaultValue={undecided} required /></label>
                <label>Note (optional)<input name="note" maxLength={500} placeholder="e.g. supplier address, photos wanted" /></label>
              </div>
              <div className="ep-form-foot" style={{ margin: 0 }}><Submit>Send decision</Submit></div>
            </form>
          )}
          {requests.length > 0 && (
            <ul className="ep-qd-list">
              {requests.map((r) => (
                <li key={r.id}>
                  <span className={`ep-qd-dot ep-qd-dot--${r.status}`} aria-hidden="true" />
                  <span><b>{r.qty} unit{r.qty === 1 ? '' : 's'} · {QD[r.decision]}</b><small>{whName.get(r.warehouse_id)?.name ?? ''} · asked {fmtDate(r.created_at)}{r.note ? ` · “${r.note}”` : ''}</small></span>
                  <span className="ep-qd-st">{r.status === 'requested' ? 'With the warehouse' : r.status === 'done' ? `Done ${fmtDate(r.handled_at)}` : `Declined${r.handled_note ? `: ${r.handled_note}` : ''}`}</span>
                  {r.status === 'requested' && tools && (
                    <form action={decideQuarantine} className="ep-qd-act">
                      <input type="hidden" name="request" value={r.id} /><input type="hidden" name="back" value={`${back}#quarantine`} />
                      <input name="note" placeholder="Note" maxLength={300} aria-label="Note for the brand" />
                      <button className="ep-btn ep-btn--sm" name="act" value="apply">Carry out</button>
                      <button className="ep-btn ep-btn--sm ep-btn--ghost" name="act" value="decline">Decline</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      </>}

      {ctx.can('products.edit') && (
        <section className={`ep-card${missing && !kit ? ' ep-card--hl' : ''}`} id="edit">
          <div className="ep-card-head"><h2>Product details</h2><span className="ep-muted ep-small">SKU {p.sku} can’t be changed. Stock changes only through inbounds, orders and the warehouse.</span></div>
          <form action={saveProductPhoto} className="ep-photo-form">
            <input type="hidden" name="product" value={p.id} />
            <ImagePick name="photo" label="Photo" current={p.photo_path ? `/files/product/${p.id}?v=${encodeURIComponent(p.photo_path.split('/').pop() ?? '')}` : null} hint="Shown in your inventory, on orders and to the packers." />
            <div className="ep-photo-acts"><Submit className="ep-btn ep-btn--sm">Save photo</Submit>{p.photo_path && <button className="ep-link ep-small" name="remove" value="1">Remove photo</button>}</div>
          </form>
          <form action={updateProduct} className="ep-form">
            <input type="hidden" name="product" value={p.id} />
            {kit ? (
              <>
                <label>Kit name<input name="name" defaultValue={p.name} required /></label>
                <input type="hidden" name="low_stock" value={p.low_stock} />
              </>
            ) : (
              <>
            <div className="ep-row2"><label>Product name<input name="name" defaultValue={p.name} required /></label><label>Barcode<input name="barcode" defaultValue={p.barcode ?? ''} placeholder="EAN / UPC" /></label></div>
                <div className="ep-row4">
                  <label>HS code<input name="hs_code" defaultValue={p.hs_code ?? ''} placeholder="e.g. 6307.90" autoFocus={missing && !p.hs_code} className={!p.hs_code ? 'is-missing' : ''} /></label>
                  <label>Customs value (USD)<input type="number" step="0.01" min={0} name="customs_value" defaultValue={Number(p.customs_value) || ''} className={!Number(p.customs_value) ? 'is-missing' : ''} /></label>
                  <label>Weight (g)<input type="number" min={0} name="weight_g" defaultValue={p.weight_g || ''} /></label>
                  <label>Low-stock alert at<input type="number" min={0} name="low_stock" defaultValue={p.low_stock} /></label>
                </div>
              </>
            )}
            <div className="ep-form-foot" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
              <span className="ep-small ep-muted">{kit ? 'Customs info, weight and stock come from the products inside the kit.' : <>Not sure of the HS code? Search the product on <a href="https://www.tariffnumber.com" target="_blank" rel="noreferrer">tariffnumber.com</a> or ask us in Support.</>}</span>
              <Submit>Save details</Submit>
            </div>
          </form>
        </section>
      )}

      <section className="ep-card ep-card--flush">
        <div className="ep-card-head ep-pad"><h2>Stock history</h2><span className="ep-muted ep-small">Every unit in and out, with its source</span></div>
        {(moves ?? []).length === 0 ? <Empty title="No movement yet" text="Stock arrives through inbounds and leaves with orders." /> : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Date</th><th>Movement</th><th>Warehouse</th><th>Reference</th><th>Note</th><th>Source</th><th className="ep-right">Units</th></tr></thead>
              <tbody>{(moves ?? []).map((m) => <tr key={m.id}><td><small>{fmtDate(m.created_at, true)}</small></td><td>{TYPES[m.type] ?? m.type}</td><td>{whName.get(m.warehouse_id)?.kind === 'holding' ? 'Unallocated' : whName.get(m.warehouse_id)?.code ?? '—'}</td><td>{m.ref || '—'}</td><td><small>{m.note || '—'}{m.evidence ? <><br />Evidence: {m.evidence}</> : null}</small></td><td><small>{SOURCE[m.source] ?? m.source}</small></td><td className="ep-right"><b className={['quarantine', 'release'].includes(m.type) ? 'ep-q' : m.qty < 0 ? 'ep-neg' : 'ep-pos'}>{m.qty > 0 ? '+' : ''}{m.qty}</b></td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
