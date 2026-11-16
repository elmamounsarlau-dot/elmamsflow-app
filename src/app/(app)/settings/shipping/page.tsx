import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { fmtDate } from '@/lib/format';
import { Back, Empty } from '@/components/ui';
import { Submit } from '@/components/client';
import { activeSheets, shipSettings } from '@/lib/shipping-db';
import { SERVICES, SHIP_TYPES, type Service, type ShipType } from '@/lib/shipping-rates';
import { saveShippingDefaults, saveShippingSheet } from './actions';

export const metadata = { title: 'Shipping prices' };

const ageDays = (d: string | null) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 864e5) : null);

export default async function ShippingPrices() {
  const ctx = await requireCtx();
  if (!ctx.staffRole || ctx.viewingAs || !ctx.can('billing.manage')) redirect('/settings');
  const [s, sheets] = await Promise.all([shipSettings(), activeSheets()]);
  const find = (sv: Service, t: ShipType) => sheets.find((x) => x.service === sv && x.product_type === t);

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

      <section className="ep-card ep-card--flush" style={{ marginBottom: '1.2rem' }}>
        <div className="ep-card-head ep-pad"><h2>Price sheets in use</h2><span className="ep-muted ep-small">Update when the date on the partner’s sheet changes</span></div>
        <div className="ep-tablewrap">
          <table className="ep-table">
            <thead><tr><th>Product type</th>{(Object.keys(SERVICES) as Service[]).map((sv) => <th key={sv}>{SERVICES[sv]}</th>)}</tr></thead>
            <tbody>
              {(Object.keys(SHIP_TYPES) as ShipType[]).map((t) => (
                <tr key={t}>
                  <td><b>{SHIP_TYPES[t]}</b></td>
                  {(Object.keys(SERVICES) as Service[]).map((sv) => {
                    const x = find(sv, t);
                    if (!x) return <td key={sv}><span className="ep-st ep-st--mute">Not offered</span></td>;
                    const age = ageDays(x.created_at);
                    const old = age != null && age >= s.remind_days;
                    return (
                      <td key={sv}>
                        <span className={`ep-st ep-st--${old ? 'warn' : 'ok'}`}>{old ? `${age} days old` : 'Up to date'}</span>
                        <small>{x.countries} countries · sheet dated {x.dated ? fmtDate(x.dated) : '—'} · pasted {fmtDate(x.created_at)}</small>
                        {x.source && <small className="ep-muted">{x.source}</small>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="ep-split">
        <section className="ep-card" id="paste">
          <h2>Paste a new sheet</h2>
          <ol className="ep-steps-list ep-small" style={{ marginBottom: '.8rem' }}>
            <li>Open the partner’s sheet on the right tab (e.g. <i>standard shipping … general goods</i>).</li>
            <li>Click any cell, press <b>Cmd + A</b> then <b>Cmd + C</b>.</li>
            <li>Choose what it is below, paste, save. It replaces the previous prices for that option straight away.</li>
          </ol>
          <form action={saveShippingSheet} className="ep-form">
            <div className="ep-row2">
              <label>Shown to clients as<select name="service" required defaultValue="economic">{(Object.keys(SERVICES) as Service[]).map((sv) => <option key={sv} value={sv}>{SERVICES[sv]}</option>)}</select></label>
              <label>Product type<select name="product_type" required defaultValue="general">{(Object.keys(SHIP_TYPES) as ShipType[]).map((t) => <option key={t} value={t}>{SHIP_TYPES[t]}</option>)}</select></label>
            </div>
            <label>Note for the team<input name="source" placeholder="e.g. ST · YunExpress standard, general goods" maxLength={120} /></label>
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
              <label>Packaging weight (g)<input name="packaging_g" type="number" min={0} max={5000} defaultValue={s.packaging_g} required /><small>Added to the product’s weight.</small></label>
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
