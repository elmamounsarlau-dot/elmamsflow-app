import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { fmtDate } from '@/lib/format';
import { Back, Empty } from '@/components/ui';
import { Submit } from '@/components/client';
import { activeSheets, sheetsFor, shipSettings, shippingLines } from '@/lib/shipping-db';
import { quoteAll, SHIP_TYPES, transitLabel, type ShipType } from '@/lib/shipping-rates';
import { countryName } from '@/lib/format';
import { flag } from '@/lib/orders-query';
import { saveShippingDefaults, saveShippingLine, saveShippingSheet, uploadShippingWorkbook } from './actions';

const CHECK = ['GB', 'US', 'DE', 'FR', 'NL', 'ES', 'IT', 'AU', 'CA', 'JP'];

export const metadata = { title: 'Shipping prices' };

const ageDays = (d: string | null) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 864e5) : null);

export default async function ShippingPrices({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const ctx = await requireCtx();
  if (!ctx.staffRole || ctx.viewingAs || !ctx.can('billing.manage')) redirect('/settings');
  const [s, sheets, lines] = await Promise.all([shipSettings(), activeSheets(), shippingLines()]);
  const find = (line: string, t: ShipType) => sheets.find((x) => x.line_id === line && x.product_type === t);
  const types = Object.keys(SHIP_TYPES) as ShipType[];
  // Price check: what each line costs us for a test parcel, to compare with the partner's own page.
  const cw = Math.min(30000, Math.max(1, Math.round(Number(sp.cw) || 140)));
  const ct: ShipType = types.includes(sp.ct as ShipType) ? (sp.ct as ShipType) : 'general';
  const checkSheets = await sheetsFor(ct, undefined, { includeOff: true });
  const checkLines = [...new Map(checkSheets.map((x) => [x.line.id, x.line])).values()].sort((a, b) => a.sort - b.sort);
  const zero = { pct: 0, fixed: 0 };

  return (
    <>
      <Back href="/rates">Shipping rates</Back>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">Settings · team only</p>
          <h1>Shipping prices</h1>
          <p>The partner’s price sheets and your margin. Clients never see this page — they only see the final price in <Link href="/rates">Shipping rates</Link>.</p>
        </div>
      </div>

      <section className="ep-card" id="upload" style={{ marginBottom: '1.2rem' }}>
        <div className="ep-card-head"><h2>Upload the price file</h2><span className="ep-st ep-st--ok">All lines at once</span></div>
        <p className="ep-small" style={{ marginBottom: '.8rem' }}>Download your copy of the partner’s sheet as <b>Excel (.xlsx)</b> and upload it here. Every tab is saved to its line from its name — e.g. <i>5-Priority General</i> → Priority · General goods, <i>13- Express General</i> → Express · General goods. The previous prices of those lines are replaced straight away.</p>
        <form action={uploadShippingWorkbook} className="ep-form ep-row3" style={{ alignItems: 'end' }}>
          <label style={{ gridColumn: 'span 2' }}>Price file (.xlsx)<input name="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></label>
          <Submit>Upload and save prices</Submit>
        </form>
      </section>

      <section className="ep-card ep-card--flush" id="lines" style={{ marginBottom: '1.2rem' }}>
        <div className="ep-card-head ep-pad"><h2>Shipping lines</h2><span className="ep-muted ep-small">Each line is one option clients can choose · one sheet per product type</span></div>
        <div className="ep-tablewrap">
          <table className="ep-table">
            <thead><tr><th>Line (as clients see it)</th>{types.map((t) => <th key={t}>{SHIP_TYPES[t]}</th>)}</tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <b>{l.name}</b>{!l.active && <span className="ep-st ep-st--mute" style={{ marginLeft: '.4rem' }}>Hidden</span>}
                    {l.note && <small className="ep-muted">{l.note}</small>}
                    <details className="ep-edit">
                      <summary><span>Edit</span></summary>
                      <form action={saveShippingLine} className="ep-form" style={{ marginTop: '.5rem' }}>
                        <input type="hidden" name="id" value={l.id} />
                        <label>Name clients see<input name="name" defaultValue={l.name} maxLength={60} required /></label>
                        <label>Team note<input name="note" defaultValue={l.note ?? ''} maxLength={160} placeholder="Which partner line / tabs" /></label>
                        <div className="ep-row2">
                          <label>Order in the list<input name="sort" type="number" min={0} max={999} defaultValue={l.sort} /></label>
                          <label className="ep-check" style={{ alignSelf: 'end' }}><input type="checkbox" name="active" defaultChecked={l.active} /> Offered to clients</label>
                        </div>
                        <Submit className="ep-btn ep-btn--sm">Save line</Submit>
                      </form>
                    </details>
                  </td>
                  {types.map((t) => {
                    const x = find(l.id, t);
                    if (!x) return <td key={t}><span className="ep-muted ep-small">—</span></td>;
                    const age = ageDays(x.created_at);
                    const old = age != null && age >= s.remind_days;
                    return (
                      <td key={t}>
                        <span className={`ep-st ep-st--${old ? 'warn' : 'ok'}`}>{old ? `${age} days old` : 'Up to date'}</span>
                        <small>{x.countries} countries · dated {x.dated ? fmtDate(x.dated) : '—'}</small>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="ep-edit ep-pad">
          <summary><span>Add a line</span></summary>
          <form action={saveShippingLine} className="ep-form" style={{ marginTop: '.6rem', maxWidth: '34rem' }}>
            <div className="ep-row2">
              <label>Name clients see<input name="name" maxLength={60} required placeholder="e.g. Express UK" /></label>
              <label>Team note<input name="note" maxLength={160} placeholder="Which partner line / tabs" /></label>
            </div>
            <input type="hidden" name="sort" value="100" />
            <input type="hidden" name="active" value="on" />
            <Submit className="ep-btn ep-btn--sm">Add line</Submit>
          </form>
        </details>
      </section>

      <section className="ep-card ep-card--flush" id="check" style={{ marginBottom: '1.2rem' }}>
        <div className="ep-card-head ep-pad">
          <h2>Price check</h2>
          <form method="get" className="ep-form" style={{ display: 'flex', gap: '.5rem', alignItems: 'end', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>Packed weight (g)<input name="cw" type="number" min={1} max={30000} defaultValue={cw} style={{ width: '7rem' }} /></label>
            <label style={{ margin: 0 }}>Type<select name="ct" defaultValue={ct}>{types.map((t) => <option key={t} value={t}>{SHIP_TYPES[t]}</option>)}</select></label>
            <button className="ep-btn ep-btn--sm ep-btn--ghost">Check</button>
          </form>
        </div>
        <p className="ep-small ep-muted ep-pad" style={{ paddingTop: 0 }}>Our cost per line for one parcel of this weight — compare with the partner’s own page. Client price (with the default margin) underneath.</p>
        {checkLines.length === 0 ? <div className="ep-pad"><Empty title="No prices yet" text="Upload the price file above." /></div> : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Country</th>{checkLines.map((l) => <th key={l.id} className="ep-right">{l.name}{!l.active && <small>hidden</small>}</th>)}</tr></thead>
              <tbody>
                {CHECK.map((cc) => {
                  const q = quoteAll(checkSheets, cc, { weight_g: cw }, s, zero);
                  return (
                    <tr key={cc}>
                      <td>{flag(cc)} {countryName(cc)}</td>
                      {checkLines.map((l) => {
                        const x = q.find((y) => y.line === l.id);
                        if (!x) return <td key={l.id} className="ep-right"><span className="ep-muted">—</span></td>;
                        const client = Math.round((x.cost * (1 + s.margin_pct / 100) + s.margin_fixed) * 100) / 100;
                        return <td key={l.id} className="ep-right"><b>${x.cost.toFixed(2)}</b><small>{x.carrier ? `${x.carrier} · ` : ''}{transitLabel(x.transit)}</small><small>client ${client.toFixed(2)}</small></td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="ep-split">
        <section className="ep-card" id="paste">
          <h2>Paste a new sheet</h2>
          <ol className="ep-steps-list ep-small" style={{ marginBottom: '.8rem' }}>
            <li>Open the partner’s sheet on a tab (e.g. <i>13 · last-mile service provider for general goods</i>).</li>
            <li>Click any cell, press <b>Cmd + A</b> then <b>Cmd + C</b>.</li>
            <li>Choose its line and product type below (the team note on each line says which tabs), paste, save. It replaces that line’s previous prices straight away.</li>
          </ol>
          <form action={saveShippingSheet} className="ep-form">
            <div className="ep-row2">
              <label>Line<select name="line" required defaultValue={lines[0]?.id}>{lines.map((l) => <option key={l.id} value={l.id}>{l.name}{l.note ? ` — ${l.note}` : ''}</option>)}</select></label>
              <label>Product type<select name="product_type" required defaultValue="general">{(Object.keys(SHIP_TYPES) as ShipType[]).map((t) => <option key={t} value={t}>{SHIP_TYPES[t]}</option>)}</select></label>
            </div>
            <label>Note for the team<input name="source" placeholder="e.g. tab 13, last-mile general goods" maxLength={120} /></label>
            <label>Paste the sheet here<textarea name="sheet" rows={8} required placeholder="Country/Region	Reference Timeframe	Weight(KG)	…" style={{ fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: '.8rem' }} /></label>
            <label>Date of the sheet<input name="dated" type="date" /><small>Optional — read from the top of the sheet when it’s there (e.g. 2026.11.9).</small></label>
            <div className="ep-form-foot"><Submit>Save prices</Submit></div>
          </form>
        </section>

        <section className="ep-card ep-card--side" id="defaults">
          <h2>Margin and weight rules</h2>
          <p className="ep-small ep-muted" style={{ marginBottom: '.8rem' }}>Client price = partner price × (1 + margin %) + margin per parcel. A client can have its own margin on its page.</p>
          <form action={saveShippingDefaults} className="ep-form">
            <div className="ep-row2">
              <label>Margin (%)<input name="margin_pct" type="number" step="0.1" min={0} max={500} defaultValue={s.margin_pct} required /></label>
              <label>Plus per parcel ($)<input name="margin_fixed" type="number" step="0.01" min={0} max={1000} defaultValue={s.margin_fixed} required /></label>
            </div>
            <div className="ep-row2">
              <label>Packaging weight (g)<input name="packaging_g" type="number" min={0} max={5000} defaultValue={s.packaging_g} required /><small>Added to the weight typed. Keep 0 when weights are packed weights.</small></label>
              <label>Volume factor<input name="volume_factor" type="number" min={1000} max={20000} defaultValue={s.volume_factor} required /><small>L × W × H (cm) ÷ this.</small></label>
            </div>
            <label>Remind me after (days)<input name="remind_days" type="number" min={1} max={90} defaultValue={s.remind_days} required /></label>
            <Submit className="ep-btn ep-btn--full">Save</Submit>
          </form>
        </section>
      </div>
      {sheets.length === 0 && <Empty title="No prices yet" text="Paste the partner’s first sheet above — the calculator for clients starts working right away." />}
    </>
  );
}
