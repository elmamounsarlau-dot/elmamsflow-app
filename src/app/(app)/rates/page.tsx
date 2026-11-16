import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getClients } from '@/lib/data';
import { countryList, countryName, fmtDate } from '@/lib/format';
import { flag } from '@/lib/orders-query';
import { PageHead } from '@/components/ui';
import { marginFor, sheetsFor, shipSettings, shippedCountries } from '@/lib/shipping-db';
import { isShipType, quoteAll, SHIP_TYPES, transitLabel, type ShipType } from '@/lib/shipping-rates';

export const metadata = { title: 'Shipping rates' };

type P = { id: string; sku: string; name: string; weight_g: number; ship_type: ShipType; length_mm: number | null; width_mm: number | null; height_mm: number | null; customs_value: number };
const money = (n: number) => `$${n.toFixed(2)}`;
const pos = (s: string | undefined) => { const n = Number(String(s ?? '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : 0; };

export default async function Rates({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const staffView = !!ctx.staffRole && !ctx.viewingAs;
  if (!ctx.org && !staffView) redirect('/');
  const clients = staffView && !ctx.org ? await getClients() : [];
  const orgId = ctx.org?.id ?? (clients.some((c) => c.id === sp.for) ? sp.for : null);

  const admin = supabaseAdmin();
  const { data: prodData } = orgId
    ? await admin.from('products').select('id, sku, name, weight_g, ship_type, length_mm, width_mm, height_mm, customs_value').eq('org_id', orgId).eq('kind', 'item').order('sku').limit(500)
    : { data: [] };
  const products = (prodData ?? []) as P[];
  const prod = products.find((p) => p.id === sp.product) ?? null;

  // Units: weight in g or kg, sizes in cm or mm. Values typed win over the chosen product's.
  const wu = sp.wu === 'kg' ? 'kg' : 'g', du = sp.du === 'mm' ? 'mm' : 'cm';
  const typed = (k: string, unit: number, fallback: number | null) => (pos(sp[k]) ? pos(sp[k]) * unit : fallback ?? 0);
  const weight_g = typed('w', wu === 'kg' ? 1000 : 1, prod?.weight_g ?? null);
  const dim = (k: string, v: number | null | undefined) => typed(k, du === 'cm' ? 10 : 1, v ?? null);
  const length_mm = dim('l', prod?.length_mm), width_mm = dim('wd', prod?.width_mm), height_mm = dim('h', prod?.height_mm);
  const type: ShipType = isShipType(sp.type ?? '') ? (sp.type as ShipType) : prod?.ship_type ?? 'general';
  const qty = Math.min(999, Math.max(1, Math.floor(pos(sp.qty) || 1)));
  const country = /^[A-Z]{2}$/.test(sp.to ?? '') ? sp.to : '';
  const asked = !!country && weight_g > 0;

  const [s, offered] = await Promise.all([shipSettings(), shippedCountries()]);
  const margin = await marginFor(orgId, s);
  const sheets = asked ? await sheetsFor(type, country) : [];
  const lines = asked ? quoteAll(sheets, country, { weight_g, length_mm, width_mm, height_mm, qty }, s, margin) : [];
  const dated = sheets.map((x) => x.dated).filter(Boolean).sort().at(-1) ?? null;
  const all = countryList(country || null);
  const list: [string, string][] = offered.length ? [...all.filter(([k]) => offered.includes(k)), ...(country && !offered.includes(country) ? [[country, countryName(country)] as [string, string]] : [])] : all;

  const show = (mm: number) => (mm ? String(du === 'cm' ? +(mm / 10).toFixed(1) : mm) : '');
  const showW = weight_g ? String(wu === 'kg' ? +(weight_g / 1000).toFixed(3) : weight_g) : '';

  return (
    <>
      <PageHead crumb="Shipping" title="Shipping rates" sub="What a parcel costs to ship from our warehouse in China, door to door. Pick one of your products or type the details.">
        {staffView && ctx.can('billing.manage') && <Link className="ep-btn ep-btn--ghost" href="/settings/shipping">Shipping prices</Link>}
      </PageHead>

      <section className="ep-card" style={{ marginBottom: '1.2rem' }}>
        <form method="get" className="ep-form">
          {clients.length > 0 && (
            <label>Client <small className="ep-muted">(team only — uses the client’s margin and products)</small>
              <select name="for" defaultValue={orgId ?? ''}><option value="">Default margin</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </label>
          )}
          <div className="ep-row3">
            <label>Your product<select name="product" defaultValue={prod?.id ?? ''}><option value="">Type the details instead</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}</select></label>
            <label>Product type<select name="type" defaultValue={type}>{(Object.keys(SHIP_TYPES) as ShipType[]).map((t) => <option key={t} value={t}>{SHIP_TYPES[t]}</option>)}</select></label>
            <label>Ship to<select name="to" defaultValue={country} required><option value="">Choose a country…</option>{list.map(([k, n]) => <option key={k} value={k}>{flag(k)} {n}</option>)}</select></label>
          </div>
          <div className="ep-row4">
            <label>Weight<span className="ep-unit"><input name="w" type="number" step="any" min={0} defaultValue={showW} placeholder={prod ? 'from the product' : 'e.g. 150'} /><select name="wu" defaultValue={wu} aria-label="Weight unit"><option value="g">g</option><option value="kg">kg</option></select></span></label>
            <label>Length<span className="ep-unit"><input name="l" type="number" step="any" min={0} defaultValue={show(length_mm)} placeholder="optional" /><select name="du" defaultValue={du} aria-label="Size unit"><option value="cm">cm</option><option value="mm">mm</option></select></span></label>
            <label>Width<input name="wd" type="number" step="any" min={0} defaultValue={show(width_mm)} placeholder="optional" /></label>
            <label>Height<input name="h" type="number" step="any" min={0} defaultValue={show(height_mm)} placeholder="optional" /></label>
          </div>
          <div className="ep-row3">
            <label>Quantity in the parcel<input name="qty" type="number" min={1} max={999} defaultValue={qty} /></label>
            <label>Zip code<input name="zip" defaultValue={sp.zip ?? ''} placeholder="optional" maxLength={12} /></label>
            <label>Declared value (USD)<input name="value" type="number" step="0.01" min={0} defaultValue={sp.value ?? (prod ? String(prod.customs_value) : '')} placeholder="optional" /></label>
          </div>
          <div className="ep-form-foot" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <span className="ep-small ep-muted" style={{ flex: '1 1 16rem' }}>Weight of the product without packaging — we add our packaging. Size of the packed parcel, if you know it.</span>
            <span style={{ display: 'flex', gap: '.5rem' }}><Link className="ep-btn ep-btn--ghost" href="/rates">Reset</Link><button className="ep-btn">Estimate cost</button></span>
          </div>
        </form>
      </section>

      {asked && (
        <section className="ep-card ep-card--flush">
          <div className="ep-card-head ep-pad">
            <h2>{flag(country)} {countryName(country)} · {SHIP_TYPES[type]}</h2>
            <span className="ep-muted ep-small">{qty > 1 ? `${qty} units · ` : ''}prices in USD{dated ? ` · rates of ${fmtDate(dated)}` : ''}</span>
          </div>
          {lines.length === 0 ? (
            <div className="ep-pad"><p className="ep-note ep-note--warn">We don’t have a price for {SHIP_TYPES[type].toLowerCase()} to {countryName(country)} at this weight yet. <Link href="/support">Ask us</Link> and we’ll quote it.</p></div>
          ) : (
            <div className="ep-tablewrap">
              <table className="ep-table">
                <thead><tr><th>Shipping option</th><th>Transit time</th><th className="ep-right">Billed weight</th><th className="ep-right">Price</th>{qty > 1 && <th className="ep-right">Per unit</th>}{staffView && <th className="ep-right">Our cost · team only</th>}</tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.service}>
                      <td><b>{l.label}</b><small>Door to door</small></td>
                      <td>{transitLabel(l.transit)}</td>
                      <td className="ep-right"><b>{l.kg.toFixed(3)} kg</b><small>{l.volumetric > l.actual ? `size-based (packed ${l.actual.toFixed(3)} kg)` : `incl. packaging`}</small></td>
                      <td className="ep-right"><b style={{ fontSize: '1.05rem' }}>{money(l.price)}</b></td>
                      {qty > 1 && <td className="ep-right">{money(l.price / qty)}</td>}
                      {staffView && <td className="ep-right"><small>{money(l.cost)} · +{money(l.price - l.cost)}</small></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
